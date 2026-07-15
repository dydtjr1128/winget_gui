const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { createWingetRunner } = require('../electron/winget.cjs');

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

// Flush pending microtasks (the serialization chain advances on microtasks).
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('listUpgrades reports wingetMissing when winget cannot be spawned (ENOENT)', async () => {
  const fakeSpawn = () => {
    const child = makeFakeChild();
    setImmediate(() => {
      const error = new Error('spawn winget ENOENT');
      error.code = 'ENOENT';
      child.emit('error', error);
    });
    return child;
  };

  const runner = createWingetRunner({ spawn: fakeSpawn });
  const result = await runner.listUpgrades();

  assert.equal(result.wingetMissing, true);
  assert.deepEqual(result.packages, []);
});

test('cancel kills the running winget child and skips the rest of the queue', async () => {
  const children = [];
  const fakeSpawn = () => {
    const child = makeFakeChild();
    children.push(child);
    return child; // driven manually below
  };

  const runner = createWingetRunner({ spawn: fakeSpawn });
  const packages = [
    { id: 'Alpha.Alpha', name: 'Alpha' },
    { id: 'Beta.Beta', name: 'Beta' }
  ];

  const promise = runner.upgradeSelected(packages, {});
  await flush();

  // Serialized: only the first package's winget has started.
  assert.equal(children.length, 1);

  runner.cancel();
  assert.equal(children[0].killed, true);
  children[0].emit('close', 1);

  const results = await promise;

  // The second package was never spawned and is reported as skipped.
  assert.equal(children.length, 1);
  assert.equal(results.length, 2);
  assert.equal(results[1].skipped, true);
});

test('serializes winget calls — the second starts only after the first closes', async () => {
  const children = [];
  const fakeSpawn = () => {
    const child = makeFakeChild();
    children.push(child);
    return child;
  };

  const runner = createWingetRunner({ spawn: fakeSpawn });
  const packages = [
    { id: 'Alpha.Alpha', name: 'Alpha' },
    { id: 'Beta.Beta', name: 'Beta' }
  ];

  const promise = runner.upgradeSelected(packages, {});
  await flush();
  assert.equal(children.length, 1);

  children[0].emit('close', 0);
  await flush();
  await flush();
  assert.equal(children.length, 2);

  children[1].emit('close', 0);
  const results = await promise;
  assert.equal(results.filter((item) => item.ok).length, 2);
});

test('uninstallSelected runs exact-id winget uninstall and reports operation events', async () => {
  const calls = [];
  const starts = [];
  const completions = [];
  const fakeSpawn = (_cmd, args) => {
    calls.push(args);
    const child = makeFakeChild();
    setImmediate(() => child.emit('close', 0));
    return child;
  };

  const runner = createWingetRunner({ spawn: fakeSpawn });
  runner.events.on('package-start', (item) => starts.push(item));
  runner.events.on('package-complete', (item) => completions.push(item));

  const results = await runner.uninstallSelected([
    { id: 'Git.Git', name: 'Git', source: 'winget' }
  ], { silent: true });

  assert.deepEqual(calls[0], [
    'uninstall',
    '--id',
    'Git.Git',
    '--exact',
    '--accept-source-agreements',
    '--disable-interactivity',
    '--source',
    'winget',
    '--silent'
  ]);
  assert.equal(starts[0].operation, 'uninstall');
  assert.equal(completions[0].operation, 'uninstall');
  assert.equal(results[0].ok, true);
  assert.equal(results[0].operation, 'uninstall');
});

test('uninstallSelected refuses to spawn a truncated package id', async () => {
  let spawnCount = 0;
  const runner = createWingetRunner({
    spawn: () => {
      spawnCount += 1;
      return makeFakeChild();
    }
  });

  const results = await runner.uninstallSelected([
    { id: 'TheDocumentFoundation.Libr…', name: 'LibreOffice', source: 'winget' }
  ]);

  assert.equal(spawnCount, 0);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].failureKind, 'id-resolution');
  assert.equal(results[0].operation, 'uninstall');
});

test('ignoreHash enables InstallerHashOverride, passes the flag, then restores the setting', async () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push(args.join(' '));
    const child = makeFakeChild();
    setImmediate(() => {
      if (args[0] === 'settings' && args[1] === 'export') {
        child.stdout.emit('data', Buffer.from('{"adminSettings":{"InstallerHashOverride":false}}'));
      }
      child.emit('close', 0);
    });
    return child;
  };

  const runner = createWingetRunner({ spawn: fakeSpawn });
  const results = await runner.upgradeSelected([{ id: 'Foo.Bar', name: 'Foo' }], { ignoreHash: true });

  assert.equal(results[0].ok, true);
  assert.ok(calls.includes('settings export'));
  assert.ok(calls.includes('settings --enable InstallerHashOverride'));
  assert.ok(calls.some((c) => c.includes('upgrade') && c.includes('--ignore-security-hash')));
  // restored afterward because we enabled it (it was off)
  assert.ok(calls.includes('settings --disable InstallerHashOverride'));
});

test('ignoreHash does not touch the setting when it is already enabled', async () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push(args.join(' '));
    const child = makeFakeChild();
    setImmediate(() => {
      if (args[0] === 'settings' && args[1] === 'export') {
        child.stdout.emit('data', Buffer.from('{"adminSettings":{"InstallerHashOverride":true}}'));
      }
      child.emit('close', 0);
    });
    return child;
  };

  const runner = createWingetRunner({ spawn: fakeSpawn });
  await runner.upgradeSelected([{ id: 'Foo.Bar', name: 'Foo' }], { ignoreHash: true });

  assert.ok(!calls.includes('settings --enable InstallerHashOverride'));
  assert.ok(!calls.includes('settings --disable InstallerHashOverride'));
  assert.ok(calls.some((c) => c.includes('--ignore-security-hash')));
});

test('ignoreHash leaves the setting untouched when winget export is unreadable', async () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push(args.join(' '));
    const child = makeFakeChild();
    setImmediate(() => {
      if (args[0] === 'settings' && args[1] === 'export') {
        child.stdout.emit('data', Buffer.from('not json at all'));
      }
      child.emit('close', 0);
    });
    return child;
  };

  const runner = createWingetRunner({ spawn: fakeSpawn });
  await runner.upgradeSelected([{ id: 'Foo.Bar', name: 'Foo' }], { ignoreHash: true });

  // unknown prior state -> never enable, never disable (don't clobber)
  assert.ok(!calls.includes('settings --enable InstallerHashOverride'));
  assert.ok(!calls.includes('settings --disable InstallerHashOverride'));
});
