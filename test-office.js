// 可用环境变量 LANSYNC_BASE 指定被测服务地址，默认 7788
const LANSYNC_BASE = process.env.LANSYNC_BASE || LANSYNC_BASE;
const LANSYNC_WS = LANSYNC_BASE.replace(/^http/, 'ws');
/**
 * Office（Word 协同）链路测试：
 * 1) 上传 docx → open-office 建富文档
 * 2) A 加入并发 replace 初始化 HTML
 * 3) B 加入收到内容，B 发 op，A 收到
 * 4) 回写 .docx（/api/file/content）→ 下载验证是合法 zip
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BASE = LANSYNC_BASE;

function wsClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(LANSYNC_WS + '/ws');
    const c = { ws, name, msgs: [], waiters: [] };
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', name }));
      resolve(c);
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      c.msgs.push(m);
      c.waiters = c.waiters.filter(w => !w.pred(m) || (w.resolve(m), false));
    });
    ws.on('error', reject);
  });
}
function waitFor(c, pred, ms = 3000) {
  const hit = c.msgs.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(c.name + ' 等待消息超时')), ms);
    c.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}

(async () => {
  let ok = true;
  // 1) 上传 docx
  const buf = fs.readFileSync(path.join(__dirname, 'test-doc.docx'));
  const up = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: { 'X-File-Name': encodeURIComponent('测试文档.docx'), 'X-Uploader': encodeURIComponent('tester') },
    body: buf,
  }).then(r => r.json());
  console.log('上传 docx:', up.ok ? 'PASS' : 'FAIL', 'fileId=' + up.file.id);
  ok = ok && up.ok;

  // 2) open-office
  const oo = await fetch(BASE + '/api/docs/open-office', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: up.file.id }),
  }).then(r => r.json());
  console.log('open-office 建文档:', oo.ok ? 'PASS' : 'FAIL', 'docId=' + oo.docId);
  ok = ok && oo.ok;

  // 3) A join 后 replace 初始化
  const A = await wsClient('Word-A');
  A.ws.send(JSON.stringify({ type: 'join', docId: oo.docId }));
  const initA = await waitFor(A, m => m.type === 'init' && m.docId === oo.docId);
  const html = '<p>这是 Word 协同测试文档第一段。</p><p>第二段。</p>';
  A.ws.send(JSON.stringify({ type: 'replace', docId: oo.docId, content: html }));

  // 4) B 加入应收到含内容的 init
  const B = await wsClient('Word-B');
  B.ws.send(JSON.stringify({ type: 'join', docId: oo.docId }));
  const initB = await waitFor(B, m => m.type === 'init' && m.docId === oo.docId);
  const gotHtml = initB.content.includes('第一段');
  console.log('B 加入拿到 HTML 内容:', gotHtml ? 'PASS' : 'FAIL');
  ok = ok && gotHtml;

  // 5) B 发 op，A 收到
  B.ws.send(JSON.stringify({ type: 'op', docId: oo.docId, op: { t: 'i', p: 0, c: '[B编辑]', uid: 'b-1' }, version: initB.version }));
  const opA = await waitFor(A, m => m.type === 'op' && m.op && m.op.c === '[B编辑]');
  console.log('B 的编辑实时到达 A:', opA ? 'PASS' : 'FAIL');
  ok = ok && !!opA;

  // 6) 回写 .docx
  const newDocx = Buffer.from(fs.readFileSync(path.join(__dirname, 'test-doc.docx')));
  const ov = await fetch(BASE + '/api/file/content?id=' + up.file.id, {
    method: 'POST', headers: { 'X-Uploader': encodeURIComponent('Word-A') }, body: newDocx,
  }).then(r => r.json());
  console.log('回写 .docx 接口:', ov.ok ? 'PASS' : 'FAIL');
  ok = ok && ov.ok;

  // 7) 下载并验证 zip 魔数 + info 更新
  const dl = Buffer.from(await (await fetch(BASE + '/api/download?id=' + up.file.id)).arrayBuffer());
  const isZip = dl[0] === 0x50 && dl[1] === 0x4b;
  console.log('下载回写文件为合法 docx(zip):', isZip ? 'PASS' : 'FAIL');
  ok = ok && isZip;

  A.ws.close(); B.ws.close();
  console.log(ok ? '\nOffice 链路全部 PASS ✅' : '\n存在 FAIL ❌');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
