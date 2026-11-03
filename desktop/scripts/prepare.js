// Web版のファイル（core/・製品ページ）とモデル類を renderer/ に配置し、ビルド対象の製品を product.json に書き出す
// 使い方: PRODUCT=getback|kamae|kamae-ai npm run prepare-assets
const fs = require("fs");
const path = require("path");
const https = require("https");

const PRODUCTS = {
  getback: { id: "getback", name: "GetBack Clone", appId: "jp.stony.posturelab.getback" },
  kamae: { id: "kamae", name: "KAMAE Lite", appId: "jp.stony.kamae.lite" },
  "kamae-ai": { id: "kamae-ai", name: "KAMAE AI", appId: "jp.stony.kamae.ai" },
};
const product = PRODUCTS[process.env.PRODUCT || "kamae"];
if (!product) { console.error("unknown PRODUCT"); process.exit(1); }

const root = path.join(__dirname, "..");
const web = path.join(root, "..");
const out = path.join(root, "renderer");
const vendor = path.join(out, "vendor");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(vendor, "wasm"), { recursive: true });
fs.cpSync(path.join(web, "core"), path.join(out, "core"), { recursive: true });
fs.cpSync(path.join(web, product.id), path.join(out, product.id), { recursive: true });
fs.writeFileSync(path.join(root, "product.json"), JSON.stringify(product, null, 2));

const pkg = path.join(root, "node_modules", "@mediapipe", "tasks-vision");
fs.copyFileSync(path.join(pkg, "vision_bundle.mjs"), path.join(vendor, "vision_bundle.mjs"));
for (const f of fs.readdirSync(path.join(pkg, "wasm"))) fs.copyFileSync(path.join(pkg, "wasm", f), path.join(vendor, "wasm", f));

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const cache = path.join(root, ".cache", "pose_landmarker_lite.task");
function download(url, dest, n = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n > 0) { res.resume(); return resolve(download(res.headers.location, dest, n - 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + ".part", f = fs.createWriteStream(tmp);
      res.pipe(f); f.on("finish", () => f.close(() => { fs.renameSync(tmp, dest); resolve(); }));
    }).on("error", reject);
  });
}
(async () => {
  if (!(fs.existsSync(cache) && fs.statSync(cache).size > 1e6)) {
    try { await download(MODEL_URL, cache); console.log("model: downloaded"); }
    catch (e) { console.error("model download failed:", e.message); process.exitCode = 1; return; }
  }
  fs.copyFileSync(cache, path.join(vendor, "pose_landmarker_lite.task"));
  console.log(`assets ready for ${product.name} ->`, out);
})();
