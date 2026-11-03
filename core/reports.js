// 姿勢ログの保存・集計・傾きの癖検出・レポート生成・配信（Slack / メール / カレンダー）
const BUCKET_MS = 10 * 60 * 1000;
const KEEP_DAYS = 120;
const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`; };
const pct = (x) => `${Math.round(x * 100)}%`;

/* ---------------- 履歴 ---------------- */
export class History {
  constructor(pid) { this.key = `${pid}.history.v1`; this.b = []; this._dirty = false; this._saved = 0; this.load(); }
  load() { try { this.b = JSON.parse(localStorage.getItem(this.key)) || []; } catch { this.b = []; } }
  save(force) {
    const now = Date.now();
    if (!force && (!this._dirty || now - this._saved < 30000)) return;
    const cut = now - KEEP_DAYS * 864e5;
    this.b = this.b.filter((x) => x.t >= cut);
    try { localStorage.setItem(this.key, JSON.stringify(this.b)); } catch {}
    this._dirty = false; this._saved = now;
  }
  bucket(now) {
    const t = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    let x = this.b[this.b.length - 1];
    if (!x || x.t !== t) { x = { t, g: 0, b: 0, a: 0, r: {}, h: {} }; this.b.push(x); }
    return x;
  }
  // state: "good" | "bad"
  tick(now, dt, state, reason) {
    if (dt <= 0 || dt > 2000) return;
    const x = this.bucket(now);
    if (state === "bad") { x.b += dt; if (reason) x.r[reason] = (x.r[reason] || 0) + dt; } else x.g += dt;
    this._dirty = true; this.save();
  }
  alert(now) { this.bucket(now).a++; this._dirty = true; }
  // 傾きの癖用の符号付きサンプル（1秒に1回程度）
  habit(now, h) {
    const x = this.bucket(now);
    for (const k in h) { if (h[k] == null || !isFinite(h[k])) continue; const s = x.h[k] || (x.h[k] = [0, 0]); s[0] += h[k]; s[1]++; }
  }
  range(from, to) { return this.b.filter((x) => x.t >= from && x.t < to); }
  clear() { this.b = []; this.save(true); }
}

/* ---------------- 集計 ---------------- */
export function summarize(buckets) {
  const s = { good: 0, bad: 0, alerts: 0, reasons: {}, hours: Array.from({ length: 24 }, () => [0, 0]), days: {}, hourFlags: 0 };
  const perHour = {};
  for (const x of buckets) {
    s.good += x.g; s.bad += x.b; s.alerts += x.a;
    for (const k in x.r) s.reasons[k] = (s.reasons[k] || 0) + x.r[k];
    const d = new Date(x.t), h = d.getHours(), dk = dayKey(x.t);
    s.hours[h][0] += x.g; s.hours[h][1] += x.b;
    const D = s.days[dk] || (s.days[dk] = { good: 0, bad: 0, alerts: 0 });
    D.good += x.g; D.bad += x.b; D.alerts += x.a;
    const hk = dk + h; const H = perHour[hk] || (perHour[hk] = [0, 0]); H[0] += x.g; H[1] += x.b;
  }
  // GetBack特許の実施例に倣った時間判定：1時間のうち不良が5%以上の時間帯数
  for (const k in perHour) { const [g, b] = perHour[k]; if (g + b > 10 * 60000 && b / (g + b) >= 0.05) s.hourFlags++; }
  s.total = s.good + s.bad;
  s.rate = s.total ? s.good / s.total : null;
  s.topReasons = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const worst = s.hours.map(([g, b], h) => ({ h, r: g + b > 15 * 60000 ? b / (g + b) : -1 })).sort((a, b) => b.r - a.r)[0];
  s.worstHour = worst && worst.r > 0 ? worst.h : null;
  return s;
}

/* ---------------- 傾きの癖（未病のサイン） ---------------- */
const HABITS = {
  shTilt: { label: "肩の高さの左右差", unit: "°", info: 3, consult: 5, pos: "左肩が下がる", neg: "右肩が下がる" },
  lateral: { label: "上体の左右への傾き", unit: "", info: 0.08, consult: 0.15, pos: "上体が左へ傾く", neg: "上体が右へ傾く" },
  roll: { label: "首の左右への傾き", unit: "°", info: 5, consult: 8, pos: "首が左へ傾く", neg: "首が右へ傾く" },
};
export function detectHabits(history, now = Date.now(), days = 14) {
  const from = now - days * 864e5;
  const perDay = {};
  for (const x of history.range(from, now + 1)) {
    const dk = dayKey(x.t);
    for (const k in x.h) {
      const D = (perDay[k] ||= {}); const s = (D[dk] ||= [0, 0]); s[0] += x.h[k][0]; s[1] += x.h[k][1];
    }
  }
  const out = [];
  for (const k in perDay) {
    const def = HABITS[k]; if (!def) continue;
    const means = Object.values(perDay[k]).filter(([, n]) => n >= 1800).map(([s, n]) => s / n); // 1日30分以上の計測日のみ
    if (means.length < 3) continue;
    const sorted = [...means].sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
    const same = means.filter((m) => Math.sign(m) === Math.sign(med) && Math.abs(m) >= def.info).length;
    if (Math.abs(med) < def.info || same / means.length < 0.7) continue;
    const consult = Math.abs(med) >= def.consult || (same >= 10);
    out.push({
      key: k, label: def.label, direction: med > 0 ? def.pos : def.neg,
      value: med, unit: def.unit, days: same, of: means.length, level: consult ? "consult" : "info",
      message: consult
        ? `${med > 0 ? def.pos : def.neg}傾向が${same}日続いています。体のゆがみ（側弯など）のサインであることもあるため、一度整形外科での相談をおすすめします。`
        : `${med > 0 ? def.pos : def.neg}癖が見られます（${same}/${means.length}日）。座る位置・画面やカメラの高さ、荷物を持つ側などを見直してみてください。`,
    });
  }
  return out;
}
export const DISCLAIMER = "本アプリは医療機器ではなく、病気の診断・治療を目的としたものではありません。痛み・しびれ・左右差の進行などがある場合は医療機関を受診してください。";

/* ---------------- レポート生成 ---------------- */
export function periodRange(kind, now = Date.now()) {
  const d = new Date(now);
  if (kind === "day") { const s = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); return [s, s + 864e5, "日次"]; }
  if (kind === "month") { const e = new Date(d.getFullYear(), d.getMonth(), 1).getTime(); const s = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(); return [s, e, "月次"]; }
  if (kind === "quarter") { const e = new Date(d.getFullYear(), d.getMonth(), 1).getTime(); const s = new Date(d.getFullYear(), d.getMonth() - 3, 1).getTime(); return [s, e, "3か月"]; }
  if (kind === "last30") return [now - 30 * 864e5, now, "直近30日"];
  if (kind === "last90") return [now - 90 * 864e5, now, "直近90日"];
  throw new Error(kind);
}

export function buildReport({ product, history, kind, now = Date.now(), aiComment = "" }) {
  const [from, to, label] = periodRange(kind, now);
  const s = summarize(history.range(from, to));
  const span = to - from;
  const prev = summarize(history.range(from - span, from));
  const habits = detectHabits(history, now, kind === "day" ? 14 : 28);
  const title = `${product.name} ${label}レポート`;
  const dateLabel = kind === "day" ? dayKey(from) : `${dayKey(from)} 〜 ${dayKey(to - 1)}`;
  const trend = s.rate != null && prev.rate != null ? Math.round((s.rate - prev.rate) * 100) : null;
  const lines = [];
  if (!s.total) lines.push("この期間の計測データはありません。");
  else {
    lines.push(`良い姿勢率 ${pct(s.rate)}${trend != null ? `（前期間比 ${trend >= 0 ? "+" : ""}${trend}pt）` : ""}`);
    lines.push(`計測時間 ${fmtDur(s.total)}／警告 ${s.alerts}回`);
    if (s.worstHour != null) lines.push(`崩れやすい時間帯 ${s.worstHour}時台`);
    if (s.topReasons.length) lines.push(`多かった崩れ方 ${s.topReasons.map(([k, ms]) => `${k}（${fmtDur(ms)}）`).join("、")}`);
    if (product.id === "getback") lines.push(`不良5%以上の時間帯 ${s.hourFlags}／警告10回以上の日 ${Object.values(s.days).filter((d) => d.alerts >= 10).length}日`);
    if (kind !== "day") {
      const ds = Object.entries(s.days).sort();
      const best = ds.filter(([, d]) => d.good + d.bad > 30 * 60000).sort((a, b) => b[1].good / (b[1].good + b[1].bad) - a[1].good / (a[1].good + a[1].bad))[0];
      lines.push(`計測日数 ${ds.length}日${best ? `／ベストの日 ${best[0]}（${pct(best[1].good / (best[1].good + best[1].bad))}）` : ""}`);
    }
  }
  const habitLines = habits.map((h) => `${h.level === "consult" ? "【受診のおすすめ】" : "【傾きの癖】"}${h.label}：${h.message}`);
  const text = [`${title}（${dateLabel}）`, ...lines.map((l) => `・${l}`), ...(habitLines.length ? ["", ...habitLines] : []), ...(aiComment ? ["", `AIコーチ：${aiComment}`] : []), "", DISCLAIMER].join("\n");

  const html = `<div style="font-family:-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;max-width:560px;margin:auto;color:#111">
  <div style="padding:20px 22px;border-radius:16px;background:linear-gradient(135deg,${product.accent[0]},${product.accent[1]});color:#fff">
    <div style="font-size:12px;opacity:.85">${dateLabel}</div><div style="font-size:20px;font-weight:700">${title}</div>
    <div style="font-size:44px;font-weight:800;margin-top:6px">${s.rate != null ? pct(s.rate) : "—"}</div><div style="font-size:12px;opacity:.85">良い姿勢率</div></div>
  <ul style="line-height:1.8;padding-left:18px">${lines.map((l) => `<li>${l}</li>`).join("")}</ul>
  ${habits.map((h) => `<div style="margin:10px 0;padding:12px 14px;border-radius:12px;background:${h.level === "consult" ? "#fff1f2" : "#fffbeb"};border:1px solid ${h.level === "consult" ? "#fecdd3" : "#fde68a"}"><b>${h.level === "consult" ? "受診のおすすめ" : "傾きの癖"}：${h.label}</b><br>${h.message}</div>`).join("")}
  ${aiComment ? `<div style="margin:10px 0;padding:12px 14px;border-radius:12px;background:#f5f3ff;border:1px solid #ddd6fe"><b>AIコーチ</b><br>${aiComment}</div>` : ""}
  <p style="font-size:11px;color:#666">${DISCLAIMER}</p></div>`;

  const slack = {
    text: `${title}：良い姿勢率 ${s.rate != null ? pct(s.rate) : "—"}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `${title}（${dateLabel}）` } },
      { type: "section", text: { type: "mrkdwn", text: lines.map((l) => `• ${l}`).join("\n") || "データなし" } },
      ...habits.map((h) => ({ type: "section", text: { type: "mrkdwn", text: `${h.level === "consult" ? ":hospital: *受診のおすすめ*" : ":warning: *傾きの癖*"}　${h.label}\n${h.message}` } })),
      ...(aiComment ? [{ type: "section", text: { type: "mrkdwn", text: `:sparkles: *AIコーチ*\n${aiComment}` } }] : []),
      { type: "context", elements: [{ type: "mrkdwn", text: DISCLAIMER }] },
    ],
  };
  return { kind, title, dateLabel, stats: s, habits, text, html, slack, subject: `【${product.name}】${label}レポート ${dateLabel}` };
}

/* ---------------- AIコメント（KAMAE AIのみ・任意） ---------------- */
export async function aiCoachComment(apiKey, report, product) {
  const s = report.stats;
  const facts = {
    period: report.dateLabel, kind: report.kind, goodRate: s.rate, measuredMin: Math.round(s.total / 60000), alerts: s.alerts,
    worstHour: s.worstHour, topReasons: s.topReasons.map(([k, ms]) => [k, Math.round(ms / 60000)]),
    habits: report.habits.map((h) => ({ label: h.label, direction: h.direction, days: h.days, level: h.level })),
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({
      model: "claude-sonnet-5-5", max_tokens: 400,
      system: "あなたはデスクワーカーの姿勢コーチです。与えられた集計値だけを根拠に、日本語で3文以内の具体的で前向きな助言を書きます。病名の断定や診断はしません。傾きの癖がlevel=consultの場合のみ、整形外科での相談を一言添えます。",
      messages: [{ role: "user", content: `製品:${product.name}\n集計:${JSON.stringify(facts)}` }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const j = await res.json();
  return (j.content || []).map((c) => c.text || "").join("").trim();
}

/* ---------------- 配信 ---------------- */
// Slack Incoming Webhook：CORSを避けるため form-encoded の単純リクエストで送る（応答は読めない）
export async function sendSlack(url, payload) {
  await fetch(url, { method: "POST", mode: "no-cors", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "payload=" + encodeURIComponent(JSON.stringify(payload)) });
}
// Google Apps Script ウェブアプリ（integrations/google-apps-script/Code.gs）：メール送信＋カレンダー登録
export async function sendGAS(url, body) {
  await fetch(url, { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) });
}
export async function deliver(report, cfg, product) {
  const done = [];
  if (cfg.slackUrl) { await sendSlack(cfg.slackUrl, report.slack); done.push("Slack"); }
  if (cfg.gasUrl) {
    const at = Date.now();
    await sendGAS(cfg.gasUrl, {
      secret: cfg.gasSecret || "", to: cfg.email || "", subject: report.subject, text: report.text, html: report.html,
      calendar: cfg.calendar ? { title: `${product.name} ${report.title.replace(product.name, "").trim()}：${report.stats.rate != null ? pct(report.stats.rate) : "—"}`, start: at, end: at + 15 * 60000, description: report.text } : null,
    });
    done.push(cfg.email ? "メール" : null, cfg.calendar ? "カレンダー" : null);
  }
  return done.filter(Boolean);
}
