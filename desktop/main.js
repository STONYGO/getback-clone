// Posture Lab デスクトップ常駐版（GetBack Clone / KAMAE Lite / KAMAE AI 共通）
// ・起動後はメニューバー／タスクトレイに常駐。ウィンドウは初回・キャリブレーション時・ユーザーが開いたときだけ表示
// ・全ディスプレイに「クリック透過・最前面・透明」のオーバーレイを重ね、四隅だけを控えめに色づける
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, protocol, net, session, systemPreferences } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const PRODUCT = require("./product.json");
app.setName(PRODUCT.name);

// 非表示中もカメラと計測を止めない
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-background-media-suspend");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
if (!app.requestSingleInstanceLock()) app.quit();

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

function firstRunSetup() {
  // 初回起動時：ログイン時に背景で自動起動するよう設定（トレイメニューで解除可）
  const flag = path.join(app.getPath("userData"), "first-run.done");
  if (fs.existsSync(flag)) return;
  try { app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ["--hidden"] }); } catch {}
  fs.writeFileSync(flag, new Date().toISOString());
}

function createControl() {
  control = new BrowserWindow({
    width: 480, height: 860, minWidth: 380, title: app.name, show: false,
    backgroundColor: "#f6f7f9", titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
  });
  control.loadURL(`app://local/renderer/${PRODUCT.id}/index.html`);
  control.on("close", (e) => {
    if (!quitting) { e.preventDefault(); hideControl(); }
  });
}
function showControl(user) {
  if (user) autoShown = false; if (process.platform === "darwin") app.dock?.show(); control.show(); control.focus(); }
function hideControl() { control.hide(); if (process.platform === "darwin") app.dock?.hide(); }

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
    w.setIgnoreMouseEvents(true);
    w.loadFile(path.join(__dirname, "overlay", "overlay.html"));
    w.once("ready-to-show", () => { w.showInactive(); w.webContents.send("overlay", lastOverlay); });
    return w;
  });
}

function buildMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${app.name}：${lastStatus}`, enabled: false },
    { type: "separator" },
    { label: monitoring ? "見守りを一時停止" : "見守りを再開", click: () => control.webContents.send("command", "toggle") },
    { label: "キャリブレーション", click: () => { showControl(true); control.webContents.send("command", "calibrate"); } },
    { label: "日次レポートを今すぐ送信", click: () => control.webContents.send("command", "report") },
    { label: "ダッシュボードを開く", click: () => showControl(true) },
    { type: "separator" },
    { label: "ログイン時に自動起動", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked, openAsHidden: true, args: ["--hidden"] }) },
    { label: "終了", click: () => { quitting = true; app.quit(); } },
  ]));
}
function updateTray() {
  const m = lastOverlay.mode;
  tray.setImage(icon(!monitoring ? "idle" : m === "red" ? "red" : m === "amber" ? "amber" : "green"));
  tray.setToolTip(`${app.name} — ${lastStatus}`);
  buildMenu();
}

ipcMain.on("overlay", (_e, data) => {
  const changed = data.mode !== lastOverlay.mode;
  lastOverlay = data;
  overlays.forEach((w) => !w.isDestroyed() && w.webContents.send("overlay", data));
  if (changed && tray) updateTray();
});
ipcMain.on("status", (_e, title) => { if (title !== lastStatus) { lastStatus = title; tray && updateTray(); } });
ipcMain.on("monitoring", (_e, on) => { monitoring = on; if (!on) ipcMain.emit("overlay", null, { mode: null }); tray && updateTray(); });
// 初回・キャリブレーション時は自動で表示し、完了したら自動で背景に戻す（ユーザーが自分で開いた場合は閉じない）
let autoShown = false;
ipcMain.on("needUI", (_e, on) => {
  if (on) { if (!control.isVisible()) autoShown = true; showControl(); }
  else if (autoShown) { autoShown = false; setTimeout(hideControl, 600); }
});

app.on("second-instance", () => control && showControl(true));
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", (e) => e.preventDefault());

app.whenReady().then(async () => {
  protocol.handle("app", (req) => net.fetch(pathToFileURL(path.join(__dirname, decodeURIComponent(new URL(req.url).pathname))).toString()));
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === "media");
  if (process.platform === "darwin") { app.dock?.hide(); try { await systemPreferences.askForMediaAccess("camera"); } catch {} }
  firstRunSetup();
  tray = new Tray(icon("idle"));
  tray.on("click", () => (process.platform === "win32" ? showControl(true) : tray.popUpContextMenu()));
  createOverlays();
  createControl();
  updateTray();
  screen.on("display-added", createOverlays);
  screen.on("display-removed", createOverlays);
  screen.on("display-metrics-changed", createOverlays);
});
