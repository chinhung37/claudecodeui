'use strict';

(() => {
  const A = window.SuspAnalysis;
  const $ = (s) => document.querySelector(s);
  const STRIDE = A.STRIDE;

  const DEFAULT_SETTINGS = {
    wheelbase: 2700, trackF: 1550, trackR: 1550, phoneX: 1100, phoneY: 0,
    rollSoft: 6, rollHard: 2, pitchSoft: 4, pitchHard: 1.5,
    rideSoft: 0.4, rideHard: 1.2, rideGate: 0.2,
    useBaseline: false, gyroMap: 'spec',
    flipLong: false, flipLat: false, flipPitch: false, flipRoll: false,
  };
  const NUM_KEYS = ['wheelbase', 'trackF', 'trackR', 'phoneX', 'phoneY', 'rollSoft', 'rollHard',
    'pitchSoft', 'pitchHard', 'rideSoft', 'rideHard', 'rideGate'];
  const BOOL_KEYS = ['useBaseline', 'flipLong', 'flipLat', 'flipPitch', 'flipRoll'];
  const CORNER_NAME = { FL: '前左', FR: '前右', RL: '後左', RR: '後右' };

  // ---------- 本機儲存（設定、校正、基準是個人便利資料） ----------
  function loadJSON(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (_) { return fallback; }
  }
  function saveJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* 私密模式等 */ }
  }

  let settings = { ...DEFAULT_SETTINGS, ...loadJSON('sgm.settings', {}) };
  let calib = loadJSON('sgm.calib', null);
  let baseline = loadJSON('sgm.baseline', null);

  // ---------- IndexedDB：錄製資料 ----------
  const DB_NAME = 'susp-gmeter';
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore('meta', { keyPath: 'id', autoIncrement: true });
          d.createObjectStore('data');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async function saveRecording(meta, data) {
    const d = await db();
    const tx = d.transaction(['meta', 'data'], 'readwrite');
    const req = tx.objectStore('meta').add(meta);
    req.onsuccess = () => tx.objectStore('data').put(data, req.result);
    await txDone(tx);
    return req.result;
  }
  async function listMeta() {
    const d = await db();
    return new Promise((resolve, reject) => {
      const req = d.transaction('meta').objectStore('meta').getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.created - a.created));
      req.onerror = () => reject(req.error);
    });
  }
  async function getRecording(id) {
    const d = await db();
    const tx = d.transaction(['meta', 'data']);
    const m = tx.objectStore('meta').get(id);
    const x = tx.objectStore('data').get(id);
    await txDone(tx);
    return { meta: m.result, data: x.result };
  }
  async function putMeta(meta) {
    const d = await db();
    const tx = d.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(meta);
    await txDone(tx);
  }
  async function deleteRecording(id) {
    const d = await db();
    const tx = d.transaction(['meta', 'data'], 'readwrite');
    tx.objectStore('meta').delete(id);
    tx.objectStore('data').delete(id);
    await txDone(tx);
  }

  // ---------- 狀態 ----------
  let sensorsOn = false;
  let gyroSeen = false;
  let lastEventT = 0;
  let rateEst = 0;
  let proc = null;
  let liveState = null;
  let mode = 'live'; // live | calibStatic | calibFwd
  let calibBuf = [];
  let calibStart = 0;
  let calibStatic = null;
  let fwdDetector = null;
  let recording = null; // { chunks, cur, n, t0, startWall }
  let wakeLock = null;
  let pb = null; // 回放狀態

  function buildProcessor() {
    proc = calib ? new A.Processor(calib, settings, calib.fs) : null;
  }
  buildProcessor();

  // ---------- 感測器 ----------
  async function startSensors() {
    const status = $('#status');
    if (!window.isSecureContext) {
      setStatus('需要 HTTPS 才能讀取感測器', 'err');
      return;
    }
    if (typeof DeviceMotionEvent === 'undefined') {
      setStatus('這個瀏覽器不支援動作感測器', 'err');
      return;
    }
    // iOS 13+（新版 Chrome 也有）：必須在使用者點擊當下要求權限
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const r = await DeviceMotionEvent.requestPermission();
        if (r !== 'granted') {
          setStatus('動作感測權限被拒絕（iPhone：設定 → Safari → 動作與方向取用；Android Chrome：網址列左側 → 網站設定 → 動作感應器）', 'err');
          return;
        }
      } catch (e) {
        setStatus('無法取得動作感測權限：' + e.message, 'err');
        return;
      }
    }
    window.addEventListener('devicemotion', onMotion);
    sensorsOn = true;
    status.textContent = '等待感測資料…';
    $('#btnStart').textContent = '感測器已啟動';
    $('#btnStart').disabled = true;
    $('#btnCalib').disabled = false;
    $('#btnResetStats').disabled = !proc;
    $('#btnRec').disabled = !proc;
    requestWakeLock();
    setTimeout(() => {
      if (!lastEventT) setStatus('收不到感測資料（瀏覽器可能封鎖）', 'err');
    }, 2500);
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (_) { /* 不支援就算了 */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (sensorsOn && document.visibilityState === 'visible') requestWakeLock();
  });

  function onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    const rr = e.rotationRate;
    const ra = rr && rr.alpha != null ? rr.alpha : 0;
    const rb = rr && rr.beta != null ? rr.beta : 0;
    const rg = rr && rr.gamma != null ? rr.gamma : 0;
    if (rr && rr.alpha != null) gyroSeen = true;
    const t = e.timeStamp || performance.now();
    if (lastEventT && t > lastEventT) {
      const hz = 1000 / (t - lastEventT);
      rateEst = rateEst ? rateEst + (hz - rateEst) * 0.02 : hz;
    }
    lastEventT = t;

    if (mode === 'calibStatic') {
      calibBuf.push(t, g.x, g.y, g.z, ra, rb, rg);
      return;
    }
    if (mode === 'calibFwd') {
      if (fwdDetector.add(g.x, g.y, g.z)) finishCalib(fwdDetector.forward());
      $('#calibBar2').style.width = (fwdDetector.progress() * 100) + '%';
      return;
    }
    if (!proc) return;
    liveState = proc.step(t, g.x, g.y, g.z, ra, rb, rg);
    if (recording) {
      const r = recording;
      if (r.t0 == null) r.t0 = t;
      if (r.n + STRIDE > r.cur.length) {
        r.chunks.push(r.cur);
        r.cur = new Float32Array(STRIDE * 4096);
        r.n = 0;
      }
      r.cur.set([t - r.t0, g.x, g.y, g.z, ra, rb, rg], r.n);
      r.n += STRIDE;
    }
  }

  function setStatus(text, cls) {
    const s = $('#status');
    s.textContent = text;
    s.className = 'status' + (cls ? ' ' + cls : '');
  }

  function updateStatus() {
    if (!sensorsOn || !lastEventT) return;
    const parts = [Math.round(rateEst) + ' Hz'];
    if (!gyroSeen) parts.push('無陀螺儀');
    parts.push(calib ? '已校正' : '未校正');
    if (recording) parts.push('● ' + fmtTime((performance.now() - recording.startWall) / 1000));
    setStatus(parts.join('・'), calib ? 'ok' : '');
  }

  // ---------- 校正 ----------
  function openCalib() {
    $('#calibDlg').classList.remove('hidden');
    $('#calibStep1').classList.remove('hidden');
    $('#calibStep2').classList.add('hidden');
    $('#autoFwd').classList.add('hidden');
    $('#calibBar1').style.width = '0';
    $('#calibBar2').style.width = '0';
    $('#calibMsg').textContent = '';
    $('#btnCalibStatic').disabled = false;
  }
  function closeCalib() {
    mode = 'live';
    $('#calibDlg').classList.add('hidden');
  }
  function startStaticCalib() {
    calibBuf = [];
    calibStart = performance.now();
    mode = 'calibStatic';
    $('#btnCalibStatic').disabled = true;
    $('#calibMsg').textContent = '';
    const tick = () => {
      if (mode !== 'calibStatic') return;
      const p = (performance.now() - calibStart) / 3000;
      $('#calibBar1').style.width = Math.min(100, p * 100) + '%';
      if (p < 1) { requestAnimationFrame(tick); return; }
      mode = 'idle';
      try {
        const c = A.staticCalibration(Float64Array.from(calibBuf));
        if (c.std > 0.6) throw new Error('晃動太大（' + c.std.toFixed(2) + ' m/s²），請靜止後重試');
        calibStatic = c;
        $('#calibStep1').classList.add('hidden');
        $('#calibStep2').classList.remove('hidden');
        if (!c.hasGyro && !gyroSeen) $('#calibMsg').textContent = '注意：沒有收到陀螺儀資料，俯仰/側傾無法量測。';
      } catch (e) {
        $('#calibMsg').textContent = e.message;
        $('#btnCalibStatic').disabled = false;
      }
    };
    requestAnimationFrame(tick);
  }
  function chooseForward(kind) {
    if (kind === 'auto') {
      fwdDetector = new A.ForwardDetector(calibStatic.gravity, calibStatic.fs);
      $('#autoFwd').classList.remove('hidden');
      mode = 'calibFwd';
      return;
    }
    finishCalib(A.FORWARD_PRESETS[kind]);
  }
  function finishCalib(forward) {
    try {
      const R = A.buildFrame(calibStatic.gravity, forward);
      calib = {
        R, gMag: calibStatic.gMag, gyroBias: calibStatic.gyroBias,
        hasGyro: calibStatic.hasGyro || gyroSeen, fs: calibStatic.fs, created: Date.now(),
      };
      saveJSON('sgm.calib', calib);
      buildProcessor();
      if (!pb) $('#modeBanner').classList.add('hidden');
      $('#btnRec').disabled = false;
      $('#btnResetStats').disabled = false;
      closeCalib();
    } catch (e) {
      mode = 'idle';
      $('#calibMsg').textContent = e.message;
    }
  }

  // ---------- 記錄 ----------
  async function toggleRecording() {
    const btn = $('#btnRec');
    if (!recording) {
      if (!proc) return;
      proc.resetStats();
      recording = { chunks: [], cur: new Float32Array(STRIDE * 4096), n: 0, t0: null, startWall: performance.now() };
      btn.textContent = '■ 停止記錄';
      btn.classList.add('on');
      return;
    }
    const r = recording;
    recording = null;
    btn.textContent = '● 開始記錄';
    btn.classList.remove('on');
    const total = r.chunks.reduce((s, c) => s + c.length, 0) + r.n;
    if (total < STRIDE * 50) { alert('記錄太短，沒有儲存'); return; }
    const samples = new Float32Array(total);
    let o = 0;
    for (const c of r.chunks) { samples.set(c, o); o += c.length; }
    samples.set(r.cur.subarray(0, r.n), o);
    try {
      await storeRecording(samples, calib, defaultName(new Date()));
      alert('已儲存，可到「紀錄」頁回放');
    } catch (e) {
      alert('儲存失敗：' + e.message);
    }
  }

  async function storeRecording(samples, cal, name, created) {
    const fs = cal.fs;
    const { metrics } = A.analyzeRecording(samples, cal, settings, fs);
    const n = samples.length / STRIDE;
    const meta = {
      name,
      created: created || Date.now(),
      duration: samples[(n - 1) * STRIDE] / 1000,
      fs,
      n,
      metrics,
      gyroCheck: cal.hasGyro ? A.gyroCheck(samples, cal, fs) : null,
    };
    const id = await saveRecording(meta, { samples: samples.buffer.slice(0), calib: cal });
    renderRecords();
    return id;
  }

  function defaultName(d) {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- 判讀 ----------
  function judge(kind, value, baseKey) {
    // kind: 'roll' | 'pitch' | 'ride'
    if (value == null) return { level: null, text: '資料不足', short: '資料不足' };
    const lowerIsHarder = kind !== 'ride';
    if (settings.useBaseline && baseline) {
      const base = baseKey(baseline.metrics);
      const pct = A.vsBaseline(value, base, lowerIsHarder);
      if (pct == null) return { level: null, text: '基準無資料', short: '無基準' };
      const near = Math.abs(pct) < 5;
      const level = near ? 'mid' : pct > 0 ? 'hard' : 'soft';
      const dir = pct > 0 ? '硬' : '軟';
      const p = Math.abs(pct).toFixed(0) + '%';
      return { level, text: near ? '與基準相近' : `比基準${dir} ${p}`, short: near ? '相近' : `${dir} ${p}` };
    }
    const [soft, hard] = kind === 'roll' ? [settings.rollSoft, settings.rollHard]
      : kind === 'pitch' ? [settings.pitchSoft, settings.pitchHard]
        : [settings.rideSoft, settings.rideHard];
    const score = A.hardness(value, soft, hard);
    const level = score < 0.34 ? 'soft' : score > 0.66 ? 'hard' : 'mid';
    return { level, text: LEVEL_TEXT[level], short: LEVEL_TEXT[level] };
  }

  // 三段固定高對比色：藍 = 偏軟、綠 = 適中、紅 = 偏硬
  const LEVEL_COLOR = { soft: '#1e88ff', mid: '#16c060', hard: '#ff3b30' };
  const LEVEL_TEXT = { soft: '偏軟', mid: '適中', hard: '偏硬' };
  function levelColor(j) { return LEVEL_COLOR[j.level] || '#4a525d'; }

  // 色塊白字標籤；align 為錨點（left / center / right），y 為垂直中心
  function drawPill(ctx, text, x, y, align, bg, fs) {
    ctx.font = `800 ${fs}px system-ui, sans-serif`;
    const tw = ctx.measureText(text).width;
    const padX = fs * 0.55, h = fs * 1.55, w = tw + padX * 2;
    const x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
    ctx.fillStyle = bg;
    roundRect(ctx, x0, y - h / 2, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(text, x0 + w / 2, y + 1);
  }

  const EDGES = [
    { key: 'dive', side: 'front', label: '前', desc: '點頭（煞車）', kind: 'pitch' },
    { key: 'squat', side: 'rear', label: '後', desc: '蹲尾（加速）', kind: 'pitch' },
    { key: 'rollR', side: 'left', label: '左', desc: '右彎側傾', kind: 'roll' },
    { key: 'rollL', side: 'right', label: '右', desc: '左彎側傾', kind: 'roll' },
  ];

  // ---------- 畫圖 ----------
  function fitCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function fmt(v, d) {
    if (v == null || !isFinite(v)) return '—';
    const t = v.toFixed(d);
    return Number(t) === 0 ? (0).toFixed(d) : t;
  }

  function drawCar(m) {
    const { ctx, w: W, h: H } = fitCanvas($('#carCanvas'));
    if (W < 40) return;
    ctx.clearRect(0, 0, W, H);
    const fs = Math.max(15, Math.min(19, W / 24));
    const bx0 = W * 0.33, bx1 = W * 0.67, by0 = H * 0.2, by1 = H * 0.8;

    // 車身
    ctx.fillStyle = '#232a33';
    ctx.strokeStyle = '#56606d';
    ctx.lineWidth = 2;
    roundRect(ctx, bx0, by0, bx1 - bx0, by1 - by0, 18);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#98a2ae';
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('▲ 車頭', W / 2, by0 + fs * 1.3);

    const edgeInfo = {};
    for (const e of EDGES) edgeInfo[e.side] = { e, v: m ? m[e.key] : null, j: judge(e.kind, m ? m[e.key] : null, (b) => b[e.key]) };

    // 前後支撐條
    const barT = H * 0.05;
    const drawHBar = (side, y, textY) => {
      const { e, v, j } = edgeInfo[side];
      ctx.fillStyle = levelColor(j);
      roundRect(ctx, bx0 + 6, y, bx1 - bx0 - 12, barT, barT / 2);
      ctx.fill();
      ctx.fillStyle = '#e8ecf1';
      ctx.font = `700 ${fs}px system-ui, sans-serif`;
      ctx.fillText(`${e.label} ${e.desc} ${fmt(v, 2)}°/g`, W / 2, textY);
      drawPill(ctx, j.text, W / 2, textY + fs * 1.55, 'center', levelColor(j), fs);
    };
    drawHBar('front', by0 - barT - 6, H * 0.035);
    drawHBar('rear', by1 + 6, by1 + barT + 6 + fs * 1.1);

    // 左右支撐條
    const wheelH = H * 0.15, wheelW = W * 0.09;
    const sideY0 = by0 + wheelH * 0.95 + 10, sideY1 = by1 - wheelH * 0.95 - 10;
    const drawVBar = (side) => {
      const { e, v, j } = edgeInfo[side];
      const x = side === 'left' ? bx0 - barT - 6 : bx1 + 6;
      ctx.fillStyle = levelColor(j);
      roundRect(ctx, x, sideY0, barT, sideY1 - sideY0, barT / 2);
      ctx.fill();
      const tx = side === 'left' ? x - 8 : x + barT + 8;
      ctx.textAlign = side === 'left' ? 'right' : 'left';
      const cy = (sideY0 + sideY1) / 2;
      ctx.fillStyle = '#e8ecf1';
      ctx.font = `700 ${fs}px system-ui, sans-serif`;
      ctx.fillText(`${e.label}`, tx, cy - fs * 1.9);
      ctx.font = `500 ${fs * 0.88}px system-ui, sans-serif`;
      ctx.fillStyle = '#98a2ae';
      ctx.fillText(e.desc, tx, cy - fs * 0.7);
      ctx.fillStyle = '#e8ecf1';
      ctx.font = `700 ${fs}px system-ui, sans-serif`;
      ctx.fillText(`${fmt(v, 2)}°/g`, tx, cy + fs * 0.5);
      drawPill(ctx, j.short, tx, cy + fs * 1.9, side === 'left' ? 'right' : 'left', levelColor(j), fs);
    };
    drawVBar('left');
    drawVBar('right');

    // 四輪路感
    const pos = {
      FL: [bx0, by0 + wheelH * 0.6], FR: [bx1, by0 + wheelH * 0.6],
      RL: [bx0, by1 - wheelH * 0.6], RR: [bx1, by1 - wheelH * 0.6],
    };
    for (const c of A.CORNERS) {
      const ride = m ? m.ride[c] : null;
      const v = ride ? ride.ratio : null;
      const j = judge('ride', v, (b) => (b.ride && b.ride[c] ? b.ride[c].ratio : null));
      const [cx, cy] = pos[c];
      ctx.fillStyle = levelColor(j);
      ctx.strokeStyle = '#0b0d10';
      roundRect(ctx, cx - wheelW / 2, cy - wheelH / 2, wheelW, wheelH, 6);
      ctx.fill(); ctx.stroke();
      const left = c === 'FL' || c === 'RL';
      const tx = left ? cx - wheelW / 2 - 10 : cx + wheelW / 2 + 10;
      ctx.textAlign = left ? 'right' : 'left';
      ctx.fillStyle = '#98a2ae';
      ctx.font = `500 ${fs * 0.88}px system-ui, sans-serif`;
      ctx.fillText(`${CORNER_NAME[c]} 路感`, tx, cy - fs * 1.1);
      ctx.fillStyle = '#e8ecf1';
      ctx.font = `700 ${fs * 1.15}px system-ui, sans-serif`;
      ctx.fillText(fmt(v, 2), tx, cy + fs * 0.1);
      drawPill(ctx, j.short, tx, cy + fs * 1.5, left ? 'right' : 'left', levelColor(j), fs);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  const trail = [];
  function drawGBall(st) {
    const { ctx, w, h } = fitCanvas($('#gCanvas'));
    if (w < 40) return;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6;
    const k = R / 1.2;
    ctx.strokeStyle = '#3a434f';
    ctx.lineWidth = 1.5;
    for (const g of [0.5, 1.0]) {
      ctx.beginPath(); ctx.arc(cx, cy, g * k, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    ctx.fillStyle = '#98a2ae';
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('煞車', cx, cy - R + 10);
    ctx.fillText('加速', cx, cy + R - 10);
    ctx.fillText('1g', cx + k + 0, cy - 10);
    if (!st) return;
    // 點代表「身體感受到的力」：煞車往上、左轉往右
    const x = cx + st.ayg * k, y = cy + st.axg * k;
    trail.push([x, y]);
    if (trail.length > 90) trail.shift();
    ctx.strokeStyle = 'rgba(61,139,253,0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    trail.forEach(([tx, ty], i) => (i ? ctx.lineTo(tx, ty) : ctx.moveTo(tx, ty)));
    ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
  }

  function drawReadout(st) {
    $('#roLong').textContent = st ? fmt(st.axg, 2) : '0.00';
    $('#roLat').textContent = st ? fmt(st.ayg, 2) : '0.00';
    $('#roPitch').textContent = st ? fmt(st.pitchDeg, 1) : '0.0';
    $('#roRoll').textContent = st ? fmt(st.rollDeg, 1) : '0.0';
  }

  function drawMetrics(m) {
    const rows = [];
    for (const e of EDGES) {
      const v = m ? m[e.key] : null;
      const j = judge(e.kind, v, (b) => b[e.key]);
      rows.push(row(`${e.label}<br><span class="muted small">${e.desc}</span>`, `${fmt(v, 2)}°/g`, j, m ? m.seconds[e.key] : 0));
    }
    for (const c of A.CORNERS) {
      const r = m ? m.ride[c] : null;
      const j = judge('ride', r && r.ratio, (b) => (b.ride && b.ride[c] ? b.ride[c].ratio : null));
      const live = r && r.live != null ? `<br><span class="muted small">即時 ${r.live.toFixed(2)}</span>` : '';
      rows.push(row(`${CORNER_NAME[c]}<br><span class="muted small">路感比</span>`, `${fmt(r && r.ratio, 2)}${live}`, j, r ? r.seconds : 0));
    }
    $('#metricsBody').innerHTML = rows.join('');
  }
  function row(name, val, j, sec) {
    return `<tr><td>${name}</td><td class="num">${val}</td>` +
      `<td><span class="tag" style="background:${levelColor(j)}">${j.text}</span></td>` +
      `<td class="num">${(sec || 0).toFixed(0)}s</td></tr>`;
  }

  // ---------- 主迴圈 ----------
  let lastMetricsDraw = 0;
  function frame(now) {
    if (pb) {
      if (pb.playing) {
        const dt = pb.lastFrame ? now - pb.lastFrame : 0;
        pb.lastFrame = now;
        let t = pb.t + dt * pb.speed;
        if (t >= pb.duration) { t = pb.duration; setPlaying(false); }
        seek(t);
      }
    } else {
      drawGBall(liveState);
      drawReadout(liveState);
      if (now - lastMetricsDraw > 500) {
        lastMetricsDraw = now;
        const m = proc ? proc.metrics() : null;
        drawCar(m);
        drawMetrics(m);
        updateStatus();
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------- 回放 ----------
  async function openPlayback(id) {
    const { meta, data } = await getRecording(id);
    if (!meta || !data) { alert('讀取失敗'); return; }
    const samples = new Float32Array(data.samples);
    const res = A.analyzeRecording(samples, data.calib, settings, meta.fs);
    pb = {
      meta, calib: data.calib, samples, series: res.series,
      n: samples.length / STRIDE,
      duration: samples[samples.length - STRIDE],
      t: 0, idx: 0, proc: null, state: null, playing: false, speed: Number($('#playSpeed').value),
      lastFrame: 0,
    };
    resetPbProc();
    trail.length = 0;
    showTab('live');
    $('#modeBanner').textContent = `回放中：${meta.name}`;
    $('#modeBanner').classList.remove('hidden');
    $('#liveControls').classList.add('hidden');
    $('#playControls').classList.remove('hidden');
    seek(0, true);
  }
  function resetPbProc() {
    pb.proc = new A.Processor(pb.calib, settings, pb.meta.fs);
    pb.idx = 0;
    pb.state = null;
  }
  function seek(t, force) {
    t = Math.max(0, Math.min(pb.duration, t));
    const jumped = Math.abs(t - pb.t) > 1000;
    if (t < pb.t || force) {
      resetPbProc();
      trail.length = 0;
    }
    pb.t = t;
    const s = pb.samples;
    while (pb.idx < pb.n && s[pb.idx * STRIDE] <= t) {
      const o = pb.idx * STRIDE;
      pb.state = pb.proc.step(s[o], s[o + 1], s[o + 2], s[o + 3], s[o + 4], s[o + 5], s[o + 6]);
      pb.idx++;
    }
    drawGBall(pb.state);
    drawReadout(pb.state);
    const now = performance.now();
    if (!pb.playing || jumped || force || now - lastMetricsDraw > 400) {
      lastMetricsDraw = now;
      const m = pb.proc.metrics();
      drawCar(m);
      drawMetrics(m);
    }
    drawChart();
    $('#scrub').value = pb.duration ? Math.round(t / pb.duration * 1000) : 0;
    $('#playTime').textContent = `${fmtTime(t / 1000)} / ${fmtTime(pb.duration / 1000)}`;
  }
  function setPlaying(on) {
    if (!pb) return;
    if (on && pb.t >= pb.duration) seek(0);
    pb.playing = on;
    pb.lastFrame = 0;
    $('#btnPlay').textContent = on ? '❚❚ 暫停' : '▶ 播放';
    if (!on) seek(pb.t);
  }
  function exitPlayback() {
    pb = null;
    trail.length = 0;
    $('#modeBanner').classList.add('hidden');
    $('#liveControls').classList.remove('hidden');
    $('#playControls').classList.add('hidden');
  }

  function drawChart() {
    const { ctx, w, h } = fitCanvas($('#chartCanvas'));
    if (w < 80) return;
    ctx.clearRect(0, 0, w, h);
    const s = pb.series;
    const n = s.t.length;
    if (n < 2) return;
    const padL = 44, padR = 6, gap = 10;
    const ph = (h - gap) / 2;
    const panels = [
      { y0: 0, keys: [['axg', '縱向 G', '#ffd166', 1], ['ayg', '橫向 G', '#4cc9f0', 1]], unit: 'g' },
      { y0: ph + gap, keys: [['pitch', '俯仰°', '#f72585', 1], ['roll', '側傾°', '#80ed99', 1]], unit: '°' },
    ];
    const tx = (t) => padL + (t / pb.duration) * (w - padL - padR);
    for (const p of panels) {
      let lim = 0.1;
      for (const [k, , , sign] of p.keys) for (let i = 0; i < n; i += 4) lim = Math.max(lim, Math.abs(s[k][i] * sign));
      lim *= 1.1;
      const ty = (v) => p.y0 + ph / 2 - (v / lim) * (ph / 2 - 4);
      ctx.strokeStyle = '#2c333d';
      ctx.lineWidth = 1;
      ctx.strokeRect(padL, p.y0, w - padL - padR, ph);
      ctx.beginPath(); ctx.moveTo(padL, ty(0)); ctx.lineTo(w - padR, ty(0)); ctx.stroke();
      ctx.fillStyle = '#98a2ae';
      ctx.font = '500 13px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+${lim.toFixed(lim < 2 ? 2 : 1)}`, padL - 4, p.y0 + 8);
      ctx.fillText(`-${lim.toFixed(lim < 2 ? 2 : 1)}`, padL - 4, p.y0 + ph - 8);
      const step = Math.max(1, Math.floor(n / (w * 1.5)));
      p.keys.forEach(([k, label, color, sign], li) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < n; i += step) {
          const x = tx(s.t[i]), y = ty(s[k][i] * sign);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = '600 15px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(label, padL + 6 + li * 80, p.y0 + 12);
      });
    }
    const cx = tx(pb.t);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
  }

  function fmtTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ---------- 紀錄列表 ----------
  async function renderRecords() {
    const list = $('#recordList');
    const bi = $('#baselineInfo');
    bi.innerHTML = baseline
      ? `目前基準：<b>${esc(baseline.name)}</b>　<button id="btnClearBase">清除基準</button>`
      : '尚未設定基準。錄一段調整前的路線，按「設為基準」，調整後再錄一段比較最準。';
    const cb = $('#btnClearBase');
    if (cb) cb.onclick = () => { baseline = null; saveJSON('sgm.baseline', null); renderRecords(); };
    let metas = [];
    try { metas = await listMeta(); } catch (e) { list.innerHTML = `<div class="card">無法開啟資料庫：${esc(e.message)}</div>`; return; }
    if (!metas.length) { list.innerHTML = '<div class="card muted">還沒有紀錄</div>'; return; }
    list.innerHTML = metas.map((m) => {
      const x = m.metrics || {};
      const isBase = baseline && baseline.id === m.id;
      const gc = m.gyroCheck;
      const gcText = gc ? `陀螺儀軸檢查：標準 ${fmt(gc.spec, 2)} / 替代 ${fmt(gc.alt, 2)}${gyroAdvice(gc)}` : '';
      return `<div class="card rec-item" data-id="${m.id}">
        <div class="head"><span>${esc(m.name)}</span>${isBase ? '<span class="badge">基準</span>' : ''}</div>
        <div class="sum">
          ${fmtTime(m.duration)}・${Math.round(m.fs)} Hz<br>
          點頭 ${fmt(x.dive, 2)}・蹲尾 ${fmt(x.squat, 2)}・左彎側傾 ${fmt(x.rollL, 2)}・右彎側傾 ${fmt(x.rollR, 2)} °/g<br>
          路感比 前左 ${fmt(x.ride && x.ride.FL.ratio, 2)}・前右 ${fmt(x.ride && x.ride.FR.ratio, 2)}・後左 ${fmt(x.ride && x.ride.RL.ratio, 2)}・後右 ${fmt(x.ride && x.ride.RR.ratio, 2)}
          ${gcText ? '<br>' + gcText : ''}
        </div>
        <div class="controls">
          <button data-act="play" class="primary">回放</button>
          <button data-act="base">設為基準</button>
          <button data-act="rename">改名</button>
          <button data-act="csv">CSV</button>
          <button data-act="json">備份</button>
          <button data-act="del">刪除</button>
        </div>
      </div>`;
    }).join('');
  }
  function gyroAdvice(gc) {
    if (gc.spec == null && gc.alt == null) return '（彎道不夠，無法判斷）';
    const s = gc.spec ?? -1, a = gc.alt ?? -1;
    if (s > 0.6 && s > a) return '（目前「標準」合理）';
    if (a > 0.6 && a > s) return '（建議改用「替代」）';
    return '（無法判斷）';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function onRecordAction(id, act) {
    if (act === 'play') return openPlayback(id);
    const { meta, data } = await getRecording(id);
    if (act === 'base') {
      // 依目前設定重算，確保與現在的判讀一致
      const res = A.analyzeRecording(new Float32Array(data.samples), data.calib, settings, meta.fs);
      baseline = { id, name: meta.name, metrics: res.metrics };
      saveJSON('sgm.baseline', baseline);
      renderRecords();
    } else if (act === 'rename') {
      const name = prompt('新名稱', meta.name);
      if (name) { meta.name = name; await putMeta(meta); renderRecords(); }
    } else if (act === 'del') {
      if (confirm(`刪除「${meta.name}」？`)) {
        await deleteRecording(id);
        if (baseline && baseline.id === id) { baseline = null; saveJSON('sgm.baseline', null); }
        renderRecords();
      }
    } else if (act === 'csv') {
      exportCSV(meta, data);
    } else if (act === 'json') {
      const out = {
        format: 'susp-gmeter', version: 1,
        name: meta.name, created: meta.created, fs: meta.fs, calib: data.calib,
        samples: Array.from(new Float32Array(data.samples)),
      };
      download(`${fileSafe(meta.name)}.json`, JSON.stringify(out), 'application/json');
    }
  }

  function exportCSV(meta, data) {
    const s = new Float32Array(data.samples);
    const { series } = A.analyzeRecording(s, data.calib, settings, meta.fs);
    const lines = ['t_ms,accG_x,accG_y,accG_z,rate_alpha,rate_beta,rate_gamma,long_g,lat_g,pitch_deg,roll_deg'];
    for (let i = 0; i < series.t.length; i++) {
      const o = i * STRIDE;
      lines.push([s[o].toFixed(1), s[o + 1].toFixed(4), s[o + 2].toFixed(4), s[o + 3].toFixed(4),
        s[o + 4].toFixed(3), s[o + 5].toFixed(3), s[o + 6].toFixed(3),
        series.axg[i].toFixed(4), series.ayg[i].toFixed(4), series.pitch[i].toFixed(3), series.roll[i].toFixed(3)].join(','));
    }
    download(`${fileSafe(meta.name)}.csv`, lines.join('\n'), 'text/csv');
  }

  function fileSafe(s) { return String(s).replace(/[\\/:*?"<>|\s]+/g, '_'); }

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function importFile(file) {
    try {
      const obj = JSON.parse(await file.text());
      if (obj.format !== 'susp-gmeter' || !Array.isArray(obj.samples) || !obj.calib) throw new Error('格式不符');
      const samples = Float32Array.from(obj.samples);
      await storeRecording(samples, obj.calib, obj.name || file.name, obj.created);
      alert('匯入完成');
    } catch (e) {
      alert('匯入失敗：' + e.message);
    }
  }

  // ---------- 設定 ----------
  function fillSettings() {
    const f = $('#settingsForm');
    for (const k of NUM_KEYS) f.elements[k].value = settings[k];
    for (const k of BOOL_KEYS) f.elements[k].checked = !!settings[k];
    f.elements.gyroMap.value = settings.gyroMap;
  }
  function readSettings() {
    const f = $('#settingsForm');
    const s = { ...settings };
    for (const k of NUM_KEYS) {
      const v = parseFloat(f.elements[k].value);
      s[k] = isFinite(v) ? v : DEFAULT_SETTINGS[k];
    }
    for (const k of BOOL_KEYS) s[k] = f.elements[k].checked;
    s.gyroMap = f.elements.gyroMap.value;
    return s;
  }
  function applySettings(s) {
    settings = s;
    saveJSON('sgm.settings', settings);
    buildProcessor();
    if (pb) {
      const res = A.analyzeRecording(pb.samples, pb.calib, settings, pb.meta.fs);
      pb.series = res.series;
      seek(pb.t, true);
    }
  }

  // ---------- 分頁 ----------
  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + name));
    if (name === 'records') renderRecords();
    if (name === 'settings') fillSettings();
    if (name === 'live' && pb) seek(pb.t);
  }

  // ---------- 綁定事件 ----------
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#btnStart').addEventListener('click', startSensors);
  $('#btnCalib').addEventListener('click', openCalib);
  $('#btnCalibStatic').addEventListener('click', startStaticCalib);
  $('#btnCalibClose').addEventListener('click', closeCalib);
  document.querySelectorAll('[data-fwd]').forEach((b) => b.addEventListener('click', () => chooseForward(b.dataset.fwd)));
  $('#btnRec').addEventListener('click', toggleRecording);
  $('#btnResetStats').addEventListener('click', () => { if (proc) proc.resetStats(); });
  $('#btnPlay').addEventListener('click', () => setPlaying(!pb.playing));
  $('#btnExitPlay').addEventListener('click', exitPlayback);
  $('#playSpeed').addEventListener('change', (e) => { if (pb) pb.speed = Number(e.target.value); });
  $('#scrub').addEventListener('input', (e) => { if (pb) seek(pb.duration * Number(e.target.value) / 1000); });
  $('#chartCanvas').addEventListener('pointerdown', (e) => {
    if (!pb) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left - 44) / (r.width - 50);
    seek(pb.duration * Math.max(0, Math.min(1, frac)));
  });
  $('#recordList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('[data-id]').dataset.id);
    onRecordAction(id, btn.dataset.act).catch((err) => alert(err.message));
  });
  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f);
  });
  $('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    applySettings(readSettings());
    alert('已儲存');
  });
  $('#btnDefaults').addEventListener('click', () => {
    settings = { ...DEFAULT_SETTINGS };
    fillSettings();
  });

  if (!calib) {
    $('#modeBanner').textContent = '第一次使用：先到「設定」填車輛尺寸，再按「啟動感測器」→「校正」。';
    $('#modeBanner').classList.remove('hidden');
  }
  window.addEventListener('beforeunload', (e) => {
    if (recording) { e.preventDefault(); e.returnValue = ''; }
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  drawCar(null);
  drawMetrics(null);
  requestAnimationFrame(frame);
})();
