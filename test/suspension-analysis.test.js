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
  rideGate: 0.05, gyroAxes: 'spec',
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

test('手機在前軸上方時，車身俯仰擺動（低頻）只出現在後輪', () => {
  const settings = { ...SETTINGS, phoneX: 0 };
  const profile = () => ({
    ax: 0, ay: 0,
    heave: (t) => 0.5 * Math.sin(2 * Math.PI * 1.2 * t) + 0.3 * Math.sin(2 * Math.PI * 9 * t),
    pitchOsc: (t) => 0.0004 * Math.sin(2 * Math.PI * 1.5 * t),
  });
  const samples = simulate(20, profile, { dive: 0, squat: 0, rollL: 0, rollR: 0 });
  const { metrics } = A.analyzeRecording(samples, calibFor(R_TRUE), settings, FS);
  const r = metrics.ride;
  assert.ok(r.FL.ratio != null && r.RL.ratio != null);
  assert.ok(r.RL.lo > 1.5 * r.FL.lo, `後輪擺動 ${r.RL.lo} 應明顯大於前輪 ${r.FL.lo}`);
  assert.ok(Math.abs(r.FL.lo - r.FR.lo) < 0.02 * r.FL.lo);
});

test('四輪投影：低頻車身俯仰按距離分配，手機在支架上的高頻晃動不會被放大', () => {
  // 1.5 Hz 車身起伏與同相俯仰：前輪 = 0.4 + α·1.1，後輪 = |0.4 − α·1.6|（手機距前軸 1.1 m、後軸 1.6 m）
  const wl = 2 * Math.PI * 1.5, amp = 0.0015;
  const alpha = amp * wl * wl;
  const want = (0.4 + alpha * 1.1) / Math.abs(0.4 - alpha * 1.6);
  // 9 Hz：手機自己在支架上晃（角度），加上量測點本身 0.3 m/s² 的路面震動
  const wh = 2 * Math.PI * 9, wobble = 0.0005;
  for (const fs of [60, 100, 200]) {
    const out = [];
    let prev = 0;
    for (let i = 0; i < 30 * fs; i++) {
      const t = i / fs;
      const ang = amp * Math.sin(wl * t) + wobble * Math.sin(wh * t);
      const q = i ? (ang - prev) * fs : 0;
      prev = ang;
      const f = toDevice(R_TRUE, [0, 0, G + 0.4 * Math.sin(wl * t) + 0.3 * Math.sin(wh * t)]);
      const gy = toDevice(R_TRUE, [0, q, 0]).map((x) => x * DEG);
      out.push(t * 1000, f[0], f[1], f[2], gy[2], gy[0], gy[1]);
    }
    const settings = { ...SETTINGS, phoneX: 1100, rideGate: 0.1 };
    const { metrics } = A.analyzeRecording(Float64Array.from(out), calibFor(R_TRUE), settings, fs);
    const r = metrics.ride;
    const got = r.FL.lo / r.RL.lo;
    assert.ok(Math.abs(got - want) / want < 0.1, `fs=${fs} 低頻前後比 ${got} ≈ ${want}`);
    // 高頻四輪相同，等於量測點本身（0.3 振幅 ≈ 0.21 RMS），不會被晃動放大到 1 m/s² 以上
    for (const c of A.CORNERS) assert.ok(Math.abs(r[c].hi - r.FL.hi) < 1e-9 && r[c].hi < 0.3, `fs=${fs} ${c} hi=${r[c].hi}`);
  }
});

test('從停止起步加速時，GPS 還顯示 0 也不會把蹲尾歸零', () => {
  const fs = 60, out = [], gps = [];
  let pitch = 0, prev = 0, v = 0;
  for (let i = 0; i < 20 * fs; i++) {
    const t = i / fs;
    const ax = t >= 5 && t < 9 ? 0.3 : 0;
    v += ax * G / fs;
    // GPS 一秒一筆，起步那一秒仍是 0
    if (i % fs === 0) gps.push(t * 1000, v);
    pitch += ((-1.4 * ax) / DEG - pitch) / fs / 0.12;
    const q = i ? (pitch - prev) * fs : 0;
    prev = pitch;
    const f = toDevice(R_TRUE, [ax * G - G * Math.sin(pitch), 0, G]);
    const gy = toDevice(R_TRUE, [0, q, 0]).map((x) => x * DEG);
    out.push(t * 1000, f[0], f[1], f[2], gy[2], gy[0], gy[1]);
  }
  const { metrics } = A.analyzeRecording(Float64Array.from(out), calibFor(R_TRUE), { ...SETTINGS, gyroAxes: 'spec' }, fs, Float32Array.from(gps));
  assert.ok(Math.abs(metrics.squat - 1.4) < 0.2, `squat=${metrics.squat}`);
  assert.ok(metrics.r2.squat > 0.9);
});

test('示範資料：各項指標都有值，陀螺儀軸檢查判定標準對應', () => {
  const D = require('../suspension-gmeter/demo');
  const d = D.simulateDrive();
  const { metrics } = A.analyzeRecording(d.samples, d.calib, { ...SETTINGS, phoneX: 1100, rideGate: 0.2 }, d.fs);
  for (const k of ['dive', 'squat', 'rollL', 'rollR']) assert.ok(metrics[k] > 0, k);
  for (const c of A.CORNERS) assert.ok(metrics.ride[c].ratio > 0, c);
  assert.ok(metrics.ride.FL.ratio > metrics.ride.RL.ratio, '示範車設定為前硬後軟');
  assert.ok(A.gyroCheck(d.samples, d.calib, d.fs).spec > 0.9);
});

test('SpeedTrack 沿用最近一筆時速，超過 3 秒沒更新就當不知道', () => {
  const s = new A.SpeedTrack(Float32Array.from([0, 10, 1000, 20]));
  assert.equal(s.at(-1), null);
  assert.equal(s.at(500), 10);
  assert.equal(s.at(1500), 20);
  assert.equal(s.at(4001), null);
  assert.equal(new A.SpeedTrack(null).at(0), null);
});

test('speedBand 依 km/h 分段', () => {
  assert.equal(A.speedBand(0), 0);
  assert.equal(A.speedBand(29.9), 0);
  assert.equal(A.speedBand(30), 1);
  assert.equal(A.speedBand(60), 2);
  assert.equal(A.speedBand(null), -1);
});

test('同一台車只錄低速段：不分車速比會誤判變軟，分時速段比較則接近 0%', () => {
  const D = require('../suspension-gmeter/demo');
  const d = D.simulateDrive();
  const settings = { ...SETTINGS, phoneX: 1100, rideGate: 0.2 };
  const base = A.analyzeRecording(d.samples, d.calib, settings, d.fs, d.gps).metrics;
  const cur = A.analyzeRecording(d.samples.subarray(0, 35 * d.fs * A.STRIDE), d.calib, settings, d.fs,
    d.gps.subarray(0, 36 * A.GPS_STRIDE)).metrics;
  for (const c of A.CORNERS) {
    const naive = A.vsBaseline(cur.ride[c].ratio, base.ride[c].ratio, false);
    const matched = A.compareRide(cur, base, c);
    assert.ok(naive < -8, `${c} 不分車速：${naive}`);
    assert.ok(matched.matched && Math.abs(matched.pct) < 5, `${c} 分段：${matched.pct}`);
  }
});

test('compareRide 沒有共同時速段時退回整體比值', () => {
  const D = require('../suspension-gmeter/demo');
  const d = D.simulateDrive();
  const settings = { ...SETTINGS, phoneX: 1100, rideGate: 0.2 };
  const withGps = A.analyzeRecording(d.samples, d.calib, settings, d.fs, d.gps).metrics;
  const noGps = A.analyzeRecording(d.samples, d.calib, settings, d.fs, null).metrics;
  const r = A.compareRide(noGps, withGps, 'FL');
  assert.equal(r.matched, false);
  assert.ok(Math.abs(r.pct) < 1e-9);
  assert.equal(noGps.speedMax, null);
  assert.equal(withGps.speedMax, 72);
});

// 有偏航的過彎＋煞車到停。order：手機 rotationRate 的軸序；gyroSign：陀螺儀整體正負號
function simulateTurnsAndStop(order, gyroSign) {
  const fs = 60;
  const out = [], gps = [];
  let pitch = 0, roll = 0, pp = 0, pr = 0;
  for (let i = 0; i < 50 * fs; i++) {
    const t = i / fs;
    let ax = 0, ay = 0;
    if (t >= 5 && t < 11) ay = 0.4;
    if (t >= 14 && t < 20) ay = -0.4;
    if (t >= 24 && t < 27) ax = -0.5;
    const kmh = t < 24 ? 45 : t < 27 ? 45 * (27 - t) / 3 : 0;
    if (i % fs === 0) gps.push(t * 1000, kmh / 3.6);
    pitch += ((ax < 0 ? 2.5 * -ax : 0) / DEG - pitch) / fs / 0.12;
    roll += (4 * ay / DEG - roll) / fs / 0.12;
    const q = i ? (pitch - pp) * fs : 0, p = i ? (roll - pr) * fs : 0;
    pp = pitch; pr = roll;
    const r = kmh > 0 ? ay * G / (kmh / 3.6) : 0;
    const f = toDevice(R_TRUE, [ax * G - G * Math.sin(pitch), ay * G + G * Math.sin(roll), G]);
    const w = toDevice(R_TRUE, [p, q, r]).map((x) => x * DEG * gyroSign);
    // 規範：alpha=z、beta=x、gamma=y；替代：alpha=x、beta=y、gamma=z
    const rate = order === 'alt' ? [w[0], w[1], w[2]] : [w[2], w[0], w[1]];
    out.push(t * 1000, f[0], f[1], f[2], ...rate);
  }
  return { samples: Float64Array.from(out), gps: Float32Array.from(gps), fs };
}

for (const [order, sign, label] of [['spec', 1, '標準軸序'], ['alt', 1, '替代軸序']]) {
  test(`陀螺儀軸對應自動判斷：${label}`, () => {
    const d = simulateTurnsAndStop(order, sign);
    const settings = { ...SETTINGS, gyroAxes: 'auto' };
    const { metrics } = A.analyzeRecording(d.samples, calibFor(R_TRUE), settings, d.fs, d.gps);
    assert.equal(metrics.axes.decided, true);
    assert.equal(metrics.axes.mapping, order);
    assert.equal(metrics.axes.sign, sign);
    // 判斷出來之前的資料會清掉，右彎在判斷之後，應能估回 4 deg/g
    assert.ok(Math.abs(metrics.rollR - 4) < 0.6, `rollR=${metrics.rollR}`);
    assert.ok(Math.abs(metrics.dive - 2.5) < 0.4, `dive=${metrics.dive}`);
  });
}

test('軸對應設錯時：停車後橫向 G 1 秒內歸零（不會卡在假的側傾）', () => {
  const d = simulateTurnsAndStop('alt', 1);
  const settings = { ...SETTINGS, gyroAxes: 'spec' };
  const { series, metrics } = A.analyzeRecording(d.samples, calibFor(R_TRUE), settings, d.fs, d.gps);
  for (let i = 0; i < series.t.length; i++) {
    if (series.t[i] < 28000) continue;
    assert.ok(Math.abs(series.axg[i]) < 0.03 && Math.abs(series.ayg[i]) < 0.03, `t=${series.t[i]} ${series.axg[i]}/${series.ayg[i]}`);
    assert.ok(Math.abs(series.roll[i]) <= A.MAX_BODY_DEG && Math.abs(series.pitch[i]) <= A.MAX_BODY_DEG);
  }
  assert.ok(metrics.anomalies > 0, '應記錄到不合理的傾角');
});

test('GPS 顯示停車時，車身傾角很快歸零', () => {
  const d = simulateTurnsAndStop('spec', 1);
  const { series } = A.analyzeRecording(d.samples, calibFor(R_TRUE), { ...SETTINGS, gyroAxes: 'spec' }, d.fs, d.gps);
  const i = series.t.findIndex((t) => t >= 29000);
  assert.ok(Math.abs(series.pitch[i]) < 0.1 && Math.abs(series.roll[i]) < 0.1);
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
