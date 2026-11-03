// デスクトップ版（同梱モデル）を実モデルで検証：起動→同梱モデル読込→キャリブレーション→自動で背景へ→傾き→全画面オーバーレイが赤→戻すと消灯
// 使い方（desktop/ で prepare-assets 済み）: xvfb-run node tests/electron-real.mjs <fixture.jpg> <outDir>
import { _electron } from "playwright";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { CAM_SCRIPT } from "./cam.mjs";

const require = createRequire(import.meta.url);
const [fixture, out = "test-results"] = process.argv.slice(2);
const desktop = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "desktop");
const product = JSON.parse(fs.readFileSync(path.join(desktop, "product.json"), "utf8"));
const IMG = "data:image/jpeg;base64," + fs.readFileSync(fixture).toString("base64");
const results = [];
const check = (name, ok, detail = "") => { results.push({ name: `desktop ${product.id}: ${name}`, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await _electron.launch({
  executablePath: require(path.join(desktop, "node_modules", "electron")),
  args: [desktop, "--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
await sleep(2000);
const wins = app.windows();
const ctl = wins.find((w) => w.url().startsWith("app://")), ov = wins.find((w) => w.url().includes("overlay.html"));
const errs = []; ctl.on("pageerror", (e) => errs.push(e.message));
const ctlVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://")).isVisible());

try {
  await ctl.waitForFunction(() => window.__app.S.running && window.__app.S.landmarker, null, { timeout: 90000 });
  check("同梱モデル（オフライン）で推定器を起動", true, await ctl.evaluate(() => document.querySelector("#stTitle").textContent));
  await ctl.evaluate(CAM_SCRIPT, IMG);
  await ctl.evaluate(() => { window.__app.cfg.badDelay = 1.5; });
  check("初回はウィンドウを自動表示", await ctlVisible(), "");
  await sleep(2000);
  await ctl.screenshot({ path: path.join(out, `desktop-${product.id}-start.png`) });
  let ok = false;
  for (let i = 0; i < 3 && !ok; i++) {
    await ctl.click("#calGo");
    try { await ctl.waitForFunction(() => window.__app.S.monitoring, null, { timeout: 15000 }); ok = true; }
    catch { console.log("calib retry:", await ctl.evaluate(() => document.querySelector("#calMsg").textContent + " feat=" + JSON.stringify(window.__app.S.feat))); }
  }
  if (!ok) throw new Error("calibration failed");
  await sleep(1500);
  check("キャリブレーション後に自動で背景へ（ウィンドウ非表示）", !(await ctlVisible()), "");
  await ctl.evaluate((r) => { window.__cam.rot = r; }, product.id === "getback" ? 0 : 9);
  if (product.id === "getback") await ctl.evaluate(() => { window.__app.cfg.sens = 2; window.__cam.scale = 1.6; });
  let red = false; for (let i = 0; i < 40 && !red; i++) { await sleep(200); red = (await ov.$eval("#c", (e) => e.className)).includes("red"); }
  check("ウィンドウ非表示のまま、全画面オーバーレイの四隅が赤", red, "");
  await ov.screenshot({ path: path.join(out, `desktop-${product.id}-overlay-red.png`) });
  await ctl.evaluate(() => { window.__cam.rot = 0; window.__cam.scale = 1; });
  let off = false; for (let i = 0; i < 60 && !off; i++) { await sleep(200); off = (await ov.$eval("#c", (e) => e.className)) === ""; }
  check("戻すと緑→キープで消灯", off, "");
  check("ページエラーなし", errs.length === 0, errs.join(" / "));
} catch (e) {
  check("例外なく完了", false, e.message);
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
fs.mkdirSync(out, { recursive: true });
const md = results.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.name} | ${r.detail} |`).join("\n");
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## デスクトップ版（${product.name}）\n\n| 結果 | テスト | 詳細 |\n|---|---|---|\n${md}\n`);
fs.writeFileSync(path.join(out, `desktop-${product.id}.json`), JSON.stringify(results, null, 2));
process.exit(results.some((r) => !r.ok) ? 1 : 0);
