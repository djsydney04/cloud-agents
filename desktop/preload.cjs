const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("cloudAgents", {
  getDocker: () => ipcRenderer.invoke("get-docker"),
  connect: (c) => ipcRenderer.invoke("connect", c),
  status: () => ipcRenderer.invoke("status"),
  restore: () => ipcRenderer.invoke("restore"),
  disconnect: () => ipcRenderer.invoke("disconnect"),
  request: (r) => ipcRenderer.invoke("request", r),
  exportWorkspace: (id) => ipcRenderer.invoke("export", id),
});
