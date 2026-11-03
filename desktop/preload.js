const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gbBridge", {
  overlay: (data) => ipcRenderer.send("overlay", data),
  status: (title, sub) => ipcRenderer.send("status", title, sub),
  monitoring: (on) => ipcRenderer.send("monitoring", on),
  needUI: (on) => ipcRenderer.send("needUI", on),
  onCommand: (fn) => ipcRenderer.on("command", (_e, cmd) => fn(cmd)),
});
