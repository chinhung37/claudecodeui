'use strict';

// 避震軟硬分析核心：純運算，不碰 DOM，瀏覽器與 Node 測試共用。
//
// 座標系（車身）：X 向前、Y 向左、Z 向上（右手系）。
//   p = 繞 X 的角速度（正值 = 左側上升、車身向右傾）
//   q = 繞 Y 的角速度（正值 = 車頭下沉）
//   r = 繞 Z 的角速度（正值 = 向左轉）
// 手機原始資料（W3C DeviceMotionEvent）：
//   accelerationIncludingGravity：m/s²，靜止時指向「上」（平放螢幕朝上 = z +9.8）
//   rotationRate：deg/s，規範上 alpha=繞 z、beta=繞 x、gamma=繞 y
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SuspAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const G = 9.80665;
  const RAD = Math.PI / 180;
  const DEG = 180 / Math.PI;

  // 錄製資料每筆 7 個數：時間(ms)、加速度含重力 x,y,z、rotationRate alpha,beta,gamma
  const STRIDE = 7;

  // 判定「穩定煞車 / 加速 / 過彎」的門檻（單位 g）
  const GATE = {
    neutral: 0.05,
    longMin: 0.15,
    longCrossMax: 0.1,
    latMin: 0.2,
    latCrossMax: 0.15,
  };

  const CORNERS = ['FL', 'FR', 'RL', 'RR'];

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function norm(a) { return Math.sqrt(dot(a, a)); }
  function scale(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function unit(a) {
    const n = norm(a);
    return n > 1e-9 ? scale(a, 1 / n) : null;
  }

  // 由「靜止重力向量」與「前進方向提示」(皆為手機座標) 建立 手機→車身 旋轉矩陣。
  // 回傳 3 列：車身 X、Y、Z 軸在手機座標下的單位向量。
  function buildFrame(gravity, forwardHint) {
    const up = unit(gravity);
    if (!up) throw new Error('重力向量無效');
    const horiz = sub(forwardHint, scale(up, dot(forwardHint, up)));
    const hn = norm(horiz);
    if (hn < 0.3 * norm(forwardHint) || hn < 1e-6) {
      throw new Error('前進方向和重力方向太接近，無法判定前方');
    }
    const fwd = scale(horiz, 1 / hn);
    return [fwd, cross(up, fwd), up];
  }

  function toCar(R, v) { return [dot(R[0], v), dot(R[1], v), dot(R[2], v)]; }

  // rotationRate(alpha,beta,gamma deg/s) → 手機座標角速度 (x,y,z rad/s)
  function gyroDevice(alpha, beta, gamma, mapping) {
    if (mapping === 'alt') return [alpha * RAD, beta * RAD, gamma * RAD];
    return [beta * RAD, gamma * RAD, alpha * RAD];
  }

  // 前進方向預設（手機座標）。螢幕朝駕駛時，不論直放或橫放，前方都是 -z。
  const FORWARD_PRESETS = {
    facingDriver: [0, 0, -1],
    flatTopForward: [0, 1, 0],
  };

  // 二階 Butterworth（RBJ biquad）
  class Biquad {
    constructor(type, fc, fs) {
      const f = Math.min(fc, fs * 0.45);
      const w0 = 2 * Math.PI * f / fs;
      const cw = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
      let b0, b1, b2;
      if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
      else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
      const a0 = 1 + alpha;
      this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
      this.a1 = -2 * cw / a0; this.a2 = (1 - alpha) / a0;
      this.x1 = this.x2 = this.y1 = this.y2 = 0;
    }
    step(x) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      return y;
    }
  }

  class Band {
    constructor(lo, hi, fs) { this.hp = new Biquad('hp', lo, fs); this.lp = new Biquad('lp', hi, fs); }
    step(x) { return this.lp.step(this.hp.step(x)); }
  }

  // 過原點的線性回歸：角度 = 斜率 × g，斜率即 deg/g
  class Gradient {
    constructor() { this.sxx = 0; this.sxy = 0; this.n = 0; }
    add(x, y) { this.sxx += x * x; this.sxy += x * y; this.n++; }
    value(minN) { return this.n >= minN && this.sxx > 0 ? this.sxy / this.sxx : null; }
  }

  // 低頻 0.5–3 Hz（車身起伏）與高頻 4–15 Hz（路面傳入的硬度）
  const RIDE_LO = [0.5, 3];
  const RIDE_HI = [4, 15];

  // 四輪相對手機的位置（公尺，車身座標）
  function cornerOffsets(s) {
    const wb = s.wheelbase / 1000, tf = s.trackF / 2000, tr = s.trackR / 2000;
    const px = -s.phoneX / 1000, py = s.phoneY / 1000;
    return {
      FL: [0 - px, tf - py],
      FR: [0 - px, -tf - py],
      RL: [-wb - px, tr - py],
      RR: [-wb - px, -tr - py],
    };
  }

  // 路感比依時速分段統計（km/h）：車速越快路面高頻輸入越多，跨車速比較會失真
  const SPEED_BANDS = [
    { label: '0–30', from: 0, to: 30 },
    { label: '30–60', from: 30, to: 60 },
    { label: '60 以上', from: 60, to: Infinity },
  ];
  // GPS 超過這麼久沒更新就當作不知道時速
  const GPS_STALE_MS = 3000;
  const GPS_STRIDE = 2; // 錄製的 GPS 軌跡每筆：時間(ms，與感測資料同一時間軸)、時速(m/s)

  function speedBand(kmh) {
    if (kmh == null || !isFinite(kmh)) return -1;
    return SPEED_BANDS.findIndex((b) => kmh >= b.from && kmh < b.to);
  }

  function emptyRide() {
    const o = {};
    for (const c of CORNERS) o[c] = { lo2: 0, hi2: 0, n: 0, wLo2: 0, wHi2: 0 };
    return o;
  }

  // 依時間取 GPS 時速（沿用最近一筆；太舊就回 null）。時間需遞增查詢。
  class SpeedTrack {
    constructor(gps) {
      this.g = gps && gps.length >= GPS_STRIDE ? gps : null;
      this.i = -1;
    }
    at(t) {
      const g = this.g;
      if (!g) return null;
      while (this.i + 1 < g.length / GPS_STRIDE && g[(this.i + 1) * GPS_STRIDE] <= t) this.i++;
      if (this.i < 0) return null;
      const o = this.i * GPS_STRIDE;
      return t - g[o] <= GPS_STALE_MS ? g[o + 1] : null;
    }
  }

  class Processor {
    // calib: { R, gMag, gyroBias:[alpha,beta,gamma], hasGyro }
    // settings: 幾何、翻轉、陀螺儀軸對應、rideGate…
    constructor(calib, settings, fs) {
      this.calib = calib;
      this.s = settings;
      this.fs = fs;
      this.minN = Math.max(10, Math.round(fs * 1));
      this.offsets = cornerOffsets(settings);
      this.signs = {
        long: settings.flipLong ? -1 : 1,
        lat: settings.flipLat ? -1 : 1,
        pitch: settings.flipPitch ? -1 : 1,
        roll: settings.flipRoll ? -1 : 1,
      };
      this.lpAx = new Biquad('lp', 2, fs);
      this.lpAy = new Biquad('lp', 2, fs);
      // 垂直加速度與角速度走同一個低通，四輪投影時相位才對得上
      this.lpP = new Biquad('lp', 20, fs);
      this.lpQ = new Biquad('lp', 20, fs);
      this.lpZ = new Biquad('lp', 20, fs);
      this.bands = {};
      for (const c of CORNERS) {
        this.bands[c] = { lo: new Band(RIDE_LO[0], RIDE_LO[1], fs), hi: new Band(RIDE_HI[0], RIDE_HI[1], fs) };
      }
      this.reset();
    }

    reset() {
      this.tPrev = null;
      this.rollInt = 0; this.pitchInt = 0;
      this.refRoll = 0; this.refPitch = 0;
      this.roll = 0; this.pitch = 0;
      this.axF = 0; this.ayF = 0;
      this.pPrev = 0; this.qPrev = 0; this.zPrev = 0;
      this.gateMs = 0;
      this.grad = { dive: new Gradient(), squat: new Gradient(), rollL: new Gradient(), rollR: new Gradient() };
      this.ride = emptyRide();
      this.rideBands = SPEED_BANDS.map(emptyRide);
      this.speedMax = null;
      this.count = 0;
      this.duration = 0;
    }

    // 只清統計，保留濾波器/角度狀態（給「重設統計」按鈕用）
    resetStats() {
      for (const k of Object.keys(this.grad)) this.grad[k] = new Gradient();
      this.ride = emptyRide();
      this.rideBands = SPEED_BANDS.map(emptyRide);
      this.speedMax = null;
      this.duration = 0;
    }

    // speed：GPS 時速 m/s，不知道就給 null
    step(t, ax, ay, az, ra, rb, rg, speed) {
      const dt = this.tPrev == null ? 1 / this.fs : Math.min(0.1, Math.max(0.001, (t - this.tPrev) / 1000));
      this.tPrev = t;
      this.count++;
      this.duration += dt;
      const { R, gMag, gyroBias, hasGyro } = this.calib;
      const sg = this.signs;

      const f = toCar(R, [ax, ay, az]);
      const fx = f[0] * sg.long;
      const fy = f[1] * sg.lat;
      const fz = f[2] - gMag;

      let p = 0, q = 0, r = 0;
      if (hasGyro) {
        const w = toCar(R, gyroDevice(ra - gyroBias[0], rb - gyroBias[1], rg - gyroBias[2], this.s.gyroMap));
        p = w[0] * sg.roll; q = w[1] * sg.pitch; r = w[2];
      }

      // 姿態：陀螺儀積分；車身回到「無加減速、無側向 G」時把參考點拉回，消除漂移
      this.rollInt += p * dt;
      this.pitchInt += q * dt;
      const neutral = Math.abs(this.axF) < GATE.neutral * G && Math.abs(this.ayF) < GATE.neutral * G;
      const k = neutral ? Math.min(1, dt / 0.5) : Math.min(1, dt / 30);
      this.refRoll += (this.rollInt - this.refRoll) * k;
      this.refPitch += (this.pitchInt - this.refPitch) * k;
      this.roll = this.rollInt - this.refRoll;
      this.pitch = this.pitchInt - this.refPitch;

      // 車身傾斜會讓重力分量混進縱/橫向 G，用姿態扣掉
      const axTrue = fx + G * Math.sin(this.pitch);
      const ayTrue = fy - G * Math.sin(this.roll);
      this.axF = this.lpAx.step(axTrue);
      this.ayF = this.lpAy.step(ayTrue);
      const axg = this.axF / G, ayg = this.ayF / G;
      const pitchDeg = this.pitch * DEG, rollDeg = this.roll * DEG;

      if (hasGyro) {
        if (Math.abs(axg) >= GATE.longMin && Math.abs(ayg) < GATE.longCrossMax) {
          if (axg < 0) this.grad.dive.add(-axg, pitchDeg);
          else this.grad.squat.add(axg, -pitchDeg);
        }
        if (Math.abs(ayg) >= GATE.latMin && Math.abs(axg) < GATE.latCrossMax) {
          if (ayg > 0) this.grad.rollL.add(ayg, rollDeg);
          else this.grad.rollR.add(-ayg, -rollDeg);
        }
      }

      // 四輪垂直加速度：剛體投影 a_z + ṗ·dy − q̇·dx
      // 後向差分落在兩個取樣中間，垂直加速度也取前後平均對齊這半個取樣
      const pF = this.lpP.step(p), qF = this.lpQ.step(q), zF = this.lpZ.step(fz);
      const dp = (pF - this.pPrev) / dt, dq = (qF - this.qPrev) / dt;
      const zMid = (zF + this.zPrev) / 2;
      this.pPrev = pF; this.qPrev = qF; this.zPrev = zF;
      const warm = this.count > this.fs * 2;
      let gateSum = 0;
      const vals = {};
      for (const c of CORNERS) {
        const [dx, dy] = this.offsets[c];
        const z = zMid + dp * dy - dq * dx;
        const lo = this.bands[c].lo.step(z);
        const hi = this.bands[c].hi.step(z);
        vals[c] = [lo, hi];
        gateSum += lo * lo + hi * hi;
      }
      this.gateMs += (gateSum / 4 - this.gateMs) * Math.min(1, dt / 1);
      const moving = warm && Math.sqrt(this.gateMs) > this.s.rideGate;
      const kw = Math.min(1, dt / 4);
      const kmh = speed != null && isFinite(speed) && speed >= 0 ? speed * 3.6 : null;
      if (kmh != null) this.speedMax = Math.max(this.speedMax || 0, kmh);
      const band = speedBand(kmh);
      for (const c of CORNERS) {
        if (!moving) continue;
        const [lo, hi] = vals[c];
        const st = this.ride[c];
        st.lo2 += lo * lo; st.hi2 += hi * hi; st.n++;
        st.wLo2 += (lo * lo - st.wLo2) * kw;
        st.wHi2 += (hi * hi - st.wHi2) * kw;
        if (band >= 0) {
          const sb = this.rideBands[band][c];
          sb.lo2 += lo * lo; sb.hi2 += hi * hi; sb.n++;
        }
      }

      return {
        t, axg, ayg, pitchDeg, rollDeg,
        yawDeg: r * DEG,
        speedKmh: kmh,
        moving,
        hasGyro,
      };
    }

    rideRatio(st) {
      return st.n >= this.minN && st.lo2 > 0 ? Math.sqrt(st.hi2 / st.lo2) : null;
    }

    metrics() {
      const ride = {};
      for (const c of CORNERS) {
        const st = this.ride[c];
        ride[c] = {
          lo: st.n ? Math.sqrt(st.lo2 / st.n) : null,
          hi: st.n ? Math.sqrt(st.hi2 / st.n) : null,
          ratio: this.rideRatio(st),
          live: st.wLo2 > 0 ? Math.sqrt(st.wHi2 / st.wLo2) : null,
          seconds: st.n / this.fs,
        };
      }
      const rideBands = SPEED_BANDS.map((b, i) => {
        const corners = {};
        for (const c of CORNERS) {
          const st = this.rideBands[i][c];
          corners[c] = { ratio: this.rideRatio(st), seconds: st.n / this.fs };
        }
        return { label: b.label, from: b.from, to: b.to, corners };
      });
      const g = this.grad;
      return {
        dive: g.dive.value(this.minN),
        squat: g.squat.value(this.minN),
        rollL: g.rollL.value(this.minN),
        rollR: g.rollR.value(this.minN),
        seconds: {
          dive: g.dive.n / this.fs, squat: g.squat.n / this.fs,
          rollL: g.rollL.n / this.fs, rollR: g.rollR.n / this.fs,
        },
        ride,
        rideBands,
        speedMax: this.speedMax,
        duration: this.duration,
      };
    }
  }

  // 路感比與基準比較：兩邊都有 GPS 時，只比同一時速段，再依這次各段的秒數加權；
  // 沒有共同時速段時退回整體比值（matched = false）。回傳「變硬多少 %」。
  function compareRide(cur, base, corner) {
    if (!cur || !base) return null;
    if (cur.rideBands && base.rideBands) {
      let wSum = 0, pSum = 0;
      cur.rideBands.forEach((b, i) => {
        const a = b.corners[corner], z = base.rideBands[i] && base.rideBands[i].corners[corner];
        if (!a || !z || a.ratio == null || z.ratio == null || z.ratio === 0) return;
        wSum += a.seconds;
        pSum += a.seconds * (a.ratio / z.ratio - 1) * 100;
      });
      if (wSum > 0) return { pct: pSum / wSum, matched: true };
    }
    const a = cur.ride && cur.ride[corner], z = base.ride && base.ride[corner];
    const pct = vsBaseline(a && a.ratio, z && z.ratio, false);
    return pct == null ? null : { pct, matched: false };
  }

  // 依「越小越硬」或「越大越硬」換成 0(軟)…1(硬)
  function hardness(value, softAt, hardAt) {
    if (value == null || !isFinite(value) || softAt === hardAt) return null;
    const s = (value - softAt) / (hardAt - softAt);
    return Math.max(0, Math.min(1, s));
  }

  // 與基準比較：回傳「變硬多少 %」。lowerIsHarder = true 表示數值越小越硬（deg/g）
  function vsBaseline(value, base, lowerIsHarder) {
    if (value == null || base == null || base === 0) return null;
    const ratio = lowerIsHarder ? base / value : value / base;
    return (ratio - 1) * 100;
  }

  // 陀螺儀軸對應檢查：正確的對應下，偏航角速度與側向 G 應強烈正相關（a_y = v·r）
  function gyroCheck(samples, calib, fs) {
    const out = {};
    for (const mapping of ['spec', 'alt']) {
      const lpR = new Biquad('lp', 1, fs), lpA = new Biquad('lp', 1, fs);
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let i = 0; i + STRIDE <= samples.length; i += STRIDE) {
        const f = toCar(calib.R, [samples[i + 1], samples[i + 2], samples[i + 3]]);
        const w = toCar(calib.R, gyroDevice(samples[i + 4] - calib.gyroBias[0],
          samples[i + 5] - calib.gyroBias[1], samples[i + 6] - calib.gyroBias[2], mapping));
        const r = lpR.step(w[2]);
        const a = lpA.step(f[1]);
        if (i < STRIDE * fs * 2 || Math.abs(a) < 0.08 * G) continue;
        n++; sx += r; sy += a; sxx += r * r; syy += a * a; sxy += r * a;
      }
      const cov = sxy - sx * sy / n, vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
      out[mapping] = n > fs * 2 && vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null;
    }
    return out;
  }

  // 跑完整段錄製，回傳最終統計與每點的時間序列（給回放圖表）
  // gps：錄製的時速軌跡（GPS_STRIDE 一筆），沒有就給 null
  function analyzeRecording(samples, calib, settings, fs, gps) {
    const proc = new Processor(calib, settings, fs);
    const speeds = new SpeedTrack(gps);
    const n = Math.floor(samples.length / STRIDE);
    const series = {
      t: new Float32Array(n), axg: new Float32Array(n), ayg: new Float32Array(n),
      pitch: new Float32Array(n), roll: new Float32Array(n), speed: new Float32Array(n),
    };
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const st = proc.step(samples[o], samples[o + 1], samples[o + 2], samples[o + 3],
        samples[o + 4], samples[o + 5], samples[o + 6], speeds.at(samples[o]));
      series.t[i] = samples[o];
      series.axg[i] = st.axg; series.ayg[i] = st.ayg;
      series.pitch[i] = st.pitchDeg; series.roll[i] = st.rollDeg;
      series.speed[i] = st.speedKmh == null ? NaN : st.speedKmh;
    }
    return { metrics: proc.metrics(), series };
  }

  function estimateFs(times) {
    if (times.length < 3) return 60;
    const d = [];
    for (let i = 1; i < times.length; i++) {
      const v = times[i] - times[i - 1];
      if (v > 0) d.push(v);
    }
    d.sort((a, b) => a - b);
    const med = d[Math.floor(d.length / 2)] || 16.7;
    return Math.max(10, Math.min(500, 1000 / med));
  }

  // 校正第一步：靜止取樣 → 重力方向、陀螺儀零點、取樣率
  function staticCalibration(samples) {
    const n = Math.floor(samples.length / STRIDE);
    if (n < 20) throw new Error('樣本太少，請再試一次');
    const sum = [0, 0, 0], bias = [0, 0, 0], times = [];
    let gyroSeen = false;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      times.push(samples[o]);
      for (let k = 0; k < 3; k++) { sum[k] += samples[o + 1 + k]; bias[k] += samples[o + 4 + k]; }
      if (samples[o + 4] || samples[o + 5] || samples[o + 6]) gyroSeen = true;
    }
    const gravity = scale(sum, 1 / n);
    const gMag = norm(gravity);
    let varSum = 0;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const m = norm([samples[o + 1], samples[o + 2], samples[o + 3]]);
      varSum += (m - gMag) * (m - gMag);
    }
    const std = Math.sqrt(varSum / n);
    if (gMag < 7 || gMag > 12.5) throw new Error('重力讀值異常（' + gMag.toFixed(2) + ' m/s²）');
    return {
      gravity, gMag, std,
      gyroBias: scale(bias, 1 / n),
      hasGyro: gyroSeen,
      fs: estimateFs(times),
    };
  }

  // 校正第二步（自動）：從靜止起步直線加速，第一段持續的水平加速度方向就是前方
  class ForwardDetector {
    constructor(gravity, fs) {
      this.g = gravity;
      this.up = unit(gravity);
      this.fs = fs;
      this.lp = [new Biquad('lp', 2, fs), new Biquad('lp', 2, fs), new Biquad('lp', 2, fs)];
      this.sum = [0, 0, 0];
      this.n = 0;
      this.need = Math.round(fs * 1.0);
    }
    add(ax, ay, az) {
      const raw = sub([ax, ay, az], this.g);
      const lin = [this.lp[0].step(raw[0]), this.lp[1].step(raw[1]), this.lp[2].step(raw[2])];
      const h = sub(lin, scale(this.up, dot(lin, this.up)));
      const hn = norm(h);
      if (hn < 0.8) return false;
      if (this.n > 5 && dot(unit(this.sum), scale(h, 1 / hn)) < 0.8) return false;
      this.sum = [this.sum[0] + h[0], this.sum[1] + h[1], this.sum[2] + h[2]];
      this.n++;
      return this.n >= this.need;
    }
    progress() { return Math.min(1, this.n / this.need); }
    forward() { return unit(this.sum); }
  }

  return {
    G, STRIDE, GATE, CORNERS, FORWARD_PRESETS, RIDE_LO, RIDE_HI,
    SPEED_BANDS, GPS_STALE_MS, GPS_STRIDE,
    buildFrame, toCar, gyroDevice, cornerOffsets,
    Biquad, Processor, ForwardDetector, SpeedTrack,
    hardness, vsBaseline, compareRide, speedBand,
    gyroCheck, analyzeRecording, staticCalibration, estimateFs,
  };
});
