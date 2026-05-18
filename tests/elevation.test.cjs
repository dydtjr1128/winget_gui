const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildElevatedRestartPowerShellArgs,
  getElevatedRelaunchOptions,
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

test('relaunches the original electron-builder portable executable when available', () => {
  const options = getElevatedRelaunchOptions({
    isPackaged: true,
    appPath: 'C:\\Temp\\WingetGuiPortable\\resources\\app.asar',
    argv: ['C:\\Temp\\WingetGuiPortable\\Winget GUI.exe', '--foo'],
    execPath: 'C:\\Temp\\WingetGuiPortable\\Winget GUI.exe',
    cwd: 'C:\\Work',
    env: {
      PORTABLE_EXECUTABLE_FILE: 'C:\\PortableApps\\Winget GUI\\Winget-GUI-Portable-0.1.4-x64.exe',
      PORTABLE_EXECUTABLE_DIR: 'C:\\PortableApps\\Winget GUI'
    }
  });

  assert.deepEqual(options, {
    filePath: 'C:\\PortableApps\\Winget GUI\\Winget-GUI-Portable-0.1.4-x64.exe',
    args: ['--foo'],
    cwd: 'C:\\PortableApps\\Winget GUI'
  });
});
