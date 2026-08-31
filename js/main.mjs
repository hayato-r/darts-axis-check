/**
 * メイン: 画面遷移とパイプライン制御
 * 動画選択 → 骨格推定(オンデバイス) → 分析 → レポート表示 → シェア画像
 */

import { extractKeypoints, loadPoseLandmarker } from "./pose.mjs?v=2026-08-31.5";
import { analyzeSession } from "./analysis.mjs?v=2026-08-31.5";
import { renderReport, renderShareImage } from "./report.mjs?v=2026-08-31.5";
import { loadHistory, appendSessionToHistory } from "./history.mjs?v=2026-08-31.5";

// 古いキャッシュ版が動いていないか画面上で確認するためのビルド版数。
// js/ 配下を変更したら必ず上げること。
export const APP_VERSION = "2026-08-31.5";

const $ = (id) => document.getElementById(id);

const state = { result: null, lastKeypoints: null, videoUrl: null };

function show(screenId) {
  for (const s of document.querySelectorAll(".screen")) s.classList.remove("active");
  $(screenId).classList.add("active");
}

function setProgress(pct, label) {
  $("progress-fill").style.width = `${pct}%`;
  $("progress-label").textContent = label;
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
    const playerType = $("player-type").value || null;
    const result = analyzeSession(data, { playerType });

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
      $("error-box").hidden = true;
      runPipeline(file);
      e.target.value = ""; // 同じファイルの再選択を可能に
    }
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
