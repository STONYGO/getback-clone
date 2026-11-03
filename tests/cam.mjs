// 実写真から上半身を切り出し、回転・拡大・頭部の沈み込みを加えたcanvas映像をカメラ入力として差し替える（page.evaluate用）
export const CAM_SCRIPT = async (img) => {
  const { PoseLandmarker, FilesetResolver } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14");
  const fs_ = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  const det = await PoseLandmarker.createFromOptions(fs_, { baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task", delegate: "CPU" }, runningMode: "IMAGE", numPoses: 1 });
  const im = new Image(); im.src = img; await im.decode();
  const lm = det.detect(im).landmarks[0];
  if (!lm) throw new Error("fixture: person not detected");
  const W = im.naturalWidth, H = im.naturalHeight, P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H });
  const ls = P(11), rs = P(12), sw = Math.hypot(ls.x - rs.x, ls.y - rs.y), smy = (ls.y + rs.y) / 2, cx = (ls.x + rs.x) / 2;
  const top = Math.min(P(0).y, P(7).y, P(8).y) - sw * 0.75, bottom = smy + sw * 0.85;
  const crop = { sx: cx - sw * 1.15, sy: top, sw: sw * 2.3, sh: bottom - top };
  const neck = ((P(9).y + P(10).y) / 2 + smy) / 2; // 口元と肩の中間を首とする
  window.__cam = { rot: 0, scale: 1, dx: 0, dy: 0, sink: 0 };
  const c = document.createElement("canvas"); c.width = 640; c.height = 480;
  const x = c.getContext("2d");
  const draw = () => {
    const p = window.__cam; x.fillStyle = "#9aa3ad"; x.fillRect(0, 0, 640, 480);
    const tw = 460 * p.scale, k = tw / crop.sw, th = crop.sh * k;
    x.save(); x.translate(320 + p.dx * 640, 240 + p.dy * 480); x.rotate((p.rot * Math.PI) / 180);
    const ox = -tw / 2, oy = -th / 2 + 40 * p.scale, nk = neck - crop.sy;
    x.drawImage(im, crop.sx, crop.sy + nk, crop.sw, crop.sh - nk, ox, oy + nk * k, tw, (crop.sh - nk) * k); // 体
    x.drawImage(im, crop.sx, crop.sy, crop.sw, nk, ox, oy + p.sink * sw * k, tw, nk * k);                      // 頭（沈み込み）
    x.restore(); requestAnimationFrame(draw);
  };
  draw();
  const v = document.querySelector("#video");
  v.srcObject = c.captureStream(30); await v.play();
  return { shoulderWidthPx: Math.round(sw), crop: Object.fromEntries(Object.entries(crop).map(([k, v]) => [k, Math.round(v)])) };
};

