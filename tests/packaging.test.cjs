const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

test('vite build uses relative asset URLs for file-based Electron loading', async () => {
  const configUrl = pathToFileURL(path.resolve(__dirname, '..', 'vite.config.mjs')).href;
  const config = (await import(configUrl)).default;

  assert.equal(config.base, './');
});
