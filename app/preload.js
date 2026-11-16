const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 新版 Electron 里 File 对象不再带 .path，必须用 webUtils 取真实路径
  getPath: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  send: (files, deviceId) => ipcRenderer.invoke('file:send', { files, deviceId }),
  fit: (height) => ipcRenderer.invoke('panel:fit', height),
  hide: () => ipcRenderer.send('panel:hide'),
  dragOverPanel: () => ipcRenderer.send('panel:drag-over'),
  dragLeavePanel: () => ipcRenderer.send('panel:drag-leave'),
  onDevices: (cb) => ipcRenderer.on('devices', (_e, d) => cb(d)),
  onPanelMode: (cb) => ipcRenderer.on('panel-mode', (_e, m) => cb(m)),
  onPanelLeave: (cb) => ipcRenderer.on('panel-leave', () => cb()),
  onPanelReveal: (cb) => ipcRenderer.on('panel-reveal', () => cb()),
  onSendProgress: (cb) => ipcRenderer.on('send-progress', (_e, p) => cb(p)),
  fitReceive: (height) => ipcRenderer.invoke('receive:fit', height),
  onReceiveProgress: (cb) => ipcRenderer.on('receive-progress', (_e, list) => cb(list)),
  hideReceive: () => ipcRenderer.send('receive:hide'),
  openReceiveDir: () => ipcRenderer.send('receive:open-dir'),
});
