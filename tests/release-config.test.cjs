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
  assert.deepEqual(packageJson.build.win.target, [
    { target: 'portable', arch: ['x64'] },
    { target: 'nsis', arch: ['x64'] }
  ]);
  assert.equal(packageJson.build.portable.artifactName, 'Winget-GUI-Portable-${version}-${arch}.${ext}');
  assert.equal(packageJson.build.nsis.artifactName, 'Winget-GUI-Setup-${version}-${arch}.${ext}');
});

test('release workflow runs when a version tag is pushed', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

  assert.match(workflow, /tags:\s*\n\s+- 'v\*'/);
  assert.match(workflow, /runs-on: windows-2025-vs2026/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run release:win/);
  assert.match(workflow, /softprops\/action-gh-release@v3/);
  assert.match(workflow, /release\/\*\.exe/);
});
