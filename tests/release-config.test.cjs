const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('package config builds the Tauri portable exe and installer without Electron', () => {
  const packageJson = require(path.join(root, 'package.json'));

  assert.equal(packageJson.scripts['release:win'], 'tauri build && node scripts/collect-release.cjs');
  assert.equal(
    packageJson.scripts.portable,
    'tauri build --no-bundle && node scripts/collect-release.cjs --portable-only'
  );
  assert.deepEqual(packageJson.dependencies, undefined);
  assert.equal(packageJson.main, undefined);
  assert.equal(packageJson.build, undefined);
  for (const name of Object.keys(packageJson.devDependencies)) {
    assert.doesNotMatch(name, /electron|concurrently|wait-on/);
  }
  assert.match(packageJson.devDependencies['@tauri-apps/cli'], /^\^2\.\d+\.\d+$/);
  assert.match(packageJson.devDependencies['@tauri-apps/api'], /^\^2\.\d+\.\d+$/);
  assert.ok(!fs.existsSync(path.join(root, 'electron')));
});

test('tauri config keeps app identity, version source, icon and NSIS installer', () => {
  const config = JSON.parse(read('src-tauri', 'tauri.conf.json'));

  assert.equal(config.identifier, 'com.est.winget-gui');
  assert.equal(config.productName, 'Winget GUI');
  assert.equal(config.version, '../package.json');
  assert.deepEqual(config.bundle.targets, ['nsis']);
  assert.deepEqual(config.bundle.icon, ['../build/icon.ico']);
  assert.equal(config.bundle.windows.nsis.installMode, 'currentUser');
  assert.equal(config.app.windows[0].decorations, false);
  assert.match(config.app.security.csp, /default-src 'self'/);
  assert.ok(fs.statSync(path.join(root, 'build', 'icon.ico')).size > 0);
});

test('release builds embed a requireAdministrator manifest', () => {
  const buildScript = read('src-tauri', 'build.rs');

  assert.match(buildScript, /requireAdministrator/);
  assert.match(buildScript, /PROFILE/);
});

test('release workflow builds and publishes Tauri artifacts when a version tag is pushed', () => {
  const workflow = read('.github', 'workflows', 'release.yml');

  assert.match(workflow, /tags:\s*\n\s+- 'v\*'/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /runs-on: windows-2025-vs2026/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /cargo test --manifest-path src-tauri\/Cargo\.toml/);
  assert.match(workflow, /npm run release:win/);
  assert.match(workflow, /actions\/attest@v4/);
  assert.match(workflow, /subject-path: release\/\*\.exe/);
  assert.match(workflow, /softprops\/action-gh-release@v3/);
  assert.doesNotMatch(workflow, /electron/i);
});

test('pull request CI runs Node and Rust checks', () => {
  const workflow = read('.github', 'workflows', 'ci.yml');

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /cargo test/);
  assert.match(workflow, /cargo clippy/);
  assert.match(workflow, /tauri build --no-bundle/);
});
