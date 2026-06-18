const assert = require('node:assert/strict');
const test = require('node:test');

test('log store appends, replaces, caps, ignores empty, and clears', async () => {
  const { createLogStore } = await import('../src/logStore.mjs');
  const store = createLogStore(3);

  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  store.addEntry('a');
  store.addEntry('b');
  assert.deepEqual(store.getSnapshot(), ['a', 'b']);

  // replace overwrites the last line (terminal carriage-return frame)
  store.addEntry('c-temp');
  store.addEntry('c', true);
  assert.deepEqual(store.getSnapshot(), ['a', 'b', 'c']);

  // cap at 3 drops the oldest
  store.addEntry('d');
  assert.deepEqual(store.getSnapshot(), ['b', 'c', 'd']);

  // empty entries are ignored and do not notify or change the reference
  const before = store.getSnapshot();
  const notificationsBefore = notifications;
  store.addEntry('');
  assert.equal(store.getSnapshot(), before);
  assert.equal(notifications, notificationsBefore);

  store.clear();
  assert.deepEqual(store.getSnapshot(), []);
  assert.ok(notifications > 0);

  unsubscribe();
  const afterUnsub = notifications;
  store.addEntry('e');
  assert.equal(notifications, afterUnsub);
});

test('replace on an empty store appends instead of replacing', async () => {
  const { createLogStore } = await import('../src/logStore.mjs');
  const store = createLogStore(5);

  store.addEntry('first', true);
  assert.deepEqual(store.getSnapshot(), ['first']);
});
