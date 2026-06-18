// Barrel for the winget implementation. Keeps a stable public API for the
// Electron main process and tests while the code is split across focused
// modules: winget/parser (pure output parsing), winget/resolver (truncated-id
// resolution), winget/args (CLI argument builders), and winget/runner (process
// orchestration).

const parser = require('./winget/parser.cjs');
const resolver = require('./winget/resolver.cjs');
const args = require('./winget/args.cjs');
const { createWingetRunner } = require('./winget/runner.cjs');

module.exports = {
  buildExportArgs: args.buildExportArgs,
  buildListArgs: args.buildListArgs,
  buildListByIdArgs: args.buildListByIdArgs,
  buildSearchArgs: args.buildSearchArgs,
  buildUpgradeArgs: args.buildUpgradeArgs,
  classifyWingetFailure: parser.classifyWingetFailure,
  createTerminalLogProcessor: parser.createTerminalLogProcessor,
  createWingetRunner,
  decodeWingetExportBuffer: parser.decodeWingetExportBuffer,
  parseWingetExportPackages: parser.parseWingetExportPackages,
  parseWingetUpgradeOutput: parser.parseWingetUpgradeOutput,
  parseWingetUpgradeResult: parser.parseWingetUpgradeResult,
  resolvePackageIdFromExport: resolver.resolvePackageIdFromExport,
  resolvePackageIdFromListOutput: resolver.resolvePackageIdFromListOutput,
  resolvePackageIdFromSearchOutput: resolver.resolvePackageIdFromSearchOutput,
  sanitizeWingetOutput: parser.sanitizeWingetOutput,
  summarizeWingetFailure: parser.summarizeWingetFailure
};
