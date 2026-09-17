// Run after npm run build: electron tests/electron-progress-smoke.cjs --dist
// Uses the actual main/preload/renderer with a deterministic runner; installs nothing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app, BrowserWindow } = require('electron');
const winget = require('../electron/winget.cjs');
const events = new EventEmitter();
const items = [
  { id: 'Example.Alpha', name: 'Alpha Editor', installedVersion: '1.0', availableVersion: '2.0', source: 'winget' },
  { id: 'Example.Beta', name: 'Beta Application With A Long Package Name', installedVersion: '3.0', availableVersion: '4.0', source: 'winget' }
];
let finish;
let activeItems;
let operation;
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
    listUpgrades: async () => ({ packages: items, code: 0, declaredUpgradeCount: 2 }),
    upgradeSelected: (packages) => run(packages, 'upgrade'),
    uninstallSelected: (packages) => run(packages, 'uninstall'),
    reinstallSelected: (packages) => run(packages, 'reinstall'),
    cancel: () => { events.emit('queue-complete', []); finish?.([]); }
  });
}
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'winget-progress-smoke-')));
require('../electron/main.cjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const window = BrowserWindow.getAllWindows()[0];
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  async function waitFor(code) {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(code)) return;
      await sleep(200);
    }
    throw new Error(`Timed out: ${code}`);
  }
  try {
    await waitFor('Boolean(document.querySelector(".command-strip"))');
    await waitFor('!document.querySelector(".progress-banner")');
    if (realList) {
      console.log('REAL LIST UI:', await evaluate('document.querySelector(".log-panel pre").textContent'));
      app.exit(0);
      return;
    }
    await evaluate('localStorage.setItem("winget-gui-language-preference", "ko")');
    window.reload();
    await sleep(500);
    await waitFor('document.querySelectorAll("tbody tr").length === 2 && !document.querySelector(".progress-banner")');
    await evaluate('document.querySelector("thead input").click(); document.querySelector(".button.primary").click()');
    await waitFor('document.querySelector(".current-package")?.textContent.includes("Alpha Editor")');
    assert.match(await evaluate('document.querySelector(".current-package").textContent'), /1\/2.*Alpha Editor.*Example.Alpha.*1.0 → 2.0/);
    assert.equal(await evaluate('document.querySelectorAll(".row-running").length'), 1);
    assert.match(await evaluate('document.querySelector(".log-panel pre").textContent'), /Smoke: upgrade Example.Alpha/);
    events.emit('package-complete', { id: items[0].id, ok: false, operation, failureKind: 'install-tech' });
    events.emit('package-start', { ...items[1], operation });
    await waitFor('document.querySelector(".current-package")?.textContent.includes("Beta Application")');
    assert.equal(await evaluate('document.querySelector("[role=progressbar]").getAttribute("aria-valuenow")'), '50');
    window.setSize(1080, 720);
    await sleep(400);
    assert.equal(await evaluate('document.querySelector(".operation-progress").getBoundingClientRect().bottom <= document.querySelector(".command-strip").getBoundingClientRect().top'), true);
    const out = path.resolve('test-results');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'current-package.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate('document.querySelector(".button.danger").click()');
    await waitFor('!document.querySelector(".operation-progress")');
    assert.equal(await evaluate('document.querySelectorAll(".row-running").length'), 0);
    // Retry through the reinstall confirmation, then verify queue completion clears the card.
    await evaluate('document.querySelector(".header-actions .button.warning").click()');
    await waitFor('Boolean(document.querySelector(".dialog-actions .button.warning"))');
    await evaluate('document.querySelector(".dialog-actions .button.warning").click()');
    await waitFor('document.querySelector(".current-package")?.textContent.includes("Alpha Editor")');
    assert.match(await evaluate('document.querySelector(".progress-copy").textContent'), /재설치/);
    events.emit('package-complete', { id: activeItems[0].id, operation, ok: false });
    events.emit('queue-complete', []);
    finish([]);
    await waitFor('!document.querySelector(".operation-progress")');
    await evaluate('localStorage.setItem("winget-gui-language-preference", "en")');
    window.reload();
    await sleep(500);
    await waitFor('document.querySelectorAll("tbody tr").length === 2 && !document.querySelector(".progress-banner")');
    await evaluate('document.querySelector("tbody input").click(); document.querySelector(".uninstall-trigger").click()');
    await waitFor('Boolean(document.querySelector(".dialog-actions .destructive"))');
    await evaluate('document.querySelector(".dialog-actions .destructive").click()');
    await waitFor('Boolean(document.querySelector(".current-package"))');
    assert.match(await evaluate('document.querySelector(".progress-copy").textContent'), /Uninstalling/);
    assert.doesNotMatch(await evaluate('document.querySelector(".current-package-version").textContent'), /→/);
    assert.match(await evaluate('document.querySelector(".queue-completed").textContent'), /0 of 1/);
    await evaluate('document.querySelector(".button.danger").click()');
    await waitFor('!document.querySelector(".operation-progress")');
    console.log('PASS: Electron main/preload IPC, package identity/versions, queue switch/failure, logs, 1080px layout, cancel, reinstall completion and English uninstall');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
