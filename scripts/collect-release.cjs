// Copies Tauri build output into release/ with versioned artifact names:
//   release/Winget-GUI-Portable-<version>-x64.exe  (the standalone exe)
//   release/Winget-GUI-Setup-<version>-x64.exe     (NSIS installer, unless --portable-only)
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const targetDir = path.join(root, 'src-tauri', 'target', 'release');
const releaseDir = path.join(root, 'release');
const portableOnly = process.argv.includes('--portable-only');

function copy(source, name) {
  if (!fs.existsSync(source)) {
    throw new Error(`Build output not found: ${source}`);
  }
  const destination = path.join(releaseDir, name);
  fs.copyFileSync(source, destination);
  console.log(destination);
}

fs.mkdirSync(releaseDir, { recursive: true });
copy(path.join(targetDir, 'winget-gui.exe'), `Winget-GUI-Portable-${version}-x64.exe`);

if (!portableOnly) {
  const nsisDir = path.join(targetDir, 'bundle', 'nsis');
  const installer = fs
    .readdirSync(nsisDir)
    .find((name) => name.endsWith('-setup.exe') && name.includes(`_${version}_`));
  if (!installer) {
    throw new Error(`NSIS installer for ${version} not found in ${nsisDir}`);
  }
  copy(path.join(nsisDir, installer), `Winget-GUI-Setup-${version}-x64.exe`);
}
