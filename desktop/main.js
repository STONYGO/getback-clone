// GetBack Clone — デスクトップ常駐版
// ・コントロールウィンドウ（カメラ/キャリブレーション/設定）を閉じてもトレイ常駐で計測を継続
// ・全ディスプレイに「クリック透過・最前面・透明」のオーバーレイを重ね、四隅を赤/緑に光らせる
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, protocol, net, session, systemPreferences } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

// 非表示中もカメラと計測を止めない
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-background-media-suspend");

// app:// で配信（カメラ・WASM・fetch を安全なオリジンで使うため）
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) { app.quit(); }

let control = null, tray = null, overlays = [], quitting = false;
let monitoring = false, lastStatus = "起動中", lastOverlay = { mode: null };

const ICONS = {};
function icon(name) {
  if (!ICONS[name]) {
    const img = nativeImage.createFromPath(path.join(__dirname, "assets", `tray-${name}.png`));
    ICONS[name] = process.platform === "darwin" ? img.resize({ width: 18, height: 18 }) : img;
  }
  return ICONS[name];
}

function createControl() {
  control = new BrowserWindow({
    width: 460, height: 820, minWidth: 380, title: "GetBack",
    backgroundColor: "#0f1115", show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false, contextIsolation: true, nodeIntegration: false,
    },
  });
  control.loadURL("app://local/renderer/index.html");
  // 閉じる＝トレイへ格納（計測は継続）
  control.on("close", (e) => {
    if (!quitting) {
      e.preventDefault(); control.hide();
      if (process.platform === "darwin") app.dock?.hide();
    }
  });
}

function showControl() {
  if (process.platform === "darwin") app.dock?.show();
  control.show(); control.focus();
}

function createOverlays() {
  overlays.forEach((w) => !w.isDestroyed() && w.destroy());
  overlays = screen.getAllDisplays().map((d) => {
    const w = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, transparent: true, resizable: false, movable: false, focusable: false,
      skipTaskbar: true, hasShadow: false, alwaysOnTop: true, fullscreenable: false,
      backgroundColor: "#00000000", show: false,
      webPreferences: { preload: path.join(__dirname, "overlay", "preload.js"), backgroundThrottling: false },
    });
    w.setAlwaysOnTop(true, "screen-saver");
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.setIgnoreMouseEvents(true); // クリックはすべて下のアプリへ
    w.loadFile(path.join(__dirname, "overlay", "overlay.html"));
    w.once("ready-to-show", () => { w.showInactive(); w.webContents.send("overlay", lastOverlay); });
    return w;
  });
}

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    { label: `状態：${lastStatus}`, enabled: false },
    { type: "separator" },
    { label: monitoring ? "監視を一時停止" : "監視を開始", click: () => control.webContents.send("command", "toggle") },
    { label: "キャリブレーション", click: () => { showControl(); control.webContents.send("command", "calibrate"); } },
    { label: "ウィンドウを表示（設定・カメラ確認）", click: showControl },
    { type: "separator" },
    {
      label: "ログイン時に自動起動", type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked }),
    },
    { label: "終了", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function updateTray() {
  const mode = lastOverlay.mode;
  tray.setImage(icon(!monitoring ? "idle" : mode === "red" ? "red" : "green"));
  tray.setToolTip(`GetBack — ${lastStatus}`);
  buildMenu();
}

// ---- レンダラーからの通知 ----
ipcMain.on("overlay", (_e, data) => {
  const changed = data.mode !== lastOverlay.mode;
  lastOverlay = data;
  overlays.forEach((w) => !w.isDestroyed() && w.webContents.send("overlay", data));
  if (changed) updateTray();
});
ipcMain.on("status", (_e, title) => {
  if (title !== lastStatus) { lastStatus = title; tray && updateTray(); }
});
ipcMain.on("monitoring", (_e, on) => { monitoring = on; if (!on) ipcMain.emit("overlay", null, { mode: null }); updateTray(); });

app.on("second-instance", () => control && showControl());
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", (e) => e.preventDefault());

app.whenReady().then(async () => {
  // app://local/... → アプリ同梱ファイル
  protocol.handle("app", (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    return net.fetch(pathToFileURL(path.join(__dirname, rel)).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === "media");
  if (process.platform === "darwin") {
    try { await systemPreferences.askForMediaAccess("camera"); } catch {}
  }

  tray = new Tray(icon("idle"));
  tray.on("click", () => (process.platform === "win32" ? showControl() : tray.popUpContextMenu()));
  createOverlays();
  createControl();
  updateTray();
  screen.on("display-added", createOverlays);
  screen.on("display-removed", createOverlays);
  screen.on("display-metrics-changed", createOverlays);
});
