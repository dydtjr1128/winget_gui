const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildElevatedRestartPowerShellArgs,
  getRelaunchArgs
} = require('../electron/elevation.cjs');

test('builds a PowerShell RunAs command for elevated restart', () => {
  const args = buildElevatedRestartPowerShellArgs({
    filePath: 'C:\\Program Files\\Winget GUI\\Winget GUI.exe',
    args: ['--dist', "quote'test"],
    cwd: 'C:\\Program Files\\Winget GUI'
  });

  const command = args.at(-1);

  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-ExecutionPolicy', 'Bypass']);
  assert.match(command, /Start-Process/);
  assert.match(command, /-Verb RunAs/);
  assert.match(command, /'C:\\Program Files\\Winget GUI\\Winget GUI.exe'/);
  assert.match(command, /-ArgumentList @\('--dist', 'quote''test'\)/);
  assert.match(command, /-WorkingDirectory 'C:\\Program Files\\Winget GUI'/);
});

test('keeps app path and CLI flags when relaunching an unpackaged Electron app', () => {
  assert.deepEqual(
    getRelaunchArgs({
      isPackaged: false,
      appPath: 'C:\\repo\\winget_gui',
      argv: ['C:\\node\\electron.exe', 'C:\\repo\\winget_gui', '--dist']
    }),
    ['C:\\repo\\winget_gui', '--dist']
  );
});

test('keeps user arguments when relaunching a packaged Electron app', () => {
  assert.deepEqual(
    getRelaunchArgs({
      isPackaged: true,
      appPath: 'C:\\repo\\winget_gui',
      argv: ['C:\\release\\Winget GUI.exe', '--foo']
    }),
    ['--foo']
  );
});
