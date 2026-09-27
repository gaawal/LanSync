/* LanSync 前端逻辑 */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  myId: null, myName: localStorage.getItem('lansync-name') || '',
  users: [], info: null,
  doc: null, // { id, name, mode:'plain'|'rich'|'preview', content, version, inflight, queue, clients:Map, boundFileId, dirtyLocal }
};

/* ---------------- 工具 ---------------- */
function toast(text, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtTime(ts) {
  const d = new Date(ts);
  const pad = x => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function getExt(name) { return (name.split('.').pop() || '').toLowerCase(); }
function fileIcon(name) {
  const ext = getExt(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return '🖼';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) return '🎵';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
  if (['pdf'].includes(ext)) return '📕';
  if (['doc', 'docx', 'wps'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['ppt', 'pptx'].includes(ext)) return '📽';
  if (['exe', 'dmg', 'msi', 'apk'].includes(ext)) return '⚙';
  return '📄';
}

/* ---------------- OT（与 server.js 保持一致） ---------------- */
function applyOp(content, op) {
  if (op.t === 'i') return content.slice(0, op.p) + op.c + content.slice(op.p);
  return content.slice(0, op.p) + content.slice(op.p + op.c);
}
function transformOp(a, b, aPriority) {
  const a2 = { ...a };
  if (b.t === 'i') {
    if (a.t === 'i') {
      if (b.p < a.p || (b.p === a.p && !aPriority)) a2.p += b.c.length;
    } else {
      if (b.p <= a.p) a2.p += b.c.length;
      else if (b.p < a.p + a.c) a2.c += b.c.length;
    }
  } else {
    const bEnd = b.p + b.c;
    if (a.t === 'i') {
      const delBefore = Math.max(0, Math.min(a.p, bEnd) - b.p);
      a2.p -= delBefore;
      if (a.p > b.p && a.p < bEnd) a2.c = '';
    } else {
      const aEnd = a.p + a.c;
      a2.p -= Math.max(0, Math.min(a.p, bEnd) - b.p);
      a2.c -= Math.max(0, Math.min(aEnd, bEnd) - Math.max(a.p, b.p));
      if (a2.c < 0) a2.c = 0;
    }
  }
  return a2;
}

/** 计算两个字符串的最小单操作差异 */
function computeDiff(oldStr, newStr) {
  let start = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (start < minLen && oldStr[start] === newStr[start]) start++;
  let endOld = oldStr.length, endNew = newStr.length;
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) { endOld--; endNew--; }
  if (endOld === endNew) {
    return [{ t: 'i', p: start, c: newStr.slice(start, endNew) }];
  }
  if (start === endNew) {
    return [{ t: 'd', p: start, c: endOld - endNew }];
  }
  return [
    { t: 'd', p: start, c: endOld - start },
    { t: 'i', p: start, c: newStr.slice(start, endNew) },
  ];
}

/* ---------------- 昵称 ---------------- */
if (!state.myName) {
  const ua = navigator.userAgent;
  const sys = /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'Mac' : '设备';
  state.myName = sys + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  localStorage.setItem('lansync-name', state.myName);
}
$('nameInput').value = state.myName;
$('nameInput').addEventListener('change', () => {
  const v = $('nameInput').value.trim() || state.myName;
  state.myName = v;
  localStorage.setItem('lansync-name', v);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'hello', name: v }));
});

/* ---------------- WebSocket ---------------- */
let ws = null;
let reconnectTimer = null;

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    $('connDot').classList.add('on');
    ws.send(JSON.stringify({ type: 'hello', name: state.myName }));
    if (state.doc && state.doc.mode !== 'preview') joinDoc(state.doc.id);
  };
  ws.onclose = () => {
    $('connDot').classList.remove('on');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWs, 2000);
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    try { handleWsMsg(m); } catch (err) { console.error('消息处理失败:', err); }
  };
}

function handleWsMsg(m) {
  switch (m.type) {
    case 'welcome':
      state.myId = m.you.id;
      break;
    case 'users':
      state.users = m.users;
      renderUsers();
      break;
    case 'init':
      if (!state.doc || state.doc.id !== m.docId) return;
      if (m.name && state.doc.mode !== 'preview') {
        state.doc.name = m.name;
        $('editorTitle').textContent = m.name;
      }
      state.doc.content = m.content;
      state.doc.version = m.version;
      state.doc.inflight = null;
      state.doc.queue = [];
      state.doc.clients = new Map(m.users.map(u => [u.id, u]));
      if (state.doc.mode === 'plain') {
        $('editorArea').value = m.content;
        updateMirror();
      } else if (state.doc.mode === 'rich') {
        if (m.version === 0 && m.content === '') {
          initRichFromDocx(); // 首个打开者：docx → HTML
        } else {
          $('richEditor').innerHTML = m.content;
          state.doc._richReady = true;
        }
      }
      renderDocUsers();
      updateSaveState();
      $('editorFoot').textContent = `已连接 · ${m.users.length} 人正在编辑`;
      break;
    case 'replaced':
      if (!state.doc || state.doc.id !== m.docId) return;
      if (state.doc.mode !== 'rich') return;
      state.doc.content = m.content;
      state.doc.version = m.version;
      state.doc.inflight = null;
      state.doc.queue = [];
      $('richEditor').innerHTML = m.content;
      state.doc._richReady = true;
      updateSaveState();
      break;
    case 'docUsers':
      if (!state.doc || state.doc.id !== m.docId) return;
      state.doc.clients = new Map(m.users.map(u => [u.id, u]));
      renderDocUsers();
      if (state.doc.mode === 'plain') updateMirror();
      break;
    case 'op':
      if (!state.doc || state.doc.id !== m.docId) return;
      if (state.doc.mode === 'preview') return;
      clientApplyRemote(m.op, m.version);
      break;
    case 'cursor':
      if (!state.doc || state.doc.id !== m.docId || state.doc.mode !== 'plain') return;
      {
        const u = state.doc.clients.get(m.userId);
        if (u) { u.cursor = m.pos; updateMirror(); }
      }
      break;
    case 'ack':
      if (!state.doc || state.doc.id !== m.docId) return;
      state.doc.version = m.version;
      state.doc.inflight = null;
      if (state.doc.queue.length) {
        state.doc.inflight = state.doc.queue.shift();
        sendOp(state.doc.inflight);
      }
      updateSaveState();
      break;
    case 'closed':
      if (state.doc && state.doc.id === m.docId) closeEditor();
      loadInfo();
      toast('该文档已被删除');
      break;
    case 'refresh':
      loadInfo();
      break;
  }
}

/* ---------------- 协同核心（plain / rich 共用） ---------------- */
let opCounter = 0;
function newOpId() { return state.myId + '-' + (++opCounter) + '-' + Date.now(); }

function clientLocalEdit(ops) {
  const d = state.doc;
  for (const op of ops) {
    op.uid = newOpId();
    if (d.inflight) d.queue.push(op);
    else { d.inflight = op; sendOp(op); }
  }
}

function sendOp(op) {
  ws.send(JSON.stringify({
    type: 'op', docId: state.doc.id,
    op: { t: op.t, p: op.p, c: op.c, uid: op.uid },
    version: state.doc.version,
  }));
}

function clientApplyRemote(remoteOp, version) {
  const d = state.doc;
  let o = { ...remoteOp };
  const pending = d.inflight ? [d.inflight, ...d.queue] : [...d.queue];
  const newPending = [];
  for (const p of pending) {
    const o2 = transformOp(o, p, o.uid < p.uid);
    const p2 = transformOp(p, o, p.uid < o.uid);
    o = o2;
    newPending.push(p2);
  }
  if (d.inflight) {
    d.inflight = newPending.shift();
    d.queue = newPending;
  } else {
    d.queue = newPending;
  }
  if (o.t === 'i' && o.c === '') return;
  d.content = applyOp(d.content, o);
  d.version = version;

  if (d.mode === 'plain') {
    const area = $('editorArea');
    const selStart = area.selectionStart, selEnd = area.selectionEnd;
    area.value = d.content;
    let s = selStart, e2 = selEnd;
    if (o.t === 'i') {
      if (o.p <= s) { s += o.c.length; e2 += o.c.length; }
    } else {
      const oEnd = o.p + o.c;
      const shift = (pos) => pos > oEnd ? pos - o.c : (pos > o.p ? o.p : pos);
      s = shift(s); e2 = shift(e2);
    }
    area.setSelectionRange(s, e2);
    updateMirror();
  } else if (d.mode === 'rich') {
    const caret = getCaretOffset($('richEditor'));
    $('richEditor').innerHTML = d.content;
    if (document.activeElement === $('richEditor')) setCaretOffset($('richEditor'), caret);
  }
  updateSaveState();
}

function updateSaveState() {
  if (!state.doc || state.doc.mode === 'preview') return;
  const pending = (state.doc.inflight ? 1 : 0) + state.doc.queue.length;
  if (state.doc.mode === 'rich') {
    $('saveState').textContent = state.doc._saving ? '保存回 Word 中…'
      : state.doc.dirtyLocal ? '待保存回 .docx' : (pending > 0 ? `同步中(${pending})…` : '已同步');
  } else {
    $('saveState').textContent = pending > 0 ? `同步中(${pending})…` : '已同步';
  }
}

/* ---------------- 纯文本编辑器 ---------------- */
const EDITABLE_EXT = ['txt', 'md', 'markdown', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'css', 'html', 'htm', 'xml', 'yml', 'yaml', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'go', 'rs', 'sh', 'bat', 'cmd', 'ps1', 'sql', 'ini', 'cfg', 'conf', 'log', 'csv', 'env', 'gd', 'vue', 'scss', 'less', 'toml'];
function isEditableName(name) {
  const ext = getExt(name);
  return EDITABLE_EXT.includes(ext) || !name.includes('.');
}

function openDoc(docId) {
  state.doc = { id: docId, name: '', mode: 'plain', content: '', version: 0, inflight: null, queue: [], clients: new Map() };
  showEditorMode('plain');
  joinDoc(docId);
}

function joinDoc(docId) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'join', docId }));
}

let inputTimer = null;
$('editorArea').addEventListener('input', () => {
  if (!state.doc || state.doc.mode !== 'plain') return;
  const area = $('editorArea');
  const old = state.doc.content;
  const newVal = area.value;
  if (newVal === old) return;
  const ops = computeDiff(old, newVal);
  for (const op of ops) state.doc.content = applyOp(state.doc.content, op);
  clientLocalEdit(ops);
  updateMirror();
  updateSaveState();
  clearTimeout(inputTimer);
  inputTimer = setTimeout(sendCursor, 300);
});

function sendCursor() {
  if (!state.doc || state.doc.mode !== 'plain' || !ws || ws.readyState !== 1) return;
  const pos = $('editorArea').selectionStart;
  if (pos === state.doc.lastSentCursor) return;
  state.doc.lastSentCursor = pos;
  ws.send(JSON.stringify({ type: 'cursor', docId: state.doc.id, pos }));
}
$('editorArea').addEventListener('keyup', sendCursor);
$('editorArea').addEventListener('click', sendCursor);
$('editorArea').addEventListener('scroll', () => {
  $('mirror').scrollTop = $('editorArea').scrollTop;
  $('mirror').scrollLeft = $('editorArea').scrollLeft;
});

function updateMirror() {
  if (!state.doc || state.doc.mode !== 'plain') return;
  const content = state.doc.content;
  const mirror = $('mirror');
  const frag = document.createDocumentFragment();
  const cursors = [];
  for (const [uid, u] of state.doc.clients) {
    if (uid !== state.myId && u.cursor >= 0 && u.cursor <= content.length) cursors.push(u);
  }
  cursors.sort((a, b) => a.cursor - b.cursor);
  let idx = 0;
  for (const u of cursors) {
    frag.appendChild(document.createTextNode(content.slice(idx, u.cursor)));
    const caret = document.createElement('span');
    caret.className = 'rc';
    caret.style.background = u.color;
    // 名字标签嵌在光标内部，才能贴着这根光标定位（否则会相对容器定位而被裁掉）
    const name = document.createElement('span');
    name.className = 'rname';
    name.style.background = u.color;
    name.textContent = u.name;
    caret.appendChild(name);
    frag.appendChild(caret);
    idx = u.cursor;
  }
  frag.appendChild(document.createTextNode(content.slice(idx)));
  mirror.textContent = '';
  mirror.appendChild(frag);
  mirror.scrollTop = $('editorArea').scrollTop;
}

/* ---------------- Word 富文本协同 ---------------- */
async function openOfficeDoc(fileId, fileName) {
  try {
    const r = await fetch('/api/docs/open-office', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    }).then(x => x.json());
    if (!r.ok) { toast('打开失败：' + (r.error || '')); return; }
    state.doc = {
      id: r.docId, name: fileName, mode: 'rich', content: '', version: 0,
      inflight: null, queue: [], clients: new Map(), boundFileId: fileId,
      dirtyLocal: false, _richReady: false,
    };
    showEditorMode('rich');
    $('richEditor').innerHTML = '<p style="color:#999">正在读取 Word 文档…</p>';
    joinDoc(r.docId);
  } catch (e) {
    toast('打开失败：' + e.message);
  }
}

async function initRichFromDocx() {
  const d = state.doc;
  try {
    const buf = await fetch('/api/download?id=' + d.boundFileId).then(x => x.arrayBuffer());
    if (!state.doc || state.doc.id !== d.id) return;
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    if (!state.doc || state.doc.id !== d.id) return;
    if (state.doc.version === 0) {
      const html = result.value || '<p></p>';
      state.doc.content = html;
      state.doc.version = 1;
      $('richEditor').innerHTML = html;
      state.doc._richReady = true;
      ws.send(JSON.stringify({ type: 'replace', docId: d.id, content: html }));
      updateSaveState();
    }
  } catch (e) {
    $('richEditor').innerHTML = '<p style="color:#c00">Word 文档读取失败：' + e.message + '</p>';
  }
}

$('richEditor').addEventListener('input', () => {
  if (!state.doc || state.doc.mode !== 'rich' || !state.doc._richReady) return;
  const div = $('richEditor');
  const old = state.doc.content;
  const next = div.innerHTML;
  if (next === old) return;
  const ops = computeDiff(old, next);
  const opSize = ops.reduce((n, o) => n + (o.c || '').length, 0);
  if (opSize > 20000) return; // 异常巨大变更（如整段粘贴重排）保守跳过，避免内容重置
  for (const op of ops) state.doc.content = applyOp(state.doc.content, op);
  clientLocalEdit(ops);
  state.doc.dirtyLocal = true;
  updateSaveState();
  scheduleDocxSave();
});

/* 自动保存回 .docx */
let docxSaveTimer = null;
function scheduleDocxSave() {
  clearTimeout(docxSaveTimer);
  docxSaveTimer = setTimeout(saveDocxBack, 2500);
}
async function saveDocxBack() {
  const d = state.doc;
  if (!d || d.mode !== 'rich' || !d.dirtyLocal || d._saving) { if (d) scheduleDocxSave(); return; }
  d._saving = true;
  updateSaveState();
  try {
    const blob = htmlDocx.asBlob(d.content);
    await fetch('/api/file/content?id=' + d.boundFileId, {
      method: 'POST',
      headers: { 'X-Uploader': encodeURIComponent(state.myName) },
      body: blob,
    });
    d.dirtyLocal = false;
    $('saveState').textContent = '已保存回 .docx';
    setTimeout(updateSaveState, 1500);
    loadInfo();
  } catch (e) {
    toast('保存 Word 失败：' + e.message);
  } finally {
    d._saving = false;
  }
}

/* 光标位置近似保持（基于纯文本长度） */
function getCaretOffset(div) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return -1;
  const r = sel.getRangeAt(0);
  if (!div.contains(r.startContainer)) return -1;
  try {
    const pre = document.createRange();
    pre.selectNodeContents(div);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length;
  } catch (e) { return -1; }
}
function setCaretOffset(div, offset) {
  if (offset < 0) return;
  try {
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    let remain = offset, node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (remain <= len) {
        const r = document.createRange();
        r.setStart(node, remain);
        r.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
      remain -= len;
    }
  } catch (e) { /* 忽略 */ }
}

/* ---------------- Office / 全格式在线预览 ---------------- */
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
const PREVIEW_EXTS = ['docx', 'xlsx', 'xls', 'pptx', 'csv', 'pdf'].concat(IMG_EXTS);
function isPreviewName(name) { return PREVIEW_EXTS.includes(getExt(name)); }

/* 点击小鱼 → 按类型选择打开方式（协同办公优先） */
function openByType(file) {
  const ext = getExt(file.name);
  if (ext === 'docx' && file.size < 20 * 1024 * 1024) return openOfficeDoc(file.id, file.name);
  if (isEditableName(file.name) && file.size < 2 * 1024 * 1024) return openDoc('f-' + file.id, file.name);
  if (PREVIEW_EXTS.includes(ext) && file.size < 100 * 1024 * 1024) return previewFile(file);
  toast(`「${file.name}」不支持在线打开，请下载后使用本地软件编辑`);
}

/* 带超时的 Promise，防止渲染库卡死导致“一直加载” */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + '超时，请下载后用本地软件打开')), ms)),
  ]);
}

async function previewFile(file) {
  state.doc = { id: 'preview-' + file.id, name: file.name, mode: 'preview', content: '', version: 0, inflight: null, queue: [], clients: new Map() };
  showEditorMode('preview');
  const ext = getExt(file.name);
  $('editorTitle').textContent = file.name;
  $('editorFoot').textContent =
    IMG_EXTS.includes(ext) ? '图片预览'
    : ext === 'pdf' ? 'PDF 预览 · 可滚动翻页'
    : ext === 'docx' ? 'Word 预览 · 关闭后可用"协同编辑"多人实时编辑'
    : (['xlsx', 'xls', 'csv'].includes(ext)) ? '表格预览 · 点击上方标签切换工作表'
    : ext === 'pptx' ? '幻灯片预览'
    : '预览模式';
  const container = $('previewContainer');
  const tabs = $('sheetTabs');
  tabs.classList.add('hidden');
  tabs.textContent = '';
  container.innerHTML = '<div class="preview-loading">加载中…</div>';
  container.style.paddingTop = '';
  try {
    /* ---- 图片：自适应窗口高度，只有图片本身（点击切换原始大小） ---- */
    if (IMG_EXTS.includes(ext)) {
      container.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'preview-img-wrap';
      const img = document.createElement('img');
      img.src = '/api/download?id=' + file.id + '&inline=1';
      img.alt = file.name;
      img.title = '点击切换 原始大小 / 适应窗口';
      img.onclick = () => wrap.classList.toggle('actual');
      wrap.appendChild(img);
      container.appendChild(wrap);
      return;
    }
    /* ---- PDF：只有内嵌查看器 ---- */
    if (ext === 'pdf') {
      container.innerHTML = `<div class="preview-pdf-wrap"><iframe src="/api/download?id=${file.id}&inline=1" title="PDF 预览"></iframe></div>`;
      return;
    }
    const buf = await fetch('/api/download?id=' + file.id).then(x => x.arrayBuffer());
    if (!state.doc || state.doc.id !== 'preview-' + file.id) return;
    /* ---- Word：只有文档页面 ---- */
    if (ext === 'docx') {
      container.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'docx-wrap';
      container.appendChild(wrap);
      await withTimeout(docx.renderAsync(buf, wrap, null, { inWrapper: true }), 20000, 'Word 渲染');
    } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
      /* ---- 表格：只有表格 + Sheet 标签 ---- */
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
      tabs.textContent = '';
      tabs.classList.remove('hidden');
      container.style.paddingTop = '34px';
      wb.SheetNames.forEach((sn, i) => {
        const btn = document.createElement('button');
        btn.textContent = sn;
        if (i === 0) btn.classList.add('active');
        btn.onclick = () => {
          tabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderSheet(wb, sn);
        };
        tabs.appendChild(btn);
      });
      renderSheet(wb, wb.SheetNames[0]);
      function renderSheet(workbook, name) {
        const html = XLSX.utils.sheet_to_html(workbook.Sheets[name]);
        container.innerHTML = '<div class="xlsx-table-wrap">' + html + '</div>';
      }
    } else if (ext === 'pptx') {
      /* ---- PPT：只有幻灯片页面 ---- */
      container.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'pptx-wrap';
      container.appendChild(wrap);
      const previewer = pptxPreview.init(wrap, 920);
      await withTimeout(previewer.preview(buf), 30000, '幻灯片渲染');
    }
  } catch (e) {
    if (state.doc && state.doc.id === 'preview-' + file.id) {
      container.innerHTML = '<div class="preview-error">预览失败：' + e.message + '</div>';
    }
  }
}

/* ---------------- 编辑器外壳 ---------------- */
function showEditorMode(mode) {
  $('editorOverlay').classList.remove('hidden');
  // 三个面板互斥显示（.hidden 规则保证其他面板真正隐藏）
  $('plainBody').classList.toggle('hidden', mode !== 'plain');
  $('richBody').classList.toggle('hidden', mode !== 'rich');
  $('previewBody').classList.toggle('hidden', mode !== 'preview');
  $('sheetTabs').classList.add('hidden');
  // 预览模式不显示“同步状态”和成员头像（那是协同编辑专属的）
  $('saveState').classList.toggle('hidden', mode === 'preview');
  $('editorUsers').classList.toggle('hidden', mode === 'preview');
  if (mode !== 'preview') $('editorTitle').textContent = state.doc.name || '文档';
  $('saveState').textContent = '已同步';
}

function closeEditor() {
  $('editorOverlay').classList.add('hidden');
  if (state.doc && state.doc.mode === 'rich' && state.doc.dirtyLocal) saveDocxBack();
  if (state.doc && state.doc.mode !== 'preview') {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'cursor', docId: state.doc.id, pos: -1 }));
  }
  clearTimeout(docxSaveTimer);
  state.doc = null;
  $('previewContainer').innerHTML = '';
}
$('closeEditor').addEventListener('click', closeEditor);

function renderDocUsers() {
  if (!state.doc) return;
  const box = $('editorUsers');
  box.textContent = '';
  for (const [uid, u] of state.doc.clients) {
    const av = document.createElement('span');
    av.className = 'user-avatar';
    av.style.background = u.color;
    av.title = uid === state.myId ? u.name + '（我）' : u.name;
    av.textContent = u.name.slice(0, 1).toUpperCase();
    box.appendChild(av);
  }
  if (state.doc.mode !== 'preview') $('editorTitle').textContent = state.doc.name || '文档';
}

/* ---------------- 文件操作 ---------------- */
$('pickBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => {
  uploadFiles([...$('fileInput').files]);
  $('fileInput').value = '';
});

const dz = $('dropzone');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', e => uploadFiles([...e.dataTransfer.files]));
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

/* ---------------- 传输进度面板（发送 ⬆ / 接收 ⬇ 共用） ---------------- */
function transferPanel() {
  const list = $('uploadList');
  list.classList.remove('hidden');
  if (!list.querySelector('.upload-title')) {
    const t = document.createElement('div');
    t.className = 'upload-title';
    t.textContent = '传输进度';
    list.insertBefore(t, list.firstChild);
  }
  return list;
}
function ensurePanelClosed() {
  const list = $('uploadList');
  if (list.querySelector('.upload-item')) return;
  list.classList.add('hidden');
  const t = list.querySelector('.upload-title');
  if (t) t.remove();
}
/** 新建一条传输记录，返回操作句柄 */
function newTransferItem(dir, name, size) {
  const list = transferPanel();
  const item = document.createElement('div');
  item.className = 'upload-item';

  const line = document.createElement('div');
  line.className = 'up-line';
  const nameEl = document.createElement('div');
  nameEl.className = 'up-name';
  nameEl.textContent = `${dir === 'up' ? '⬆ 发送' : '⬇ 接收'} ${name}`;
  nameEl.title = name;
  const sizeEl = document.createElement('div');
  sizeEl.className = 'up-size';
  sizeEl.textContent = `0 / ${fmtSize(size)}`;
  line.appendChild(nameEl);
  line.appendChild(sizeEl);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  bar.appendChild(fill);

  item.appendChild(line);
  item.appendChild(bar);
  list.appendChild(item);

  const removeLater = (ms) => setTimeout(() => { item.remove(); ensurePanelClosed(); }, ms);
  return {
    item,
    setProgress(loaded, total) {
      const pct = total > 0 ? Math.min(100, Math.floor(loaded / total * 100)) : 0;
      fill.style.width = pct + '%';
      sizeEl.textContent = `${fmtSize(loaded)} / ${fmtSize(total)} · ${pct}%`;
    },
    setDone(keepMs = 2500) {
      fill.style.width = '100%';
      sizeEl.textContent = `${fmtSize(size)} / ${fmtSize(size)} · 100% · 完成`;
      nameEl.textContent = `✓ ${dir === 'up' ? '已发送' : '已接收'} ${name}`;
      item.classList.add('done');
      removeLater(keepMs);
    },
    setFail(msg, keepMs = 6000) {
      nameEl.textContent = `✗ ${name} 失败：${msg}`;
      item.classList.add('fail');
      removeLater(keepMs);
    },
    removeLater,
  };
}

async function uploadFiles(files) {
  for (const f of files) {
    const t = newTransferItem('up', f.name, f.size);
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(f.name));
        xhr.setRequestHeader('X-Uploader', encodeURIComponent(state.myName));
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) t.setProgress(e.loaded, e.total);
        };
        xhr.onload = () => {
          if (xhr.status === 200) {
            t.setDone();
            const ext = getExt(f.name);
            if (ext === 'docx') toast(`「${f.name}」已上传，可预览或多人协同编辑`);
            else if (['xlsx', 'xls', 'pptx', 'csv', 'pdf'].includes(ext) || IMG_EXTS.includes(ext)) toast(`「${f.name}」已上传，点击小鱼即可预览`);
            loadInfo();
            resolve();
          } else { reject(new Error('HTTP ' + xhr.status)); }
        };
        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.send(f);
      });
    } catch (err) {
      t.setFail(err.message);
    }
  }
}

/* 接收（下载）：流式读取，实时显示进度条 */
async function downloadFile(file) {
  const t = newTransferItem('down', file.name, file.size);
  try {
    const res = await fetch('/api/download?id=' + file.id);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('Content-Length')) || file.size || 0;
    let blob;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        t.setProgress(loaded, total);
      }
      blob = new Blob(chunks);
    } else {
      blob = await res.blob();
      t.setProgress(total, total);
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    t.setDone();
  } catch (e) {
    t.setFail(e.message);
  }
}

function renderFiles(files) {
  const table = $('fileTable');
  table.textContent = '';
  if (!files.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = '还没有文件，发送一个试试吧';
    table.appendChild(div);
    return;
  }
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'file-row';

    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.textContent = fileIcon(f.name);

    const main = document.createElement('div');
    main.className = 'file-main';
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = f.name;
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.textContent = `${fmtSize(f.size)} · ${f.uploader} · ${fmtTime(f.time)}`;
    main.appendChild(name);
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const ext = getExt(f.name);
    if (ext === 'docx' && f.size < 20 * 1024 * 1024) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn';
      editBtn.textContent = '协同编辑';
      editBtn.onclick = () => openOfficeDoc(f.id, f.name);
      actions.appendChild(editBtn);
      const pvBtn = document.createElement('button');
      pvBtn.className = 'btn';
      pvBtn.textContent = '预览';
      pvBtn.onclick = () => previewFile(f);
      actions.appendChild(pvBtn);
    } else if (PREVIEW_EXTS.includes(ext) && f.size < 100 * 1024 * 1024) {
      const pvBtn = document.createElement('button');
      pvBtn.className = 'btn';
      pvBtn.textContent = '预览';
      pvBtn.onclick = () => previewFile(f);
      actions.appendChild(pvBtn);
    } else if (isEditableName(f.name) && f.size < 2 * 1024 * 1024) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn';
      editBtn.textContent = '协同编辑';
      editBtn.onclick = () => openDoc('f-' + f.id, f.name);
      actions.appendChild(editBtn);
    }
    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn';
    dlBtn.textContent = '下载';
    dlBtn.onclick = () => downloadFile(f);
    actions.appendChild(dlBtn);
    const delBtn = document.createElement('button');
    delBtn.className = 'btn danger';
    delBtn.textContent = '删除';
    delBtn.onclick = async () => {
      if (!confirm(`确定删除「${f.name}」吗？`)) return;
      await fetch('/api/file?id=' + f.id, { method: 'DELETE' });
      loadInfo();
    };
    actions.appendChild(delBtn);

    row.appendChild(icon);
    row.appendChild(main);
    row.appendChild(actions);
    table.appendChild(row);
  }
}

/* ---------------- 文档列表 ---------------- */
$('newDocBtn').addEventListener('click', async () => {
  const name = prompt('文档名称：', '未命名文档');
  if (name === null) return;
  const r = await fetch('/api/docs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() || '未命名文档' }),
  }).then(x => x.json());
  if (r.ok) { await loadInfo(); openDoc(r.docId); }
});

function renderDocs(docs) {
  const list = $('docList');
  list.textContent = '';
  if (!docs.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = '暂无协同文档';
    list.appendChild(div);
    return;
  }
  for (const d of docs) {
    const li = document.createElement('li');
    li.className = 'doc-item';
    const name = document.createElement('span');
    name.className = 'doc-name';
    name.textContent = '📝 ' + d.name;
    name.onclick = () => openDoc(d.id, d.name);
    const meta = document.createElement('span');
    meta.className = 'doc-meta';
    meta.textContent = fmtSize(d.size);
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = '×';
    del.title = '删除文档';
    del.onclick = async () => {
      if (!confirm(`删除文档「${d.name}」？`)) return;
      await fetch('/api/docs/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId: d.id }),
      });
      loadInfo();
    };
    li.appendChild(name);
    li.appendChild(meta);
    li.appendChild(del);
    list.appendChild(li);
  }
}

/* ---------------- 成员 & 邀请 ---------------- */
function renderUsers() {
  const list = $('userList');
  list.textContent = '';
  if (!state.users.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = '暂无其他设备在线';
    list.appendChild(div);
    return;
  }
  for (const u of state.users) {
    const li = document.createElement('li');
    li.className = 'user-item';
    const av = document.createElement('span');
    av.className = 'user-avatar';
    av.style.background = u.color;
    av.textContent = u.name.slice(0, 1).toUpperCase();
    const name = document.createElement('span');
    name.textContent = u.id === state.myId ? u.name + '（我）' : u.name;
    li.appendChild(av);
    li.appendChild(name);
    list.appendChild(li);
  }
}

function renderInvite() {
  const box = $('invite');
  box.textContent = '';
  const info = state.info;
  if (!info || !info.ips.length) return;
  const tip = document.createElement('div');
  tip.textContent = `让同一局域网内的 Mac / Windows / 手机浏览器打开以下地址，即可连接（服务端：${info.host}）：`;
  box.appendChild(tip);
  const add = (label, url) => {
    const code = document.createElement('code');
    code.textContent = `${label}  ${url}`;
    code.title = '点击复制';
    code.onclick = () => {
      navigator.clipboard.writeText(url).then(() => toast('已复制'));
    };
    box.appendChild(code);
  };
  for (const ip of info.ips) add('➜', `http://${ip}:${info.port}`);
}

/* ---------------- 初始化 ---------------- */
async function loadInfo() {
  try {
    const r = await fetch('/api/info').then(x => x.json());
    state.info = r;
    $('hostInfo').textContent = `服务端：${r.host}`;
    renderFiles(r.files);
    FishPond.update(r.files);
    renderDocs(r.docs);
    renderInvite();
  } catch (e) {
    $('hostInfo').textContent = '无法连接服务器，请确认 server 正在运行';
  }
}

/* ---------------- 鱼池视图 & 视图切换 ---------------- */
FishPond.init($('pond'), { onOpen: openByType });
window.__onPondDrop = (files) => uploadFiles(files);

$('viewToggle').addEventListener('click', () => {
  const pondHidden = $('pondWrap').classList.toggle('hidden');
  $('listWrap').classList.toggle('hidden', !pondHidden);
  $('viewToggle').textContent = pondHidden ? '鱼池视图' : '列表视图';
});

connectWs();
loadInfo();
setInterval(loadInfo, 8000);
