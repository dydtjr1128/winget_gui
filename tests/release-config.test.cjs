const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('package config builds portable and installer Windows executables', () => {
  const packageJson = require(path.join(root, 'package.json'));

  assert.equal(packageJson.scripts['release:win'], 'npm run build && electron-builder --win portable nsis --x64 --publish never');
  assert.deepEqual(packageJson.dependencies, undefined);
  assert.match(packageJson.devDependencies['@vitejs/plugin-react'], /^\^\d+\.\d+\.\d+$/);
  assert.match(packageJson.devDependencies.vite, /^\^\d+\.\d+\.\d+$/);
  assert.match(packageJson.devDependencies.react, /^\^\d+\.\d+\.\d+$/);
  assert.match(packageJson.devDependencies['electron-builder'], /^\^\d+\.\d+\.\d+$/);
  assert.match(packageJson.devDependencies.electron, /^\^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.build.appId, 'com.est.winget-gui');
  assert.equal(packageJson.build.productName, 'Winget GUI');
  assert.equal(packageJson.build.win.icon, 'build/icon.ico');
  assert.equal(packageJson.build.win.requestedExecutionLevel, 'requireAdministrator');
  assert.deepEqual(packageJson.build.win.target, [
    { target: 'portable', arch: ['x64'] },
    { target: 'nsis', arch: ['x64'] }
  ]);
  assert.equal(packageJson.build.portable.artifactName, 'Winget-GUI-Portable-${version}-${arch}.${ext}');
  assert.equal(packageJson.build.portable.requestExecutionLevel, 'admin');
  assert.equal(packageJson.build.nsis.artifactName, 'Winget-GUI-Setup-${version}-${arch}.${ext}');
  assert.equal(packageJson.build.nsis.installerIcon, 'build/icon.ico');
  assert.equal(packageJson.build.nsis.uninstallerIcon, 'build/icon.ico');
  assert.ok(fs.statSync(path.join(root, 'build', 'icon.ico')).size > 0);
});

test('release workflow runs when a version tag is pushed', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

  assert.match(workflow, /tags:\s*\n\s+- 'v\*'/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /artifact-metadata: write/);
  assert.match(workflow, /runs-on: windows-2025-vs2026/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /ELECTRON_CACHE: \$\{\{ github\.workspace \}\}\\\.cache\\electron/);
  assert.match(workflow, /ELECTRON_BUILDER_CACHE: \$\{\{ github\.workspace \}\}\\\.cache\\electron-builder/);
  assert.match(workflow, /actions\/cache@v5/);
  assert.match(workflow, /\.cache\\electron/);
  assert.match(workflow, /\.cache\\electron-builder/);
  assert.match(workflow, /key: \$\{\{ runner\.os \}\}-electron-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run release:win/);
  assert.match(workflow, /actions\/attest@v4/);
  assert.match(workflow, /subject-path: release\/\*\.exe/);
  assert.match(workflow, /softprops\/action-gh-release@v3/);
  assert.match(workflow, /release\/\*\.exe/);
});

test('portable packaging embeds a requireAdministrator manifest into the exe', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'package-portable.cjs'), 'utf8');

  assert.match(script, /--set-requested-execution-level/);
  assert.match(script, /requireAdministrator/);
});
