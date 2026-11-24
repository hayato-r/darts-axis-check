/**
 * メイン: 画面遷移とパイプライン制御
 * 動画選択 → 骨格推定(オンデバイス) → 分析 → レポート表示 → シェア画像
 */

import { extractKeypoints, loadPoseLandmarker } from "./pose.mjs?v=2026-11-25.1";
import { analyzeSession, computeQuickCaptureQuality, captureQualityIssues } from "./analysis.mjs?v=2026-11-25.1";
import { renderReport, renderShareImage } from "./report.mjs?v=2026-11-25.1";
import { loadHistory, appendSessionToHistory } from "./history.mjs?v=2026-11-25.1";

// 古いキャッシュ版が動いていないか画面上で確認するためのビルド版数。
// js/ 配下を変更したら必ず上げること。
export const APP_VERSION = "2026-11-25.1";

// プリチェックで先頭何秒だけ見るか。短すぎると判定が不安定、長すぎると
// 「軽量」の意味がなくなるため、3投を撮り始める前の構えが映る程度を想定
const PRECHECK_SECONDS = 4;

const PRECHECK_LABELS = {
  side_view: "真横(サイドビュー)から撮れていない可能性があります",
  detection_rate: "人物がうまく検出できていません(画角・明るさを確認してください)",
  foot_visibility: "足元が映っていない可能性があります",
};

const $ = (id) => document.getElementById(id);

const state = { result: null, lastKeypoints: null, videoUrl: null, pendingFile: null };

function show(screenId) {
  for (const s of document.querySelectorAll(".screen")) s.classList.remove("active");
  $(screenId).classList.add("active");
}

function setProgress(pct, label) {
  $("progress-fill").style.width = `${pct}%`;
  $("progress-label").textContent = label;
}

/**
 * 動画選択直後に呼ぶ: 先頭数秒だけ解析して撮影品質を軽くチェックする。
 * 問題がなければそのままフル解析(runPipeline)へ、問題があれば
 * プリチェック画面で「このまま解析する/選び直す」を選ばせる。
 */
async function handleFileSelected(file) {
  $("error-box").hidden = true;
  show("screen-progress");
  setProgress(2, "AIモデルを読み込み中…(初回は少し時間がかかります)");
  try {
    await loadPoseLandmarker();
    setProgress(10, "撮影状態を確認中…");
    const preview = await extractKeypoints(file, () => {}, { maxSeconds: PRECHECK_SECONDS });
    const quality = computeQuickCaptureQuality(preview);
    const issues = captureQualityIssues(quality);

    if (issues.length) {
      state.pendingFile = file;
      $("precheck-summary").innerHTML = issues.map((i) => "・" + PRECHECK_LABELS[i]).join("<br>");
      show("screen-precheck");
      return;
    }
    await runPipeline(file);
  } catch (e) {
    // プリチェック自体の失敗(タイムアウト等)は致命的でない。
    // 事前チェックをスキップしてフル解析にそのまま進む(事後警告は引き続き機能する)
    console.warn("プリチェックに失敗、フル解析へフォールバック:", e.message || e);
    await runPipeline(file);
  }
}

async function runPipeline(file) {
  show("screen-progress");
  try {
    setProgress(2, "AIモデルを読み込み中…(初回は少し時間がかかります)");
    await loadPoseLandmarker();

    const data = await extractKeypoints(file, (done, total) => {
      const pct = 5 + (done / total) * 85;
      setProgress(pct, `フォームを解析中… ${Math.round((done / total) * 100)}%`);
    });

    setProgress(92, "3投を検出してバラツキを計算中…");
    state.lastKeypoints = data;
    // タイプを選ぶ欄は 2026-11-25 に廃止。ドリルのコツの出し分けは、動画からの自動判定(coarse_type)だけで行う
    const result = analyzeSession(data, { playerType: null });

    if (result.error) {
      show("screen-input");
      $("error-box").textContent = "⚠️ " + result.error;
      $("error-box").hidden = false;
      $("btn-debug").hidden = false;
      return;
    }

    setProgress(100, "レポートを作成中…");
    state.result = result;
    $("btn-debug").hidden = false; // 数値がおかしい時に🐞で解析データを保存できるように
    // 過去セッションとの比較(推移表示)のため、今回の結果を追記する前に読み込む
    const pastHistory = loadHistory();
    appendSessionToHistory(result);
    // 撮影した動画をレポート画面で見返せるようにする(端末内のみ、送信なし)。
    // 前回分の再生用URLが残っていたら破棄してから作り直す
    if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
    state.videoUrl = URL.createObjectURL(file);
    $("report-body").innerHTML = renderReport(result, pastHistory, state.videoUrl);
    wireVideoSeekButtons();
    show("screen-report");
    window.scrollTo(0, 0);
  } catch (e) {
    console.error(e);
    show("screen-input");
    $("error-box").textContent = "⚠️ エラー: " + (e.message || e);
    $("error-box").hidden = false;
  }
}

/** レポート内の「◯投目へ」ボタンを、動画のその場面へのシークに接続する */
function wireVideoSeekButtons() {
  const video = $("review-video");
  if (!video) return;
  for (const btn of document.querySelectorAll("[data-seek-sec]")) {
    btn.addEventListener("click", () => {
      video.currentTime = Number(btn.dataset.seekSec) || 0;
      video.play();
    });
  }
}

function downloadShareImage() {
  if (!state.result) return;
  const url = renderShareImage(state.result);
  const a = document.createElement("a");
  a.href = url;
  a.download = `darts-report-${new Date().toISOString().slice(0, 10)}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function shareImage() {
  if (!state.result) return;
  const url = renderShareImage(state.result);
  try {
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], "darts-report.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "ダーツ フォーム再現度レポート" });
      return;
    }
  } catch (_) { /* シェア未対応・キャンセル時はダウンロードへ */ }
  downloadShareImage();
}

function init() {
  $("video-input").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) {
      handleFileSelected(file);
      e.target.value = ""; // 同じファイルの再選択を可能に
    }
  });
  $("btn-precheck-continue").addEventListener("click", () => {
    const file = state.pendingFile;
    state.pendingFile = null;
    if (file) runPipeline(file);
  });
  $("btn-precheck-retry").addEventListener("click", () => {
    state.pendingFile = null;
    show("screen-input");
  });
  $("btn-share").addEventListener("click", shareImage);
  $("btn-debug").addEventListener("click", () => {
    if (!state.lastKeypoints) return;
    const blob = new Blob([JSON.stringify(state.lastKeypoints)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "debug_keypoints.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  $("btn-retry").addEventListener("click", () => show("screen-input"));
  $("btn-guide-ok").addEventListener("click", () => {
    localStorage.setItem("guideSeen", "1");
    show("screen-input");
  });
  $("btn-show-guide").addEventListener("click", () => show("screen-guide"));

  const ver = $("app-version");
  if (ver) ver.textContent = `build v${APP_VERSION}`;
  const footer = document.querySelector(".app-footer");
  if (footer) footer.textContent += ` — v${APP_VERSION}`;
  console.log(`darts-form-app v${APP_VERSION}`);

  show(localStorage.getItem("guideSeen") ? "screen-input" : "screen-guide");
}

init();
