const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function load() {
  return import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'listCache.mjs')).href);
}

const defaults = { includeUnknown: false, includePinned: false };
const packages = [
  {
    name: 'Git',
    id: 'Git.Git',
    installedVersion: '2.47.1',
    availableVersion: '2.48.1',
    source: 'winget',
    idResolutionStatus: 'complete',
    selected: true,
    status: 'failed',
    failureDetail: 'transient UI state'
  }
];

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value))
  };
}

test('round-trips the last list with display fields only', async () => {
  const { readListCache, writeListCache } = await load();
  const storage = memoryStorage();

  writeListCache(
    { packages, listMeta: { declaredUpgradeCount: 1, unknownVersionCount: 2 }, options: defaults, savedAt: 1000 },
    storage
  );
  const cache = readListCache(defaults, storage);

  assert.equal(cache.savedAt, 1000);
  assert.equal(cache.declaredUpgradeCount, 1);
  assert.equal(cache.unknownVersionCount, 2);
  assert.deepEqual(cache.packages, [
    {
      name: 'Git',
      id: 'Git.Git',
      installedVersion: '2.47.1',
      availableVersion: '2.48.1',
      source: 'winget',
      idResolutionStatus: 'complete'
    }
  ]);
});

test('ignores a cache taken with different visibility options', async () => {
  const { parseListCache, serializeListCache } = await load();
  const text = serializeListCache({ packages, listMeta: {}, options: defaults, savedAt: 1 });

  assert.notEqual(parseListCache(text, defaults), null);
  assert.equal(parseListCache(text, { includeUnknown: true, includePinned: false }), null);
  assert.equal(parseListCache(text, { includeUnknown: false, includePinned: true }), null);
});

test('rejects missing, malformed, or old-format caches', async () => {
  const { parseListCache, readListCache } = await load();

  assert.equal(parseListCache(null, defaults), null);
  assert.equal(parseListCache('not json', defaults), null);
  assert.equal(parseListCache('{"version":0,"savedAt":1,"packages":[]}', defaults), null);
  assert.equal(parseListCache('{"version":1,"packages":[]}', defaults), null);
  assert.equal(
    readListCache(defaults, {
      getItem: () => {
        throw new Error('storage disabled');
      }
    }),
    null
  );
});

test('a storage failure while saving does not throw', async () => {
  const { writeListCache } = await load();

  assert.doesNotThrow(() =>
    writeListCache(
      { packages, listMeta: {}, options: defaults, savedAt: 1 },
      {
        setItem: () => {
          throw new Error('quota');
        }
      }
    )
  );
});
