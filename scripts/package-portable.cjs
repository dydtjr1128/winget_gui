const fs = require('node:fs');
const path = require('node:path');

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
fs.writeFileSync(
  path.join(portableDir, 'README.txt'),
  [
    'Winget GUI Portable',
    '',
    'Winget GUI.exe 를 실행하면 설치 없이 바로 시작됩니다.',
    'Windows winget 명령을 사용하므로 Windows 10/11과 winget이 필요합니다.',
    ''
  ].join('\r\n'),
  'utf8'
);

console.log(`Portable app created: ${targetExe}`);
