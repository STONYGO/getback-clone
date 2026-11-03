// 実モデル（MediaPipe Pose Landmarker）で3製品を検証する統合テスト
// 実在の人物写真から上半身を切り出し、回転・拡大・頭部の沈み込みを加えた映像をカメラ入力の代わりに流す。
// 使い方: node tests/real-model.mjs <fixture.jpg> <baseURL> <outDir>
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { CAM_SCRIPT } from "./cam.mjs";

const [fixture, base = "http://localhost:8080", out = "test-results"] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const IMG = "data:image/jpeg;base64," + fs.readFileSync(fixture).toString("base64");
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setupPage(browser, pid) {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`${base}/${pid}/`);
  await page.evaluate(() => { const a = window.__app; a.cfg.badDelay = 1.5; a.cfg.holdSec = 3; a.cfg.preview = true; });
  await page.click("#btnMain");
  await page.waitForFunction(() => window.__app.S.running, null, { timeout: 60000 });
  const info = await page.evaluate(CAM_SCRIPT, IMG);
  await page.click("#btnCam");
  await sleep(1500);
  return { page, errs, info };
}
const st = (page) => page.evaluate(() => ({ title: document.querySelector("#stTitle").textContent, sub: document.querySelector("#stSub").textContent, corners: document.querySelector("#corners").className, feat: window.__app.S.feat }));
const cam = (page, o) => page.evaluate((o) => Object.assign(window.__cam, o), o);
async function calibrate(page) {
  if (!(await page.$eval("#calib", (e) => e.classList.contains("on")))) await page.click("#btnCalib");
  await page.click("#calGo");
  await page.waitForFunction(() => window.__app.S.monitoring, null, { timeout: 30000 });
  await sleep(1500);
}
async function waitCorner(page, mode, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const s = await st(page); if (mode === "" ? s.corners === "" : s.corners.includes(mode)) return s; await sleep(200); }
  return null;
}

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });

/* ---------- KAMAE Lite / KAMAE AI ---------- */
for (const pid of ["kamae", "kamae-ai"]) {
  const { page, errs, info } = await setupPage(browser, pid);
  check(`${pid}: 実写真から人物を検出`, info.shoulderWidthPx > 0, JSON.stringify(info));
  const s0 = await st(page);
  check(`${pid}: 肩基準の特徴量を算出`, s0.feat && s0.feat.gap != null, JSON.stringify(s0.feat));
  await calibrate(page);
  const base = (await st(page)).feat;
  check(`${pid}: キャリブレーション完了・見守り開始`, (await st(page)).corners === "", (await st(page)).title);

  await cam(page, { scale: 1.3, dx: 0.04 }); await sleep(3500);
  const near = await st(page);
  const dGap = Math.abs(near.feat.gap - base.gap), dTilt = Math.abs(near.feat.shTilt - base.shTilt);
  check(`${pid}: 画面に近づく（1.3倍）＋横移動では反応しない［回避設計］`, near.corners === "" && dGap < 0.06 && dTilt < 2.5, `Δgap=${dGap.toFixed(3)} ΔshTilt=${dTilt.toFixed(2)}° 状態=${near.title}`);
  await cam(page, { scale: 1, dx: 0 }); await sleep(1500);

  if (pid === "kamae-ai") {
    let amber = null;
    for (let r = 0; r <= 12 && !amber; r += 0.5) { await cam(page, { rot: r }); await sleep(450); const s = await st(page); if (s.corners.includes("amber")) amber = { r, s }; if (s.corners.includes("red")) break; }
    check(`${pid}: ゆっくり傾くと赤の前に予兆（琥珀色）`, !!amber, amber ? `回転${amber.r}°で予兆` : "予兆なし");
    await page.screenshot({ path: path.join(out, `${pid}-amber.png`) });
    await cam(page, { rot: 0 }); await waitCorner(page, "", 9000);
  }

  await cam(page, { rot: 9 });
  const red = await waitCorner(page, "red");
  check(`${pid}: 体を9°傾けると赤`, !!red, red ? red.sub : "赤にならず");
  await page.screenshot({ path: path.join(out, `${pid}-red.png`) });
  await cam(page, { rot: 0 });
  const green = await waitCorner(page, "green");
  check(`${pid}: 戻すと緑`, !!green, green?.title || "");
  const off = await waitCorner(page, "", 9000);
  check(`${pid}: 3秒キープで消灯`, !!off, off?.title || "");

  await cam(page, { sink: 0.22 });
  const red2 = await waitCorner(page, "red");
  check(`${pid}: 頭が沈む（首と肩の間隔が縮む）と赤`, !!red2, red2 ? red2.sub : JSON.stringify((await st(page)).feat));
  await cam(page, { sink: 0 }); await waitCorner(page, "", 9000);
  await page.screenshot({ path: path.join(out, `${pid}-home.png`), fullPage: true });
  check(`${pid}: ページエラーなし`, errs.length === 0, errs.join(" / "));
  await page.close();
}

/* ---------- GetBack Clone ---------- */
{
  const pid = "getback";
  const { page, errs } = await setupPage(browser, pid);
  const s0 = await st(page);
  check(`${pid}: 頭部角度・視距離・脊柱5角度を算出`, s0.feat && s0.feat.d > 0 && s0.feat.Y1 != null, s0.feat ? `θ=${s0.feat.theta.toFixed(1)}° d=${Math.round(s0.feat.d)}mm Y1=${s0.feat.Y1.toFixed(1)}°` : "");
  await calibrate(page);
  const b = (await st(page)).feat;
  await cam(page, { scale: 1.3 }); await sleep(3500);
  const n = (await st(page)).feat;
  const ratio = n.d / b.d;
  check(`${pid}: 近づくと視距離が短くなる（特許方式は視距離に依存）`, ratio < 0.9 && ratio > 0.65, `d ${Math.round(b.d)}→${Math.round(n.d)}mm（×${ratio.toFixed(2)}、理論値×0.77）`);
  check(`${pid}: 視距離の短縮で推定頚椎前傾Y1が増える`, n.Y1 > b.Y1, `Y1 ${b.Y1.toFixed(1)}→${n.Y1.toFixed(1)}°`);
  await page.evaluate(() => { window.__app.cfg.sens = 2; });
  await cam(page, { scale: 1.6 });
  const red = await waitCorner(page, "red", 10000);
  check(`${pid}: 大きく前のめり（感度2）で脊柱推定に基づき赤`, !!red, red ? red.sub : JSON.stringify((await st(page)).feat));
  await page.screenshot({ path: path.join(out, `${pid}-red.png`) });
  await cam(page, { scale: 1 });
  check(`${pid}: 戻すと緑→消灯`, !!(await waitCorner(page, "green")) && !!(await waitCorner(page, "", 9000)), "");
  await page.screenshot({ path: path.join(out, `${pid}-home.png`), fullPage: true });
  check(`${pid}: ページエラーなし`, errs.length === 0, errs.join(" / "));
  await page.close();
}

await browser.close();
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
const md = ["| 結果 | テスト | 詳細 |", "|---|---|---|", ...results.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.name} | ${String(r.detail).replace(/\|/g, "/").slice(0, 160)} |`)].join("\n");
fs.writeFileSync(path.join(out, "summary.md"), md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 実モデル統合テスト\n\n${md}\n`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
