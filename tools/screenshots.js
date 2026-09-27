/**
 * 生成 README 里的界面截图。
 *
 * 前置：
 *   1. 准备一份演示数据并用它启动服务：
 *        python tools/make-demo-data.py .demo
 *        cd .demo && PORT=7790 node ../server.js
 *   2. 安装截图依赖（不需要下载浏览器，复用本机 Chrome）：
 *        npm install --no-save puppeteer-core
 *
 * 运行：
 *   LANSYNC_BASE=http://localhost:7790 node tools/screenshots.js
 *
 * 环境变量：
 *   LANSYNC_BASE  被测服务地址，默认 http://localhost:7788
 *   SHOT_OUT      输出目录，默认 <仓库>/docs/screenshots
 *   CHROME_PATH   浏览器路径，默认自动探测 Chrome / Edge
 */
const fs = require('fs');
const path = require('path');

let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  console.error('缺少依赖：请先执行  npm install --no-save puppeteer-core');
  process.exit(1);
}

const BASE = process.env.LANSYNC_BASE || 'http://localhost:7788';
const OUT = process.env.SHOT_OUT || path.join(__dirname, '..', 'docs', 'screenshots');
const PORT = new URL(BASE).port || '80';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error('没找到 Chrome / Edge，可用 CHROME_PATH 指定浏览器路径');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none', '--lang=zh-CN'],
    defaultViewport: { width: 1400, height: 880, deviceScaleFactor: 1.5 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[页面 JS 错误]', e.message));

  // 让“我”显示成一个真实的人名
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('lansync-name', 'Windows · 项目组');
  });
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await sleep(1500);

  const shot = async (name) => {
    const p = path.join(OUT, name);
    await page.screenshot({ path: p });
    console.log('  ✓', name, (fs.statSync(p).size / 1024).toFixed(0) + 'KB');
  };

  /* 固定两台“其它设备”的连接，后面复用它们加入文档，避免成员列表出现重复项 */
  await page.evaluate(() => {
    window.__peers = [];
    const make = (name) => {
      const ws = new WebSocket('ws://' + location.host + '/ws');
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', name }));
      window.__peers.push(ws);
    };
    make('MacBook Pro · 小林');
    make('iPad · 阿 May');
    window.__peerSend = (i, msg) => {
      const ws = window.__peers[i];
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    };
  });
  await sleep(1200);

  const open = async (name, fn) => {
    await page.evaluate(
      async (name, fn) => {
        const info = await fetch('/api/info').then((r) => r.json());
        const f = info.files.find((x) => x.name === name);
        if (!f) throw new Error('演示文件不存在: ' + name + '（先执行 tools/make-demo-data.py）');
        window[fn](f);
      },
      name,
      fn
    );
  };
  const back = async () => {
    await page.evaluate(() => document.getElementById('closeEditor').click());
    await sleep(600);
  };

  console.log('生成截图 →', OUT, '（服务端:', BASE, '）');

  /* 1) 鱼池视图 */
  await shot('01-pond.png');

  /* 2) 列表视图 */
  await page.evaluate(() => document.getElementById('viewToggle').click());
  await sleep(700);
  await shot('02-list-view.png');
  await page.evaluate(() => document.getElementById('viewToggle').click());
  await sleep(600);

  /* 3) 图片预览 */
  await open('团队合影.png', 'openByType');
  await sleep(1800);
  await shot('03-preview-image.png');
  await back();

  /* 4) 表格预览（xlsx，多 Sheet） */
  await open('项目排期.xlsx', 'openByType');
  await sleep(2000);
  await shot('04-preview-xlsx.png');
  await back();

  /* 5) Word 预览 */
  await open('产品设计方案.docx', 'openByType');
  await sleep(3000);
  await shot('05-preview-docx.png');
  await back();

  /* 6) Word 协同编辑（另一台设备同时在线） */
  const docxFile = await page.evaluate(async () => {
    const info = await fetch('/api/info').then((r) => r.json());
    return info.files.find((x) => x.name === '产品设计方案.docx');
  });
  await page.evaluate((f) => window.openOfficeDoc(f.id, f.name), docxFile);
  await sleep(3500);
  await page.evaluate((id) => window.__peerSend(0, { type: 'join', docId: 'o-' + id }), docxFile.id);
  await sleep(1600);
  await shot('06-collab-docx.png');
  await back();

  /* 7) 纯文本协同编辑（Markdown，含对方的彩色光标与名字） */
  const mdFile = await page.evaluate(async () => {
    const info = await fetch('/api/info').then((r) => r.json());
    return info.files.find((x) => x.name === '会议纪要.md');
  });
  await page.evaluate((f) => window.openByType(f), mdFile);
  await sleep(1500);
  await page.evaluate((id) => {
    window.__peerSend(0, { type: 'join', docId: 'f-' + id });
    setTimeout(() => window.__peerSend(0, { type: 'cursor', docId: 'f-' + id, pos: 9 }), 500);
  }, mdFile.id);
  await sleep(1200);
  await page.evaluate(() => {
    const ta = document.getElementById('editorArea');
    ta.focus();
    ta.setSelectionRange(13, 13);
    ta.dispatchEvent(new Event('select'));
  });
  await sleep(900);
  await shot('07-collab-text.png');
  await back();

  /* 8) 传输进度（限速上传，让进度条停在中间才看得到） */
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 80,
    downloadThroughput: 128 * 1024,
    uploadThroughput: 22 * 1024,
  });
  await page.evaluate(async () => {
    const blob = new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'video/quicktime' });
    const f = new File([blob], '屏幕录制 2026-09-27.mov', { type: 'video/quicktime' });
    window.uploadFiles([f]);
  });
  await sleep(6000);
  await shot('08-transfer-progress.png');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  await sleep(400);
  await page.evaluate(() => (window.__peers || []).forEach((w) => w.close()));
  await browser.close();
  console.log('完成（服务端 ' + PORT + ' 上的演示数据不会被删除，仅多出一个上传测试文件）');
})().catch((e) => {
  console.error('截图失败:', e.message);
  process.exit(1);
});
