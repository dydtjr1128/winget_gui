const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('wingetApi', {
  listUpgrades: (options) => ipcRenderer.invoke('winget:list-upgrades', { options }),
  upgradeSelected: (ids, options) => ipcRenderer.invoke('winget:upgrade-selected', { ids, options }),
  cancelUpgrade: () => ipcRenderer.invoke('winget:cancel-upgrade'),
  onLog: (callback) => subscribe('winget:log', callback),
  onPackageStart: (callback) => subscribe('winget:package-start', callback),
  onPackageComplete: (callback) => subscribe('winget:package-complete', callback),
  onQueueComplete: (callback) => subscribe('winget:queue-complete', callback)
});

contextBridge.exposeInMainWorld('windowApi', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChange: (callback) => subscribe('window:maximized', callback)
});

contextBridge.exposeInMainWorld('localeApi', {
  getSystemLocale: () => ipcRenderer.invoke('app:get-locale')
});

contextBridge.exposeInMainWorld('appApi', {
  isElevated: () => ipcRenderer.invoke('app:is-elevated'),
  restartElevated: () => ipcRenderer.invoke('app:restart-elevated')
});
