/**
 * ダーツフォーム分析 — コアロジック(Python tool/src からの移植)
 *
 * 移植元(パリティ検証済みであること):
 *   - analyze.py: _pick_throwing_wrist, _moving_average, _find_peaks
 *   - visualize_trajectory.py: detect_throws_by_speed
 *   - throw_features.py: extract_throw_features, compare_features,
 *     cluster_by_similarity, compute_body_stability, compute_release_angle
 *   - record_session.py: バラツキ指標・評価閾値・ランキング・連続3投選抜
 *   - experiment_cluster_ratio.py(notes/13): 縦横比による大枠A/B判定
 *
 * データ形式は Python 側の keypoints JSON と同一:
 *   { fps, frames: [{ frame, points: [{ name, x, y, visibility }] }] }
 * ブラウザ(MediaPipe Tasks)からも Node(パリティテスト)からも使えるよう、
 * DOM 依存ゼロの純粋モジュールにしている。
 */

// ---------------------------------------------------------------- 基本ユーティリティ

export function movingAverage(arr, window) {
  // np.convolve(arr, ones(w)/w, mode="same") と同一(端はゼロパディングで減衰)
  const n = arr.length;
  if (window <= 1 || n < window) return arr.slice();
  const half = Math.floor(window / 2);
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    // convolve 'same': out[i] = sum_{k} arr[i - half + k] / w(範囲外は0)
    for (let k = 0; k < window; k++) {
      const j = i - half + k;
      if (j >= 0 && j < n) s += arr[j];
    }
    out[i] = s / window;
  }
  return out;
}

export function findPeaks(values, minProminence, minDistance) {
  // analyze._find_peaks と同一(左は厳密超過・右は等号許容、prominence=左右の全域最小との差)
  const n = values.length;
  if (n < 3) return [];
  const raw = [];
  for (let i = 1; i < n - 1; i++) {
    if (values[i] > values[i - 1] && values[i] >= values[i + 1]) {
      let leftMin = Infinity, rightMin = Infinity;
      for (let j = 0; j < i; j++) leftMin = Math.min(leftMin, values[j]);
      for (let j = i + 1; j < n; j++) rightMin = Math.min(rightMin, values[j]);
      if (i === 0) leftMin = values[i];
      if (i + 1 >= n) rightMin = values[i];
      const prominence = values[i] - Math.max(leftMin, rightMin);
      if (prominence >= minProminence) raw.push([i, values[i]]);
    }
  }
  raw.sort((a, b) => b[1] - a[1]);
  const chosen = [];
  for (const [idx] of raw) {
    if (chosen.every((c) => Math.abs(idx - c) >= minDistance)) chosen.push(idx);
  }
  return chosen.sort((a, b) => a - b);
}

export function median(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(vals, p) {
  // np.percentile(linear補間)と同一
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function std(vals) {
  // np.std(母標準偏差)
  if (vals.length < 1) return null;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
  return Math.sqrt(v);
}

const round = (v, d) => (v == null ? null : Number(v.toFixed(d)));

// 手首専用の visibility 足切りは「データの出どころ」で切り替える。
// - ブラウザ版 MediaPipe(.taskモデル、source="mediapipe-tasks-web")は高速に動く手首の
//   visibility を低めに出す傾向があり、0.5 だと投擲の瞬間のデータが欠落する。
//   実測(IMG_5433): 0.5→本物の投擲が消える / 0.35→復活 / 0.2→ゴミ混入。
// - Python版(heavyモデル、sourceなし)は 0.5 のまま。一律で下げると低信頼ノイズが
//   混入して sample6 のA判定が壊れることを確認済み(2026-07-08)。
const wristVisMin = (data) => (data && data.source === "mediapipe-tasks-web" ? 0.35 : 0.5);

function findPoint(frame, name, minVis = 0.5) {
  for (const p of frame.points || []) {
    if (p.name === name && (p.visibility ?? 0) >= minVis) return p;
  }
  return null;
}

function framesById(data) {
  const m = new Map();
  for (const f of data.frames || []) m.set(f.frame | 0, f);
  return m;
}

// ---------------------------------------------------------------- 利き手・投擲検出

export function pickThrowingWrist(data) {
  // analyze._pick_throwing_wrist: 動きの総量が大きい方の手首
  const motion = (name) => {
    const pts = [];
    for (const f of data.frames || []) {
      const p = findPoint(f, name, wristVisMin(data));
      if (p) pts.push(p);
    }
    let s = 0;
    for (let i = 1; i < pts.length; i++) {
      s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return { s, n: pts.length };
  };
  const l = motion("LEFT_WRIST");
  const r = motion("RIGHT_WRIST");
  if (!l.n && !r.n) return "unknown";
  return l.s >= r.s ? "LEFT_WRIST" : "RIGHT_WRIST";
}

function wristSeries(data, wristName, minVis = null) {
  if (minVis == null) minVis = wristVisMin(data);
  const fids = [], xs = [], ys = [];
  for (const f of data.frames || []) {
    const p = findPoint(f, wristName, minVis);
    if (p) { fids.push(f.frame | 0); xs.push(p.x); ys.push(p.y); }
  }
  return { fids, xs, ys };
}

export function detectThrowsBySpeed(data, wristName, fps, {
  maxThrows = 3,
  prominenceFrac = 0.25,
  minSpeedFrac = 0.5,
  minSpeedAbs = 0.02,
} = {}) {
  // visualize_trajectory.detect_throws_by_speed と同一
  const { fids, xs, ys } = wristSeries(data, wristName);
  if (fids.length < 8) return [];

  const speed = new Array(fids.length).fill(0);
  for (let i = 1; i < fids.length; i++) {
    if (fids[i] - fids[i - 1] <= 3) {
      speed[i] = Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    }
  }
  const speedS = movingAverage(speed, 3);
  const maxS = Math.max(...speedS);
  if (maxS <= 1e-6) return [];

  const minDist = Math.max(5, Math.trunc(0.6 * fps));
  let peaks = findPeaks(speedS, prominenceFrac * maxS, minDist);
  peaks = peaks.filter((p) => speedS[p] >= minSpeedFrac * maxS || speedS[p] >= minSpeedAbs);

  const pre = Math.trunc(0.5 * fps), post = Math.trunc(0.3 * fps);
  let throws = [];
  for (const p of peaks) {
    const pf = fids[p];
    const win = fids.filter((f) => pf - pre <= f && f <= pf + post);
    if (win.length >= 4) throws.push({ peak_frame: pf, frames: win, peak_speed: speedS[p] });
  }
  throws.sort((a, b) => b.peak_speed - a.peak_speed);
  throws = throws.slice(0, maxThrows);
  throws.sort((a, b) => a.peak_frame - b.peak_frame);
  return throws;
}

// ---------------------------------------------------------------- 特徴量・類似度

function resample(traj, n = 20) {
  // 弧長等間隔で n 点にリサンプル(throw_features._resample と同一)
  if (traj.length < 2) return traj.length ? Array(n).fill(traj[0]) : [];
  const cum = [0];
  for (let i = 1; i < traj.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(traj[i][0] - traj[i - 1][0], traj[i][1] - traj[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  if (total <= 1e-9) return Array(n).fill(traj[0]);
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = (total * k) / (n - 1);
    let j = 1;
    while (j < cum.length - 1 && cum[j] < t) j++;
    const seg = cum[j] - cum[j - 1];
    const a = seg > 1e-12 ? (t - cum[j - 1]) / seg : 0;
    out.push([
      traj[j - 1][0] + (traj[j][0] - traj[j - 1][0]) * a,
      traj[j - 1][1] + (traj[j][1] - traj[j - 1][1]) * a,
    ]);
  }
  return out;
}

export function extractThrowFeatures(data, wristName, throwObj, fps) {
  // throw_features.extract_throw_features と同一
  const shoulderName = wristName === "LEFT_WRIST" ? "LEFT_SHOULDER" : "RIGHT_SHOULDER";
  const hipName = wristName === "LEFT_WRIST" ? "LEFT_HIP" : "RIGHT_HIP";
  const fmap = framesById(data);

  const torsos = [];
  for (const fid of throwObj.frames) {
    const f = fmap.get(fid);
    if (!f) continue;
    const sh = findPoint(f, shoulderName);
    const hip = findPoint(f, hipName);
    if (sh && hip) torsos.push(Math.abs(sh.y - hip.y));
  }
  const torso = torsos.length ? median(torsos) : 0;
  if (torso <= 1e-6) return null;

  const traj = [];
  const relByFrame = new Map();
  for (const fid of throwObj.frames) {
    const f = fmap.get(fid);
    if (!f) continue;
    const w = findPoint(f, wristName, wristVisMin(data));
    const sh = findPoint(f, shoulderName);
    if (!(w && sh)) continue;
    const nx = (w.x - sh.x) / torso;
    const ny = (w.y - sh.y) / torso;
    traj.push([nx, ny]);
    relByFrame.set(fid, [nx, ny]);
  }
  if (traj.length < 3) return null;

  const xsA = traj.map((p) => p[0]), ysA = traj.map((p) => p[1]);
  const arcW = Math.max(...xsA) - Math.min(...xsA);
  const arcH = Math.max(...ysA) - Math.min(...ysA);
  let path = 0;
  for (let i = 1; i < traj.length; i++) {
    path += Math.hypot(traj[i][0] - traj[i - 1][0], traj[i][1] - traj[i - 1][1]);
  }
  const release = relByFrame.get(throwObj.peak_frame) ?? traj[Math.floor(traj.length / 2)];
  let takeback = traj[0], best = -1;
  for (const p of traj) {
    const d = Math.abs(p[0] - release[0]);
    if (d > best) { best = d; takeback = p; }
  }

  return {
    throwing_wrist: wristName,
    peak_frame: throwObj.peak_frame | 0,
    frame_range: [throwObj.frames[0] | 0, throwObj.frames[throwObj.frames.length - 1] | 0],
    n_frames: traj.length,
    duration_sec: round((throwObj.frames[throwObj.frames.length - 1] - throwObj.frames[0]) / fps, 3),
    fps: round(fps, 2),
    torso_scale: round(torso, 4),
    trajectory_resampled: resample(traj, 20).map(([x, y]) => [round(x, 4), round(y, 4)]),
    release_point_norm: [round(release[0], 4), round(release[1], 4)],
    takeback_point_norm: [round(takeback[0], 4), round(takeback[1], 4)],
    arc_width: round(arcW, 4),
    arc_height: round(arcH, 4),
    path_length: round(path, 4),
  };
}

const SHAPE_DIST_ZERO_SIM = 0.5;

export function compareFeatures(newFeat, refFeat) {
  // throw_features.compare_features(類似度部分)と同一。左右反転を自動吸収
  const a = newFeat.trajectory_resampled, b = refFeat.trajectory_resampled;
  const dist = (p, q) => {
    let s = 0;
    for (let i = 0; i < p.length; i++) s += Math.hypot(p[i][0] - q[i][0], p[i][1] - q[i][1]);
    return s / p.length;
  };
  const d1 = dist(a, b);
  const mirrored = a.map(([x, y]) => [-x, y]);
  const d2 = dist(mirrored, b);
  const d = Math.min(d1, d2);
  return {
    similarity: round(Math.max(0, 100 * (1 - d / SHAPE_DIST_ZERO_SIM)), 1),
    mirrored: d2 < d1,
  };
}

export function clusterBySimilarity(feats, clusterSim = 50.0, minCluster = 2) {
  // throw_features.cluster_by_similarity と同一(貪欲法)
  const n = feats.length;
  if (n === 0) return { real: [], noise: [] };
  const sim = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) sim[i][j] = compareFeatures(feats[i], feats[j]).similarity;
    }
  }
  const unassigned = new Set(Array.from({ length: n }, (_, i) => i));
  const clusters = [];
  while (unassigned.size) {
    let seed = -1, bestCount = -1;
    for (const i of [...unassigned].sort((a, b) => a - b)) {
      let c = 0;
      for (const j of unassigned) if (sim[i][j] >= clusterSim) c++;
      if (c > bestCount) { bestCount = c; seed = i; }
    }
    const cl = new Set([seed]);
    for (const j of unassigned) if (sim[seed][j] >= clusterSim) cl.add(j);
    clusters.push([...cl].sort((a, b) => a - b));
    for (const j of cl) unassigned.delete(j);
  }
  // 勝者クラスタの選び方: サイズは3投(1セッション分)で頭打ちにし、
  // 同点はクラスタ内の平均類似度で決める。本物の投擲は互いによく似る
  // (実測78〜95%)がノイズの固まり(構え直し・戻り動作)は60〜72%止まりのため。
  // 純粋なサイズ多数決だと、ノイズが偶然4個固まっただけで本物3投に勝ってしまう
  // (2026-07-10 ブラウザ実データで発生)。
  const clusterScore = (cl) => {
    const sims = [];
    for (let i = 0; i < cl.length; i++) {
      for (let j = i + 1; j < cl.length; j++) sims.push(sim[cl[i]][cl[j]]);
    }
    const avg = sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
    return [Math.min(cl.length, 3), avg];
  };
  clusters.sort((a, b) => {
    const sa = clusterScore(a), sb = clusterScore(b);
    return sb[0] - sa[0] || sb[1] - sa[1];
  });
  const real = clusters.length && clusters[0].length >= minCluster ? clusters[0] : [];
  const noise = clusters.flat().filter((i) => !real.includes(i));
  return { real, noise };
}

// ---------------------------------------------------------------- 体軸・リリース角度

const BODY_VIS_MIN = 0.7;

function drift(points) {
  if (points.length < 2) return null;
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    s += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return s;
}

export function computeBodyStability(data, wristName, throwObj) {
  // throw_features.compute_body_stability と同一
  const fmap = framesById(data);
  const isRight = wristName !== "LEFT_WRIST";
  const backAnkle = isRight ? "LEFT_ANKLE" : "RIGHT_ANKLE";
  const trunkPts = [], headPts = [], footPts = [];
  for (const fid of throwObj.frames) {
    const f = fmap.get(fid);
    if (!f) continue;
    const shL = findPoint(f, "LEFT_SHOULDER", BODY_VIS_MIN);
    const shR = findPoint(f, "RIGHT_SHOULDER", BODY_VIS_MIN);
    const hipL = findPoint(f, "LEFT_HIP", BODY_VIS_MIN);
    const hipR = findPoint(f, "RIGHT_HIP", BODY_VIS_MIN);
    if (shL && shR && hipL && hipR) {
      trunkPts.push([
        (shL.x + shR.x + hipL.x + hipR.x) / 4,
        (shL.y + shR.y + hipL.y + hipR.y) / 4,
      ]);
    }
    const nose = findPoint(f, "NOSE", BODY_VIS_MIN);
    if (nose) headPts.push([nose.x, nose.y]);
    const foot = findPoint(f, backAnkle, BODY_VIS_MIN);
    if (foot) footPts.push([foot.x, foot.y]);
  }
  return {
    trunk_drift: round(drift(trunkPts), 4),
    head_drift: round(drift(headPts), 4),
    back_foot_drift: round(drift(footPts), 4),
  };
}

export function computeReleaseAngle(data, wristName, throwObj) {
  // throw_features.compute_release_angle と同一
  const fmap = framesById(data);
  let pts = [];
  for (const fid of throwObj.frames) {
    if (fid > throwObj.peak_frame) break;
    const f = fmap.get(fid);
    if (!f) continue;
    const w = findPoint(f, wristName, wristVisMin(data));
    if (w) pts.push([w.x, w.y]);
  }
  pts = pts.slice(-4);
  if (pts.length < 2) return null;
  const dx = pts[pts.length - 1][0] - pts[0][0];
  const dy = -(pts[pts.length - 1][1] - pts[0][1]);
  return round((Math.atan2(dy, dx) * 180) / Math.PI, 1);
}

// ---------------------------------------------------------------- バラツキ指標・評価

export const THRESHOLDS = {
  takeback_position: [0.05, 0.10],
  release_position: [0.05, 0.10],
  trajectory_length: [0.10, 0.20],
  arc_wh_ratio: [0.15, 0.30],
  release_angle: [5.0, 10.0],
  throw_interval: [0.5, 1.0],
  trunk_drift: [0.015, 0.030],
  head_drift: [0.015, 0.030],
  back_foot_drift: [0.015, 0.030],
};

export const METRIC_LABELS = {
  takeback_position: "テイクバック位置",
  release_position: "リリース位置",
  trajectory_length: "軌跡長",
  arc_wh_ratio: "弧W/H比",
  release_angle: "リリース角度",
  throw_interval: "投擲間隔",
  trunk_drift: "胴体中心のブレ",
  head_drift: "頭部の動き",
  back_foot_drift: "軸足の安定性",
};

const sdOf = (vals) => {
  const v = vals.filter((x) => x != null);
  return v.length < 2 ? null : round(std(v), 4);
};
const meanOf = (vals) => {
  const v = vals.filter((x) => x != null);
  return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 4) : null;
};

export function evaluateMetric(metric, sd) {
  if (sd == null) return "unknown";       // ⚪ 未検出
  const [yellow, red] = THRESHOLDS[metric];
  if (sd >= red) return "red";            // 🔴 不安定
  if (sd >= yellow) return "yellow";      // 🟡 やや不安定
  return "green";                          // 🟢 安定
}

export function computeVariance(throws, fps) {
  // record_session.compute_variance と同一
  const feats = throws.map((t) => t.features);
  const body = throws.map((t) => t.body_stability);
  const wh = feats.map((f) => (f.arc_height > 1e-9 ? f.arc_width / f.arc_height : null));
  const peaks = feats.map((f) => f.peak_frame);
  const intervals = peaks.slice(1).map((b, i) => round((b - peaks[i]) / fps, 3));
  return {
    takeback_position: {
      x_sd: sdOf(feats.map((f) => f.takeback_point_norm[0])),
      y_sd: sdOf(feats.map((f) => f.takeback_point_norm[1])),
      x_mean: meanOf(feats.map((f) => f.takeback_point_norm[0])),
      y_mean: meanOf(feats.map((f) => f.takeback_point_norm[1])),
    },
    release_position: {
      x_sd: sdOf(feats.map((f) => f.release_point_norm[0])),
      y_sd: sdOf(feats.map((f) => f.release_point_norm[1])),
      x_mean: meanOf(feats.map((f) => f.release_point_norm[0])),
      y_mean: meanOf(feats.map((f) => f.release_point_norm[1])),
    },
    trajectory_length: { sd: sdOf(feats.map((f) => f.path_length)), mean: meanOf(feats.map((f) => f.path_length)) },
    arc_wh_ratio: { sd: sdOf(wh), mean: meanOf(wh) },
    release_angle: { sd_deg: sdOf(throws.map((t) => t.release_angle)), mean_deg: meanOf(throws.map((t) => t.release_angle)) },
    throw_interval: { sd_sec: sdOf(intervals), mean_sec: meanOf(intervals), intervals_sec: intervals },
    trunk_drift: { sd: sdOf(body.map((b) => b.trunk_drift)), mean: meanOf(body.map((b) => b.trunk_drift)) },
    head_drift: { sd: sdOf(body.map((b) => b.head_drift)), mean: meanOf(body.map((b) => b.head_drift)) },
    back_foot_drift: { sd: sdOf(body.map((b) => b.back_foot_drift)), mean: meanOf(body.map((b) => b.back_foot_drift)) },
  };
}

export function representativeSd(metric, variance) {
  const v = variance[metric];
  if ("x_sd" in v) {
    const c = [v.x_sd, v.y_sd].filter((x) => x != null);
    return c.length ? Math.max(...c) : null;
  }
  for (const key of ["sd", "sd_deg", "sd_sec"]) if (key in v) return v[key];
  return null;
}

export function buildRanking(variance) {
  const ranking = [];
  for (const metric of Object.keys(THRESHOLDS)) {
    const sd = representativeSd(metric, variance);
    if (sd == null) continue;
    const red = THRESHOLDS[metric][1];
    ranking.push({
      metric,
      label_jp: METRIC_LABELS[metric],
      sd,
      score: round(sd / red, 3),
      level: evaluateMetric(metric, sd),
    });
  }
  ranking.sort((a, b) => b.score - a.score);
  return ranking;
}

// ---------------------------------------------------------------- 軸の安定度(headline指標)

const AXIS_METRICS = ["trunk_drift", "head_drift", "back_foot_drift"];
const LEVEL_RANK = { green: 0, yellow: 1, red: 2 };

/**
 * 3つの体軸系指標(胴体中心・頭部・軸足)を1つの headline スコアにまとめる。
 * score = sd / red閾値(既存ranking と同じ考え方)。1.5 でキャップするのは、
 * 閾値ちょうど(score=1)でも 0% にはせず「際どいが0ではない」感触を残すため
 * (1.5 キャップ時: score=1→約33%, score=1.5以上→0%)。
 */
export function computeAxisStability(variance) {
  const scores = [];
  const components = {};
  let worstLevel = null;
  for (const metric of AXIS_METRICS) {
    const sd = representativeSd(metric, variance);
    const level = evaluateMetric(metric, sd);
    components[metric] = { sd, level };
    if (sd != null) {
      scores.push(Math.min(sd / THRESHOLDS[metric][1], 1.5));
      if (worstLevel == null || LEVEL_RANK[level] > LEVEL_RANK[worstLevel]) worstLevel = level;
    }
  }
  if (!scores.length) return { score_pct: null, level: "unknown", components };
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  return {
    score_pct: round(Math.max(0, 100 * (1 - avgScore / 1.5)), 1),
    level: worstLevel,
    components,
  };
}

// ---------------------------------------------------------------- セッション組み立て

export const SESSION_THROWS = 3;
export const MIN_THROWS = 2;
export const MAX_GAP_SEC = 10.0;

/** クラスタから「連続3投の最良窓」を選ぶ(record_session と同一ロジック) */
export function selectSessionThrows(cand, realIdx, fps) {
  if (realIdx.length <= SESSION_THROWS) {
    return [...realIdx].sort((a, b) => cand[a].throw.peak_frame - cand[b].throw.peak_frame);
  }
  const ordered = [...realIdx].sort((a, b) => cand[a].throw.peak_frame - cand[b].throw.peak_frame);
  const winScore = (win) => {
    const sims = [];
    for (let i = 0; i < win.length; i++) {
      for (let j = i + 1; j < win.length; j++) {
        sims.push(compareFeatures(cand[win[i]].feat, cand[win[j]].feat).similarity);
      }
    }
    return sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
  };
  const winOk = (win) => {
    const peaks = win.map((i) => cand[i].throw.peak_frame);
    for (let i = 1; i < peaks.length; i++) {
      if ((peaks[i] - peaks[i - 1]) / fps > MAX_GAP_SEC) return false;
    }
    return true;
  };
  const windows = [];
  for (let s = 0; s + SESSION_THROWS <= ordered.length; s++) {
    windows.push(ordered.slice(s, s + SESSION_THROWS));
  }
  const candidates = windows.filter(winOk);
  const pool = candidates.length ? candidates : windows;
  let best = pool[0], bestScore = -1;
  for (const w of pool) {
    const sc = winScore(w);
    if (sc > bestScore) { bestScore = sc; best = w; }
  }
  return best;
}

/** 縦横比(h/w)中央値による大枠A/B判定(notes/13) */
export function coarseTypeFromRatio(feats) {
  const ratios = feats
    .filter((f) => f.arc_width > 1e-9)
    .map((f) => f.arc_height / f.arc_width);
  if (!ratios.length) return null;
  const med = median(ratios);
  let verdict = "unknown";
  if (med >= 0.80) verdict = "B";
  else if (med <= 0.65) verdict = "A";
  return { verdict, ratio_median: round(med, 3) };
}

export function computeCaptureQuality(data, wristName, throwFrames) {
  // record_session.compute_capture_quality と同一(肩幅x=全フレームp75)
  const frames = data.frames || [];
  const fmap = framesById(data);
  const isRight = wristName !== "LEFT_WRIST";
  const backAnkle = isRight ? "LEFT_ANKLE" : "RIGHT_ANKLE";

  const shDiffs = [];
  for (const f of frames) {
    const ls = findPoint(f, "LEFT_SHOULDER");
    const rs = findPoint(f, "RIGHT_SHOULDER");
    if (ls && rs) shDiffs.push(Math.abs(ls.x - rs.x));
  }
  const footVis = [];
  for (const fid of throwFrames) {
    const f = fmap.get(fid);
    if (!f) continue;
    let vis = 0;
    for (const p of f.points || []) if (p.name === backAnkle) { vis = p.visibility ?? 0; break; }
    footVis.push(vis);
  }
  let nDetected = 0;
  for (const f of frames) {
    if ((f.points || []).some((p) => p.name === wristName && (p.visibility ?? 0) >= 0.5)) nDetected++;
  }
  return {
    shoulder_x_diff: shDiffs.length ? round(percentile(shDiffs, 75), 4) : null,
    detection_rate: frames.length ? round(nDetected / frames.length, 3) : 0,
    foot_visibility: footVis.length ? round(median(footVis), 3) : null,
  };
}

// computeCaptureQuality と同じ基準値。report.mjs のレポート画面(事後警告)と
// main.mjs のプリチェック(事前警告)の両方から参照し、基準のブレを防ぐ
export const CAPTURE_QUALITY_THRESHOLDS = { shoulder_x_diff: 0.03, detection_rate: 0.7, foot_visibility: 0.7 };

export function captureQualityIssues(q) {
  const issues = [];
  if ((q.shoulder_x_diff ?? 0) < CAPTURE_QUALITY_THRESHOLDS.shoulder_x_diff) issues.push("side_view");
  if ((q.detection_rate ?? 0) < CAPTURE_QUALITY_THRESHOLDS.detection_rate) issues.push("detection_rate");
  if ((q.foot_visibility ?? 0) < CAPTURE_QUALITY_THRESHOLDS.foot_visibility) issues.push("foot_visibility");
  return issues;
}

/**
 * 軽量プリチェック用: フル解析(投擲検出)の前に、動画の先頭数秒だけで
 * 簡易的な撮影品質を判定する。利き手・投擲はまだ特定できていないため、
 * computeCaptureQuality と違い「左右どちらか検出できていればOK」で近似する。
 */
export function computeQuickCaptureQuality(data) {
  const frames = data.frames || [];
  const shDiffs = [];
  const footVis = [];
  let nDetected = 0;
  for (const f of frames) {
    const ls = findPoint(f, "LEFT_SHOULDER");
    const rs = findPoint(f, "RIGHT_SHOULDER");
    if (ls && rs) shDiffs.push(Math.abs(ls.x - rs.x));

    const wristVis = (f.points || [])
      .filter((p) => p.name === "LEFT_WRIST" || p.name === "RIGHT_WRIST")
      .map((p) => p.visibility ?? 0);
    if (wristVis.some((v) => v >= 0.5)) nDetected++;

    const ankleVis = (f.points || [])
      .filter((p) => p.name === "LEFT_ANKLE" || p.name === "RIGHT_ANKLE")
      .map((p) => p.visibility ?? 0);
    if (ankleVis.length) footVis.push(Math.max(...ankleVis));
  }
  return {
    shoulder_x_diff: shDiffs.length ? round(percentile(shDiffs, 75), 4) : null,
    detection_rate: frames.length ? round(nDetected / frames.length, 3) : 0,
    foot_visibility: footVis.length ? round(median(footVis), 3) : null,
  };
}

/**
 * メイン: keypoints データ → セッション分析結果
 * record_session.main の分析部分に、再現度スコア(3投の相互類似度平均)を追加
 */
export function analyzeSession(data, { playerType = null } = {}) {
  const fps = Number(data.fps || 30);
  const wrist = pickThrowingWrist(data);
  if (wrist === "unknown") return { error: "利き手の手首を特定できませんでした" };

  const bursts = detectThrowsBySpeed(data, wrist, fps, {
    maxThrows: 10, prominenceFrac: 0.1, minSpeedFrac: 0.2, minSpeedAbs: 0.008,
  });
  const cand = [];
  for (const t of bursts) {
    const f = extractThrowFeatures(data, wrist, t, fps);
    if (f) cand.push({ throw: t, feat: f });
  }
  const { real, noise } = clusterBySimilarity(cand.map((c) => c.feat));
  if (real.length < MIN_THROWS) {
    return {
      error: `本物と推定できた投擲が ${real.length} 投しかありません。` +
        "撮影ガイド(横向き・利き手側・全身)を確認して撮り直してください",
      n_bursts: cand.length,
    };
  }
  const selected = selectSessionThrows(cand, real, fps);

  const throws = selected.map((i, k) => ({
    throw_id: k + 1,
    features: cand[i].feat,
    body_stability: computeBodyStability(data, wrist, cand[i].throw),
    release_angle: computeReleaseAngle(data, wrist, cand[i].throw),
  }));

  // 再現度スコア = 選抜3投の相互類似度の平均
  const sims = [];
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      sims.push(compareFeatures(cand[selected[i]].feat, cand[selected[j]].feat).similarity);
    }
  }
  const reproducibility = sims.length
    ? round(sims.reduce((a, b) => a + b, 0) / sims.length, 1)
    : null;

  const variance = computeVariance(throws, fps);
  const allFrames = selected.flatMap((i) => cand[i].throw.frames);
  return {
    fps,
    throwing_wrist: wrist,
    player_type: playerType,
    reproducibility,
    coarse_type: coarseTypeFromRatio(throws.map((t) => t.features)),
    capture_quality: computeCaptureQuality(data, wrist, allFrames),
    noise_excluded_frames: noise.map((i) => cand[i].throw.peak_frame),
    throws,
    variance,
    ranking: buildRanking(variance),
    axis_stability: computeAxisStability(variance),
  };
}
