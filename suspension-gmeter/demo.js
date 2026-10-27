'use strict';

// 模擬行車示範資料：產生跟手機一樣格式的原始讀值，讓沒上車也能看介面怎麼運作。
// 數值是虛構的，畫面上會標示「模擬資料」。
(function (root, factory) {
  const api = factory(root.SuspAnalysis || (typeof require === 'function' ? require('./analysis') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SuspDemo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (A) {
  const G = A.G;
  const DEG = 180 / Math.PI;
  // 手機直立、螢幕朝駕駛：裝置 x = 車右、y = 車上、z = 車後
  const R_DEV = [[0, 0, -1], [-1, 0, 0], [0, 1, 0]];

  // [開始秒, 結束秒, 縱向 g, 側向 g]，前後各 0.4 秒平順過渡
  const ROUTE = [
    [3, 7, 0.3, 0], [10, 13, -0.6, 0], [16, 21, 0, 0.5], [24, 29, 0, -0.5],
    [33, 36, -0.4, 0], [39, 42, 0.25, 0], [45, 50, 0, 0.4], [53, 58, 0, -0.4],
  ];
  const DEFAULT_CAR = { dive: 3.2, squat: 1.4, rollL: 6.5, rollR: 3.9 };

  function toDevice(v) {
    return [0, 1, 2].map((k) => R_DEV[0][k] * v[0] + R_DEV[1][k] * v[1] + R_DEV[2][k] * v[2]);
  }

  function smooth(t, t0, t1) {
    const r = 0.4;
    if (t <= t0 - r || t >= t1 + r) return 0;
    if (t < t0) return 0.5 - 0.5 * Math.cos(Math.PI * (t - t0 + r) / r);
    if (t > t1) return 0.5 + 0.5 * Math.cos(Math.PI * (t - t1) / r);
    return 1;
  }

  // 可重現的亂數（每次示範都長一樣）
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296 - 0.5;
    };
  }

  function simulateDrive(opts = {}) {
    const fs = opts.fs || 100;
    const seconds = opts.seconds || 61;
    const car = { ...DEFAULT_CAR, ...(opts.car || {}) };
    const rnd = rng(opts.seed || 7);
    const n = Math.round(seconds * fs);
    const out = new Float32Array(n * A.STRIDE);
    const gps = [];
    const dt = 1 / fs;
    let pitch = 0, roll = 0, pPrev = 0, rPrev = 0;
    for (let i = 0; i < n; i++) {
      const t = i * dt;
      let ax = 0, ay = 0;
      for (const [t0, t1, gx, gy] of ROUTE) {
        const k = smooth(t, t0, t1);
        ax += gx * k; ay += gy * k;
      }
      const kmh = speedAt(t);
      const v = kmh / 3.6;
      // GPS 一秒一筆
      if (i % fs === 0) gps.push(t * 1000, v);
      const moving = kmh > 3;
      // 車速越快，路面傳上來的高頻震動越大
      const road = 0.5 + kmh / 80;
      const tp = ax < 0 ? car.dive * -ax : -car.squat * ax;
      const tr = ay > 0 ? car.rollL * ay : car.rollR * ay;
      pitch += (tp / DEG - pitch) * dt / 0.12;
      roll += (tr / DEG - roll) * dt / 0.12;
      // 路面：車身起伏（低頻）＋ 路面細震（高頻）
      const heave = moving ? 0.55 * Math.sin(2 * Math.PI * 1.25 * t) + 0.25 * Math.sin(2 * Math.PI * 0.8 * t + 1) : 0;
      const hiZ = moving ? road * 0.69 * Math.sin(2 * Math.PI * 9 * t) : 0;
      // 車身俯仰擺動（1.6 Hz）讓後軸上下動得比前軸多 = 後軟；9 Hz 是手機在支架上的小晃動
      const pOsc = moving ? road * 0.00004 * Math.sin(2 * Math.PI * 9 * t) + 0.004 * Math.sin(2 * Math.PI * 1.6 * t) : 0;
      const rOsc = moving ? 0.0003 * Math.sin(2 * Math.PI * 7 * t) : 0;
      const pAng = pitch + pOsc, rAng = roll + rOsc;
      const q = i ? (pAng - pPrev) / dt : 0;
      const p = i ? (rAng - rPrev) / dt : 0;
      pPrev = pAng; rPrev = rAng;
      const r = moving ? ay * G / Math.max(v, 3) : 0;
      const f = [
        ax * G - G * Math.sin(pAng) + rnd() * 0.08,
        ay * G + G * Math.sin(rAng) + rnd() * 0.08,
        G * Math.cos(pAng) * Math.cos(rAng) + heave + hiZ + rnd() * 0.08,
      ];
      const acc = toDevice(f);
      const w = toDevice([p, q, r]).map((x) => x * DEG + rnd() * 0.15);
      out.set([t * 1000, acc[0], acc[1], acc[2], w[2], w[0], w[1]], i * A.STRIDE);
    }
    const calib = {
      R: A.buildFrame(toDevice([0, 0, G]), A.FORWARD_PRESETS.facingDriver),
      gMag: G, gyroBias: [0, 0, 0], hasGyro: true, fs, created: 0,
    };
    return { samples: out, gps: Float32Array.from(gps), calib, fs, car };
  }

  // 示範路線的時速（km/h），關鍵點之間線性內插
  const SPEED_POINTS = [
    [0, 0], [3, 0], [7, 45], [10, 45], [13, 22], [16, 25], [29, 28], [33, 40],
    [36, 20], [39, 30], [42, 72], [61, 72],
  ];
  function speedAt(t) {
    for (let i = 1; i < SPEED_POINTS.length; i++) {
      const [t1, v1] = SPEED_POINTS[i];
      if (t <= t1) {
        const [t0, v0] = SPEED_POINTS[i - 1];
        return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
      }
    }
    return SPEED_POINTS[SPEED_POINTS.length - 1][1];
  }

  return { simulateDrive, DEFAULT_CAR };
});
