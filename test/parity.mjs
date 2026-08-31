/**
 * パリティテスト: JS移植版(analysis.mjs)が Python 版と同じ結果を出すか検証する。
 *
 * 期待値は Python 版の実行結果(2026-07-06 に確認済み):
 *   sample1  : 投擲 [332, 462, 590], ノイズに401含む, 大枠B
 *   sample4  : 投擲 [2014, 2290, 2561], ノイズに1384/2688含む, 大枠B
 *   sample6  : 投擲 [253, 549, 890], 大枠A
 *   IMG_5433 : 投擲 [446, 679, 914], 大枠B
 *
 * 使い方: node app/test/parity.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzeSession } from "../js/analysis.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(here, "..", "..", "tool", "output");

const CASES = [
  { file: "sample1.keypoints.json", throws: [332, 462, 590], type: "B", ratio: 1.09 },
  { file: "sample4.keypoints.json", throws: [2014, 2290, 2561], type: "B", ratio: 1.0 },
  { file: "sample6.keypoints.json", throws: [253, 549, 890], type: "A", ratio: 0.55 },
  { file: "IMG_5433.keypoints.json", throws: [446, 679, 914], type: "B", ratio: 1.01 },
];

// Pythonレポートの詳細指標との一致確認(IMG_5433 = session_20260706_1350)
const IMG_EXPECT = {
  release_angle_mean: 38.167,
  interval_mean: 3.904,
  trunk_mean: 0.013,
  reproducibility_hint: null, // JS新設指標(Python側に無い)なので値の存在だけ確認
};

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
};

for (const c of CASES) {
  console.log(`\n=== ${c.file} ===`);
  const data = JSON.parse(readFileSync(join(outputDir, c.file), "utf-8"));
  const r = analyzeSession(data);
  if (r.error) {
    check("分析成功", false, r.error);
    continue;
  }
  const peaks = r.throws.map((t) => t.features.peak_frame);
  check(`投擲選択 = [${c.throws}]`, JSON.stringify(peaks) === JSON.stringify(c.throws),
    `実際: [${peaks}]`);
  check(`大枠判定 = ${c.type}`, r.coarse_type?.verdict === c.type,
    `実際: ${r.coarse_type?.verdict} (ratio=${r.coarse_type?.ratio_median})`);
  check(`縦横比 ≈ ${c.ratio}`, Math.abs(r.coarse_type.ratio_median - c.ratio) < 0.03,
    `実際: ${r.coarse_type.ratio_median}`);
  check("再現度スコアが算出される", r.reproducibility != null && r.reproducibility > 0,
    `再現度: ${r.reproducibility}%`);
  console.log(`     ノイズ除外: [${r.noise_excluded_frames}]  ` +
    `Top3: ${r.ranking.slice(0, 3).map((x) => `${x.label_jp}(${x.level})`).join(" / ")}`);
}

// IMG_5433 の数値詳細パリティ
console.log("\n=== IMG_5433 数値詳細(Pythonレポートと照合) ===");
{
  const data = JSON.parse(readFileSync(join(outputDir, "IMG_5433.keypoints.json"), "utf-8"));
  const r = analyzeSession(data);
  const v = r.variance;
  check("リリース角度 mean ≈ 38.167",
    Math.abs(v.release_angle.mean_deg - IMG_EXPECT.release_angle_mean) < 0.01,
    `実際: ${v.release_angle.mean_deg}`);
  check("投擲間隔 mean ≈ 3.904",
    Math.abs(v.throw_interval.mean_sec - IMG_EXPECT.interval_mean) < 0.01,
    `実際: ${v.throw_interval.mean_sec}`);
  check("胴体ブレ mean ≈ 0.013",
    Math.abs(v.trunk_drift.mean - IMG_EXPECT.trunk_mean) < 0.001,
    `実際: ${v.trunk_drift.mean}`);
  check("撮影品質 肩幅x ≈ 0.084",
    Math.abs(r.capture_quality.shoulder_x_diff - 0.084) < 0.002,
    `実際: ${r.capture_quality.shoulder_x_diff}`);
  check("足元 visibility ≈ 0.955",
    Math.abs(r.capture_quality.foot_visibility - 0.955) < 0.01,
    `実際: ${r.capture_quality.foot_visibility}`);
}

console.log(`\n${failed === 0 ? "🎉 パリティ全件一致" : `❌ ${failed} 件不一致`}`);
process.exit(failed === 0 ? 0 : 1);
