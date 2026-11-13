// Last successful upgrade list, shown immediately on the next launch while the
// slow `winget upgrade` refresh runs. Only display fields are kept; the backend
// still refuses any id that is not in its own freshly loaded list.

export const listCacheStorageKey = 'winget-gui-list-cache';
const cacheVersion = 1;
const packageFields = ['name', 'id', 'installedVersion', 'availableVersion', 'source', 'idResolutionStatus'];

function pickPackage(item) {
  const picked = {};
  for (const field of packageFields) {
    if (typeof item?.[field] === 'string') {
      picked[field] = item[field];
    }
  }
  return picked;
}

export function serializeListCache({ packages, listMeta, options, savedAt }) {
  return JSON.stringify({
    version: cacheVersion,
    savedAt,
    includeUnknown: Boolean(options?.includeUnknown),
    includePinned: Boolean(options?.includePinned),
    declaredUpgradeCount:
      typeof listMeta?.declaredUpgradeCount === 'number' ? listMeta.declaredUpgradeCount : null,
    unknownVersionCount:
      typeof listMeta?.unknownVersionCount === 'number' ? listMeta.unknownVersionCount : 0,
    packages: (Array.isArray(packages) ? packages : []).map(pickPackage)
  });
}

// Returns the cached snapshot, or null when it is missing, malformed, from an
// older format, or was taken with different visibility options.
export function parseListCache(text, options) {
  let cache;
  try {
    cache = JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }

  if (
    !cache ||
    cache.version !== cacheVersion ||
    !Array.isArray(cache.packages) ||
    typeof cache.savedAt !== 'number' ||
    cache.includeUnknown !== Boolean(options?.includeUnknown) ||
    cache.includePinned !== Boolean(options?.includePinned)
  ) {
    return null;
  }

  const packages = cache.packages
    .map(pickPackage)
    .filter((item) => item.id && item.installedVersion !== undefined);

  return {
    savedAt: cache.savedAt,
    packages,
    declaredUpgradeCount:
      typeof cache.declaredUpgradeCount === 'number' ? cache.declaredUpgradeCount : null,
    unknownVersionCount:
      typeof cache.unknownVersionCount === 'number' ? cache.unknownVersionCount : 0
  };
}

export function readListCache(options, storage = globalThis.localStorage) {
  try {
    return parseListCache(storage?.getItem(listCacheStorageKey), options);
  } catch {
    return null;
  }
}

export function writeListCache(snapshot, storage = globalThis.localStorage) {
  try {
    storage?.setItem(listCacheStorageKey, serializeListCache(snapshot));
  } catch {
    // The cache only speeds up the next launch; ignore storage failures.
  }
}
