// KAMAE AI：端末内で完結する個人適応型の姿勢モデル（映像・特徴量は外部送信しない）
const KEY = "kamae-ai.model.v1";
const T = 9; // 3σ相当の判定しきい値（マハラノビス距離²）

function inv(M) {
  const n = M.length, A = M.map((r, i) => [...r, ...M.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-9;
    for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j]; }
  }
  return A.map((r) => r.slice(n));
}

export class AdaptiveModel {
  constructor(o) { Object.assign(this, o); this._inv = inv(this.cov); this._lastLearn = 0; this._ew = null; this._slope = 0; this._lastT = 0; }

  static fromCalibration(keys, samples, base) {
    const X = samples.map((s) => keys.map((k) => s[k])).filter((v) => v.every((x) => x != null && isFinite(x)));
    const n = X.length, d = keys.length;
    const mu = keys.map((_, i) => X.reduce((a, v) => a + v[i], 0) / n);
    const cov = keys.map((_, i) => keys.map((_, j) => X.reduce((a, v) => a + (v[i] - mu[i]) * (v[j] - mu[j]), 0) / n));
    for (let i = 0; i < d; i++) cov[i][i] += (base[i] / 3) ** 2; // 最低限の許容幅（過敏防止）
    return new AdaptiveModel({ keys, base, mu, mu0: [...mu], cov, n: 0, createdAt: Date.now() });
  }
  static load() {
    try { const o = JSON.parse(localStorage.getItem(KEY)); return o ? new AdaptiveModel(o) : null; } catch { return null; }
  }
  save() {
    try { const { keys, base, mu, mu0, cov, n, createdAt } = this; localStorage.setItem(KEY, JSON.stringify({ keys, base, mu, mu0, cov, n, createdAt })); } catch {}
  }

  // dirs: "up" | "down" | "abs" — 良い方向へのずれは異常としない（片側化）
  score(x, dirs, sens) {
    const dev = x.map((v, i) => v - this.mu[i]);
    const dv = dev.map((v, i) => (dirs[i] === "up" ? Math.max(0, v) : dirs[i] === "down" ? Math.min(0, v) : v));
    let d2 = 0;
    for (let i = 0; i < dv.length; i++) for (let j = 0; j < dv.length; j++) d2 += dv[i] * this._inv[i][j] * dv[j];
    const r = Math.sqrt(Math.max(0, d2) / T) * sens;
    const contrib = dv.map((v, i) => Math.abs(v) / Math.sqrt(this.cov[i][i] * T) * sens);
    return { r, dev, contrib };
  }

  // 良い構えの区間から継続学習（1秒に1回、ゆっくり）。キャリブレーション基準から許容幅の半分以上は離れない
  learn(x, now) {
    if (now - this._lastLearn < 1000) return;
    this._lastLearn = now;
    const a = 0.003;
    for (let i = 0; i < x.length; i++) {
      const lim = this.base[i] * 0.5;
      this.mu[i] = Math.max(this.mu0[i] - lim, Math.min(this.mu0[i] + lim, this.mu[i] + a * (x[i] - this.mu[i])));
    }
    for (let i = 0; i < x.length; i++) for (let j = 0; j < x.length; j++) {
      const c = (x[i] - this.mu[i]) * (x[j] - this.mu[j]);
      this.cov[i][j] = (1 - a) * this.cov[i][j] + a * c;
      if (i === j) this.cov[i][i] = Math.max(this.cov[i][i], (this.base[i] / 3) ** 2);
    }
    this._inv = inv(this.cov);
    this.n++;
    if (this.n % 60 === 0) this.save();
  }

  // スコアの平滑値と傾きから、30秒以内に崩れるかを予測
  predict(r, now) {
    if (this._ew == null) { this._ew = r; this._lastT = now; return { warn: false }; }
    const dt = Math.max(0.016, (now - this._lastT) / 1000); this._lastT = now;
    const prev = this._ew; this._ew = prev * 0.95 + r * 0.05;
    this._slope = this._slope * 0.97 + ((this._ew - prev) / dt) * 0.03;
    const eta = this._slope > 0 ? (1 - this._ew) / this._slope : Infinity;
    return { warn: this._ew > 0.55 && this._ew < 1 && eta < 30, eta, level: this._ew };
  }

  stats() {
    const drift = Math.max(...this.mu.map((m, i) => Math.abs(m - this.mu0[i]) / this.base[i]));
    return { learned: this.n, drift, days: Math.max(0, (Date.now() - this.createdAt) / 864e5) };
  }
  static reset() { try { localStorage.removeItem(KEY); } catch {} }
}
