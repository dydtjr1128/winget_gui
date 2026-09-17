const assert = require('node:assert/strict');
const test = require('node:test');

const load = () => import('../src/queueProgress.mjs');

test('current package follows queue order independently of table order and selection', async () => {
  const { getQueueProgress } = await load();
  const current = { id: 'B', name: 'App B', status: 'running', selected: false };
  const result = getQueueProgress([
    current, { id: 'old', status: 'success' }, { id: 'A', status: 'success' },
    { id: 'C', status: 'idle' }
  ], ['A', 'B', 'C']);
  assert.deepEqual(result, { current, position: 2, completed: 1, total: 3, percent: 33 });
});

test('failure counts as processed and next package becomes current', async () => {
  const { getQueueProgress } = await load();
  const rows = [{ id: 'A', status: 'failed' }, { id: 'B', status: 'running' }];
  const result = getQueueProgress(rows, ['A', 'B']);
  assert.equal(result.current.id, 'B');
  assert.equal(result.percent, 50);
  rows[1].status = 'success';
  assert.equal(getQueueProgress(rows, ['A', 'B']).current, null);
  assert.equal(getQueueProgress(rows, ['A', 'B']).percent, 100);
});

test('cleared queue hides stale running package on cancellation and retry resets progress', async () => {
  const { getQueueProgress } = await load();
  assert.deepEqual(getQueueProgress([{ id: 'A', status: 'running' }], []), {
    current: null, position: 0, completed: 0, total: 0, percent: null
  });
  const result = getQueueProgress([{ id: 'A', status: 'idle' }, { id: 'B', status: 'success' }], ['A']);
  assert.equal(result.current, null);
  assert.equal(result.percent, 0);
});

test('upgrade, uninstall and reinstall retain current package version metadata', async () => {
  const { getQueueProgress } = await load();
  for (const lastAction of ['upgrade', 'uninstall', 'reinstall']) {
    const current = { id: 'A', status: 'running', installedVersion: '1', availableVersion: '2', lastAction };
    assert.equal(getQueueProgress([current], ['A']).current, current);
  }
});

test('progress copy identifies whole-queue completion in both languages', async () => {
  const { createTranslator } = await import('../src/i18n.mjs');
  for (const locale of ['ko', 'en']) {
    const { t } = createTranslator(locale);
    assert.equal(t('progress.current', { position: 2, total: 3, name: 'App' }), '2/3 · App');
    assert.match(t('progress.completed', { completed: 1, total: 3 }), /1/);
    assert.doesNotMatch(t('progress.queue'), /^progress\./);
  }
});
