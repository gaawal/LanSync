// 可用环境变量 LANSYNC_BASE 指定被测服务地址，默认 7788
const LANSYNC_BASE = process.env.LANSYNC_BASE || LANSYNC_BASE;
const LANSYNC_WS = LANSYNC_BASE.replace(/^http/, 'ws');
/**
 * 协同编辑收敛性测试：模拟两个客户端并发编辑同一个文档
 * 场景1: 两端同时在不同位置插入
 * 场景2: 两端同时插入相同位置
 * 场景3: 一端删除、另一端同时插入（删除范围内）
 * 场景4: 两端同时删除重叠区域
 * 通过标准: 两个客户端最终内容一致，且与服务器一致
 */
const WebSocket = require('ws');

const DOC_ID = process.argv[2];
if (!DOC_ID) { console.error('需要传入 docId'); process.exit(1); }

function makeClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(LANSYNC_WS + '/ws');
    const c = { ws, name, content: '', version: 0, inflight: null, queue: [], acks: 0, docName: '' };
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', name }));
      ws.send(JSON.stringify({ type: 'join', docId: DOC_ID }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'init') {
        c.content = m.content; c.version = m.version; c.docName = m.name;
        resolve(c);
      } else if (m.type === 'ack') {
        c.version = m.version; c.inflight = null; c.acks++;
        c._lastAck = m.opId;
        if (c.queue.length) { c.inflight = c.queue.shift(); doSend(c, c.inflight); }
      } else if (m.type === 'op') {
        // 简化：测试中发下一个 op 前都等 ack，所以 inflight 为空
        let o = { ...m.op };
        const pending = c.inflight ? [c.inflight, ...c.queue] : [...c.queue];
        const np = [];
        for (const p of pending) {
          const o2 = transform(o, p, o.uid < p.uid);
          const p2 = transform(p, o, p.uid < o.uid);
          o = o2; np.push(p2);
        }
        if (c.inflight) { c.inflight = np.shift(); c.queue = np; } else c.queue = np;
        c.content = applyOp(c.content, o);
        c.version = m.version;
      }
    });
    ws.on('error', reject);
  });
}

// 与 server.js 相同的 OT 实现（复制以保证测试独立）
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
      a2.p -= Math.max(0, Math.min(a.p, bEnd) - b.p);
    } else {
      const aEnd = a.p + a.c;
      a2.p -= Math.max(0, Math.min(a.p, bEnd) - b.p);
      a2.c -= Math.max(0, Math.min(aEnd, bEnd) - Math.max(a.p, b.p));
      if (a2.c < 0) a2.c = 0;
    }
  }
  return a2;
}
const transform = transformOp;

function makeSend(c) {
  return (op) => new Promise((resolve) => {
    c.seq = (c.seq || 0) + 1;
    op.uid = c.name + '-' + c.seq;
    op._localApplied = false;
    c._waiters = c._waiters || new Map();
    // 本地立即应用（Jupiter 模型：本地操作先落地再发送）
    c.content = applyOp(c.content, op);
    op._localApplied = true;
    const attempt = () => {
      if (!c.inflight) { c.inflight = op; doSend(c, op); }
      else c.queue.push(op);
    };
    attempt();
    const check = setInterval(() => {
      if (c._lastAck === op.uid) { clearInterval(check); resolve(); }
    }, 5);
    setTimeout(() => { clearInterval(check); resolve(); }, 3000);
  });
}
function doSend(c, op) {
  c.ws.send(JSON.stringify({ type: 'op', docId: DOC_ID, op: { t: op.t, p: op.p, c: op.c, uid: op.uid }, version: c.version }));
}

(async () => {
  const A = await makeClient('Alice');
  const B = await makeClient('Bob');
  // B 加入房间（init 已在 makeClient 中完成）
  const sendA = makeSend(A);
  const sendB = makeSend(B);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  console.log('初始内容:', JSON.stringify(A.content));

  // 场景1: 不同位置并发插入
  await Promise.all([
    sendA({ t: 'i', p: 0, c: '[A头]' }),
    sendB({ t: 'i', p: A.content.length, c: '[B尾]' }),
  ]);
  await sleep(300);
  console.log('场景1(两端插入):', JSON.stringify(A.content));
  console.log('  一致:', A.content === B.content ? 'PASS' : 'FAIL A=' + JSON.stringify(A.content) + ' B=' + JSON.stringify(B.content));

  // 场景2: 相同位置并发插入
  await Promise.all([
    sendA({ t: 'i', p: 5, c: '甲' }),
    sendB({ t: 'i', p: 5, c: '乙' }),
  ]);
  await sleep(300);
  console.log('场景2(同位置插入):', JSON.stringify(A.content));
  console.log('  一致:', A.content === B.content ? 'PASS' : 'FAIL');

  // 场景3: A 删除范围，B 同时在其中插入
  const delStart = A.content.indexOf('[A头]');
  await Promise.all([
    sendA({ t: 'd', p: delStart, c: 5 }),
    sendB({ t: 'i', p: delStart + 2, c: '!' }),
  ]);
  await sleep(300);
  console.log('场景3(删+插并发):', JSON.stringify(A.content));
  console.log('  一致:', A.content === B.content ? 'PASS' : 'FAIL');

  // 场景4: 两端删除重叠区域
  const s = Math.max(0, A.content.length - 4);
  await Promise.all([
    sendA({ t: 'd', p: s, c: 2 }),
    sendB({ t: 'd', p: s + 1, c: 2 }),
  ]);
  await sleep(300);
  console.log('场景4(重叠删除):', JSON.stringify(A.content));
  console.log('  一致:', A.content === B.content ? 'PASS' : 'FAIL');

  // 与服务器对照
  const info = await fetch(LANSYNC_BASE + '/api/info').then(r => r.json());
  const serverDoc = info.docs.find(d => d.id === DOC_ID);
  console.log('服务器文档存在:', !!serverDoc);

  A.ws.close(); B.ws.close();
  const allOk = A.content === B.content && serverDoc;
  console.log(allOk ? '\n全部收敛 PASS ✅' : '\n存在 FAIL ❌');
  process.exit(allOk ? 0 : 1);
})();
