const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
const {
  getElevatedRelaunchOptions,
  isRunningElevated,
  startDeferredElevatedRestart
} = require('./elevation.cjs');
const { createWingetRunner } = require('./winget.cjs');

const runner = createWingetRunner();
let mainWindow = null;
let knownPackages = new Map();

const maxErrorLogBytes = 512 * 1024;

function logError(label, detail) {
  try {
    const logPath = path.join(app.getPath('userData'), 'winget-gui-error.log');
    // Rotate to a single .old backup once the log passes the cap so it can never
    // grow without bound over long-running use.
    try {
      if (fs.statSync(logPath).size > maxErrorLogBytes) {
        fs.rmSync(`${logPath}.old`, { force: true });
        fs.renameSync(logPath, `${logPath}.old`);
      }
    } catch {
      // No existing log yet, or rotation failed; fall through and append.
    }
    const line = `[${new Date().toISOString()}] ${label} ${detail ?? ''}\n`;
    fs.appendFileSync(logPath, line);
  } catch {
    // Logging is best-effort; never let it break the app.
  }
}

process.on('uncaughtException', (error) => logError('uncaughtException', error?.stack || String(error)));
process.on('unhandledRejection', (reason) =>
  logError('unhandledRejection', reason?.stack || String(reason))
);

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    if (
      Number.isFinite(state?.width) &&
      state.width >= 1080 &&
      Number.isFinite(state?.height) &&
      state.height >= 720
    ) {
      return state;
    }
  } catch {
    // No saved state or unreadable; fall back to defaults.
  }
  return null;
}

// Guards against restoring the window onto a display that no longer exists
// (e.g. an unplugged monitor), which would place it off-screen.
function isOnSomeDisplay(state) {
  if (!Number.isFinite(state?.x) || !Number.isFinite(state?.y)) {
    return false;
  }
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      state.x < area.x + area.width &&
      state.x + state.width > area.x &&
      state.y < area.y + area.height &&
      state.y + state.height > area.y
    );
  });
}

function saveWindowState(window) {
  try {
    if (!window || window.isDestroyed()) {
      return;
    }
    const bounds = window.getNormalBounds();
    fs.writeFileSync(
      windowStatePath(),
      JSON.stringify({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        isMaximized: window.isMaximized()
      }),
      'utf8'
    );
  } catch {
    // Best-effort; never block window close on a failed save.
  }
}

function createWindow() {
  const loadDist = app.isPackaged || process.argv.includes('--dist');
  const devUrl = 'http://127.0.0.1:5317';
  const iconPath = loadDist
    ? path.join(__dirname, '..', 'dist', 'winget-gui-logo.png')
    : path.join(__dirname, '..', 'public', 'winget-gui-logo.png');

  const savedState = loadWindowState();
  const usePosition = savedState && isOnSomeDisplay(savedState);

  mainWindow = new BrowserWindow({
    width: savedState?.width ?? 1360,
    height: savedState?.height ?? 860,
    ...(usePosition ? { x: savedState.x, y: savedState.y } : {}),
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

  if (savedState?.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('maximize', () => sendToRenderer('window:maximized', true));
  mainWindow.on('unmaximize', () => sendToRenderer('window:maximized', false));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const allowed = loadDist ? targetUrl.startsWith('file://') : targetUrl.startsWith(devUrl);
    if (!allowed) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    logError('did-fail-load', JSON.stringify({ code, description, url }));
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logError('render-process-gone', JSON.stringify(details));
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
    includePinned: Boolean(payload?.options?.includePinned)
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

ipcMain.handle('app:is-elevated', () => isRunningElevated());

ipcMain.handle('app:restart-elevated', () => {
  if (isRunningElevated()) {
    return {
      ok: true,
      alreadyElevated: true
    };
  }

  const { filePath, args, cwd } = getElevatedRelaunchOptions({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    argv: process.argv,
    execPath: process.execPath,
    cwd: process.cwd()
  });

  // The portable launcher unpacks into a single shared directory and will not
  // start a second instance against it while this one is alive, which made the
  // elevated relaunch fail to appear or crash. So hand the relaunch to a
  // detached helper that waits for THIS instance to fully exit before starting
  // the elevated copy, then quit. (If the user declines UAC the helper relaunches
  // without elevation so they are not left with no window.)
  const result = startDeferredElevatedRestart({
    filePath,
    args,
    cwd,
    waitForName: path.basename(process.execPath),
    waitForDir: path.dirname(process.execPath)
  });

  if (result.ok) {
    app.quit();
  }

  return result;
});

app.on('child-process-gone', (_event, details) => {
  logError('child-process-gone', JSON.stringify(details));
});

app.whenReady().then(() => {
  if (app.isPackaged || process.argv.includes('--dist')) {
    // Lock the renderer down in packaged/dist mode. Skipped in dev so the Vite
    // HMR client and its websocket keep working.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'none'"
          ]
        }
      });
    });
  }

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
