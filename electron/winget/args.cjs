// Builders for the winget CLI argument arrays. Pure — no process access.

function buildListArgs(options = {}) {
  const args = ['upgrade', '--accept-source-agreements'];

  if (options.includeUnknown) {
    args.push('--include-unknown');
  }

  if (options.includePinned) {
    args.push('--include-pinned');
  }

  return args;
}

function buildSearchArgs(prefix, source = '') {
  if (!prefix || typeof prefix !== 'string') {
    throw new Error('A package id prefix is required.');
  }

  const args = ['search', '--id', prefix];

  if (source) {
    args.push('--source', source);
  }

  args.push('--accept-source-agreements', '--disable-interactivity');

  return args;
}

function buildListByIdArgs(prefix, source = '') {
  if (!prefix || typeof prefix !== 'string') {
    throw new Error('A package id prefix is required.');
  }

  const args = ['list', '--id', prefix];

  if (source) {
    args.push('--source', source);
  }

  args.push('--accept-source-agreements', '--disable-interactivity');

  return args;
}

function buildExportArgs(outputPath) {
  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error('An export output path is required.');
  }

  return [
    'export',
    '--output',
    outputPath,
    '--include-versions',
    '--accept-source-agreements',
    '--disable-interactivity'
  ];
}

function buildUpgradeArgs(id, options = {}) {
  if (!id || typeof id !== 'string') {
    throw new Error('A package id is required.');
  }

  const args = [
    'upgrade',
    '--id',
    id,
    '--exact',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity'
  ];

  if (options.silent) {
    args.push('--silent');
  }

  if (options.includeUnknown) {
    args.push('--include-unknown');
  }

  if (options.includePinned) {
    args.push('--include-pinned');
  }

  return args;
}

module.exports = {
  buildListArgs,
  buildSearchArgs,
  buildListByIdArgs,
  buildExportArgs,
  buildUpgradeArgs
};
