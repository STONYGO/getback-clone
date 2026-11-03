const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayBridge", {
  onUpdate: (fn) => ipcRenderer.on("overlay", (_e, data) => fn(data)),
});
