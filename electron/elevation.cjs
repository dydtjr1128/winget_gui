const { spawn, spawnSync } = require('node:child_process');

function quotePowerShellSingle(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function getRelaunchArgs({ isPackaged, appPath, argv }) {
  const currentArgv = Array.isArray(argv) ? argv : [];

  if (isPackaged) {
    return currentArgv.slice(1);
  }

  return [appPath, ...currentArgv.slice(2)].filter(Boolean);
}

function buildElevatedRestartPowerShellArgs({ filePath, args = [], cwd = '' }) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('An executable path is required.');
  }

  const argumentList =
    args.length > 0
      ? ` -ArgumentList @(${args.map(quotePowerShellSingle).join(', ')})`
      : '';
  const workingDirectory = cwd ? ` -WorkingDirectory ${quotePowerShellSingle(cwd)}` : '';
  const command = [
    'Start-Process',
    '-FilePath',
    quotePowerShellSingle(filePath),
    argumentList.trimStart(),
    workingDirectory.trimStart(),
    '-Verb RunAs'
  ]
    .filter(Boolean)
    .join(' ');

  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command];
}

function isRunningElevated({ platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  if (platform !== 'win32') {
    return false;
  }

  const result = spawnSyncImpl('net', ['session'], {
    windowsHide: true,
    stdio: 'ignore'
  });

  return result.status === 0;
}

function startElevatedRestart({
  filePath,
  args = [],
  cwd = '',
  platform = process.platform,
  spawnImpl = spawn
}) {
  if (platform !== 'win32') {
    return Promise.resolve({
      ok: false,
      code: null,
      message: 'Administrator elevation is only available on Windows.'
    });
  }

  return new Promise((resolve) => {
    const child = spawnImpl(
      'powershell.exe',
      buildElevatedRestartPowerShellArgs({ filePath, args, cwd }),
      {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      }
    );
    let stderr = '';

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      resolve({
        ok: false,
        code: -1,
        message: error.message
      });
    });

    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        code,
        message: stderr.trim()
      });
    });
  });
}

module.exports = {
  buildElevatedRestartPowerShellArgs,
  getRelaunchArgs,
  isRunningElevated,
  startElevatedRestart
};
