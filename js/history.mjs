/**
 * セッション履歴(端末内 localStorage のみ・送信なし)
 *
 * 「軸の安定度」を一回の測定で終わらせず、セッションをまたいだ推移として
 * 見せるための最小限の記録。サーバーは使わず、この端末のブラウザにだけ残る。
 */

const KEY = "darts_session_history_v1";
const MAX_ENTRIES = 30;

export function loadHistory() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

/** 現在のセッション結果を履歴に追記して保存する(以前までの履歴は変更しない) */
export function appendSessionToHistory(result) {
  const history = loadHistory();
  history.push({
    ts: Date.now(),
    reproducibility: result.reproducibility,
    axis_score: result.axis_stability.score_pct,
    axis_level: result.axis_stability.level,
    player_type: result.player_type,
    coarse_type: result.coarse_type?.verdict ?? null,
  });
  while (history.length > MAX_ENTRIES) history.shift();
  try {
    localStorage.setItem(KEY, JSON.stringify(history));
  } catch (_) {
    // ストレージ容量超過などで保存できなくても分析自体は継続させる
  }
  return history;
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch (_) { /* noop */ }
}
