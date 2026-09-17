// Run after npm run build: electron tests/electron-progress-smoke.cjs --dist
// Uses the actual main/preload/renderer with a deterministic runner; installs nothing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app, BrowserWindow, ipcMain } = require('electron');
const winget = require('../electron/winget.cjs');
const events = new EventEmitter();
const items = [
  { id: 'Example.Alpha', name: 'Alpha Editor', installedVersion: '1.0', availableVersion: '2.0', source: 'winget' },
  { id: 'Example.Beta', name: 'Beta Application With A Long Package Name', installedVersion: '3.0', availableVersion: '4.0', source: 'winget' }
];
let finish;
let activeItems;
let operation;
let holdList = false;
let finishList;
let cancelCount = 0;
function run(packages, nextOperation) {
  activeItems = packages;
  operation = nextOperation;
  events.emit('package-start', { ...packages[0], operation });
  events.emit('log', `Smoke: ${operation} ${packages[0].id}`);
  return new Promise((resolve) => { finish = resolve; });
}
const realList = process.argv.includes('--real-list');
if (!realList) {
  winget.createWingetRunner = () => ({
    events,
    listUpgrades: async () => {
      if (holdList) await new Promise((resolve) => { finishList = resolve; });
      return { packages: items, code: 0, declaredUpgradeCount: 2 };
    },
    upgradeSelected: (packages) => run(packages, 'upgrade'),
    uninstallSelected: (packages) => run(packages, 'uninstall'),
    reinstallSelected: (packages) => run(packages, 'reinstall'),
    cancel: () => { cancelCount++; finishList?.(); events.emit('queue-complete', []); finish?.([]); }
  });
}
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'winget-progress-smoke-')));
require('../electron/main.cjs');
if (!realList) {
  ipcMain.removeHandler('app:is-elevated');
  ipcMain.handle('app:is-elevated', () => false);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const window = BrowserWindow.getAllWindows()[0];
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const tableTop = () => evaluate('document.querySelector(".table-region").getBoundingClientRect().top');
  async function waitFor(code) {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(code)) return;
      await sleep(200);
    }
    throw new Error(`Timed out: ${code}`);
  }
  async function checkCancelLayout(stage, cancelRequired = true) {
    console.log(`Layout matrix: ${stage}`);
    const previousLocale = await evaluate('document.querySelector("select").value');
    for (const locale of ['ko', 'en']) {
      await evaluate(`(() => {
        const select = document.querySelector('select');
        select.value = '${locale}';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      for (const width of [1080, 1360, 1600]) {
        for (const zoom of [1, 1.25]) {
          window.setSize(width, 900);
          window.webContents.setZoomFactor(zoom);
          await sleep(250);
          const geometry = await evaluate(`(() => {
            const button = document.querySelector('${cancelRequired ? '.button.danger' : '.header-actions .button.secondary'}');
            const b = button.getBoundingClientRect();
            const p = document.querySelector('.progress-banner').getBoundingClientRect();
            const h = document.querySelector('.workspace-header').getBoundingClientRect();
            return {
              separate: p.top >= h.bottom && (p.right <= b.left || p.left >= b.right || p.top >= b.bottom || p.bottom <= b.top),
              compact: document.querySelector('.operation-progress').getBoundingClientRect().height === 64,
              visible: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight,
              reachable: [0.1, 0.5, 0.9].every(x => button.contains(document.elementFromPoint(b.left + b.width * x, b.top + b.height / 2)))
            };
          })()`);
          assert.deepEqual(geometry, { separate: true, compact: true, visible: true, reachable: true }, `${stage}: ${locale} ${width}px zoom ${zoom}`);
        }
      }
    }
    window.webContents.setZoomFactor(1);
    window.setSize(1080, 720);
    await evaluate(`(() => { const select = document.querySelector('select'); select.value = '${previousLocale}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(250);
    console.log(`PASS layout: ${stage} (12 combinations)`);
  }
  async function clickCancel() {
    const before = cancelCount;
    const point = await evaluate(`(() => { const r = document.querySelector('.button.danger').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await waitFor('!document.querySelector("[data-active=true]")');
    assert.equal(cancelCount, before + 1, 'native pointer click reaches cancellation IPC');
  }
  try {
    await waitFor('Boolean(document.querySelector(".command-strip"))');
    await waitFor('!document.querySelector("[data-active=true]")');
    if (realList) {
      console.log('REAL LIST UI:', await evaluate('document.querySelector(".log-panel pre").textContent'));
      app.exit(0);
      return;
    }
    window.setSize(1080, 720);
    await sleep(300);
    const idleTop = await tableTop();
    holdList = true;
    await evaluate('document.querySelector(".header-actions .button.secondary").click()');
    await waitFor('Boolean(document.querySelector("[data-active=true]"))');
    assert.equal(await tableTop(), idleTop, 'list does not move when loading starts');
    await checkCancelLayout('list loading');
    await clickCancel();
    assert.equal(await tableTop(), idleTop, 'list does not move when loading ends');
    holdList = false;
    await evaluate('localStorage.setItem("winget-gui-language-preference", "ko")');
    window.reload();
    await sleep(500);
    await waitFor('document.querySelectorAll("tbody tr").length === 2 && !document.querySelector("[data-active=true]")');
    await evaluate('document.querySelector("thead input").click()');
    await sleep(100);
    const selectedTop = await tableTop();
    await evaluate('document.querySelector(".button.primary").click()');
    await waitFor('document.querySelector(".current-package")?.textContent.includes("Alpha Editor")');
    assert.equal(await tableTop(), selectedTop, 'list does not move when installation starts');
    assert.match(await evaluate('document.querySelector(".progress-banner").textContent'), /1\/2.*Alpha Editor.*Example.Alpha.*1.0 → 2.0/);
    assert.equal(await evaluate('document.querySelectorAll(".row-running").length'), 1);
    assert.match(await evaluate('document.querySelector(".log-panel pre").textContent'), /Smoke: upgrade Example.Alpha/);
    events.emit('package-complete', { id: items[0].id, ok: false, operation, failureKind: 'install-tech' });
    events.emit('package-start', { ...items[1], operation });
    await waitFor('document.querySelector(".current-package")?.textContent.includes("Beta Application")');
    assert.equal(await tableTop(), selectedTop, 'long package name does not move list');
    assert.equal(await evaluate('document.querySelector("[role=progressbar]").getAttribute("aria-valuenow")'), '50');
    await checkCancelLayout('upgrade');
    window.setSize(1080, 720);
    await sleep(400);
    assert.equal(await evaluate('document.querySelector(".operation-progress").getBoundingClientRect().bottom <= document.querySelector(".command-strip").getBoundingClientRect().top'), true);
    const out = path.resolve('test-results');
    fs.mkdirSync(out, { recursive: true });
    // Windows may temporarily lose its compositor surface after rapid zoom/resize.
    // Retry only the capture; layout assertions above must pass on the first try.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        window.show();
        window.webContents.invalidate();
        await sleep(400);
        fs.writeFileSync(path.join(out, 'current-package.png'), (await window.webContents.capturePage()).toPNG());
        break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    await clickCancel();
    await waitFor('!document.querySelector("[data-active=true]")');
    // Keep elevation in-process; never open a real UAC prompt in this UI test.
    let finishElevation;
    ipcMain.removeHandler('app:restart-elevated');
    ipcMain.handle('app:restart-elevated', () => new Promise((resolve) => { finishElevation = resolve; }));
    await evaluate('document.querySelector(".header-actions .button.secondary[title]").click()');
    await waitFor('Boolean(document.querySelector("[data-active=true]"))');
    await checkCancelLayout('elevation', false);
    finishElevation({ ok: false, message: 'Smoke elevation finished' });
    await waitFor('!document.querySelector("[data-active=true]")');
    assert.equal(await evaluate('document.querySelectorAll(".row-running").length'), 0);
    // Retry through the reinstall confirmation, then verify queue completion clears the card.
    await evaluate('document.querySelector(".header-actions .button.warning").click()');
    await waitFor('Boolean(document.querySelector(".dialog-actions .button.warning"))');
    await evaluate('document.querySelector(".dialog-actions .button.warning").click()');
    await waitFor('document.querySelector(".current-package")?.textContent.includes("Alpha Editor")');
    assert.match(await evaluate('document.querySelector(".progress-copy").textContent'), /재설치/);
    await checkCancelLayout('reinstall');
    events.emit('package-complete', { id: activeItems[0].id, operation, ok: false });
    events.emit('queue-complete', []);
    finish([]);
    await waitFor('!document.querySelector("[data-active=true]")');
    await evaluate('localStorage.setItem("winget-gui-language-preference", "en")');
    window.reload();
    await sleep(500);
    await waitFor('document.querySelectorAll("tbody tr").length === 2 && !document.querySelector("[data-active=true]")');
    await evaluate('document.querySelector("tbody input").click(); document.querySelector(".uninstall-trigger").click()');
    await waitFor('Boolean(document.querySelector(".dialog-actions .destructive"))');
    await evaluate('document.querySelector(".dialog-actions .destructive").click()');
    await waitFor('Boolean(document.querySelector(".current-package"))');
    assert.match(await evaluate('document.querySelector(".progress-copy").textContent'), /Uninstalling/);
    assert.doesNotMatch(await evaluate('document.querySelector(".current-package-version").textContent'), /→/);
    assert.match(await evaluate('document.querySelector(".queue-completed").textContent'), /0\/1/);
    await checkCancelLayout('uninstall');
    await clickCancel();
    await waitFor('!document.querySelector("[data-active=true]")');
    console.log('PASS: Electron main/preload IPC, package identity/versions, queue switch/failure, logs, 1080px layout, cancel, reinstall completion and English uninstall');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
