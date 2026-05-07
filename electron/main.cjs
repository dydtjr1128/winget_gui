const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createWingetRunner } = require('./winget.cjs');

const runner = createWingetRunner();
let mainWindow = null;
let knownPackages = new Map();

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  const loadDist = app.isPackaged || process.argv.includes('--dist');
  const devUrl = 'http://127.0.0.1:5317';
  const iconPath = loadDist
    ? path.join(__dirname, '..', 'dist', 'winget-gui-logo.png')
    : path.join(__dirname, '..', 'public', 'winget-gui-logo.png');

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    icon: iconPath,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1f22',
    title: 'Winget GUI',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.on('maximize', () => sendToRenderer('window:maximized', true));
  mainWindow.on('unmaximize', () => sendToRenderer('window:maximized', false));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const allowed = loadDist ? targetUrl.startsWith('file://') : targetUrl.startsWith(devUrl);
    if (!allowed) {
      event.preventDefault();
    }
  });

  if (loadDist) {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    mainWindow.loadURL(devUrl);
  }
}

runner.events.on('log', (line) => sendToRenderer('winget:log', line));
runner.events.on('package-start', (item) => sendToRenderer('winget:package-start', item));
runner.events.on('package-complete', (result) => sendToRenderer('winget:package-complete', result));
runner.events.on('queue-complete', (results) => sendToRenderer('winget:queue-complete', results));

ipcMain.handle('winget:list-upgrades', async (_event, payload) => {
  const result = await runner.listUpgrades({
    includeUnknown: Boolean(payload?.options?.includeUnknown),
    includePinned: Boolean(payload?.options?.includePinned)
  });
  knownPackages = new Map(result.packages.map((item) => [item.id, item]));
  return result;
});

ipcMain.handle('winget:upgrade-selected', async (_event, payload) => {
  const requestedIds = Array.isArray(payload?.ids) ? payload.ids : [];
  const selectedPackages = requestedIds
    .filter((id) => typeof id === 'string' && knownPackages.has(id))
    .map((id) => knownPackages.get(id));

  if (selectedPackages.length === 0) {
    return [];
  }

  return runner.upgradeSelected(selectedPackages, {
    silent: Boolean(payload?.options?.silent),
    includeUnknown: Boolean(payload?.options?.includeUnknown),
    includePinned: Boolean(payload?.options?.includePinned),
    allowReboot: Boolean(payload?.options?.allowReboot)
  });
});

ipcMain.handle('winget:cancel-upgrade', () => {
  runner.cancel();
  return true;
});

ipcMain.handle('window:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.handle('window:toggle-maximize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) {
    return false;
  }
  if (window.isMaximized()) {
    window.unmaximize();
    return false;
  }
  window.maximize();
  return true;
});

ipcMain.handle('window:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle('window:is-maximized', (event) => {
  return Boolean(BrowserWindow.fromWebContents(event.sender)?.isMaximized());
});

ipcMain.handle('app:get-locale', () => app.getLocale());

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
