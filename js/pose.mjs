/**
 * 骨格推定(MediaPipe Tasks Vision / ブラウザ専用)
 *
 * 動画ファイルをシークしながら PoseLandmarker にかけ、
 * Python 版と同じ keypoints 形式 { fps, frames: [...] } を生成する。
 * 動画は端末外に送信されない(完全オンデバイス処理)。
 */

const MP_VERSION = "0.10.14";
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
// lite は速く動く手首の visibility が低すぎて投擲検出に不十分(実測: 手首0.49 vs 肩0.99)。
// full で手首の追跡精度を確保する(モデル約9MB・初回のみダウンロード)
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

// 分析に必要な9ランドマーク(MediaPipe Pose の33点のうち)
const LANDMARK_NAMES = {
  0: "NOSE",
  11: "LEFT_SHOULDER",
  12: "RIGHT_SHOULDER",
  15: "LEFT_WRIST",
  16: "RIGHT_WRIST",
  23: "LEFT_HIP",
  24: "RIGHT_HIP",
  27: "LEFT_ANKLE",
  28: "RIGHT_ANKLE",
};

export const TARGET_FPS = 30; // 処理レート(60fps動画も30fpsで解析 — sample1と同条件)

let _landmarker = null;
// MediaPipe VIDEOモードのタイムスタンプは「同一インスタンスの生涯で単調増加」が必須。
// 実行ごとに0へ戻すと INVALID_ARGUMENT(timestamp mismatch)になるため、
// モジュール全体で増え続けるカウンタを使う(値の絶対量は重要でなく増加だけが必要)。
let _globalTs = 0;

export async function loadPoseLandmarker() {
  if (_landmarker) return _landmarker;
  const { FilesetResolver, PoseLandmarker } = await import(
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`
  );
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  _landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numPoses: 1,
  });
  return _landmarker;
}

// iOS Safari は DOM 未接続の <video> だと seeked が発火しないことがあるため
// タイムアウトで検知する(無限ハングを防ぎ、ユーザーにエラー表示できるようにする)
const SEEK_TIMEOUT_MS = 8000;

function seekTo(video, t) {
  return new Promise((resolve, reject) => {
    const onSeek = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error("動画のシークに失敗しました")); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("動画の読み込みがタイムアウトしました(ブラウザが動画をシークできませんでした)"));
    }, SEEK_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeek);
      video.removeEventListener("error", onErr);
    };
    video.addEventListener("seeked", onSeek, { once: true });
    video.addEventListener("error", onErr, { once: true });
    video.currentTime = t;
  });
}

/**
 * 動画ファイル → keypoints データ
 * @param {File} file 動画ファイル
 * @param {(done:number, total:number)=>void} onProgress 進捗コールバック
 * @param {{maxSeconds?: number}} opts maxSeconds指定時は動画の先頭だけを処理する(軽量プリチェック用)
 */
export async function extractKeypoints(file, onProgress = () => {}, { maxSeconds = null } = {}) {
  const landmarker = await loadPoseLandmarker();

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  // iOS Safari は DOM に接続されていない <video> だとシーク時の
  // frame decode / seeked イベントが不安定になることがあるため、
  // 画面には出さずに DOM へ接続しておく。
  // opacity:0 は iOS Safari が「非表示」とみなしてデコードを抑制することがあるため
  // 使わず、極小サイズ+ほぼ透明(0.01)で「表示はされているが見えない」状態にする
  video.style.cssText = "position:fixed;top:0;left:0;width:2px;height:2px;opacity:0.01;pointer-events:none;";
  document.body.appendChild(video);
  const url = URL.createObjectURL(file);
  video.src = url;

  const cleanup = () => {
    URL.revokeObjectURL(url);
    video.remove();
  };

  try {
    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error("動画を読み込めませんでした")), { once: true });
    });

    // iOS Safari 対策: シークする前に一度 play→pause してデコードパイプラインを
    // 起動しておかないと、その後の currentTime 変更で seeked が発火しないことがある
    try {
      await video.play();
      video.pause();
    } catch (_) {
      // muted+playsInline のためほぼ成功するはずだが、失敗しても致命的ではないので続行
    }

    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) {
      throw new Error("動画の長さを取得できませんでした");
    }
    if (duration > 120) {
      throw new Error("動画が長すぎます(2分以内にしてください)");
    }

    const effectiveDuration = maxSeconds != null ? Math.min(duration, maxSeconds) : duration;
    const step = 1 / TARGET_FPS;
    const total = Math.floor(effectiveDuration * TARGET_FPS);
    const frames = [];

    for (let i = 0; i < total; i++) {
      const t = i * step;
      await seekTo(video, Math.min(t, duration - 0.001));
      _globalTs += 34; // 常に前回より大きく(≈33ms間隔)

      let result;
      try {
        result = landmarker.detectForVideo(video, _globalTs);
      } catch (err) {
        console.warn(`frame ${i} の推定をスキップ:`, err.message || err);
        continue; // 1フレームの失敗で全体を止めない
      }
      const lm = result.landmarks && result.landmarks[0];
      if (lm) {
        const points = [];
        for (const [idx, name] of Object.entries(LANDMARK_NAMES)) {
          const p = lm[Number(idx)];
          if (!p) continue;
          points.push({
            name,
            x: p.x,
            y: p.y,
            visibility: p.visibility ?? 1.0,
          });
        }
        if (points.length) frames.push({ frame: i, points });
      }
      if (i % 5 === 0) onProgress(i, total);
    }
    onProgress(total, total);
    // source はブラウザ抽出の印。analysis 側が手首の visibility 足切りをこの値で切り替える
    return { fps: TARGET_FPS, total_frames: total, source: "mediapipe-tasks-web", frames: dropImplausibleFrames(frames) };
  } finally {
    cleanup();
  }
}

// 人物が部分的にしか映っていない瞬間(動画冒頭など)に、ブラウザ版モデルは
// 画面外の下半身を幻覚し高 visibility で返すことがある(IMG_5433 実測:
// 腰 y=1.2〜1.3・胴体長が正常値の4倍)。この偽骨格は手首の巨大な速度バーストになり
// 投擲検出の速度スケールを壊す。Python 版(heavy)は同区間を低 visibility で
// 自然に無視するため、ブラウザ側でも「胴体長が動画の中央値から大きく外れた
// フレーム」を捨ててデータ品質を揃える。
function dropImplausibleFrames(frames) {
  const get = (f, n) => (f.points || []).find((p) => p.name === n);
  // 妥当性チェックは visibility でゲートしない(座標のみで判定する)。
  // 幻覚フレームの腰は visibility が 0.5 を割ることがあり、visibility 依存だと
  // 「胴体長を計算できない→無罪放免」の抜け穴で偽骨格が素通りする(実測で発生)。
  // 幻覚かどうかは座標(腰が画面外 y≈1.2 等)に必ず現れるため、位置ベースが確実。
  const torso = (f) => {
    const ds = [];
    for (const side of ["LEFT", "RIGHT"]) {
      const s = get(f, side + "_SHOULDER");
      const h = get(f, side + "_HIP");
      if (s && h) ds.push(Math.hypot(s.x - h.x, s.y - h.y));
    }
    return ds.length ? ds.reduce((a, b) => a + b) / ds.length : null;
  };
  const ts = frames.map(torso).filter((t) => t != null).sort((a, b) => a - b);
  if (ts.length < 10) return frames; // 標本が少なすぎる時は判定しない
  const med = ts[Math.floor(ts.length / 2)];
  return frames.filter((f) => {
    const t = torso(f);
    // 胴体長が計算できないフレームも捨てる(骨格全体が信頼できないため)
    return t != null && t >= 0.6 * med && t <= 1.5 * med;
  });
}
