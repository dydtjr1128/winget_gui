const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('vite build uses relative asset URLs for file-based Electron loading', async () => {
  const configUrl = pathToFileURL(path.resolve(root, 'vite.config.mjs')).href;
  const config = (await import(configUrl)).default;

  assert.equal(config.base, './');
});

test('renderer keeps Pretendard as the primary UI font', () => {
  const packageJson = require(path.join(root, 'package.json'));
  const entry = fs.readFileSync(path.join(root, 'src', 'main.jsx'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');

  assert.match(packageJson.devDependencies.pretendard, /^\^\d+\.\d+\.\d+$/);
  assert.match(entry, /pretendard\/dist\/web\/variable\/pretendardvariable\.css/);
  assert.match(styles, /"Pretendard Variable"/);
});
