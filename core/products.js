// 3製品の判定ロジック定義
//  - getback   : GetBack（背骨計）の特許方式を実験的に再現（画面基準の頭部位置＝視距離＋頭部角度 → 脊柱角度を回帰推定）
//  - kamae     : 回避設計（肩基準の体座標のみ・視距離／頭部角度／脊柱推定を使わない）ルールベース
//  - kamae-ai  : 回避設計＋端末内AI（個人適応する多変量異常検知・崩れの予兆予測）
import { AdaptiveModel } from "./ai.js";

const VIS = 0.5;
const P = (lm, i, W, H) => ({ x: lm[i].x * W, y: lm[i].y * H, z: (lm[i].z ?? 0) * W, v: lm[i].visibility ?? 1 });
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lineAngle = (a, b) => { let t = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI; if (t > 90) t -= 180; if (t < -90) t += 180; return t; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// 両肩（体座標の基準）
function shoulders(lm, W, H) {
  const ls = P(lm, 11, W, H), rs = P(lm, 12, W, H);
  if (ls.v < VIS || rs.v < VIS || ls.y > H * 0.98 || rs.y > H * 0.98) return null;
  const sw = dist(ls, rs);
  if (sw < W * 0.12) return null;
  // shTilt > 0 : 本人の左肩が下がっている（画像は非反転座標）
  return { ls, rs, m: mid(ls, rs), sw, tilt: lineAngle(rs, ls) };
}

/* =====================================================================
   1) GetBack Clone — 特許方式の再現
   頭部角度θ（目―耳ラインの傾き：正面カメラから推定）と視距離d（瞳孔間距離から推定, mm）を取得し、
   2次回帰 Y = A1·θ + A2·d + A3·θ² + A4·d² + A5 で脊柱5角度を推定する。
   ※ 回帰係数は公開情報に数値がないため「仮係数」。実験用であり臨床的妥当性はない。
   ===================================================================== */
const HFOV_DEG = 65;      // 一般的なWebカメラの水平画角（仮定）
const IPD_MM = 63;        // 成人平均の瞳孔間距離
const EAR_EYE_DEPTH = 1.9; // 顔幅に対する目―耳の奥行き比（正面像からピッチを復元する近似係数）
const SPINE = [
  // key, 名称, 仮係数 [A1(θ), A2(d), A3(θ²), A4(d²), A5], 許容幅(°), 注意メッセージ
  ["Y1", "頚椎前傾 C2–C7", [0.62, -0.020, 0.004, 0.000004, 24], 6, "首（頚椎）の前傾が大きくなっています"],
  ["Y2", "T1スロープ", [0.35, -0.015, 0.002, 0.000003, 28], 6, "首の付け根（T1）の傾きが大きくなっています"],
  ["Y3", "上位胸椎後弯", [0.28, -0.012, 0.001, 0.000002, 30], 7, "背中の上部が丸まっています"],
  ["Y4", "中下位胸椎後弯", [0.16, -0.008, 0.001, 0.000001, 34], 7, "背中の中ほどが丸まっています"],
  ["Y5", "腰椎前弯", [-0.12, 0.010, -0.001, 0.000000, 32], 7, "腰の反り（前弯）が減っています"],
];
const D0 = 550; // 視距離の基準化定数(mm)

export const getback = {
  id: "getback",
  name: "GetBack Clone",
  short: "GB",
  tagline: "脊柱アライメント推定（特許方式の実験再現）",
  accent: ["#3b82f6", "#22d3ee"],
  requiresShoulders: false,
  experimental: true,
  features: [
    { key: "theta", name: "頭部角度", unit: "°", fmt: (v) => v.toFixed(1) },
    { key: "d", name: "視距離", unit: "mm", fmt: (v) => Math.round(v) },
    { key: "roll", name: "首の左右傾き", unit: "°", fmt: (v) => v.toFixed(1) },
    ...SPINE.map(([k, n]) => ({ key: k, name: n, unit: "°", fmt: (v) => v.toFixed(1), spine: true })),
  ],
  compute(lm, W, H) {
    const nose = P(lm, 0, W, H), le = P(lm, 2, W, H), re = P(lm, 5, W, H), lear = P(lm, 7, W, H), rear = P(lm, 8, W, H);
    if (nose.v < VIS || le.v < VIS || re.v < VIS) return null;
    const earsOk = lear.v > 0.3 && rear.v > 0.3;
    const eyeM = mid(le, re), earM = earsOk ? mid(lear, rear) : null;
    const ipdPx = dist(le, re);
    const faceW = earsOk ? dist(lear, rear) : ipdPx * 2.1;
    const fPx = (W / 2) / Math.tan((HFOV_DEG / 2) * Math.PI / 180);
    const d = fPx * IPD_MM / ipdPx;
    // 頭部角度：目―耳ラインの水平に対する傾き（うつむくと目が耳より下がる）
    const ref = earM ?? { y: eyeM.y - (nose.y - eyeM.y) * 0.25 };
    const theta = Math.asin(clamp(EAR_EYE_DEPTH * (eyeM.y - ref.y) / faceW, -1, 1)) * 180 / Math.PI + 10;
    const f = { theta, d, roll: lineAngle(re, le) };
    for (const [k, , A] of SPINE) {
      const x2 = d - D0;
      f[k] = A[0] * theta + A[1] * x2 + A[2] * theta * theta + A[3] * x2 * x2 + A[4];
    }
    const sh = shoulders(lm, W, H);
    f.shTilt = sh ? sh.tilt : null;
    return f;
  },
  // 習慣（傾きの癖）として記録する符号付き特徴
  habit(f) { return { roll: f.roll, shTilt: f.shTilt }; },
  evaluate(f, B, cfg) {
    let worst = null, r = 0;
    const details = [];
    for (const [k, n, , tol0, msg] of SPINE) {
      if (!B[k]) continue;
      const tol = Math.max(tol0, 3 * B[k].sd) / cfg.sens;
      const dev = f[k] - B[k].mean;
      // 特許実施例と同様「理想範囲（ここでは本人の良姿勢±許容幅）」の外で異常
      const ri = k === "Y5" ? Math.max(0, -dev) / tol : Math.max(0, dev) / tol;
      details.push({ key: k, name: n, dev, ratio: ri });
      if (ri > r) { r = ri; worst = msg; }
    }
    if (B.roll) {
      const tol = Math.max(8, 3 * B.roll.sd) / cfg.sens, ri = Math.abs(f.roll - B.roll.mean) / tol;
      details.push({ key: "roll", name: "首の左右傾き", dev: f.roll - B.roll.mean, ratio: ri });
      if (ri > r) { r = ri; worst = "首が左右に傾いています"; }
    }
    return { r, bad: r > 1, reason: r > 1 ? worst : "", details };
  },
};

/* =====================================================================
   2) KAMAE Lite — 回避設計（AI非搭載）
   肩中点を原点・肩幅を単位とする体座標のみ。視距離・頭部角度・脊柱推定は計算しない。
   ===================================================================== */
const KFEAT = [
  { key: "gap", name: "首と肩の間隔", unit: "", fmt: (v) => v.toFixed(2), base: 0.10, dir: "down", msg: "肩がすくむ／上体が沈んでいます" },
  { key: "lateral", name: "上体の左右ずれ", unit: "", fmt: (v) => v.toFixed(2), base: 0.12, dir: "abs", msg: "上体が左右に傾いています" },
  { key: "shTilt", name: "肩の高さの差", unit: "°", fmt: (v) => v.toFixed(1), base: 6, dir: "abs", msg: "左右の肩の高さがずれています" },
  { key: "forward", name: "肩より前への突出", unit: "", fmt: (v) => v.toFixed(2), base: 0.30, dir: "up", msg: "頭が肩より前に出ています" },
];
function kamaeCompute(lm, W, H) {
  const sh = shoulders(lm, W, H);
  if (!sh) return null;
  const ml = P(lm, 9, W, H), mr = P(lm, 10, W, H);
  if (ml.v < VIS || mr.v < VIS) return null;
  const mo = mid(ml, mr);
  return {
    gap: (sh.m.y - mo.y) / sh.sw,
    lateral: (mo.x - sh.m.x) / sh.sw,   // 正：本人の左側へ
    shTilt: sh.tilt,
    forward: (sh.m.z - mo.z) / sh.sw,
  };
}
function directional(def, dev, tol) {
  return def.dir === "abs" ? Math.abs(dev) / tol : def.dir === "up" ? Math.max(0, dev) / tol : Math.max(0, -dev) / tol;
}

export const kamae = {
  id: "kamae",
  name: "KAMAE Lite",
  short: "KM",
  tagline: "肩で整える、構えモニター",
  accent: ["#10b981", "#84cc16"],
  requiresShoulders: true,
  features: KFEAT,
  compute: kamaeCompute,
  habit(f) { return { shTilt: f.shTilt, lateral: f.lateral }; },
  evaluate(f, B, cfg) {
    let sum = 0, worst = null, wr = 0;
    const details = [];
    for (const d of KFEAT) {
      if (!B[d.key]) continue;
      const tol = Math.max(d.base, 3 * B[d.key].sd) / cfg.sens;
      const dev = f[d.key] - B[d.key].mean, ri = directional(d, dev, tol);
      details.push({ key: d.key, name: d.name, dev, ratio: ri });
      sum += ri * ri; if (ri > wr) { wr = ri; worst = d.msg; }
    }
    const r = Math.sqrt(sum);
    return { r, bad: r > 1, reason: r > 1 ? worst : "", details };
  },
};

/* =====================================================================
   3) KAMAE AI — 回避設計＋端末内AI
   ・肩基準の4特徴の共分散を学習するガウス異常検知（マハラノビス距離・片側化）
   ・使用中に「良い構え」と判定された区間から個人モデルを継続学習（基準から離れすぎないよう制約）
   ・スコアの傾き（EWMA）から30秒以内の崩れを予測し、先回りで淡い琥珀色を灯す
   ===================================================================== */
export const kamaeAI = {
  id: "kamae-ai",
  name: "KAMAE AI",
  short: "AI",
  tagline: "使うほど、あなたの構えを覚えるAI",
  accent: ["#8b5cf6", "#ec4899"],
  requiresShoulders: true,
  ai: true,
  features: KFEAT,
  compute: kamaeCompute,
  habit(f) { return { shTilt: f.shTilt, lateral: f.lateral }; },
  model: null,
  initModel(B, samples) {
    this.model = AdaptiveModel.fromCalibration(KFEAT.map((d) => d.key), samples, KFEAT.map((d) => d.base));
    this.model.save();
  },
  loadModel() { this.model = AdaptiveModel.load(); return !!this.model; },
  evaluate(f, B, cfg, now) {
    if (!this.model) this.loadModel();
    if (!this.model) return kamae.evaluate(f, B, cfg);
    const dirs = KFEAT.map((d) => d.dir);
    const res = this.model.score(KFEAT.map((d) => f[d.key]), dirs, cfg.sens);
    const details = KFEAT.map((d, i) => ({ key: d.key, name: d.name, dev: res.dev[i], ratio: res.contrib[i] }));
    let wi = 0; res.contrib.forEach((c, i) => { if (c > res.contrib[wi]) wi = i; });
    const pred = this.model.predict(res.r, now);
    // 良い構えの区間だけ学習（崩れを「普通」と学ばない）
    if (res.r < 0.5) this.model.learn(KFEAT.map((d) => f[d.key]), now);
    return { r: res.r, bad: res.r > 1, reason: res.r > 1 ? KFEAT[wi].msg : "", details, predict: pred, ai: this.model.stats() };
  },
};

export const PRODUCTS = { getback, kamae, "kamae-ai": kamaeAI };
