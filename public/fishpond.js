/* FishPond —— 俯视鱼池视图：每个文件是一条游动的小鱼 */
'use strict';

const FishPond = (() => {
  let canvas = null, ctx = null;
  let fishes = [];      // {file, x, y, angle, speed, targetSpeed, size, color, phase, scared, vx, vy}
  let ripples = [];     // {x, y, r, alpha}
  let bubbles = [];
  let hoverFish = null;
  let onOpen = null;    // 双击回调 (file)
  let W = 0, H = 0, dpr = 1;
  let mouse = { x: -999, y: -999 };
  let running = false;

  const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
  const TYPE_COLOR = {
    docx: '#4f6ef7', doc: '#4f6ef7', wps: '#4f6ef7',
    xlsx: '#10b981', xls: '#10b981', csv: '#0d9488',
    pptx: '#f59e0b', ppt: '#f59e0b',
    pdf: '#ef4444',
    md: '#8b5cf6', markdown: '#8b5cf6', txt: '#64748b',
    zip: '#a16207', rar: '#a16207', '7z': '#a16207',
    mp4: '#e879f9', mov: '#e879f9', mkv: '#e879f9',
    mp3: '#c084fc', wav: '#c084fc', flac: '#c084fc',
    js: '#0ea5e9', ts: '#0ea5e9', py: '#0ea5e9', json: '#0ea5e9', html: '#0ea5e9', css: '#0ea5e9',
  };

  function colorFor(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (IMG_EXTS.includes(ext)) return '#a855f7';
    return TYPE_COLOR[ext] || '#64748b';
  }

  function radiusFor(file) {
    const kb = Math.max(1, file.size / 1024);
    return 14 + Math.min(20, Math.log10(kb + 1) * 9); // 14 ~ 34px
  }

  // 挑一个尽量远离其它鱼的位置（避免挤成一堆、标签互相压字）
  function pickSpot() {
    let best = { x: 60 + Math.random() * Math.max(10, W - 120), y: 60 + Math.random() * Math.max(10, H - 120) };
    let bestD = -1;
    for (let i = 0; i < 24; i++) {
      const x = 60 + Math.random() * Math.max(10, W - 120);
      const y = 60 + Math.random() * Math.max(10, H - 120);
      let d = Infinity;
      for (const f of fishes) d = Math.min(d, Math.hypot(x - f.x, y - f.y));
      if (d > bestD) { bestD = d; best = { x, y }; }
      if (bestD > 160) break;
    }
    return best;
  }

  function spawn(file, at) {
    const spot = at || pickSpot();
    const f = {
      file,
      x: spot.x,
      y: spot.y,
      angle: Math.random() * Math.PI * 2,
      speed: 20 + Math.random() * 25,
      targetSpeed: 20 + Math.random() * 25,
      size: radiusFor(file),
      color: colorFor(file.name),
      phase: Math.random() * Math.PI * 2,
      scared: 0,
      vx: 0, vy: 0,
    };
    fishes.push(f);
    ripples.push({ x: f.x, y: f.y, r: 4, alpha: 0.9 });
    return f;
  }

  function update(newFiles) {
    // 先量画布：否则新鱼会全部随机落在左上角一小块区域
    if (!W || !H) { try { resize(); } catch (e) {} }
    const byId = new Map(fishes.map(f => [f.file.id, f]));
    const seen = new Set();
    for (const file of newFiles) {
      seen.add(file.id);
      if (!byId.has(file.id)) spawn(file);
      else byId.get(file.id).file = file; // 刷新大小等元数据
    }
    fishes = fishes.filter(f => seen.has(f.file.id));
    ensureRunning();
  }

  function splash(x, y) { ripples.push({ x, y, r: 4, alpha: 0.9 }); }

  /* ---------- 行为 ---------- */
  function stepFish(f, dt) {
    f.phase += dt * (2 + f.speed * 0.08);
    // 受惊逃跑
    if (f.scared > 0) {
      f.scared -= dt;
      f.speed = 150;
    } else {
      f.speed += (f.targetSpeed - f.speed) * dt * 0.8;
      if (Math.random() < dt * 0.4) f.targetSpeed = 12 + Math.random() * 35;
      if (Math.random() < dt * 0.3) f.angle += (Math.random() - 0.5) * 1.2;
    }
    // 边缘回避：靠近边界时转向中心
    const m = f.size + 24;
    if (f.x < m || f.x > W - m || f.y < m || f.y > H - m) {
      const toC = Math.atan2(H / 2 - f.y, W / 2 - f.x);
      let diff = toC - f.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      f.angle += diff * Math.min(1, dt * 4);
      // 兜底：越界拉回
      f.x = Math.max(f.size, Math.min(W - f.size, f.x));
      f.y = Math.max(f.size, Math.min(H - f.size, f.y));
    }
    // 鱼与鱼轻微分离，避免叠成一团
    for (const o of fishes) {
      if (o === f) continue;
      const dx = f.x - o.x, dy = f.y - o.y;
      const d2 = dx * dx + dy * dy;
      const min = f.size + o.size;
      if (d2 > 0.01 && d2 < min * min) {
        const d = Math.sqrt(d2);
        f.x += (dx / d) * (min - d) * dt * 2.5;
        f.y += (dy / d) * (min - d) * dt * 2.5;
      }
    }
    f.x += Math.cos(f.angle) * f.speed * dt;
    f.y += Math.sin(f.angle) * f.speed * dt;
  }

  /* ---------- 绘制 ---------- */
  function drawWater() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#dcedff');
    g.addColorStop(1, '#b8d9f5');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // 缓动的光带
    const t = performance.now() / 1000;
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 3; i++) {
      const yy = ((t * 12 + i * H / 3) % (H + 120)) - 60;
      ctx.beginPath();
      ctx.ellipse(W * 0.5, yy, W * 0.55, 34, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // 气泡
    if (Math.random() < 0.02 && bubbles.length < 24) {
      bubbles.push({ x: Math.random() * W, y: H + 10, r: 1.5 + Math.random() * 3, v: 18 + Math.random() * 26 });
    }
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    for (const b of bubbles) {
      b.y -= b.v * 0.016;
      b.x += Math.sin(b.y * 0.05) * 0.3;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    bubbles = bubbles.filter(b => b.y > -10);
  }

  function drawFish(f) {
    const s = f.size;
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.angle);
    // 阴影
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#1e3a5f';
    ctx.beginPath();
    ctx.ellipse(1, 3, s, s * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    // 尾巴（摆动）
    const wag = Math.sin(f.phase * 3) * 0.45;
    ctx.fillStyle = f.color;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(-s * 0.75, 0);
    ctx.lineTo(-s * 1.5, Math.tan(wag) * s * 0.9 - s * 0.55);
    ctx.lineTo(-s * 1.35, Math.tan(wag) * s * 0.9);
    ctx.lineTo(-s * 1.5, Math.tan(wag) * s * 0.9 + s * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    // 身体
    const grad = ctx.createLinearGradient(0, -s * 0.6, 0, s * 0.6);
    grad.addColorStop(0, f.color);
    grad.addColorStop(1, shade(f.color, -28));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, 0, s, s * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
    // 背鳍
    ctx.beginPath();
    ctx.moveTo(-s * 0.3, -s * 0.55);
    ctx.quadraticCurveTo(0, -s * 1.05, s * 0.35, -s * 0.5);
    ctx.closePath();
    ctx.fill();
    // 高光
    ctx.fillStyle = 'rgba(255,255,255,.28)';
    ctx.beginPath();
    ctx.ellipse(s * 0.1, -s * 0.22, s * 0.52, s * 0.24, -0.2, 0, Math.PI * 2);
    ctx.fill();
    // 眼睛
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(s * 0.58, -s * 0.1, s * 0.11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(s * 0.62, -s * 0.14, s * 0.045, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // 悬停高亮圈
    if (f === hoverFish) {
      ctx.strokeStyle = f.color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(f.x, f.y, s * 1.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }
    // 名字标签
    ctx.font = '11px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    const label = f.file.name.length > 16 ? f.file.name.slice(0, 15) + '…' : f.file.name;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(255,255,255,.82)';
    roundRect(f.x - tw / 2 - 5, f.y + s * 0.75, tw + 10, 16, 8);
    ctx.fill();
    ctx.fillStyle = '#334155';
    ctx.fillText(label, f.x, f.y + s * 0.75 + 12);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function shade(hex, pct) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) + pct, g = ((n >> 8) & 255) + pct, b = (n & 255) + pct;
    r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }

  function drawRipples(dt) {
    ripples = ripples.filter(r => r.alpha > 0.02);
    for (const r of ripples) {
      r.r += 60 * dt;
      r.alpha -= dt * 0.9;
      ctx.strokeStyle = 'rgba(255,255,255,' + Math.max(0, r.alpha).toFixed(3) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  /* ---------- 交互 ---------- */
  function hitTest(x, y) {
    let best = null, bestD = Infinity;
    for (const f of fishes) {
      const d = Math.hypot(x - f.x, y - f.y);
      if (d < f.size * 1.35 && d < bestD) { best = f; bestD = d; }
    }
    return best;
  }

  function bindEvents() {
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      hoverFish = hitTest(mouse.x, mouse.y);
      canvas.style.cursor = hoverFish ? 'pointer' : 'default';
    });
    canvas.addEventListener('mouseleave', () => { hoverFish = null; mouse.x = -999; mouse.y = -999; });
    // 单击小鱼 = 打开（预览 / 协同办公）
    canvas.addEventListener('click', () => {
      const f = hitTest(mouse.x, mouse.y);
      if (f && onOpen) { splash(f.x, f.y); onOpen(f.file); }
    });
    // 拖文件进鱼池
    ['dragenter', 'dragover'].forEach(ev => canvas.addEventListener(ev, e => { e.preventDefault(); canvas.style.outline = '3px dashed #4f6ef7'; }));
    ['dragleave', 'drop'].forEach(ev => canvas.addEventListener(ev, e => { e.preventDefault(); canvas.style.outline = 'none'; }));
    canvas.addEventListener('drop', (e) => {
      const rect = canvas.getBoundingClientRect();
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      splash(at.x, at.y);
      if (window.__onPondDrop) window.__onPondDrop([...e.dataTransfer.files], at);
    });
  }

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = rect.width; H = rect.height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function loop(now) {
    const dt = Math.min(0.05, (now - (loop._t || now)) / 1000);
    loop._t = now;
    if (document.hidden) { requestAnimationFrame(loop); return; }
    drawWater();
    drawRipples(dt);
    for (const f of fishes) stepFish(f, dt);
    fishes.sort((a, b) => a.size - b.size);
    for (const f of fishes) drawFish(f);
    requestAnimationFrame(loop);
  }

  function ensureRunning() {
    if (running) return;
    running = true;
    resize();
    requestAnimationFrame(loop);
  }

  function init(canvasEl, opts) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    onOpen = opts && opts.onOpen;
    window.addEventListener('resize', resize);
    bindEvents();
  }

  return { init, update, splash };
})();
