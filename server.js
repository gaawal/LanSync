/**
 * LanSync —— 局域网文件互传 + 协同编辑服务器
 * 运行: node server.js   (Mac / Windows 通用)
 * 其他设备在浏览器打开 http://<本机局域网IP>:7788 即可连接
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const IS_PKG = !!process.pkg;                       // 是否由 pkg 打包成 exe 运行
const ROOT = __dirname;                             // 打包后为只读快照目录（前端资源在这里）
const BASE = IS_PKG ? path.dirname(process.execPath) : ROOT; // 数据目录：跟着 exe 走，可写
const PORT = Number(process.env.PORT || 7788);
const PUBLIC = path.join(ROOT, 'public');
const SHARED = path.join(BASE, 'shared');
const FILES_DIR = path.join(SHARED, 'files');
const DOCS_DIR = path.join(SHARED, 'docs');
const META_FILE = path.join(SHARED, 'files.json');

for (const d of [SHARED, FILES_DIR, DOCS_DIR]) fs.mkdirSync(d, { recursive: true });

/* ---------------- 文件元数据 ---------------- */
let fileMeta = [];
try { fileMeta = JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch (e) { fileMeta = []; }
function saveFileMeta() { fs.writeFileSync(META_FILE, JSON.stringify(fileMeta, null, 2)); }

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.css', '.html', '.htm', '.xml', '.yml', '.yaml', '.py', '.java', '.c', '.h', '.cpp', '.hpp', '.go', '.rs', '.sh', '.bat', '.cmd', '.ps1', '.sql', '.ini', '.cfg', '.conf', '.log', '.csv', '.env', '.gitignore', '.gd', '.vue', '.scss', '.less', '.toml']);
function isTextFile(name) {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXTS.has(ext) || !ext; // 无扩展名也按文本尝试
}

/* ---------------- OT 操作变换 ---------------- */
// op: { t:'i'|'d', p:位置, c:文本或长度, uid:操作唯一id }
function applyOp(content, op) {
  if (op.t === 'i') return content.slice(0, op.p) + op.c + content.slice(op.p);
  return content.slice(0, op.p) + content.slice(op.p + op.c);
}

/**
 * 把 op a 变换为 "在 op b 之后应用" 的等价操作。
 * aPriority: 同位置插入时的优先方（true = a 排前面）
 */
function transformOp(a, b, aPriority) {
  const a2 = { ...a };
  if (b.t === 'i') {
    if (a.t === 'i') {
      if (b.p < a.p || (b.p === a.p && !aPriority)) a2.p += b.c.length;
    } else { // a 是 delete
      if (b.p <= a.p) a2.p += b.c.length;
      else if (b.p < a.p + a.c) a2.c += b.c.length; // 简化：插入点落在删除范围内则一并删除
    }
  } else { // b 是 delete
    const bEnd = b.p + b.c;
    if (a.t === 'i') {
      const delBefore = Math.max(0, Math.min(a.p, bEnd) - b.p);
      a2.p -= delBefore;
      if (a.p > b.p && a.p < bEnd) a2.c = ''; // 插入点落在删除范围内 → 插入内容被吞掉（与 d 遇 i 的处理互补）
    } else { // a 是 delete
      const aEnd = a.p + a.c;
      const delBefore = Math.max(0, Math.min(a.p, bEnd) - b.p);
      const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(a.p, b.p));
      a2.p -= delBefore;
      a2.c -= overlap;
      if (a2.c < 0) a2.c = 0;
    }
  }
  return a2;
}

/* ---------------- 协同文档 ---------------- */
const docs = new Map();

function createDoc(id, name, content, boundFileId, rich) {
  const doc = {
    id, name, content: content || '', boundFileId: boundFileId || null, rich: !!rich,
    version: 0, history: [], clients: new Map(), dirty: false, saveTimer: null,
  };
  docs.set(id, doc);
  persistDoc(doc);
  return doc;
}

function persistDoc(doc) {
  const data = { id: doc.id, name: doc.name, content: doc.content, boundFileId: doc.boundFileId, rich: !!doc.rich };
  fs.writeFileSync(path.join(DOCS_DIR, doc.id + '.json'), JSON.stringify(data));
  doc.dirty = false;
}

function scheduleSave(doc) {
  doc.dirty = true;
  if (doc.saveTimer) return;
  doc.saveTimer = setTimeout(() => {
    doc.saveTimer = null;
    try {
      persistDoc(doc);
      // 富文档（Office）的二进制回写由客户端转 docx 后走 /api/file/content，这里只存 HTML 中间态
      if (doc.boundFileId && !doc.rich) {
        const meta = fileMeta.find(f => f.id === doc.boundFileId);
        if (meta) fs.writeFileSync(path.join(FILES_DIR, meta.stored), doc.content, 'utf8');
      }
      notifyRefresh();
    } catch (e) { console.error('保存文档失败:', e.message); }
  }, 1200);
}

function loadDocs() {
  let list = [];
  try { list = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.json')); } catch (e) {}
  for (const f of list) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DOCS_DIR, f), 'utf8'));
      docs.set(d.id, {
        id: d.id, name: d.name, content: d.content, boundFileId: d.boundFileId || null, rich: !!d.rich,
        version: 0, history: [], clients: new Map(), dirty: false, saveTimer: null,
      });
    } catch (e) { console.error('加载文档失败:', f, e.message); }
  }
}
loadDocs();

/* ---------------- 用户与 WS ---------------- */
const PALETTE = ['#e74c3c', '#8e44ad', '#2980b9', '#16a085', '#f39c12', '#d35400', '#27ae60', '#c0392b', '#7f8c8d'];
let colorIdx = 0;
const allSockets = new Set(); // 已 hello 的连接

function broadcastUsers() {
  const users = [];
  for (const ws of allSockets) {
    if (ws._info && ws._info.name) users.push({ id: ws._info.id, name: ws._info.name, color: ws._info.color });
  }
  const msg = JSON.stringify({ type: 'users', users });
  for (const ws of allSockets) { if (ws.readyState === 1) ws.send(msg); }
}

function broadcastDocUsers(doc) {
  const users = [];
  for (const [c, st] of doc.clients) {
    if (c._info) users.push({ id: c._info.id, name: c._info.name, color: c._info.color, cursor: st.cursor });
  }
  const msg = JSON.stringify({ type: 'docUsers', docId: doc.id, users });
  for (const [c] of doc.clients) { if (c.readyState === 1) c.send(msg); }
}

function notifyRefresh() {
  const msg = JSON.stringify({ type: 'refresh' });
  for (const ws of allSockets) { if (ws.readyState === 1) ws.send(msg); }
}

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  ws._info = { id: crypto.randomBytes(4).toString('hex'), name: null, color: PALETTE[colorIdx++ % PALETTE.length] };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    try { handleWs(ws, msg); } catch (e) { console.error('WS 处理出错:', e); }
  });

  ws.on('close', () => {
    allSockets.delete(ws);
    for (const doc of docs.values()) {
      if (doc.clients.has(ws)) {
        doc.clients.delete(ws);
        broadcastDocUsers(doc);
      }
    }
    broadcastUsers();
  });
});

function handleWs(ws, msg) {
  switch (msg.type) {
    case 'hello': {
      ws._info.name = (msg.name || '匿名用户').slice(0, 24);
      allSockets.add(ws);
      ws.send(JSON.stringify({ type: 'welcome', you: ws._info }));
      broadcastUsers();
      break;
    }
    case 'join': {
      let doc = docs.get(msg.docId);
      // 兜底：文档缺失但原文件在（例如直接拷进 shared/ 的文件），就地补建协同文档
      if (!doc && typeof msg.docId === 'string' && msg.docId.startsWith('f-')) {
        const meta = fileMeta.find(f => f.id === msg.docId.slice(2));
        if (meta) {
          let content = '';
          try { content = fs.readFileSync(path.join(FILES_DIR, meta.stored), 'utf8'); } catch (e) {}
          doc = createDoc(msg.docId, meta.name, content, meta.id);
        }
      }
      if (!doc) { ws.send(JSON.stringify({ type: 'error', message: '文档不存在' })); return; }
      doc.clients.set(ws, { cursor: -1 });
      const users = [];
      for (const [c] of doc.clients) {
        if (c._info) users.push({ id: c._info.id, name: c._info.name, color: c._info.color });
      }
      ws.send(JSON.stringify({ type: 'init', docId: doc.id, name: doc.name, content: doc.content, version: doc.version, users }));
      broadcastDocUsers(doc);
      break;
    }
    case 'op': {
      const doc = docs.get(msg.docId);
      if (!doc || !doc.clients.has(ws)) return;
      let op = { t: msg.op.t, p: msg.op.p, c: msg.op.c, uid: msg.op.uid };
      const base = msg.version | 0;
      if (base > doc.version) return; // 客户端版本超前，丢弃
      const concurrent = doc.history.filter(h => h.version > base);
      for (const h of concurrent) {
        op = transformOp(op, h.op, op.uid < h.op.uid);
        if (op.t === 'd' && op.c <= 0) break;
      }
      if (!(op.t === 'd' && op.c <= 0)) {
        doc.content = applyOp(doc.content, op);
        doc.version++;
        doc.history.push({ version: doc.version, op });
        if (doc.history.length > 500) doc.history.splice(0, doc.history.length - 500);
        scheduleSave(doc);
        const out = JSON.stringify({ type: 'op', docId: doc.id, op, from: ws._info.id, version: doc.version });
        for (const [c] of doc.clients) {
          if (c !== ws && c.readyState === 1) c.send(out);
        }
      }
      ws.send(JSON.stringify({ type: 'ack', docId: doc.id, version: doc.version, opId: msg.op.uid }));
      break;
    }
    case 'replace': {
      // 富文档首次初始化：仅在文档为空（version 0）时接受，先到先得
      const doc = docs.get(msg.docId);
      if (!doc || !doc.clients.has(ws)) return;
      if (doc.version !== 0 || typeof msg.content !== 'string') return;
      if (Buffer.byteLength(msg.content) > 20 * 1024 * 1024) return;
      doc.content = msg.content;
      doc.version = 1;
      doc.history.push({ version: 1, op: { t: 'i', p: 0, c: msg.content, uid: 'init-' + doc.id } });
      scheduleSave(doc);
      const out = JSON.stringify({ type: 'replaced', docId: doc.id, content: doc.content });
      for (const [c] of doc.clients) {
        if (c !== ws && c.readyState === 1) c.send(out);
      }
      break;
    }
    case 'cursor': {
      const doc = docs.get(msg.docId);
      if (!doc || !doc.clients.has(ws)) return;
      doc.clients.get(ws).cursor = msg.pos | 0;
      const out = JSON.stringify({ type: 'cursor', docId: doc.id, userId: ws._info.id, pos: msg.pos | 0 });
      for (const [c] of doc.clients) {
        if (c !== ws && c.readyState === 1) c.send(out);
      }
      break;
    }
  }
}

/* ---------------- HTTP 服务 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

/* 预览时内联显示用的 MIME */
const INLINE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

function getLanIPs() {
  const res = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name]) {
      if (it.family === 'IPv4' && !it.internal) res.push(it.address);
    }
  }
  return res;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 2 * 1024 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('文件过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function docListInfo() {
  return [...docs.values()].map(d => ({
    id: d.id, name: d.name, boundFileId: d.boundFileId,
    size: Buffer.byteLength(d.content),
    updated: _docFileTime(d),
  }));
}
function _docFileTime(d) {
  try { return fs.statSync(path.join(DOCS_DIR, d.id + '.json')).mtimeMs; } catch (e) { return Date.now(); }
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/info' && req.method === 'GET') {
    return json(res, 200, {
      host: os.hostname() + ' (' + (process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'Mac' : process.platform) + ')',
      ips: getLanIPs(), port: PORT, files: fileMeta.slice().reverse(), docs: docListInfo(),
    });
  }
  if (p === '/api/upload' && req.method === 'POST') {
    const name = decodeURIComponent(req.headers['x-file-name'] || '未命名文件');
    const uploader = decodeURIComponent(req.headers['x-uploader'] || '匿名');
    const buf = await readBody(req);
    const id = crypto.randomBytes(5).toString('hex');
    const stored = id + path.extname(name);
    fs.writeFileSync(path.join(FILES_DIR, stored), buf);
    const meta = { id, name, size: buf.length, uploader, time: Date.now(), stored };
    fileMeta.push(meta);
    saveFileMeta();
    // 文本文件自动创建协同文档
    let docId = null;
    if (isTextFile(name) && buf.length < 2 * 1024 * 1024) {
      const did = 'f-' + id;
      if (!docs.has(did)) createDoc(did, name, buf.toString('utf8'), id);
      docId = did;
    }
    return json(res, 200, { ok: true, file: meta, docId });
  }
  if (p === '/api/download' && req.method === 'GET') {
    const meta = fileMeta.find(f => f.id === url.searchParams.get('id'));
    if (!meta) return json(res, 404, { error: '文件不存在' });
    const fp = path.join(FILES_DIR, meta.stored);
    if (!fs.existsSync(fp)) return json(res, 404, { error: '文件已丢失' });
    const inline = url.searchParams.get('inline') === '1'; // 预览用：内联显示而不是下载
    const type = INLINE_MIME[path.extname(meta.name).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': inline ? type : 'application/octet-stream',
      'Content-Length': meta.size,
      'Content-Disposition': (inline ? 'inline' : 'attachment') + '; filename*=UTF-8\'\'' + encodeURIComponent(meta.name),
    });
    fs.createReadStream(fp).pipe(res);
    return;
  }
  if (p === '/api/file' && req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    const idx = fileMeta.findIndex(f => f.id === id);
    if (idx < 0) return json(res, 404, { error: '文件不存在' });
    try { fs.unlinkSync(path.join(FILES_DIR, fileMeta[idx].stored)); } catch (e) {}
    fileMeta.splice(idx, 1);
    saveFileMeta();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/file/content' && req.method === 'POST') {
    // 覆写已上传文件的二进制内容（用于 Word 协同后回写 .docx）
    const id = url.searchParams.get('id');
    const meta = fileMeta.find(f => f.id === id);
    if (!meta) return json(res, 404, { error: '文件不存在' });
    const buf = await readBody(req);
    fs.writeFileSync(path.join(FILES_DIR, meta.stored), buf);
    meta.size = buf.length;
    meta.time = Date.now();
    meta.uploader = decodeURIComponent(req.headers['x-uploader'] || meta.uploader);
    saveFileMeta();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/docs/open-office' && req.method === 'POST') {
    // 为 Office 文件创建/获取协同编辑文档（内容为 HTML 中间态）
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
    const meta = fileMeta.find(f => f.id === body.fileId);
    if (!meta) return json(res, 404, { error: '文件不存在' });
    const id = 'o-' + meta.id;
    if (!docs.has(id)) createDoc(id, meta.name, '', meta.id, true);
    return json(res, 200, { ok: true, docId: id, fileName: meta.name });
  }
  if (p === '/api/docs' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
    const id = 'd-' + crypto.randomBytes(4).toString('hex');
    createDoc(id, (body.name || '未命名文档').slice(0, 60), '');
    notifyRefresh();
    return json(res, 200, { ok: true, docId: id });
  }
  if (p === '/api/docs/delete' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
    const doc = docs.get(body.docId);
    if (!doc) return json(res, 404, { error: '文档不存在' });
    for (const [c] of doc.clients) c.send(JSON.stringify({ type: 'closed', docId: doc.id }));
    docs.delete(body.docId);
    try { fs.unlinkSync(path.join(DOCS_DIR, body.docId + '.json')); } catch (e) {}
    notifyRefresh();
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    try { await handleApi(req, res, url); } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  let p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const fp = path.join(PUBLIC, p);
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

// WebSocket 挂载到 HTTP 服务
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/ws') wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  else socket.destroy();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error('  ✗ 端口 ' + PORT + ' 已被占用（可能已经启动过一个 LanSync）。');
    console.error('    直接打开 http://localhost:' + PORT + ' 即可；');
    console.error('    或用其它端口启动：set PORT=7799 && LanSync.exe');
    console.error('');
    if (IS_PKG) setTimeout(() => process.exit(1), 4000);
  } else {
    console.error('服务器错误:', e.message);
  }
});

server.listen(PORT, () => {
  const ips = getLanIPs();
  console.log('==========================================');
  console.log('  LanSync 局域网互传已启动' + (IS_PKG ? '（打包版）' : ''));
  console.log('  本机打开:  http://localhost:' + PORT);
  for (const ip of ips) console.log('  其他设备打开:  http://' + ip + ':' + PORT);
  console.log('  共享目录: ' + SHARED);
  console.log('  （关闭本窗口即停止服务）');
  console.log('==========================================');
  // 打包版双击运行时自动打开浏览器
  if (IS_PKG && process.env.LANSYNC_NO_OPEN !== '1') {
    try {
      const { exec } = require('child_process');
      const url = 'http://localhost:' + PORT;
      if (process.platform === 'win32') exec('start "" "' + url + '"');
      else if (process.platform === 'darwin') exec('open "' + url + '"');
      else exec('xdg-open "' + url + '"');
    } catch (e) { /* 忽略 */ }
  }
});
