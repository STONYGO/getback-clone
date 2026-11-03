// 共通アプリ本体（Web版・デスクトップ版で共用）。<html data-product="..."> で製品を切り替える
import { PRODUCTS } from "./products.js";
import { AdaptiveModel } from "./ai.js";
import { History, summarize, detectHabits, buildReport, deliver, aiCoachComment, dayKey, DISCLAIMER } from "./reports.js";

const BR = window.gbBridge || null; // デスクトップ版のみ
const PRODUCT = PRODUCTS[document.documentElement.dataset.product] || PRODUCTS.kamae;
const CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const VENDOR = new URL("../vendor/", import.meta.url).href;
const REMOTE_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const { PoseLandmarker, FilesetResolver } = await import(BR ? VENDOR + "vision_bundle.mjs" : CDN);

const $ = (s) => document.querySelector(s);
const pid = PRODUCT.id;
const W = PRODUCT.id === "getback" ? "姿勢" : "構え"; // 製品ごとの用語
const store = {
  get(k, d = null) { try { const v = JSON.parse(localStorage.getItem(`${pid}.${k}`)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`${pid}.${k}`, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(`${pid}.${k}`); } catch {} },
};
const DEFAULTS = {
  sens: 1, badDelay: 2, holdSec: 3, intensity: "subtle", showMsg: false, preview: false,
  slackUrl: "", gasUrl: "", gasSecret: "", email: "", calendar: true, reportTime: "18:00",
  daily: true, monthly: true, quarterly: true, claudeKey: "",
};
const cfg = { ...DEFAULTS, ...store.get("cfg.v2", {}) };
const saveCfg = () => store.set("cfg.v2", cfg);
const history = new History(pid);

const S = {
  landmarker: null, running: false, monitoring: false, lastVT: -1,
  ema: {}, feat: null, baseline: store.get("baseline.v2"), calibrating: false, samples: [],
  state: "normal", badSince: 0, goodSince: 0, lastSeen: 0, lastTick: 0, lastHabit: 0,
  ev: null, wake: null,
};

/* ================= theme / static UI ================= */
document.documentElement.style.setProperty("--a1", PRODUCT.accent[0]);
document.documentElement.style.setProperty("--a2", PRODUCT.accent[1]);
document.title = `${PRODUCT.name} — ${PRODUCT.tagline}`;
$("#mark").textContent = PRODUCT.short;
$("#pname").textContent = PRODUCT.name;
$("#ptag").textContent = PRODUCT.tagline;
if (PRODUCT.experimental) $("#expChip").hidden = false;
if (PRODUCT.ai) { $("#aiCard").hidden = false; $("#claudeField").hidden = false; }
if (PRODUCT.id === "getback") $("#spineCard").hidden = false;
$("#disclaimer").textContent = DISCLAIMER;
$("#nowTitle").firstChild.textContent = `いまの${W}`;
$("#camNote").textContent = PRODUCT.requiresShoulders
  ? "両肩と胸の上部まで映る位置にカメラを置いてください。映像は端末内だけで処理され、保存も送信もされません。"
  : "顔がはっきり映る位置にカメラを置いてください。映像は端末内だけで処理され、保存も送信もされません。";

// tabs
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", x === b));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === b.dataset.v));
  if (b.dataset.v === "v-history") renderHistory();
  if (b.dataset.v === "v-report") renderPreview();
}));

let toastT;
function toast(m, ms = 2600) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), ms); }

/* ================= overlay (四隅) ================= */
const INT = { subtle: { a: 0.42, s: "20vmin" }, normal: { a: 0.6, s: "28vmin" }, vivid: { a: 0.85, s: "38vmin" } };
let lastOverlay = "";
function overlay(mode, progress = 0, msg = "") {
  const key = `${mode}|${Math.round(progress * 20)}|${msg}|${cfg.intensity}|${cfg.showMsg}`;
  if (key === lastOverlay) return; lastOverlay = key;
  const it = INT[cfg.intensity] || INT.subtle;
  if (BR) { BR.overlay({ mode, progress, msg: cfg.showMsg ? msg : "", alpha: it.a, size: it.s }); return; }
  const c = $("#corners");
  c.style.setProperty("--ca", it.a); c.style.setProperty("--cs", it.s);
  c.className = mode ? `on ${mode}` : "";
}

/* ================= status ================= */
const RING = 2 * Math.PI * 80;
function setRing(score, color) {
  const v = $("#ringVal");
  v.style.strokeDashoffset = RING * (1 - Math.max(0, Math.min(100, score)) / 100);
  if (color) v.style.stroke = color;
  $("#ringNum").textContent = score == null ? "—" : Math.round(score);
}
function setStatus(title, sub = "") {
  $("#stTitle").textContent = title; $("#stSub").textContent = sub;
  BR?.status(title, sub);
}

/* ================= camera & model ================= */
async function initModel() {
  setStatus("準備しています", "姿勢推定モデルを読み込み中（初回のみ数秒）");
  const fileset = await FilesetResolver.forVisionTasks(BR ? VENDOR + "wasm" : CDN + "/wasm");
  const opt = (d) => ({
    baseOptions: { modelAssetPath: BR ? VENDOR + "pose_landmarker_lite.task" : REMOTE_MODEL, delegate: d },
    runningMode: "VIDEO", numPoses: 1, minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  try { S.landmarker = await PoseLandmarker.createFromOptions(fileset, opt("GPU")); }
  catch { S.landmarker = await PoseLandmarker.createFromOptions(fileset, opt("CPU")); }
}
async function startCamera() {
  if (S.running) return;
  $("#btnMain").disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("この環境ではカメラを使えません（HTTPSで開いてください）");
    const v = $("#video");
    v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    await v.play();
    if (!S.landmarker) await initModel();
    S.running = true;
    loop();
    if (S.baseline) toggleMonitor(true);
    else { setStatus(`はじめに${W}を登録します`, "キャリブレーションを行ってください"); openCalib(); }
    BR?.needUI(!S.baseline);
  } catch (e) {
    console.error(e);
    setStatus("開始できませんでした", e.message || String(e));
    BR?.needUI(true);
  } finally { $("#btnMain").disabled = false; updateMainBtn(); }
}

/* ================= main loop ================= */
function smooth(m) {
  const a = 0.25, o = {};
  for (const k in m) { const v = m[k]; if (v == null) { S.ema[k] = null; o[k] = null; continue; } S.ema[k] = S.ema[k] == null ? v : S.ema[k] * (1 - a) + v * a; o[k] = S.ema[k]; }
  return o;
}
function loop() {
  if (!S.running) return;
  const v = $("#video");
  if (BR && v.paused && v.srcObject) v.play().catch(() => {});
  if (v.readyState >= 2 && v.currentTime !== S.lastVT && (BR || !document.hidden)) {
    S.lastVT = v.currentTime;
    const cv = $("#overlay"); if (cv.width !== v.videoWidth) { cv.width = v.videoWidth; cv.height = v.videoHeight; }
    const now = performance.now(), wall = Date.now();
    const r = S.landmarker.detectForVideo(v, now);
    const lm = r.landmarks?.[0];
    const raw = lm ? PRODUCT.compute(lm, v.videoWidth, v.videoHeight) : null;
    if (raw) {
      S.lastSeen = now;
      const f = smooth(raw); S.feat = f;
      if (S.calibrating) { S.samples.push(raw); draw(lm, true); }
      else if (S.baseline) {
        const ev = PRODUCT.evaluate(f, S.baseline, cfg, now); S.ev = ev;
        draw(lm, !ev.bad); renderLive(f, ev);
        if (S.monitoring) {
          updateState(ev, now);
          if (wall - S.lastHabit > 1000) { S.lastHabit = wall; history.habit(wall, PRODUCT.habit(f)); }
        }
      } else draw(lm, true);
    } else {
      draw(null); S.ema = {};
      if (S.monitoring && now - S.lastSeen > 1500) {
        setStatus(PRODUCT.requiresShoulders ? "両肩が映っていません" : "顔が見えません", "判定を一時停止しています");
        setRing(null, "var(--faint)"); S.lastTick = 0;
        if (S.state !== "red") overlay(null);
      }
    }
  }
  if (BR) setTimeout(loop, 66); else requestAnimationFrame(loop);
}

/* ================= state machine =================
   normal →（崩れが badDelay 継続）→ red →（戻す）→ green →（holdSec キープ）→ normal
   KAMAE AI：normal 中に崩れの予兆を検知すると淡い amber を灯す */
function updateState(ev, now) {
  if (ev.bad) { if (!S.badSince) S.badSince = now; S.goodSince = 0; }
  else { S.badSince = 0; if (!S.goodSince) S.goodSince = now; }
  const bd = cfg.badDelay * 1000, hd = cfg.holdSec * 1000;
  if (S.state === "normal" && ev.bad && now - S.badSince >= bd) { S.state = "red"; history.alert(Date.now()); }
  else if (S.state === "red" && !ev.bad && now - S.goodSince >= 250) S.state = "green";
  else if (S.state === "green") {
    if (ev.bad && now - S.badSince >= 500) S.state = "red";
    else if (!ev.bad && now - S.goodSince >= hd) { S.state = "normal"; toast(`良い${W}に戻りました`); }
  }
  const score = Math.max(0, 100 - ev.r * 50);
  if (S.state === "red") { overlay("red", 0, ev.reason); setStatus("姿勢が崩れています", ev.reason); setRing(score, "var(--bad)"); }
  else if (S.state === "green") {
    const p = Math.min(1, (now - S.goodSince) / hd);
    overlay("green", p, `その${W}をキープ`); setStatus(`その${W}をキープ`, `あと ${Math.max(0, (hd - (now - S.goodSince)) / 1000).toFixed(1)} 秒`); setRing(score, "var(--good)");
  } else if (ev.predict?.warn) {
    overlay("amber", 0, "崩れの兆候があります"); setStatus("崩れの兆候", "AIが予兆を検知しました。軽く背すじを伸ばしましょう"); setRing(score, "var(--warn)");
  } else {
    overlay(null); setStatus(ev.bad ? "少し崩れています" : `良い${W}です`, ev.bad ? ev.reason : "背景で見守っています"); setRing(score, ev.bad ? "var(--warn)" : "url(#grad)");
  }
  const t = Date.now();
  if (S.lastTick) history.tick(t, t - S.lastTick, S.state === "red" ? "bad" : "good", S.state === "red" ? ev.reason : "");
  S.lastTick = t;
}

/* ================= live panels ================= */
let liveT = 0;
function renderLive(f, ev) {
  const now = performance.now(); if (now - liveT < 250) return; liveT = now;
  const det = Object.fromEntries((ev.details || []).map((d) => [d.key, d]));
  $("#meters").innerHTML = PRODUCT.features.filter((d) => !d.spine).map((d) => {
    const v = f[d.key], x = det[d.key];
    const cls = v == null ? "na" : !x ? "" : x.ratio > 1 ? "bad" : x.ratio > 0.6 ? "warn" : "";
    const w = x ? Math.min(100, x.ratio * 100) : 0;
    return `<div class="meter ${cls}"><div class="row"><span>${d.name}</span><em>${v == null ? "—" : d.fmt(v) + d.unit}</em></div><div class="bar"><i style="width:${w}%"></i></div></div>`;
  }).join("");
  if (PRODUCT.id === "getback") {
    $("#spine").innerHTML = PRODUCT.features.filter((d) => d.spine).map((d) => {
      const x = det[d.key]; const cls = !x ? "" : x.ratio > 1 ? "bad" : x.ratio > 0.6 ? "warn" : "";
      return `<div class="meter ${cls}"><div class="row"><span>${d.name}</span><em>${d.fmt(f[d.key])}°${x ? `（${x.dev >= 0 ? "+" : ""}${x.dev.toFixed(1)}）` : ""}</em></div><div class="bar"><i style="width:${x ? Math.min(100, x.ratio * 100) : 0}%"></i></div></div>`;
    }).join("");
  }
  if (PRODUCT.ai && ev.ai) {
    $("#aiLearned").textContent = ev.ai.learned.toLocaleString();
    $("#aiDrift").textContent = Math.round(ev.ai.drift * 100) + "%";
    $("#aiPredict").textContent = ev.predict?.warn ? `${Math.max(1, Math.round(ev.predict.eta))}秒後` : "安定";
  }
}
function draw(lm, ok) {
  if ($("#cam").classList.contains("hide")) return;
  const cv = $("#overlay"), ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H); if (!lm) return;
  const pts = PRODUCT.requiresShoulders ? [9, 10, 11, 12] : [0, 2, 5, 7, 8, 11, 12];
  ctx.fillStyle = ok ? "#4ade80" : "#fb7185";
  for (const i of pts) { if ((lm[i].visibility ?? 1) < 0.5) continue; ctx.beginPath(); ctx.arc(lm[i].x * W, lm[i].y * H, Math.max(3, W / 150), 0, 7); ctx.fill(); }
}

/* ================= today tiles / history ================= */
function fmtMin(ms) { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`; }
function renderToday() {
  const s0 = new Date(); s0.setHours(0, 0, 0, 0);
  const s = summarize(history.range(s0.getTime(), Date.now() + 1));
  $("#tRate").textContent = s.rate == null ? "—" : Math.round(s.rate * 100) + "%";
  $("#tTime").textContent = fmtMin(s.total);
  $("#tAlerts").textContent = s.alerts;
  const hb = detectHabits(history);
  $("#homeHabits").innerHTML = hb.map(habitHTML).join("");
}
const habitHTML = (h) => `<div class="habit ${h.level}"><b>${h.level === "consult" ? "受診のおすすめ" : "傾きの癖"}・${h.label}</b>${h.message}</div>`;
function renderHistory() {
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); days.push(d.getTime()); }
  $("#bars").innerHTML = days.map((t) => {
    const s = summarize(history.range(t, t + 864e5)), r = s.rate;
    const lbl = ["日", "月", "火", "水", "木", "金", "土"][new Date(t).getDay()];
    return `<div><em>${r == null ? "" : Math.round(r * 100)}</em><i class="${r == null ? "empty" : ""}" style="height:${r == null ? 3 : Math.max(4, r * 100)}%"></i><span>${lbl}</span></div>`;
  }).join("");
  const s0 = new Date(); s0.setHours(0, 0, 0, 0);
  const s = summarize(history.range(s0.getTime(), Date.now() + 1));
  $("#strip").innerHTML = s.hours.map(([g, b]) => {
    const t = g + b; if (!t) return "<i></i>";
    const r = g / t, c = r > 0.85 ? "var(--good)" : r > 0.6 ? "var(--warn)" : "var(--bad)";
    return `<i style="background:${c};opacity:${0.35 + Math.min(1, t / 36e5) * 0.65}" title="${Math.round(r * 100)}%"></i>`;
  }).join("");
  const m = summarize(history.range(Date.now() - 30 * 864e5, Date.now() + 1));
  $("#m30").textContent = m.rate == null ? "データ蓄積中" : `直近30日の良い姿勢率 ${Math.round(m.rate * 100)}%・計測 ${fmtMin(m.total)}・警告 ${m.alerts}回${PRODUCT.id === "getback" ? `・不良5%超の時間帯 ${m.hourFlags}` : ""}`;
  const hb = detectHabits(history, Date.now(), 28);
  $("#habits").innerHTML = hb.length ? hb.map(habitHTML).join("") : `<div class="empty-s">いまのところ、一定方向への傾きの癖は見つかっていません（1日30分以上・3日分以上のデータで判定します）</div>`;
}

/* ================= calibration ================= */
const CAL_MS = 4000, CRING = 2 * Math.PI * 50;
function openCalib() {
  if (S.monitoring) toggleMonitor(false);
  $("#calTitle").textContent = `良い${W}を登録します`;
  $("#calMsg").innerHTML = PRODUCT.requiresShoulders
    ? "カメラを水平にし、<b>両肩と胸の上部</b>が映る位置で、背すじを伸ばした良い姿勢をとってください。"
    : "カメラを水平にし、<b>顔全体</b>が映る位置で、背すじを伸ばした良い姿勢をとってください。";
  $("#calNum").textContent = ""; $("#calArc").style.strokeDashoffset = CRING; $("#calGo").disabled = false; $("#calGo").textContent = "開始";
  $("#calib").classList.add("on"); BR?.needUI(true);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runCalib() {
  if (!S.running) await startCamera();
  $("#calGo").disabled = true;
  for (let i = 3; i > 0; i--) { $("#calNum").textContent = i; await sleep(800); }
  $("#calNum").textContent = ""; $("#calMsg").innerHTML = "そのまま<b>動かずに</b>画面を見ていてください";
  S.samples = []; S.calibrating = true;
  const t0 = performance.now();
  await new Promise((res) => { const tick = () => { const p = Math.min(1, (performance.now() - t0) / CAL_MS); $("#calArc").style.strokeDashoffset = CRING * (1 - p); p < 1 ? requestAnimationFrame(tick) : res(); }; tick(); });
  S.calibrating = false;
  const smp = S.samples;
  const fail = (m) => { $("#calTitle").textContent = "もう一度お願いします"; $("#calMsg").innerHTML = m; $("#calGo").disabled = false; $("#calGo").textContent = "再試行"; };
  if (smp.length < 30) return fail(PRODUCT.requiresShoulders ? "両肩が十分に映っていませんでした。カメラを少し離すか下向きにしてください。" : "顔が十分に映っていませんでした。明るい場所で再度お試しください。");
  const B = {};
  for (const k of Object.keys(smp[0])) {
    const v = smp.map((s) => s[k]).filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
    if (v.length < smp.length * 0.6) continue;
    const tr = v.slice(Math.floor(v.length * 0.1), Math.ceil(v.length * 0.9));
    const mean = tr.reduce((a, b) => a + b, 0) / tr.length;
    B[k] = { mean, sd: Math.sqrt(tr.reduce((a, b) => a + (b - mean) ** 2, 0) / tr.length) };
  }
  const tilt = B.shTilt?.sd > 4 || B.roll?.sd > 4 || B.gap?.sd > 0.08 || B.theta?.sd > 5;
  if (tilt) return fail("計測中に体が動いていました。端末を固定し、静止した状態で再度お試しください。");
  B.at = Date.now();
  S.baseline = B; store.set("baseline.v2", B);
  if (PRODUCT.ai) PRODUCT.initModel(B, smp);
  $("#calNum").textContent = "✓"; $("#calTitle").textContent = "登録しました";
  const sh = B.shTilt?.mean;
  $("#calMsg").innerHTML = sh != null && Math.abs(sh) >= 4
    ? `登録時点で${sh > 0 ? "左" : "右"}肩が約${Math.abs(sh).toFixed(0)}°下がっています。カメラが水平か確認してください。カメラが水平で毎回こうなる場合は、傾きの癖として経過を見ていきます。`
    : "以後はウィンドウを閉じても、背景で見守ります。";
  await sleep(sh != null && Math.abs(sh) >= 4 ? 4000 : 1400);
  $("#calib").classList.remove("on");
  toggleMonitor(true);
  BR?.needUI(false);
}

/* ================= monitor ================= */
function updateMainBtn() { $("#btnMain").textContent = !S.running ? "はじめる" : S.monitoring ? "一時停止" : "再開"; }
async function toggleMonitor(on) {
  if (!S.running) { await startCamera(); return; }
  if (!S.baseline) { openCalib(); return; }
  S.monitoring = on ?? !S.monitoring;
  S.state = "normal"; S.badSince = S.goodSince = 0; S.lastTick = 0; overlay(null);
  updateMainBtn(); BR?.monitoring(S.monitoring);
  if (S.monitoring) { try { S.wake = await navigator.wakeLock?.request("screen"); } catch {} setStatus("見守り中", "背景で見守っています"); }
  else { try { await S.wake?.release(); } catch {} setStatus("一時停止中", "「再開」で見守りを再開します"); setRing(null, "var(--faint)"); history.save(true); }
}

/* ================= settings UI ================= */
function bindRange(id, key, fmt) {
  const el = $(id), out = el.nextElementSibling; el.value = cfg[key];
  const upd = () => { cfg[key] = +el.value; out.textContent = fmt(+el.value); saveCfg(); };
  el.addEventListener("input", upd); out.textContent = fmt(cfg[key]);
}
bindRange("#sens", "sens", (v) => v.toFixed(1));
bindRange("#badDelay", "badDelay", (v) => v + "秒");
bindRange("#holdSec", "holdSec", (v) => v + "秒");
document.querySelectorAll("#intensity button").forEach((b) => {
  b.setAttribute("aria-pressed", b.dataset.v === cfg.intensity);
  b.addEventListener("click", () => { cfg.intensity = b.dataset.v; saveCfg(); document.querySelectorAll("#intensity button").forEach((x) => x.setAttribute("aria-pressed", x === b)); previewCorner(); });
});
function previewCorner() { overlay("green", 1, "表示の確認"); setTimeout(() => overlay(null), 1600); }
for (const [id, key] of [["#showMsg", "showMsg"], ["#calendar", "calendar"], ["#daily", "daily"], ["#monthly", "monthly"], ["#quarterly", "quarterly"]]) {
  const el = $(id); el.checked = !!cfg[key]; el.addEventListener("change", () => { cfg[key] = el.checked; saveCfg(); });
}
for (const [id, key] of [["#slackUrl", "slackUrl"], ["#gasUrl", "gasUrl"], ["#gasSecret", "gasSecret"], ["#email", "email"], ["#reportTime", "reportTime"], ["#claudeKey", "claudeKey"]]) {
  const el = $(id); el.value = cfg[key] || ""; el.addEventListener("change", () => { cfg[key] = el.value.trim(); saveCfg(); });
}
const camEl = $("#cam");
function setPreview(on) { cfg.preview = on; saveCfg(); camEl.classList.toggle("hide", !on); $("#btnCam").textContent = on ? "カメラを隠す" : "カメラを表示"; }
setPreview(!!cfg.preview);
$("#btnCam").onclick = () => setPreview(camEl.classList.contains("hide"));
$("#btnMain").onclick = () => toggleMonitor();
$("#btnCalib").onclick = openCalib;
$("#calGo").onclick = runCalib;
$("#calCancel").onclick = () => { S.calibrating = false; $("#calib").classList.remove("on"); if (S.baseline) BR?.needUI(false); };
$("#resetCal").onclick = () => { store.del("baseline.v2"); if (PRODUCT.ai) AdaptiveModel.reset(); S.baseline = null; toast("キャリブレーションを消去しました"); openCalib(); };
$("#resetHist").onclick = () => { history.clear(); renderToday(); toast("記録を消去しました"); };

/* ================= reports ================= */
const sentLog = store.get("sent.v2", { day: "", month: "", quarter: "", log: [] });
function logSend(t) { sentLog.log.unshift(`${new Date().toLocaleString("ja-JP")}　${t}`); sentLog.log = sentLog.log.slice(0, 8); store.set("sent.v2", sentLog); $("#sendLog").innerHTML = sentLog.log.join("<br>") || "まだ送信していません"; }
$("#sendLog").innerHTML = sentLog.log.join("<br>") || "まだ送信していません";
async function makeReport(kind) {
  let r = buildReport({ product: PRODUCT, history, kind });
  if (PRODUCT.ai && cfg.claudeKey && r.stats.total) {
    try { const c = await aiCoachComment(cfg.claudeKey, r, PRODUCT); r = buildReport({ product: PRODUCT, history, kind, aiComment: c }); }
    catch (e) { console.warn(e); }
  }
  return r;
}
async function sendReport(kind, manual) {
  history.save(true);
  if (!cfg.slackUrl && !cfg.gasUrl) { if (manual) toast("送信先（Slack または Google Apps Script）を設定してください"); return false; }
  const r = await makeReport(kind);
  try {
    const ch = await deliver(r, cfg, PRODUCT);
    logSend(`${r.title} → ${ch.join("・")}`); if (manual) toast(`${r.title}を送信しました`); return true;
  } catch (e) { logSend(`送信失敗：${e.message}`); if (manual) toast("送信に失敗しました"); return false; }
}
async function renderPreview(kind = $("#pvKind").value) {
  const r = await makeReport(kind);
  $("#preview").textContent = r.text;
}
$("#pvKind").onchange = () => renderPreview();
document.querySelectorAll("[data-send]").forEach((b) => b.addEventListener("click", () => sendReport(b.dataset.send, true)));

// 定期配信：日次（設定時刻以降に1回）、月次（毎月初回の日次タイミングで前月分）、3か月（1・4・7・10月に前3か月分）
async function scheduler() {
  const now = new Date(), [hh, mm] = (cfg.reportTime || "18:00").split(":").map(Number);
  if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return;
  const today = dayKey(now), ym = today.slice(0, 7);
  if (cfg.daily && sentLog.day !== today) { if (await sendReport("day")) { sentLog.day = today; store.set("sent.v2", sentLog); } }
  if (cfg.monthly && sentLog.month !== ym) {
    if (history.b.some((x) => x.t < new Date(now.getFullYear(), now.getMonth(), 1).getTime())) { if (await sendReport("month")) { sentLog.month = ym; store.set("sent.v2", sentLog); } }
  }
  if (cfg.quarterly && now.getMonth() % 3 === 0 && sentLog.quarter !== ym) {
    if (history.b.some((x) => x.t < new Date(now.getFullYear(), now.getMonth() - 2, 1).getTime())) { if (await sendReport("quarter")) { sentLog.quarter = ym; store.set("sent.v2", sentLog); } }
  }
}
setInterval(scheduler, 60000);
setInterval(() => { renderToday(); history.save(); }, 15000);
window.addEventListener("beforeunload", () => history.save(true));
document.addEventListener("visibilitychange", async () => { if (!document.hidden && S.monitoring) { try { S.wake = await navigator.wakeLock?.request("screen"); } catch {} } });

/* ================= desktop bridge ================= */
if (BR) {
  BR.onCommand((c) => {
    if (c === "calibrate") openCalib();
    else if (c === "toggle") toggleMonitor();
    else if (c === "report") sendReport("day", true);
  });
  startCamera();
}

renderToday();
setRing(null, "var(--faint)");
updateMainBtn();
if (!BR) setStatus(S.baseline ? "準備できています" : "はじめましょう", S.baseline ? "「はじめる」でカメラを起動します" : `最初に良い${W}を登録します`);

// テスト・開発用
window.__app = { S, cfg, history, PRODUCT, buildReport, detectHabits, sendReport, updateState };
