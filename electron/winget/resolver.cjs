// Resolves a truncated upgrade-list package id to a full PackageIdentifier using
// the various winget outputs (export JSON, installed-list table, catalog search).
// Pure functions over already-captured output — no process access.

const {
  parseWingetSearchRows,
  parseWingetUpgradeRows,
  versionsMatch,
  hasTruncatedMarker,
  getTruncatedPrefix,
  normalizeSearchName,
  getSearchNameMatchPrefixes
} = require('./parser.cjs');

function resolvePackageIdFromSearchOutput(output, prefix, source = '', name = '') {
  const normalizedPrefix = String(prefix ?? '').trim().toLowerCase();
  const normalizedSource = String(source ?? '').trim().toLowerCase();
  const normalizedNamePrefixes = getSearchNameMatchPrefixes(name);
  if (!normalizedPrefix) {
    return null;
  }

  const candidates = parseWingetSearchRows(output).filter((row) => {
    const id = String(row.id ?? '');
    const rowSource = String(row.source ?? '').trim().toLowerCase();
    const rowName = normalizeSearchName(row.name);

    return (
      id &&
      !hasTruncatedMarker(id) &&
      id.toLowerCase().startsWith(normalizedPrefix) &&
      (
        normalizedNamePrefixes.length === 0 ||
        normalizedNamePrefixes.some((namePrefix) => rowName.startsWith(namePrefix))
      ) &&
      (!normalizedSource || !rowSource || rowSource === normalizedSource)
    );
  });
  const uniqueIds = [...new Set(candidates.map((row) => row.id))];

  return uniqueIds.length === 1 ? uniqueIds[0] : null;
}

// Resolves a truncated package id against `winget list` (installed packages)
// output. This is more reliable than a catalog search for upgradable packages:
// the catalog may hold several same-prefix variants (e.g. VCRedist x64/x86)
// that share a version and whose catalog name differs from the installed name,
// but the installed list only contains what is actually installed and carries
// the installed/available versions to disambiguate. parseWingetUpgradeRows
// keeps only rows that have an available upgrade, so same-prefix packages that
// are already current drop out on their own.
function resolvePackageIdFromListOutput(
  output,
  prefix,
  source = '',
  installedVersion = '',
  availableVersion = ''
) {
  const normalizedPrefix = String(prefix ?? '').trim().toLowerCase();
  if (!normalizedPrefix) {
    return null;
  }

  const normalizedSource = String(source ?? '').trim().toLowerCase();
  const candidates = parseWingetUpgradeRows(output).filter((row) => {
    const id = String(row.id ?? '');
    const rowSource = String(row.source ?? '').trim().toLowerCase();

    return (
      id &&
      !hasTruncatedMarker(id) &&
      id.toLowerCase().startsWith(normalizedPrefix) &&
      (!normalizedSource || !rowSource || rowSource === normalizedSource)
    );
  });

  if (candidates.length === 0) {
    return null;
  }

  let matches = candidates;
  if (matches.length > 1 && installedVersion) {
    const byInstalled = matches.filter((row) =>
      versionsMatch(row.installedVersion, installedVersion)
    );
    if (byInstalled.length > 0) {
      matches = byInstalled;
    }
  }
  if (matches.length > 1 && availableVersion) {
    const byAvailable = matches.filter((row) =>
      versionsMatch(row.availableVersion, availableVersion)
    );
    if (byAvailable.length > 0) {
      matches = byAvailable;
    }
  }

  const uniqueIds = [...new Set(matches.map((row) => row.id))];
  return uniqueIds.length === 1 ? uniqueIds[0] : null;
}

// Resolves a truncated upgrade-list id against the installed packages reported
// by `winget export`. Export carries full ids plus the installed version, which
// disambiguates same-prefix variants (e.g. the VCRedist x64/x86 pair) that the
// truncated table output cannot tell apart.
function resolvePackageIdFromExport(exportPackages, prefix, source = '', installedVersion = '') {
  const normalizedPrefix = String(prefix ?? '').trim().toLowerCase();
  if (!normalizedPrefix) {
    return null;
  }

  const normalizedSource = String(source ?? '').trim().toLowerCase();
  let matches = (Array.isArray(exportPackages) ? exportPackages : []).filter((pkg) => {
    const id = String(pkg?.id ?? '');
    const pkgSource = String(pkg?.source ?? '').trim().toLowerCase();

    return (
      id &&
      !hasTruncatedMarker(id) &&
      id.toLowerCase().startsWith(normalizedPrefix) &&
      (!normalizedSource || !pkgSource || pkgSource === normalizedSource)
    );
  });

  // Whenever the installed version is known, require it to match — even for a
  // single candidate. Export and the upgrade table both report winget's
  // installed version, so they are equal for the real package; demanding a
  // match stops a same-prefix sibling (e.g. if export omits the real package)
  // from being upgraded by mistake. Exact equality is required unless the
  // upgrade table itself truncated the version, where prefix matching is the
  // best available signal.
  if (installedVersion) {
    const installedTruncated = hasTruncatedMarker(installedVersion);
    const target = String(installedVersion).trim();
    matches = matches.filter((pkg) =>
      installedTruncated
        ? versionsMatch(pkg.version, installedVersion)
        : String(pkg.version).trim() === target
    );
  }

  const uniqueIds = [...new Set(matches.map((pkg) => pkg.id))];
  return uniqueIds.length === 1 ? uniqueIds[0] : null;
}

module.exports = {
  resolvePackageIdFromSearchOutput,
  resolvePackageIdFromListOutput,
  resolvePackageIdFromExport
};
