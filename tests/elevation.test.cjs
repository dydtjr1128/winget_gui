const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildDeferredRestartScript,
  buildStartProcessCommand,
  getElevatedRelaunchOptions,
  getRelaunchArgs,
  startDeferredElevatedRestart
} = require('../electron/elevation.cjs');

test('buildStartProcessCommand adds -Verb RunAs only when elevated', () => {
  const elevated = buildStartProcessCommand({
    filePath: 'C:\\App\\Winget GUI.exe',
    args: ['--dist', "quote'test"],
    cwd: 'C:\\App',
    elevated: true
  });
  assert.match(elevated, /Start-Process -FilePath 'C:\\App\\Winget GUI.exe'/);
  assert.match(elevated, /-ArgumentList @\('--dist', 'quote''test'\)/);
  assert.match(elevated, /-WorkingDirectory 'C:\\App'/);
  assert.match(elevated, /-Verb RunAs/);

  const plain = buildStartProcessCommand({
    filePath: 'C:\\App\\Winget GUI.exe',
    args: [],
    cwd: '',
    elevated: false
  });
  assert.doesNotMatch(plain, /-Verb RunAs/);
  assert.doesNotMatch(plain, /-ArgumentList/);
});

test('buildDeferredRestartScript waits for the original to exit, then elevates with a non-elevated fallback', () => {
  const script = buildDeferredRestartScript({
    filePath: 'C:\\Portable\\Winget-GUI-Portable.exe',
    args: ['--foo'],
    cwd: 'C:\\Portable',
    waitForName: 'Winget GUI.exe',
    waitForDir: 'C:\\Users\\me\\AppData\\Local\\Temp\\3ABC',
    timeoutMs: 15000
  });

  // waits for the original instance's processes to disappear first
  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.match(script, /Winget GUI\.exe/);
  assert.match(script, /3ABC/);
  assert.match(script, /-like/);
  // then relaunches elevated, with a non-elevated fallback if UAC is declined
  assert.match(script, /try \{/);
  assert.match(script, /-Verb RunAs/);
  assert.match(script, /\} catch \{/);
  assert.match(script, /'C:\\Portable\\Winget-GUI-Portable.exe'/);
  // and cleans itself up
  assert.match(script, /Remove-Item -LiteralPath \$PSCommandPath/);
});

test('buildDeferredRestartScript falls back to a fixed delay without a wait target', () => {
  const script = buildDeferredRestartScript({ filePath: 'C:\\App\\Winget GUI.exe' });
  assert.match(script, /Start-Sleep -Milliseconds 700/);
  assert.doesNotMatch(script, /Get-CimInstance/);
});

test('buildDeferredRestartScript requires an executable path', () => {
  assert.throws(() => buildDeferredRestartScript({ filePath: '' }), /executable path/);
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

test('relaunches the current executable when not an electron-builder portable', () => {
  const options = getElevatedRelaunchOptions({
    isPackaged: true,
    appPath: 'C:\\Program Files\\Winget GUI\\resources\\app.asar',
    argv: ['C:\\Program Files\\Winget GUI\\Winget GUI.exe'],
    execPath: 'C:\\Program Files\\Winget GUI\\Winget GUI.exe',
    cwd: 'C:\\Somewhere',
    env: {}
  });

  assert.deepEqual(options, {
    filePath: 'C:\\Program Files\\Winget GUI\\Winget GUI.exe',
    args: [],
    cwd: 'C:\\Somewhere'
  });
});

test('startDeferredElevatedRestart is a no-op off Windows', () => {
  let spawned = false;
  const result = startDeferredElevatedRestart({
    filePath: 'C:\\App\\Winget GUI.exe',
    platform: 'darwin',
    writeFileImpl: () => {},
    spawnSyncImpl: () => {
      spawned = true;
      return { status: 0 };
    }
  });
  assert.equal(result.ok, false);
  assert.equal(spawned, false);
});

test('startDeferredElevatedRestart writes a helper script and launches it detached via Start-Process', () => {
  let written = null;
  let spawnCall = null;
  const result = startDeferredElevatedRestart({
    filePath: 'C:\\Portable\\Winget-GUI-Portable.exe',
    args: [],
    cwd: 'C:\\Portable',
    waitForName: 'Winget GUI.exe',
    waitForDir: 'C:\\Temp\\3ABC',
    platform: 'win32',
    tmpDir: 'C:\\Temp',
    pid: 4242,
    writeFileImpl: (file, content) => {
      written = { file, content };
    },
    spawnSyncImpl: (cmd, cmdArgs) => {
      spawnCall = { cmd, cmdArgs };
      return { status: 0 };
    }
  });

  assert.equal(result.ok, true);
  // helper script written to temp with the elevated relaunch inside it
  assert.match(written.file, /winget-gui-elevate-4242\.ps1$/);
  assert.match(written.content, /-Verb RunAs/);
  // launched as an independent process via Start-Process referencing that script
  assert.equal(spawnCall.cmd, 'powershell.exe');
  const launchCommand = spawnCall.cmdArgs.at(-1);
  assert.match(launchCommand, /Start-Process -FilePath 'powershell.exe'/);
  assert.match(launchCommand, /-WindowStyle Hidden/);
  assert.match(launchCommand, /-File', 'C:\\Temp\\winget-gui-elevate-4242\.ps1'/);
});
