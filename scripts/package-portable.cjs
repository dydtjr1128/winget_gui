const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const releaseRoot = path.join(root, 'release');
const portableDir = path.join(releaseRoot, 'Winget GUI Portable');
const appDir = path.join(portableDir, 'resources', 'app');
const sourceExe = path.join(portableDir, 'electron.exe');
const targetExe = path.join(portableDir, 'Winget GUI.exe');

function assertExists(target, label) {
  if (!fs.existsSync(target)) {
    throw new Error(`${label} not found: ${target}`);
  }
}

function copyDir(name) {
  fs.cpSync(path.join(root, name), path.join(appDir, name), { recursive: true });
}

// Finds electron-builder's bundled app-builder binary, which exposes a modern
// `rcedit` subcommand (the same tool electron-builder uses to set the execution
// level). electron-winstaller's vendored rcedit.exe is too old to support
// --set-requested-execution-level, so it is not used here.
function resolveAppBuilderExe() {
  const archDirs = [process.arch, 'x64', 'ia32', 'arm64'];

  for (const arch of archDirs) {
    const candidate = path.join(
      root,
      'node_modules',
      'app-builder-bin',
      'win',
      arch,
      'app-builder.exe'
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

assertExists(path.join(electronDist, 'electron.exe'), 'Electron runtime');
assertExists(path.join(root, 'dist', 'index.html'), 'Vite build output');

fs.rmSync(portableDir, { recursive: true, force: true });
fs.mkdirSync(releaseRoot, { recursive: true });
fs.cpSync(electronDist, portableDir, { recursive: true });

fs.mkdirSync(appDir, { recursive: true });
copyDir('dist');
copyDir('electron');

const packageJson = require(path.join(root, 'package.json'));
const portablePackage = {
  name: packageJson.name,
  version: packageJson.version,
  productName: 'Winget GUI',
  main: 'electron/main.cjs'
};

fs.writeFileSync(
  path.join(appDir, 'package.json'),
  `${JSON.stringify(portablePackage, null, 2)}\n`,
  'utf8'
);

fs.renameSync(sourceExe, targetExe);

// Embed a requireAdministrator manifest so the portable exe always launches
// elevated (UAC at startup). This is more reliable than relaunching elevated
// from inside the running app, which could intermittently fail to reappear.
const appBuilderExe = resolveAppBuilderExe();
if (!appBuilderExe) {
  throw new Error(
    'app-builder.exe not found under node_modules/app-builder-bin; cannot embed the administrator manifest.'
  );
}

const rceditArgs = JSON.stringify([
  targetExe,
  '--set-requested-execution-level',
  'requireAdministrator'
]);
const elevation = spawnSync(appBuilderExe, ['rcedit', '--args', rceditArgs], { stdio: 'inherit' });
if (elevation.error) {
  throw elevation.error;
}
if (elevation.status !== 0) {
  throw new Error(
    `Failed to embed requireAdministrator manifest (app-builder rcedit exit code ${elevation.status}).`
  );
}

// Verify the manifest actually changed, so a silent no-op can never ship a
// portable exe that quietly launches without elevation.
if (!fs.readFileSync(targetExe).includes('requireAdministrator')) {
  throw new Error('requireAdministrator was not embedded into the portable exe manifest.');
}
console.log('Embedded requireAdministrator manifest (portable exe always elevates).');

fs.writeFileSync(
  path.join(portableDir, 'README.txt'),
  [
    'Winget GUI Portable',
    '',
    'Winget GUI.exe 를 실행하면 설치 없이 바로 시작됩니다.',
    '이 앱은 브라우저용 정적 웹앱이 아니라 Electron PC 앱입니다.',
    '실제 winget 목록 조회와 업데이트는 이 exe 안에서만 동작합니다.',
    'Windows winget 명령을 사용하므로 Windows 10/11과 winget이 필요합니다.',
    ''
  ].join('\r\n'),
  'utf8'
);

console.log(`Portable app created: ${targetExe}`);
