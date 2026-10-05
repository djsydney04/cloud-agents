const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("cloudAgents", {
  connect: (c) => ipcRenderer.invoke("connect", c),
  restore: () => ipcRenderer.invoke("restore"),
  disconnect: () => ipcRenderer.invoke("disconnect"),
  request: (r) => ipcRenderer.invoke("request", r),
  exportWorkspace: (id) => ipcRenderer.invoke("export", id),
});
