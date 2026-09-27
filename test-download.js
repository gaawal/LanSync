// 可用环境变量 LANSYNC_BASE 指定被测服务地址，默认 7788
const LANSYNC_BASE = process.env.LANSYNC_BASE || LANSYNC_BASE;
const LANSYNC_WS = LANSYNC_BASE.replace(/^http/, 'ws');
/**
 * 下载（接收）进度测试：跑真实 app.js 的 downloadFile
 * 验证：进度实时更新（0 → N → 100%）、Blob 字节数与服务器一致、触发保存
 */
const fs = require('fs');
const path = require('path');
const BASE = LANSYNC_BASE;

/* ---------- DOM 桩 ---------- */
const created = [];
function makeEl(id) {
  const el = {
    id, value: '', textContent: '', title: '', className: '', hidden: false,
    style: {}, selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollLeft: 0,
    handlers: {}, children: [],
    addEventListener(ev, fn) { (el.handlers[ev] = el.handlers[ev] || []).push(fn); },
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(c) { el.children.push(c); return c; },
    insertBefore(c) { el.children.unshift(c); return c; },
    remove() {},
    querySelector(sel) {
      const cls = sel.replace('.', '');
      return el.children.find(c => (c.className || '').split(' ').includes(cls)) || null;
    },
    querySelectorAll: () => [],
    setSelectionRange() {}, focus() {},
    click() { el.clicked = true; },
  };
  created.push(el);
  return el;
}
const els = {};
const getEl = (id) => els[id] || (els[id] = makeEl(id));

global.document = {
  getElementById: getEl,
  body: { appendChild() {}, removeChild() {} },
  createElement: (tag) => makeEl(tag),
  createDocumentFragment: () => ({ appendChild() {} }),
  createTextNode: (t) => ({ text: t }),
};
global.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; } };
global.navigator = { userAgent: 'Windows', clipboard: { writeText: () => {} } };
global.location = { protocol: 'http:', host: LANSYNC_BASE.replace(/^https?:\/\//, '') };
global.window = { addEventListener() {} };
global.prompt = () => 'x'; global.confirm = () => true;
global.FishPond = { init() {}, update() {}, splash() {} };

const blobs = [];
global.URL.createObjectURL = (b) => { blobs.push(b); return 'blob:test-' + blobs.length; };
global.URL.revokeObjectURL = () => {};
const _fetch = global.fetch;
global.fetch = (u, o) => _fetch(typeof u === 'string' && u.startsWith('/') ? BASE + u : u, o);

/* ---------- 加载真实 app.js ---------- */
const code = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8')
  + '\n;global.__T = { downloadFile, getState: () => state };';
eval(code);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await sleep(600);
  /* 1) 上传一个 3MB 测试文件 */
  const size = 3 * 1024 * 1024;
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  const up = await _fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: { 'X-File-Name': encodeURIComponent('下载进度测试.bin'), 'X-Uploader': 'tester' },
    body: bytes,
  });
  if (up.status !== 200) throw new Error('上传测试文件失败 ' + up.status);
  const info = await _fetch(BASE + '/api/info').then(r => r.json());
  const meta = info.files.find(f => f.name === '下载进度测试.bin');
  console.log('测试文件:', meta.name, meta.size, 'B');

  /* 2) 调用真实 downloadFile（并行采样进度，验证过程中确实在更新） */
  const before = created.length;
  const samples = [];
  const dl = global.__T.downloadFile(meta);
  const timer = setInterval(() => {
    const s = created.slice(before).filter(e => e.className === 'up-size');
    const v = s.length ? s[s.length - 1].textContent : '';
    if (v && v !== samples[samples.length - 1]) samples.push(v);
  }, 5);
  await dl;
  clearInterval(timer);
  await sleep(300);
  console.log('进度采样(' + samples.length + ' 次):', samples.slice(0, 6).join(' → ') + (samples.length > 6 ? ' → …' : ''));

  /* 3) 读取进度元素文本（最后一条 .up-size 即本条传输记录） */
  const sizes = created.slice(before).filter(e => e.className === 'up-size');
  const names = created.slice(before).filter(e => e.className === 'up-name');
  const finalText = sizes.length ? sizes[sizes.length - 1].textContent : '(未找到)';
  const finalName = names.length ? names[names.length - 1].textContent : '(未找到)';
  console.log('进度文本:', finalText);
  console.log('条目文本:', finalName);

  const okProgress = /100%/.test(finalText) && /完成/.test(finalText);
  const okName = /^✓ 已接收/.test(finalName);
  const okBytes = blobs.length === 1 && blobs[0].size === meta.size;
  const anchor = created.slice(before).find(e => e.id === 'a' && e.clicked);
  const okSave = !!anchor && anchor.download === meta.name;

  console.log('接收进度到达 100%:', okProgress ? 'PASS ✅' : 'FAIL ❌');
  console.log('状态文案正确:', okName ? 'PASS ✅' : 'FAIL ❌');
  console.log('字节完整(' + (blobs[0] ? blobs[0].size : 0) + '/' + meta.size + '):', okBytes ? 'PASS ✅' : 'FAIL ❌');
  console.log('触发浏览器保存:', okSave ? 'PASS ✅' : 'FAIL ❌');

  /* 4) 清理测试文件 */
  const del = await _fetch(BASE + '/api/file?id=' + meta.id, { method: 'DELETE' });
  console.log('清理测试文件:', del.status === 200 ? 'OK' : 'HTTP ' + del.status);

  /* ---------- 场景 2：限速流，验证中途进度确实在刷新 ---------- */
  const total = 4 * 1024 * 1024, chunk = 1024 * 1024;
  global.fetch = (u, o) => {
    if (typeof u === 'string' && u.includes('/api/download')) {
      let sent = 0;
      const stream = new ReadableStream({
        start(controller) {
          const push = () => {
            if (sent >= total) return controller.close();
            controller.enqueue(new Uint8Array(chunk));
            sent += chunk;
            setTimeout(push, 80);
          };
          setTimeout(push, 80);
        },
      });
      return Promise.resolve(new Response(stream, { headers: { 'Content-Length': String(total) } }));
    }
    return _fetch(u, o);
  };
  const before2 = created.length;
  const samples2 = [];
  const dl2 = global.__T.downloadFile({ id: 'fake', name: '限速流测试.bin', size: total });
  const t2 = setInterval(() => {
    const s = created.slice(before2).filter(e => e.className === 'up-size');
    const v = s.length ? s[s.length - 1].textContent : '';
    if (v && v !== samples2[samples2.length - 1]) samples2.push(v);
  }, 10);
  await dl2;
  clearInterval(t2);
  console.log('限速流进度采样:', samples2.join(' → '));
  const midShown = samples2.some(s => /· (2[0-9]|3[0-9]|4[0-9]|5[0-9]|6[0-9]|7[0-9]|8[0-9])%/.test(s));
  console.log('中途百分比实时刷新:', midShown ? 'PASS ✅' : 'FAIL ❌');

  process.exit(okProgress && okName && okBytes && okSave && midShown ? 0 : 1);
})().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
