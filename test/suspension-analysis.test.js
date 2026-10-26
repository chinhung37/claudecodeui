'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../suspension-gmeter/analysis');

const G = A.G;
const FS = 100;
const DEG = 180 / Math.PI;

// 手機直立、螢幕朝駕駛：裝置 x = 車右、y = 車上、z = 車後
const R_TRUE = [[0, 0, -1], [-1, 0, 0], [0, 1, 0]];

function toDevice(R, v) {
  return [0, 1, 2].map((k) => R[0][k] * v[0] + R[1][k] * v[1] + R[2][k] * v[2]);
}

const SETTINGS = {
  wheelbase: 2700, trackF: 1550, trackR: 1550, phoneX: 1350, phoneY: 0,
  rideGate: 0.05, gyroMap: 'spec',
  flipLong: false, flipLat: false, flipPitch: false, flipRoll: false,
};

// 依車身運動產生手機原始讀值。profile(t) 回傳 { ax, ay (g), heave, pitchOsc }
function simulate(seconds, profile, k) {
  const out = [];
  let pitch = 0, roll = 0;
  const dt = 1 / FS;
  for (let i = 0; i < seconds * FS; i++) {
    const t = i * dt;
    const m = profile(t);
    const tp = m.ax < 0 ? k.dive * -m.ax : -k.squat * m.ax;
    const tr = m.ay > 0 ? k.rollL * m.ay : k.rollR * m.ay;
    const nPitch = pitch + ((tp / DEG) - pitch) * dt / 0.1 + (m.pitchOsc ? m.pitchOsc(t) : 0);
    const nRoll = roll + ((tr / DEG) - roll) * dt / 0.1;
    const q = (nPitch - pitch) / dt, p = (nRoll - roll) / dt;
    pitch = nPitch; roll = nRoll;
    const f = [m.ax * G - G * Math.sin(pitch), m.ay * G + G * Math.sin(roll),
      G * Math.cos(pitch) * Math.cos(roll) + (m.heave ? m.heave(t) : 0)];
    const acc = toDevice(R_TRUE, f);
    const w = toDevice(R_TRUE, [p, q, 0]).map((x) => x * DEG);
    out.push(t * 1000, acc[0], acc[1], acc[2], w[2], w[0], w[1]);
  }
  return Float64Array.from(out);
}

function calibFor(R) {
  return { R, gMag: G, gyroBias: [0, 0, 0], hasGyro: true };
}

test('buildFrame 由重力與「螢幕朝駕駛」預設還原出正確的車身座標', () => {
  const R = A.buildFrame([0, 9.8, 0], A.FORWARD_PRESETS.facingDriver);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) assert.ok(Math.abs(R[i][j] - R_TRUE[i][j]) < 1e-9);
  }
});

test('buildFrame 前進方向與重力平行時報錯', () => {
  assert.throws(() => A.buildFrame([0, 0, 9.8], [0, 0, 1]), /太接近/);
});

test('煞車點頭、加速蹲尾、左右過彎側傾的 deg/g 能被估回來', () => {
  const k = { dive: 2.5, squat: 1.2, rollL: 4, rollR: 5 };
  const profile = (t) => {
    if (t >= 2 && t < 5) return { ax: -0.6, ay: 0 };
    if (t >= 7 && t < 10) return { ax: 0.3, ay: 0 };
    if (t >= 12 && t < 16) return { ax: 0, ay: 0.5 };
    if (t >= 18 && t < 22) return { ax: 0, ay: -0.5 };
    return { ax: 0, ay: 0 };
  };
  const samples = simulate(24, profile, k);
  const { metrics } = A.analyzeRecording(samples, calibFor(R_TRUE), SETTINGS, FS);
  const near = (v, want) => assert.ok(v != null && Math.abs(v - want) / want < 0.15, `${v} ≈ ${want}`);
  near(metrics.dive, k.dive);
  near(metrics.squat, k.squat);
  near(metrics.rollL, k.rollL);
  near(metrics.rollR, k.rollR);
});

test('手機在前軸上方時，純俯仰振動只出現在後輪', () => {
  const settings = { ...SETTINGS, phoneX: 0 };
  const profile = () => ({
    ax: 0, ay: 0,
    heave: (t) => 0.5 * Math.sin(2 * Math.PI * 1.2 * t),
    pitchOsc: (t) => 0.0004 * Math.sin(2 * Math.PI * 8 * t),
  });
  const samples = simulate(20, profile, { dive: 0, squat: 0, rollL: 0, rollR: 0 });
  const { metrics } = A.analyzeRecording(samples, calibFor(R_TRUE), settings, FS);
  const r = metrics.ride;
  assert.ok(r.FL.ratio != null && r.RL.ratio != null);
  assert.ok(r.RL.ratio > 3 * r.FL.ratio, `後輪 ${r.RL.ratio} 應明顯大於前輪 ${r.FL.ratio}`);
  assert.ok(Math.abs(r.FL.ratio - r.FR.ratio) < 0.05 * r.RL.ratio);
});

test('沒有在動（低於門檻）時不累積路感統計', () => {
  const samples = simulate(10, () => ({ ax: 0, ay: 0 }), { dive: 0, squat: 0, rollL: 0, rollR: 0 });
  const { metrics } = A.analyzeRecording(samples, calibFor(R_TRUE), SETTINGS, FS);
  assert.equal(metrics.ride.FL.ratio, null);
  assert.equal(metrics.dive, null);
});

test('翻轉側向後，左右彎的歸屬互換', () => {
  const k = { dive: 0, squat: 0, rollL: 3, rollR: 6 };
  const profile = (t) => (t >= 2 && t < 6 ? { ax: 0, ay: 0.5 } : t >= 8 && t < 12 ? { ax: 0, ay: -0.5 } : { ax: 0, ay: 0 });
  const samples = simulate(14, profile, k);
  const flipped = { ...SETTINGS, flipLat: true, flipRoll: true };
  const { metrics } = A.analyzeRecording(samples, calibFor(R_TRUE), flipped, FS);
  assert.ok(Math.abs(metrics.rollL - 6) < 0.9 && Math.abs(metrics.rollR - 3) < 0.45);
});

test('hardness / vsBaseline 換算方向正確', () => {
  assert.equal(A.hardness(6, 6, 2), 0);
  assert.equal(A.hardness(2, 6, 2), 1);
  assert.equal(A.hardness(4, 6, 2), 0.5);
  assert.equal(A.hardness(null, 6, 2), null);
  assert.ok(Math.abs(A.vsBaseline(2, 2.5, true) - 25) < 1e-9);
  assert.ok(Math.abs(A.vsBaseline(1.2, 1.0, false) - 20) < 1e-9);
});

test('staticCalibration 取出重力、零點與取樣率', () => {
  const s = [];
  for (let i = 0; i < 200; i++) s.push(i * 10, 0.01, 9.8, -0.02, 0.3, -0.1, 0.2);
  const c = A.staticCalibration(Float64Array.from(s));
  assert.ok(Math.abs(c.fs - 100) < 1e-6);
  assert.ok(Math.abs(c.gMag - 9.8) < 0.01);
  assert.deepEqual(c.gyroBias.map((x) => Math.round(x * 10) / 10), [0.3, -0.1, 0.2]);
  assert.equal(c.hasGyro, true);
});

test('ForwardDetector 從起步加速找出前方', () => {
  const gravity = toDevice(R_TRUE, [0, 0, G]);
  const det = new A.ForwardDetector(gravity, FS);
  let done = false;
  for (let i = 0; i < 400 && !done; i++) {
    const f = toDevice(R_TRUE, [i > 50 ? 2.5 : 0, 0, G]);
    done = det.add(f[0], f[1], f[2]);
  }
  assert.ok(done);
  const R = A.buildFrame(gravity, det.forward());
  assert.ok(R[0][2] < -0.99, '前方應為裝置 -z');
});

test('gyroCheck 在規範軸對應下呈強正相關', () => {
  // 左右彎：側向 G 與偏航角速度同號
  const out = [];
  for (let i = 0; i < 20 * FS; i++) {
    const t = i / FS;
    const ay = 0.4 * Math.sin(2 * Math.PI * t / 6);
    const r = ay * G / 15; // v = 15 m/s
    const acc = toDevice(R_TRUE, [0, ay * G, G]);
    const w = toDevice(R_TRUE, [0, 0, r]).map((x) => x * DEG);
    out.push(t * 1000, acc[0], acc[1], acc[2], w[2], w[0], w[1]);
  }
  const c = A.gyroCheck(Float64Array.from(out), calibFor(R_TRUE), FS);
  assert.ok(c.spec > 0.9, `spec=${c.spec}`);
  assert.ok(c.alt == null || c.alt < 0.5, `alt=${c.alt}`);
});
