// Renderer API boundary: exposes window.wingetApi / windowApi / localeApi /
// appApi backed by Tauri commands and events (src-tauri/src/lib.rs). Must be
// imported before App.jsx, which reads these globals at load.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Tauri rejects with the command's error string; App.jsx reads error.message,
// so normalize every rejection to an Error.
function call(command, args) {
  return invoke(command, args).catch((error) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
}

function subscribe(channel, callback) {
  let disposed = false;
  let unlisten = null;
  listen(channel, (event) => callback(event.payload))
    .then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    })
    .catch((error) => console.error(`Failed to subscribe to ${channel}`, error));
  return () => {
    disposed = true;
    unlisten?.();
  };
}

function installTauriBridge() {
  const appWindow = getCurrentWindow();

  window.wingetApi = {
    listUpgrades: (options) => call('list_upgrades', { options }),
    upgradeSelected: (ids, options) => call('upgrade_selected', { ids, options }),
    uninstallSelected: (ids, options) => call('uninstall_selected', { ids, options }),
    reinstallSelected: (ids, options) => call('reinstall_selected', { ids, options }),
    cancelUpgrade: () => call('cancel_upgrade'),
    // The backend batches log frames; replay each entry in order.
    onLog: (callback) =>
      subscribe('winget:log', (payload) =>
        (Array.isArray(payload) ? payload : [payload]).forEach((entry) => callback(entry))
      ),
    onPackageStart: (callback) => subscribe('winget:package-start', callback),
    onPackageComplete: (callback) => subscribe('winget:package-complete', callback),
    onQueueComplete: (callback) => subscribe('winget:queue-complete', callback)
  };

  window.windowApi = {
    minimize: () => appWindow.minimize(),
    toggleMaximize: async () => {
      await appWindow.toggleMaximize();
      return appWindow.isMaximized();
    },
    close: () => appWindow.close(),
    isMaximized: () => appWindow.isMaximized(),
    onMaximizedChange: (callback) => {
      let last = null;
      let unlisten = null;
      let disposed = false;
      appWindow
        .onResized(async () => {
          const value = await appWindow.isMaximized();
          if (value !== last) {
            last = value;
            callback(value);
          }
        })
        .then((fn) => (disposed ? fn() : (unlisten = fn)))
        .catch((error) => console.error('Failed to watch window maximize state', error));
      return () => {
        disposed = true;
        unlisten?.();
      };
    }
  };

  window.localeApi = {
    getSystemLocale: async () => navigator.language
  };

  window.appApi = {
    isElevated: () => call('is_elevated'),
    restartElevated: () => call('restart_elevated')
  };

  // WebView2 under Tauri ignores -webkit-app-region, so emulate the frameless
  // title-bar drag: start a native drag from .titlebar-drag, except on controls.
  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('.titlebar-drag') || target.closest('button, a, input, select, .window-controls')) {
      return;
    }
    const action = event.detail === 2 ? appWindow.toggleMaximize() : appWindow.startDragging();
    action.catch(() => {});
  });
}

if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
  installTauriBridge();
}
