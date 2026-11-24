/**
 * レポート描画(DOM)+ シェア画像生成(Canvas 1080×1080)
 */

import { THRESHOLDS, METRIC_LABELS, evaluateMetric, CAPTURE_QUALITY_THRESHOLDS } from "./analysis.mjs?v=2026-11-25.1";
import { pickHint, pickDrill, pickDrillTip } from "./hints.mjs?v=2026-11-25.1";

// 2026-11-25: 「軸の安定度」の見出し・🧭マークと、4スタンス理論の表記(タイプ名・判定結果)を画面から削除。
// 見出しは「3投の再現度」。タイプ別の内容は、ドリルの「コツ」の出し分けにだけ使う(判定結果は表示しない)。

const LEVEL = {
  green: { mark: "🟢", word: "安定", color: "#7FC8A9" },
  yellow: { mark: "🟡", word: "やや不安定", color: "#E9C46A" },
  red: { mark: "🔴", word: "不安定", color: "#E76F51" },
  unknown: { mark: "⚪", word: "未検出", color: "#8FA3B8" },
};

const fmt = (v, d = 3) => (v == null ? "--" : Number(v).toFixed(d));

function reproComment(score) {
  if (score == null) return "";
  if (score >= 85) return "非常に高い再現性です。この感覚を大切に。";
  if (score >= 70) return "良い再現性です。Top指標を磨けばさらに安定します。";
  if (score >= 50) return "再現性に伸びしろがあります。下のヒントから1つずつ。";
  return "3投の形がバラついています。まずはテンポとテイクバック位置から。";
}

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** 過去セッションとの比較(推移)セクションのHTML。3投の再現度で比べる */
function renderTrendSection(currentScore, pastHistory) {
  if (!pastHistory || !pastHistory.length) {
    return `<p class="note">これが最初の記録です。次回以降、ここに前回との比較が表示されます。</p>`;
  }
  const prev = pastHistory[pastHistory.length - 1];
  let deltaHtml = "";
  if (prev.reproducibility != null && currentScore != null) {
    const d = r1(currentScore - prev.reproducibility);
    const cls = d > 0 ? "up" : d < 0 ? "down" : "flat";
    const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "→";
    const sign = d > 0 ? "+" : "";
    deltaHtml = `<div class="trend-delta ${cls}">前回比 ${arrow} ${sign}${d}pt</div>`;
  }
  const series = [...pastHistory, { reproducibility: currentScore, current: true }].slice(-8);
  const maxBarH = 44;
  const barsHtml = series.map((h) => {
    const v = h.reproducibility;
    const height = v == null ? 4 : Math.max(4, (v / 100) * maxBarH);
    return `<div class="trend-bar${h.current ? " current" : ""}" style="height:${height}px" title="${v == null ? "--" : v + "%"}"></div>`;
  }).join("");
  return `
    ${deltaHtml}
    <div class="trend-bars">${barsHtml}</div>
    <p class="note">直近${series.length}回の再現度の推移(右端が今回、濃い色が現在)</p>
  `;
}

/** 撮影した動画をその場で見返せるセクション。各投のリリース直前へジャンプするボタン付き */
function renderVideoSection(result, videoUrl) {
  if (!videoUrl) return "";
  const fps = result.fps || 30;
  const LEAD_IN_SEC = 1.2; // リリース(peak_frame)より少し前から再生し、投げる動作の流れが見えるようにする
  const buttons = result.throws.map((t, i) => {
    const peakSec = (t.features.peak_frame || 0) / fps;
    const seekSec = Math.max(0, peakSec - LEAD_IN_SEC);
    return `<button type="button" class="btn ghost seek-btn" data-seek-sec="${seekSec.toFixed(2)}">▶ ${i + 1}投目</button>`;
  }).join("");
  return `
    <section class="card">
      <h2>🎬 撮影した動画</h2>
      <video id="review-video" class="review-video" src="${videoUrl}" controls playsinline></video>
      <div class="seek-row">${buttons}</div>
      <p class="note">ボタンを押すと、その投擲のリリース${LEAD_IN_SEC}秒前から再生します。数値だけでなく実際の動きも見比べてみましょう。</p>
    </section>
  `;
}

/** 分析結果 → レポートHTML(文字列)。pastHistory は今回より前のセッション記録(古い順) */
export function renderReport(result, pastHistory = [], videoUrl = null) {
  const q = result.capture_quality;
  // 自動判定("A"=スイング系 / "B"=プッシュ系 / "unknown")。画面には出さず、ドリルのコツの出し分けにだけ使う
  const verdict = result.coarse_type?.verdict ?? null;
  const n = result.throws.length;
  const repro = result.reproducibility;

  const top3 = result.ranking.slice(0, 3);
  const unstable = top3.filter((r) => r.level === "red" || r.level === "yellow");

  // 詳細テーブルの行定義
  const feats = result.throws.map((t) => t.features);
  const body = result.throws.map((t) => t.body_stability);
  const v = result.variance;
  const rows = [
    ["テイクバック位置(x)", feats.map((f) => f.takeback_point_norm[0]), v.takeback_position.x_sd, "takeback_position"],
    ["テイクバック位置(y)", feats.map((f) => f.takeback_point_norm[1]), v.takeback_position.y_sd, "takeback_position"],
    ["リリース位置(x)", feats.map((f) => f.release_point_norm[0]), v.release_position.x_sd, "release_position"],
    ["リリース位置(y)", feats.map((f) => f.release_point_norm[1]), v.release_position.y_sd, "release_position"],
    ["軌跡長", feats.map((f) => f.path_length), v.trajectory_length.sd, "trajectory_length"],
    ["弧W/H比", feats.map((f) => (f.arc_height > 1e-9 ? f.arc_width / f.arc_height : null)), v.arc_wh_ratio.sd, "arc_wh_ratio"],
    ["リリース角度(°)", result.throws.map((t) => t.release_angle), v.release_angle.sd_deg, "release_angle"],
    ["投擲間隔(秒)", [null, ...v.throw_interval.intervals_sec], v.throw_interval.sd_sec, "throw_interval"],
    ["胴体中心のブレ", body.map((b) => b.trunk_drift), v.trunk_drift.sd, "trunk_drift"],
    ["頭部の動き", body.map((b) => b.head_drift), v.head_drift.sd, "head_drift"],
    ["軸足の安定性", body.map((b) => b.back_foot_drift), v.back_foot_drift.sd, "back_foot_drift"],
  ];

  const drillHtml = (metric) => {
    const d = pickDrill(metric);
    if (!d) return "";
    const tip = pickDrillTip(metric, verdict);
    return `
      <div class="drill">
        <div class="drill-head">🏋️ ドリル</div>
        <p>${d.action}</p>
        ${tip ? `<p class="drill-tip">💡 ${tip}</p>` : ""}
        <div class="drill-meta">${d.reps} → 📅 ${d.retest_days}日後にもう一度撮影して、再現度の変化を確認しましょう</div>
      </div>`;
  };

  const hintsHtml = unstable.length
    ? unstable.map((r, i) => `
        <div class="hint">
          <div class="hint-head">${i + 1}. ${r.label_jp} ${LEVEL[r.level].mark}${i === 0 && r.level === "red" ? "(最優先)" : ""}</div>
          <p>${pickHint(r.metric, null)}</p>
          ${drillHtml(r.metric)}
        </div>`).join("")
    : `<div class="hint"><div class="hint-head">🎉 全指標が安定しています</div>
       <p>素晴らしい再現性です。この感覚を忘れないうちに、同じ条件でもう1セッション記録しておきましょう。</p></div>`;

  return `
    <section class="score-card">
      <div class="score-label">🎯 3投の再現度</div>
      <div class="score-value">${repro == null ? "--" : fmt(repro, 1)}<span class="score-unit">${repro == null ? "" : "%"}</span></div>
      <div class="score-comment">${repro == null ? "再現度を計算するデータが不足しています。" : reproComment(repro)}</div>
      <div class="trend-section">${renderTrendSection(repro, pastHistory)}</div>
    </section>

    ${renderVideoSection(result, videoUrl)}

    <section class="card">
      <h2>サマリ</h2>
      <ul class="summary">
        <li>解析投擲数: <b>${n}投</b>(ノイズ除外 ${result.noise_excluded_frames.length}件)</li>
        <li>投擲間隔: 平均 ${fmt(v.throw_interval.mean_sec, 1)}秒(SD ±${fmt(v.throw_interval.sd_sec, 1)}秒)</li>
        <li class="quality">撮影品質:
          サイドビュー ${(q.shoulder_x_diff ?? 0) >= CAPTURE_QUALITY_THRESHOLDS.shoulder_x_diff ? "✅" : "⚠️"} /
          検出率 ${Math.round((q.detection_rate ?? 0) * 100)}% ${(q.detection_rate ?? 0) >= CAPTURE_QUALITY_THRESHOLDS.detection_rate ? "✅" : "⚠️"} /
          足元 ${(q.foot_visibility ?? 0) >= CAPTURE_QUALITY_THRESHOLDS.foot_visibility ? "✅" : "⚠️ 未検出(全身を映すと、体や軸足のブレも評価できます)"}
        </li>
      </ul>
    </section>

    <section class="card">
      <h2>バラツキ要因 Top 3</h2>
      ${top3.map((r) => `
        <div class="bar-row">
          <div class="bar-label">${r.label_jp}</div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${Math.min(r.score, 1.2) / 1.2 * 100}%; background:${LEVEL[r.level].color}"></div>
          </div>
          <div class="bar-value">${LEVEL[r.level].mark} ${LEVEL[r.level].word}</div>
        </div>`).join("")}
      <p class="note">バーが右端に近いほど不安定(3投のばらつきが大きい)</p>
    </section>

    <section class="card">
      <h2>改善ヒント</h2>
      ${hintsHtml}
    </section>

    <section class="card">
      <h2>詳細指標</h2>
      <div class="table-wrap">
      <table>
        <thead><tr><th>指標</th>${result.throws.map((_, i) => `<th>${i + 1}投目</th>`).join("")}<th>SD</th><th>評価</th></tr></thead>
        <tbody>
          ${rows.map(([label, vals, sd, metric]) => `
            <tr><td>${label}</td>
              ${vals.map((x) => `<td>${fmt(x)}</td>`).join("")}
              <td>${fmt(sd)}</td>
              <td>${LEVEL[evaluateMetric(metric, sd)].mark}</td></tr>`).join("")}
        </tbody>
      </table>
      </div>
    </section>
  `;
}

/** シェア用 1080×1080 画像を canvas に描画して dataURL を返す */
export function renderShareImage(result) {
  const W = 1080, H = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  const BG = "#2C4A6E", TEXT = "#F4F1EA", SUB = "#A9BCD4", YELLOW = "#E9C46A";
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  const jp = (size, weight = "normal") =>
    `${weight} ${size}px "Hiragino Sans", "Noto Sans JP", sans-serif`;

  // タイトル
  ctx.fillStyle = TEXT; ctx.font = jp(52, "bold");
  ctx.fillText("ダーツ フォーム再現度レポート", 72, 110);
  ctx.fillStyle = SUB; ctx.font = jp(30);
  const date = new Date().toISOString().slice(0, 10);
  ctx.fillText(`${date} / ${result.throws.length}投セッション`, 72, 165);

  // 3投の再現度(大、headline)。色の境目は reproComment と同じ(85% / 70%)
  const repro = result.reproducibility;
  ctx.fillStyle = TEXT; ctx.font = jp(40, "bold");
  ctx.fillText("🎯 3投の再現度", 72, 300);
  ctx.font = `bold 170px "Hiragino Sans", sans-serif`;
  ctx.fillStyle = repro == null ? SUB : repro >= 85 ? "#7FC8A9" : repro >= 70 ? YELLOW : "#E76F51";
  ctx.fillText(`${repro?.toFixed(1) ?? "--"}%`, 72, 470);

  // Top3 バー
  ctx.fillStyle = TEXT; ctx.font = jp(36, "bold");
  ctx.fillText("バラツキ要因 Top 3", 72, 580);
  const colors = { green: "#7FC8A9", yellow: "#E9C46A", red: "#E76F51", unknown: "#8FA3B8" };
  result.ranking.slice(0, 3).forEach((r, i) => {
    const y = 630 + i * 90;
    ctx.fillStyle = TEXT; ctx.font = jp(30);
    ctx.fillText(r.label_jp, 72, y + 38);
    const barX = 360, barW = 460, w = Math.min(r.score, 1.2) / 1.2 * barW;
    ctx.fillStyle = "#24405F"; ctx.fillRect(barX, y + 8, barW, 40);
    ctx.fillStyle = colors[r.level]; ctx.fillRect(barX, y + 8, w, 40);
    ctx.fillStyle = TEXT; ctx.font = jp(26);
    const word = { green: "安定", yellow: "やや不安定", red: "不安定", unknown: "未検出" }[r.level];
    ctx.fillText(word, barX + barW + 20, y + 38);
  });

  // 今日の一手
  const unstable = result.ranking.slice(0, 3).filter((r) => r.level === "red" || r.level === "yellow");
  ctx.fillStyle = YELLOW; ctx.font = jp(34, "bold");
  const head = unstable.length ? `今日の一手 — ${unstable[0].label_jp}` : "今日の一手";
  ctx.fillText(head, 72, 950);
  const hint = unstable.length
    ? pickHint(unstable[0].metric, null)
    : "全指標が安定しています。この感覚を大切に。";
  ctx.fillStyle = TEXT; ctx.font = jp(26);
  wrapText(ctx, hint, 72, 990, W - 144, 38, 2);

  // フッタ
  ctx.fillStyle = SUB; ctx.font = jp(22);
  ctx.fillText("ダーツフォーム分析 — Claude Code × MediaPipe", 72, H - 36);

  return canvas.toDataURL("image/png");
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  let line = "", lines = 0;
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxWidth) {
      ctx.fillText(line, x, y + lines * lineHeight);
      lines++;
      if (lines >= maxLines) { line = ""; break; }
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line && lines < maxLines) ctx.fillText(line, x, y + lines * lineHeight);
}
