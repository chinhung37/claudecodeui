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
  let recording = null; // { chunks, cur, n, t0, startWall, lastRel, gps }
  let wakeLock = null;
  let pb = null; // 回放狀態
  // GPS：時速 m/s、收到的時間（performance.now）、精度、狀態文字
  const gps = { watchId: null, speed: null, t: 0, acc: null, state: '' };

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
    startGps();
    setTimeout(() => {
      if (lastEventT) return;
      setStatus('收不到感測資料', 'err');
      toast(window.parent !== window
        ? '這個頁面被嵌在其他畫面裡（例如 Claude 的檢視器），動作感測器被封鎖。請改用 HTTPS 網址直接開啟的版本。'
        : '收不到感測資料：瀏覽器可能封鎖了動作感測器，請檢查網站權限。', 8000);
    }, 2500);
  }

  // GPS 時速：大約一秒一筆。拿不到也不影響其他功能，只是不分時速段。
  function startGps() {
    if (!('geolocation' in navigator)) { gps.state = '無 GPS'; return; }
    gps.state = 'GPS 定位中';
    try {
      gps.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
        enableHighAccuracy: true, maximumAge: 0, timeout: 15000,
      });
    } catch (_) {
      gps.state = 'GPS 無法使用';
    }
  }
  function onPosition(p) {
    const s = p.coords.speed;
    // 沒有時速（null）或無效（負值）都當作不知道
    gps.speed = s == null || !isFinite(s) || s < 0 ? null : s;
    gps.t = performance.now();
    gps.acc = p.coords.accuracy;
    gps.state = gps.speed == null ? 'GPS 無時速' : 'GPS';
    const r = recording;
    if (r && r.t0 != null && gps.speed != null) r.gps.push(r.lastRel, gps.speed);
  }
  function onPositionError(e) {
    // 1 = 權限被拒、2 = 位置無法取得、3 = 逾時（會繼續等）
    if (e.code === 1) {
      gps.state = 'GPS 權限被拒';
      toast('沒有位置權限，時速不會記錄；其他功能照常。要開啟請到瀏覽器的網站設定允許「位置」。', 7000);
    } else {
      gps.state = 'GPS 訊號不足';
    }
  }
  // 目前時速 m/s；超過 3 秒沒新資料就當不知道
  function speedNow() {
    return gps.speed != null && performance.now() - gps.t <= A.GPS_STALE_MS ? gps.speed : null;
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
    liveState = proc.step(t, g.x, g.y, g.z, ra, rb, rg, speedNow());
    if (recording) {
      const r = recording;
      if (r.t0 == null) {
        r.t0 = t;
        // 開始記錄當下已經有時速，先記一筆
        const v = speedNow();
        if (v != null) r.gps.push(0, v);
      }
      if (r.n + STRIDE > r.cur.length) {
        r.chunks.push(r.cur);
        r.cur = new Float32Array(STRIDE * 4096);
        r.n = 0;
      }
      r.lastRel = t - r.t0;
      r.cur.set([r.lastRel, g.x, g.y, g.z, ra, rb, rg], r.n);
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
    if (gps.state) parts.push(gps.state);
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
      recording = {
        chunks: [], cur: new Float32Array(STRIDE * 4096), n: 0, t0: null,
        startWall: performance.now(), lastRel: 0, gps: [],
      };
      btn.textContent = '■ 停止記錄';
      btn.classList.add('on');
      return;
    }
    const r = recording;
    recording = null;
    btn.textContent = '● 開始記錄';
    btn.classList.remove('on');
    const total = r.chunks.reduce((s, c) => s + c.length, 0) + r.n;
    if (total < STRIDE * 50) { toast('記錄太短，沒有儲存'); return; }
    const samples = new Float32Array(total);
    let o = 0;
    for (const c of r.chunks) { samples.set(c, o); o += c.length; }
    samples.set(r.cur.subarray(0, r.n), o);
    try {
      await storeRecording(samples, calib, defaultName(new Date()), null, Float32Array.from(r.gps), activeVehicleName());
      toast(r.gps.length ? '已儲存，可到「紀錄」頁回放' : '已儲存（這段沒有收到 GPS 時速），可到「紀錄」頁回放', 5000);
    } catch (e) {
      toast('儲存失敗：' + e.message);
    }
  }

  // 頁內提示（嵌入式檢視器不顯示 alert）
  let toastTimer = 0;
  function toast(msg, ms = 3500) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  // gpsTrack：時速軌跡 Float32Array（時間 ms、m/s 交錯），沒有就給空陣列
  async function storeRecording(samples, cal, name, created, gpsTrack, vehicle) {
    const fs = cal.fs;
    const track = gpsTrack && gpsTrack.length ? gpsTrack : null;
    const { metrics } = A.analyzeRecording(samples, cal, settings, fs, track);
    const n = samples.length / STRIDE;
    const meta = {
      name,
      created: created || Date.now(),
      duration: samples[(n - 1) * STRIDE] / 1000,
      fs,
      n,
      vehicle: vehicle || '',
      hasGps: !!track,
      metrics,
      gyroCheck: cal.hasGyro ? A.gyroCheck(samples, cal, fs) : null,
    };
    const data = { samples: samples.buffer.slice(0), calib: cal };
    if (track) data.gps = track.buffer.slice(0);
    const id = await saveRecording(meta, data);
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
      return judgePct(A.vsBaseline(value, baseKey(baseline.metrics), lowerIsHarder), '');
    }
    const [soft, hard] = kind === 'roll' ? [settings.rollSoft, settings.rollHard]
      : kind === 'pitch' ? [settings.pitchSoft, settings.pitchHard]
        : [settings.rideSoft, settings.rideHard];
    const score = A.hardness(value, soft, hard);
    const level = score < 0.34 ? 'soft' : score > 0.66 ? 'hard' : 'mid';
    return { level, text: LEVEL_TEXT[level], short: LEVEL_TEXT[level] };
  }

  // 與基準的差異（變硬 %）換成判讀；note 顯示在表格標籤下方
  function judgePct(pct, note) {
    if (pct == null) return { level: null, text: '基準無資料', short: '無基準' };
    const near = Math.abs(pct) < 5;
    const level = near ? 'mid' : pct > 0 ? 'hard' : 'soft';
    const dir = pct > 0 ? '硬' : '軟';
    const p = Math.abs(pct).toFixed(0) + '%';
    return { level, text: near ? '與基準相近' : `比基準${dir} ${p}`, short: near ? '相近' : `${dir} ${p}`, note };
  }

  // 路感比：與基準比較時只比同一時速段（兩邊都有 GPS 才做得到）
  function judgeRide(m, c) {
    const value = m && m.ride[c] ? m.ride[c].ratio : null;
    if (value != null && settings.useBaseline && baseline) {
      const cmp = A.compareRide(m, baseline.metrics, c);
      return judgePct(cmp && cmp.pct, cmp && !cmp.matched ? '（未分時速）' : '（同時速段）');
    }
    return judge('ride', value, null);
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
      const j = judgeRide(m, c);
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
    $('#roSpeed').textContent = st && st.speedKmh != null ? Math.round(st.speedKmh) : '—';
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
      const j = judgeRide(m, c);
      const live = r && r.live != null ? `<br><span class="muted small">即時 ${r.live.toFixed(2)}</span>` : '';
      rows.push(row(`${CORNER_NAME[c]}<br><span class="muted small">路感比</span>`, `${fmt(r && r.ratio, 2)}${live}`, j, r ? r.seconds : 0));
    }
    $('#metricsBody').innerHTML = rows.join('');
    drawBands(m);
  }
  function row(name, val, j, sec) {
    const note = j.note ? `<br><span class="muted small">${j.note}</span>` : '';
    return `<tr><td>${name}</td><td class="num">${val}</td>` +
      `<td><span class="tag" style="background:${levelColor(j)}">${j.text}</span>${note}</td>` +
      `<td class="num">${(sec || 0).toFixed(0)}s</td></tr>`;
  }

  // 路感比依 GPS 時速分段：每一格是比值，下方小字是秒數
  function drawBands(m) {
    const bands = m && m.rideBands;
    const has = bands && bands.some((b) => A.CORNERS.some((c) => b.corners[c].seconds > 0));
    $('#bandsCard').classList.toggle('hidden', !has);
    if (!has) return;
    const head = `<tr><th>路感比</th>${bands.map((b) => `<th>${b.label}<br><span class="muted small">km/h</span></th>`).join('')}</tr>`;
    const body = A.CORNERS.map((c) => `<tr><td>${CORNER_NAME[c]}</td>${bands.map((b) => {
      const x = b.corners[c];
      return `<td class="num">${fmt(x.ratio, 2)}<br><span class="muted small">${x.seconds.toFixed(0)}s</span></td>`;
    }).join('')}</tr>`).join('');
    $('#bandsTable').innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
    $('#speedMax').textContent = m.speedMax != null ? `最高時速 ${Math.round(m.speedMax)} km/h` : '';
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
    if (!meta || !data) { toast('讀取失敗'); return; }
    playData(meta, data);
  }

  // 示範：模擬一段行車（不需要感測器），直接回放
  function openDemo() {
    const d = window.SuspDemo.simulateDrive();
    const meta = { name: '示範（模擬資料，非實車）', fs: d.fs, demo: true };
    playData(meta, { samples: d.samples.buffer, gps: d.gps.buffer, calib: d.calib });
  }

  // 紀錄裡的 GPS 時速軌跡；舊紀錄沒有就回 null
  function gpsOf(data) {
    return data && data.gps ? new Float32Array(data.gps) : null;
  }

  function playData(meta, data) {
    const samples = new Float32Array(data.samples);
    const track = gpsOf(data);
    const res = A.analyzeRecording(samples, data.calib, settings, meta.fs, track);
    pb = {
      meta, calib: data.calib, samples, track, series: res.series,
      n: samples.length / STRIDE,
      duration: samples[samples.length - STRIDE],
      t: 0, idx: 0, proc: null, state: null, playing: false, speed: Number($('#playSpeed').value),
      lastFrame: 0,
    };
    resetPbProc();
    trail.length = 0;
    showTab('live');
    $('#modeBanner').textContent = meta.demo
      ? '示範：模擬一段 60 秒的行車（不是實車資料）。按「播放」看過程，按「離開回放」改用手機感測器。'
      : `回放中：${meta.name}`;
    $('#modeBanner').classList.remove('hidden');
    $('#liveControls').classList.add('hidden');
    $('#playControls').classList.remove('hidden');
    // 示範一打開就停在結尾，整段統計都看得到
    seek(meta.demo ? pb.duration : 0, true);
  }
  function resetPbProc() {
    pb.proc = new A.Processor(pb.calib, settings, pb.meta.fs);
    pb.speeds = new A.SpeedTrack(pb.track);
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
      pb.state = pb.proc.step(s[o], s[o + 1], s[o + 2], s[o + 3], s[o + 4], s[o + 5], s[o + 6], pb.speeds.at(s[o]));
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
    $('#liveControls').classList.remove('hidden');
    $('#playControls').classList.add('hidden');
    if (calib) {
      $('#modeBanner').classList.add('hidden');
    } else {
      $('#modeBanner').textContent = '第一次使用：先到「設定」填車輛尺寸，再按「啟動感測器」→「校正」。';
    }
    drawCar(proc ? proc.metrics() : null);
    drawMetrics(proc ? proc.metrics() : null);
  }

  function drawChart() {
    const canvas = $('#chartCanvas');
    const s = pb.series;
    const n = s.t.length;
    const hasSpeed = s.speed.some((v) => isFinite(v));
    // 有時速時多一格，圖拉高一點
    canvas.style.aspectRatio = hasSpeed ? '1.35 / 1' : '2 / 1';
    const { ctx, w, h } = fitCanvas(canvas);
    if (w < 80) return;
    ctx.clearRect(0, 0, w, h);
    if (n < 2) return;
    const padL = 44, padR = 6, gap = 10;
    const panels = [
      { keys: [['axg', '縱向 G', '#ffd166', 1], ['ayg', '橫向 G', '#4cc9f0', 1]] },
      { keys: [['pitch', '俯仰°', '#f72585', 1], ['roll', '側傾°', '#80ed99', 1]] },
    ];
    // 時速只有正值：0 在底部
    if (hasSpeed) panels.push({ keys: [['speed', '時速 km/h', '#c5a3ff', 1]], positive: true });
    const ph = (h - gap * (panels.length - 1)) / panels.length;
    panels.forEach((p, i) => { p.y0 = i * (ph + gap); });
    const tx = (t) => padL + (t / pb.duration) * (w - padL - padR);
    for (const p of panels) {
      let lim = p.positive ? 10 : 0.1;
      for (const [k, , , sign] of p.keys) {
        for (let i = 0; i < n; i += 4) if (isFinite(s[k][i])) lim = Math.max(lim, Math.abs(s[k][i] * sign));
      }
      lim *= 1.1;
      const ty = p.positive
        ? (v) => p.y0 + ph - 4 - (v / lim) * (ph - 8)
        : (v) => p.y0 + ph / 2 - (v / lim) * (ph / 2 - 4);
      ctx.strokeStyle = '#2c333d';
      ctx.lineWidth = 1;
      ctx.strokeRect(padL, p.y0, w - padL - padR, ph);
      if (!p.positive) { ctx.beginPath(); ctx.moveTo(padL, ty(0)); ctx.lineTo(w - padR, ty(0)); ctx.stroke(); }
      ctx.fillStyle = '#98a2ae';
      ctx.font = '500 13px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const digits = lim < 2 ? 2 : lim < 20 ? 1 : 0;
      ctx.fillText(`${p.positive ? '' : '+'}${lim.toFixed(digits)}`, padL - 4, p.y0 + 8);
      ctx.fillText(p.positive ? '0' : `-${lim.toFixed(digits)}`, padL - 4, p.y0 + ph - 8);
      const step = Math.max(1, Math.floor(n / (w * 1.5)));
      p.keys.forEach(([k, label, color, sign], li) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < n; i += step) {
          // 沒有時速的區段（GPS 斷訊）不畫線
          if (!isFinite(s[k][i])) { pen = false; continue; }
          const x = tx(s.t[i]), y = ty(s[k][i] * sign);
          if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          pen = true;
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
          ${fmtTime(m.duration)}・${Math.round(m.fs)} Hz${m.vehicle ? '・' + esc(m.vehicle) : ''}・${x.speedMax != null ? `最高 ${Math.round(x.speedMax)} km/h` : '無 GPS 時速'}<br>
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

  async function onRecordAction(id, act, btn) {
    if (act === 'play') return openPlayback(id);
    if (act === 'del' && btn.dataset.armed !== '1') {
      // 刪除要按兩次（嵌入式檢視器不顯示 confirm）
      btn.dataset.armed = '1';
      btn.textContent = '再按一次刪除';
      btn.classList.add('danger');
      setTimeout(() => {
        btn.dataset.armed = '';
        btn.textContent = '刪除';
        btn.classList.remove('danger');
      }, 3000);
      return;
    }
    const { meta, data } = await getRecording(id);
    if (act === 'base') {
      // 依目前設定重算，確保與現在的判讀一致
      const res = A.analyzeRecording(new Float32Array(data.samples), data.calib, settings, meta.fs, gpsOf(data));
      baseline = { id, name: meta.name, metrics: res.metrics };
      saveJSON('sgm.baseline', baseline);
      renderRecords();
      toast(`已將「${meta.name}」設為基準`);
    } else if (act === 'rename') {
      startRename(id, meta);
    } else if (act === 'del') {
      await deleteRecording(id);
      if (baseline && baseline.id === id) { baseline = null; saveJSON('sgm.baseline', null); }
      renderRecords();
      toast(`已刪除「${meta.name}」`);
    } else if (act === 'csv') {
      exportCSV(meta, data);
    } else if (act === 'json') {
      const out = {
        format: 'susp-gmeter', version: 1,
        name: meta.name, created: meta.created, fs: meta.fs, calib: data.calib, vehicle: meta.vehicle || '',
        samples: Array.from(new Float32Array(data.samples)),
        gps: data.gps ? Array.from(new Float32Array(data.gps)) : [],
      };
      download(`${fileSafe(meta.name)}.json`, JSON.stringify(out), 'application/json');
    }
  }

  function exportCSV(meta, data) {
    const s = new Float32Array(data.samples);
    const { series } = A.analyzeRecording(s, data.calib, settings, meta.fs, gpsOf(data));
    const lines = ['t_ms,accG_x,accG_y,accG_z,rate_alpha,rate_beta,rate_gamma,long_g,lat_g,pitch_deg,roll_deg,speed_kmh'];
    for (let i = 0; i < series.t.length; i++) {
      const o = i * STRIDE;
      const v = series.speed[i];
      lines.push([s[o].toFixed(1), s[o + 1].toFixed(4), s[o + 2].toFixed(4), s[o + 3].toFixed(4),
        s[o + 4].toFixed(3), s[o + 5].toFixed(3), s[o + 6].toFixed(3),
        series.axg[i].toFixed(4), series.ayg[i].toFixed(4), series.pitch[i].toFixed(3), series.roll[i].toFixed(3),
        isFinite(v) ? v.toFixed(1) : ''].join(','));
    }
    download(`${fileSafe(meta.name)}.csv`, lines.join('\n'), 'text/csv');
  }

  function startRename(id, meta) {
    const head = document.querySelector(`[data-id="${id}"] .head span`);
    if (!head) return;
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = meta.name;
    head.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== meta.name) {
        meta.name = name;
        await putMeta(meta);
      }
      renderRecords();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  function fileSafe(s) { return String(s).replace(/[\\/:*?"<>|\s]+/g, '_'); }

  // 在 Claude 檢視器裡用平台的下載功能；一般瀏覽器用下載連結
  async function download(name, text, type) {
    const blob = new Blob([text], { type });
    let saver = null;
    try { saver = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (_) { saver = null; }
    if (saver) {
      try {
        await saver.save({ filename: name, data: blob });
        toast('已下載 ' + name);
      } catch (e) {
        if (e && e.code !== 'declined') toast('下載失敗：' + (e.message || e.code));
      }
      return;
    }
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
    let obj;
    try {
      obj = JSON.parse(await file.text());
      if (obj.format !== 'susp-gmeter' || !Array.isArray(obj.samples) || !obj.calib) throw new Error('不是這個 App 的備份檔');
    } catch (e) {
      toast('匯入失敗：' + e.message);
      return;
    }
    const samples = Float32Array.from(obj.samples);
    const track = Float32Array.from(Array.isArray(obj.gps) ? obj.gps : []);
    const name = obj.name || file.name;
    try {
      await storeRecording(samples, obj.calib, name, obj.created, track, obj.vehicle);
      toast('匯入完成');
    } catch (_) {
      // 這個瀏覽器不能存（例如私密模式）：不存，直接回放
      toast('這個瀏覽器無法儲存紀錄，改為直接回放（重新整理後會消失）', 6000);
      const data = { samples: samples.buffer, calib: obj.calib };
      if (track.length) data.gps = track.buffer;
      playData({ name, fs: obj.fs || obj.calib.fs, created: obj.created }, data);
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
      const res = A.analyzeRecording(pb.samples, pb.calib, settings, pb.meta.fs, pb.track);
      pb.series = res.series;
      seek(pb.t, true);
    }
  }

  // ---------- 車輛與記錄的設定 ----------
  // 內建車輛只放查得到來源的數值；查不到的欄位不填，保留使用者目前的值
  const VEHICLES = [
    {
      id: 'cmc-jspace',
      name: '中華 J SPACE（廂型車／貨車）',
      values: { wheelbase: 2610 },
      info: [
        '軸距 2,610 mm（廂型車與貨車相同，多個規格來源一致）',
        '車身 長 4,165 × 寬 1,685 × 高 1,955 mm（廂型車）',
        '後輪驅動；前懸吊麥花臣、後懸吊葉片彈簧（單一來源，未驗證）',
        '原廠胎 165R14C（部分車型為 15 吋）',
      ],
      missing: '前後輪距：查不到原廠數值（未驗證），請自己量左右輪胎中心的距離後填入下方欄位，再按「記錄目前設定」。',
    },
  ];

  let profiles = loadJSON('sgm.profiles', []);
  let activeVehicle = String(loadJSON('sgm.activeVehicle', '') || '');

  function activeVehicleName() {
    if (activeVehicle.startsWith('preset:')) {
      const v = VEHICLES.find((x) => 'preset:' + x.id === activeVehicle);
      return v ? v.name : '';
    }
    if (activeVehicle.startsWith('profile:')) return activeVehicle.slice(8);
    return '';
  }

  function renderVehicles() {
    const sel = $('#vehicleSelect');
    const opt = (value, text) => `<option value="${esc(value)}">${esc(text)}</option>`;
    sel.innerHTML = opt('', '— 自訂（使用下方目前數值）—') +
      `<optgroup label="內建車輛">${VEHICLES.map((v) => opt('preset:' + v.id, v.name)).join('')}</optgroup>` +
      (profiles.length
        ? `<optgroup label="已記錄的設定">${profiles.map((p) => opt('profile:' + p.name, p.name)).join('')}</optgroup>`
        : '');
    if (![...sel.options].some((o) => o.value === activeVehicle)) activeVehicle = '';
    sel.value = activeVehicle;
    $('#btnDeleteProfile').disabled = !activeVehicle.startsWith('profile:');
    if (activeVehicle.startsWith('profile:') && !$('#profileName').value) $('#profileName').value = activeVehicle.slice(8);
    const note = $('#vehicleNote');
    const v = VEHICLES.find((x) => 'preset:' + x.id === activeVehicle);
    if (v) {
      note.innerHTML = `<b>${esc(v.name)}</b><ul>${v.info.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` +
        `<div class="warn">${esc(v.missing)}</div>`;
    } else if (activeVehicle.startsWith('profile:')) {
      note.innerHTML = `使用中：<b>${esc(activeVehicle.slice(8))}</b>`;
    } else {
      note.innerHTML = '';
    }
  }

  function selectVehicle(value) {
    activeVehicle = value;
    saveJSON('sgm.activeVehicle', activeVehicle);
    if (value.startsWith('preset:')) {
      const v = VEHICLES.find((x) => 'preset:' + x.id === value);
      applySettings({ ...settings, ...v.values });
      toast(`已套用 ${v.name}`);
    } else if (value.startsWith('profile:')) {
      const p = profiles.find((x) => x.name === value.slice(8));
      applySettings({ ...DEFAULT_SETTINGS, ...p.settings });
      $('#profileName').value = p.name;
      toast(`已套用「${p.name}」`);
    }
    fillSettings();
    renderVehicles();
  }

  function saveProfile() {
    const name = $('#profileName').value.trim();
    if (!name) {
      toast('請先輸入這筆設定的名稱');
      $('#profileName').focus();
      return;
    }
    const s = readSettings();
    applySettings(s);
    const rest = profiles.filter((p) => p.name !== name);
    const replaced = rest.length !== profiles.length;
    profiles = [...rest, { name, settings: s, saved: Date.now() }].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    saveJSON('sgm.profiles', profiles);
    activeVehicle = 'profile:' + name;
    saveJSON('sgm.activeVehicle', activeVehicle);
    renderVehicles();
    toast(replaced ? `已更新「${name}」` : `已記錄「${name}」`);
  }

  function deleteProfile(btn) {
    if (!activeVehicle.startsWith('profile:')) return;
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = '再按一次刪除';
      btn.classList.add('danger');
      setTimeout(() => {
        btn.dataset.armed = '';
        btn.textContent = '刪除這筆記錄';
        btn.classList.remove('danger');
      }, 3000);
      return;
    }
    const name = activeVehicle.slice(8);
    profiles = profiles.filter((p) => p.name !== name);
    saveJSON('sgm.profiles', profiles);
    activeVehicle = '';
    saveJSON('sgm.activeVehicle', activeVehicle);
    $('#profileName').value = '';
    btn.dataset.armed = '';
    btn.textContent = '刪除這筆記錄';
    btn.classList.remove('danger');
    renderVehicles();
    toast(`已刪除「${name}」`);
  }

  // ---------- 分頁 ----------
  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + name));
    if (name === 'records') renderRecords();
    if (name === 'settings') { fillSettings(); renderVehicles(); }
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
  // 用 click 而不是 pointerdown：從曲線圖上開始捲動頁面時不會誤跳時間
  $('#chartCanvas').addEventListener('click', (e) => {
    if (!pb) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left - 44) / (r.width - 50);
    seek(pb.duration * Math.max(0, Math.min(1, frac)));
  });
  $('#recordList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('[data-id]').dataset.id);
    onRecordAction(id, btn.dataset.act, btn).catch((err) => toast(err.message));
  });
  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f);
  });
  $('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    applySettings(readSettings());
    toast('設定已儲存');
  });
  $('#btnDemo').addEventListener('click', openDemo);
  $('#vehicleSelect').addEventListener('change', (e) => selectVehicle(e.target.value));
  $('#btnSaveProfile').addEventListener('click', saveProfile);
  $('#btnDeleteProfile').addEventListener('click', (e) => deleteProfile(e.currentTarget));
  $('#profileName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveProfile(); } });
  $('#btnDefaults').addEventListener('click', () => {
    settings = { ...DEFAULT_SETTINGS };
    fillSettings();
  });

  window.addEventListener('beforeunload', (e) => {
    if (recording) { e.preventDefault(); e.returnValue = ''; }
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  drawCar(null);
  drawMetrics(null);
  // 還沒校正過：先開示範，讓第一眼就看得到 App 在做什麼
  if (!calib) openDemo();
  requestAnimationFrame(frame);
})();
