// 可用环境变量 LANSYNC_BASE 指定被测服务地址，默认 7788
const LANSYNC_BASE = process.env.LANSYNC_BASE || LANSYNC_BASE;
const LANSYNC_WS = LANSYNC_BASE.replace(/^http/, 'ws');
/**
 * 前端 app.js 端到端测试（Node + DOM 桩，跑真实前端代码）
 * 验证：
 *  1) 本地在编辑器输入 → op 发送到服务器 → 服务器文档内容更新
 *  2) 另一客户端发 op → 前端编辑器内容实时刷新（用户报告的 bug）
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

/* ---------- DOM 桩 ---------- */
function makeEl(id) {
  const el = {
    id, value: '', textContent: '', title: '', hidden: false,
    style: {}, selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollLeft: 0,
    handlers: {},
    addEventListener(ev, fn) { (el.handlers[ev] = el.handlers[ev] || []).push(fn); },
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, remove() {},
    setSelectionRange(s, e) { el.selectionStart = s; el.selectionEnd = e; },
    focus() {},
  };
  return el;
}
const els = {};
function getEl(id) { return els[id] || (els[id] = makeEl(id)); }

global.document = {
  getElementById: getEl,
  createElement: () => makeEl('dyn'),
  createDocumentFragment: () => ({ appendChild() {} }),
  createTextNode: (t) => ({ text: t }),
};
global.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; } };
global.navigator = { userAgent: 'Windows', clipboard: { writeText: () => {} } };
global.location = { protocol: 'http:', host: LANSYNC_BASE.replace(/^https?:\/\//, '') };
global.window = { addEventListener() {}, };
global.prompt = () => '前端E2E测试文档';
global.confirm = () => true;
const _fetch = global.fetch;
global.fetch = (url, opts) => _fetch(typeof url === 'string' && url.startsWith('/') ? LANSYNC_BASE + url : url, opts);

/* ---------- 加载真实 app.js ---------- */
global.FishPond = { init() {}, update() {}, splash() {} }; // 鱼池桩
const code = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8')
  + '\n;global.__T = { getState: () => state };';
eval(code);
const state = () => global.__T.getState();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await sleep(800); // 等 ws 连接 + hello
  if (!state().myId) throw new Error('ws 未连接 / 未收到 welcome');

  // 1) 通过「新建文档」按钮创建文档（走真实 UI 逻辑）
  getEl('newDocBtn').handlers.click[0]();
  await sleep(600);
  if (!state().doc) throw new Error('openDoc 未执行');
  console.log('docId =', state().doc.id);

  // 2) 模拟本地输入：设置 textarea 值并触发 input 事件
  const area = getEl('editorArea');
  area.value = '第一行: hello';
  area.handlers.input[0]();
  await sleep(500);
  area.value = '第一行: hello\n第二行: 世界';
  area.handlers.input[0]();
  await sleep(1500); // 等 ack + 自动保存

  // 服务器端持久化内容应包含输入的文本：
  // 用一条新连接重新 join 读回内容（不依赖服务端数据目录在哪台机器上，也能验证是真的落盘）
  const verifyWs = new WebSocket(LANSYNC_WS + '/ws');
  await new Promise(r => verifyWs.on('open', r));
  verifyWs.send(JSON.stringify({ type: 'hello', name: '落盘校验' }));
  await sleep(200);
  const verifyInit = await new Promise((resolve) => {
    verifyWs.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'init') resolve(m); });
    verifyWs.send(JSON.stringify({ type: 'join', docId: state().doc.id }));
  });
  verifyWs.close();
  const t1 = verifyInit.content.includes('第一行: hello') && verifyInit.content.includes('第二行: 世界');
  console.log('本地输入 → 服务器落盘:', t1 ? 'PASS ✅' : 'FAIL ❌ 内容=' + JSON.stringify(verifyInit.content));

  // 3) 模拟另一台设备（原始 ws 客户端）加入并插入文字
  const peer = new WebSocket(LANSYNC_WS + '/ws');
  await new Promise(r => peer.on('open', r));
  peer.send(JSON.stringify({ type: 'hello', name: '另一台设备' }));
  await sleep(200);
  const init = await new Promise((resolve) => {
    peer.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'init') resolve(m); });
    peer.send(JSON.stringify({ type: 'join', docId: state().doc.id }));
  });
  peer.send(JSON.stringify({
    type: 'op', docId: state().doc.id,
    op: { t: 'i', p: 0, c: '[远端设备输入] ', uid: 'peer-1' },
    version: init.version,
  }));
  await sleep(800);

  // 4) 关键验证：前端编辑器 textarea 是否刷新出远端内容
  const refreshed = area.value.startsWith('[远端设备输入] ');
  console.log('远端操作 → 本地编辑器实时刷新:', refreshed ? 'PASS ✅' : 'FAIL ❌ 编辑器内容=' + JSON.stringify(area.value));

  peer.close();
  // 清理测试文档（等响应落地再退出，避免请求未完成）
  try {
    const docId = state().doc.id;
    const r = await fetch('/api/docs/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docId }) });
    console.log('清理测试文档', docId, r.status);
    try { fs.unlinkSync(path.join(__dirname, 'shared', 'docs', docId + '.json')); } catch (e) {}
    await sleep(300);
  } catch (e) { console.error('清理失败:', e.message); }
  process.exit(t1 && refreshed ? 0 : 1);
})().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
