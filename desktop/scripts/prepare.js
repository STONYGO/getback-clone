// 共通UI（リポジトリ直下の index.html）とモデル類を renderer/ に配置する
const fs = require("fs");
const path = require("path");
const https = require("https");

const root = path.join(__dirname, "..");
const out = path.join(root, "renderer");
const vendor = path.join(out, "vendor");
fs.mkdirSync(path.join(vendor, "wasm"), { recursive: true });

fs.copyFileSync(path.join(root, "..", "index.html"), path.join(out, "index.html"));

const pkg = path.join(root, "node_modules", "@mediapipe", "tasks-vision");
fs.copyFileSync(path.join(pkg, "vision_bundle.mjs"), path.join(vendor, "vision_bundle.mjs"));
for (const f of fs.readdirSync(path.join(pkg, "wasm"))) {
  fs.copyFileSync(path.join(pkg, "wasm", f), path.join(vendor, "wasm", f));
}

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const modelPath = path.join(vendor, "pose_landmarker_lite.task");

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume(); return resolve(download(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const tmp = dest + ".part", f = fs.createWriteStream(tmp);
      res.pipe(f);
      f.on("finish", () => f.close(() => { fs.renameSync(tmp, dest); resolve(); }));
    }).on("error", reject);
  });
}

(async () => {
  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1e6) {
    console.log("model: cached");
  } else {
    try { await download(MODEL_URL, modelPath); console.log("model: downloaded"); }
    catch (e) { console.error("model download failed:", e.message); process.exitCode = 1; }
  }
  console.log("assets ready ->", out);
})();
