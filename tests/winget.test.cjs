const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildExportArgs,
  buildListArgs,
  buildListByIdArgs,
  buildSearchArgs,
  buildUpgradeArgs,
  classifyWingetFailure,
  createTerminalLogProcessor,
  decodeWingetExportBuffer,
  parseWingetExportPackages,
  parseWingetUpgradeOutput,
  parseWingetUpgradeResult,
  resolvePackageIdFromExport,
  resolvePackageIdFromListOutput,
  resolvePackageIdFromSearchOutput,
  sanitizeWingetOutput,
  summarizeWingetFailure
} = require('../electron/winget.cjs');

test('parses English winget upgrade table rows', () => {
  const output = `
Name                           Id                           Version      Available    Source
------------------------------------------------------------------------------------------
Microsoft PowerToys            Microsoft.PowerToys          0.88.0       0.89.0       winget
Git                            Git.Git                      2.47.1       2.48.1       winget
2 upgrades available.
`;

  assert.deepEqual(parseWingetUpgradeOutput(output), [
    {
      name: 'Microsoft PowerToys',
      id: 'Microsoft.PowerToys',
      installedVersion: '0.88.0',
      availableVersion: '0.89.0',
      source: 'winget'
    },
    {
      name: 'Git',
      id: 'Git.Git',
      installedVersion: '2.47.1',
      availableVersion: '2.48.1',
      source: 'winget'
    }
  ]);
});

test('parses Korean winget upgrade table rows', () => {
  const output = `
이름                           ID                           버전         사용 가능    원본
------------------------------------------------------------------------------------------
Microsoft PowerToys            Microsoft.PowerToys          0.88.0       0.89.0       winget
Git                            Git.Git                      2.47.1       2.48.1       winget
2개 업그레이드 사용 가능.
`;

  const rows = parseWingetUpgradeOutput(output);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'Microsoft.PowerToys');
  assert.equal(rows[0].availableVersion, '0.89.0');
  assert.equal(rows[1].name, 'Git');
});

test('parses current Korean winget output with device id header and truncated names', () => {
  const output = `
이름                        장치 ID                     버전                        사용 가능                    원본
-----------------------------------------------------------------------------------------------------------------------
DBeaver 26.0.3              DBeaver.DBeaver.Community   26.0.3                      26.0.4                       winget
Miniforge3 24.11.3-0 (Pyth… CondaForge.Miniforge3       24.11.3-0                   26.3.2-0                     winget
Microsoft Visual Studio Co… Microsoft.VisualStudioCode  1.118.1                     1.119.0                      winget
15 업그레이드를 사용할 수 있습니다.
`;

  const rows = parseWingetUpgradeOutput(output);

  assert.equal(rows.length, 3);
  assert.equal(rows[1].name, 'Miniforge3 24.11.3-0 (Pyth…');
  assert.equal(rows[1].id, 'CondaForge.Miniforge3');
  assert.equal(rows[2].availableVersion, '1.119.0');
});

test('parses Korean winget rows when a package id is truncated by terminal width', () => {
  const output = `
이름                        장치 ID                     버전                        사용 가능                    원본
-----------------------------------------------------------------------------------------------------------------------
DBeaver 26.0.3              DBeaver.DBeaver.Community   26.0.3                      26.0.4                       winget
Google Cloud SDK            Google.CloudSDK             Unknown                     567.0.0                      winget
Miniforge3 24.11.3-0 (Pyth… CondaForge.Miniforge3       24.11.3-0                   26.3.2-0                     winget
Warp                        Warp.Warp                   v0.2026.04.22.08.46.stable… v0.2026.04.29.08.57.stable_… winget
Microsoft Azure CLI (64-bi… Microsoft.AzureCLI          2.85.0                      2.86.0                       winget
Microsoft Build of OpenJDK… Microsoft.OpenJDK.21        21.0.10.7                   21.0.11.10                   winget
Oh My Posh                  JanDeDobbeleer.OhMyPosh     29.11.0                     29.13.0                      winget
Microsoft Build of OpenJDK… Microsoft.OpenJDK.17        17.0.18.8                   17.0.19.10                   winget
LibreOffice 26.2.2.2        TheDocumentFoundation.Libr… 26.2.2.2                    26.2.3.2                     winget
GitHub CLI                  GitHub.cli                  2.91.0                      2.92.0                       winget
Google Chrome               Google.Chrome.EXE           147.0.7727.138              148.0.7778.97                winget
Cursor (User)               Anysphere.Cursor            3.2.11                      3.2.21                       winget
psmux                       marlocarlo.psmux            3.3.3                       3.3.4                        winget
Zed                         ZedIndustries.Zed           0.232.3                     1.1.5                        winget
Ollama version 0.21.2       Ollama.Ollama               0.21.2                      0.23.1                       winget
Microsoft Visual Studio Co… Microsoft.VisualStudioCode  1.118.1                     1.119.0                      winget
16 업그레이드를 사용할 수 있습니다.
`;

  const result = parseWingetUpgradeResult(output);
  const libreOffice = result.packages.find((item) => item.name === 'LibreOffice 26.2.2.2');

  assert.equal(result.packages.length, 16);
  assert.equal(result.declaredUpgradeCount, 16);
  assert.equal(result.countMismatch, false);
  assert.deepEqual(libreOffice, {
    name: 'LibreOffice 26.2.2.2',
    id: 'TheDocumentFoundation.Libr…',
    installedVersion: '26.2.2.2',
    availableVersion: '26.2.3.2',
    source: 'winget'
  });
});

test('keeps carriage-return progress frames from shifting Korean table headers', () => {
  const output = `\r   - \r   \\ \r   | \r   / \r이름                        장치 ID                     버전                        사용 가능                    원본
-----------------------------------------------------------------------------------------------------------------------
LibreOffice 26.2.2.2        TheDocumentFoundation.Libr… 26.2.2.2                    26.2.3.2                     winget
1 업그레이드를 사용할 수 있습니다.
`;

  const rows = parseWingetUpgradeOutput(output);

  assert.deepEqual(rows, [
    {
      name: 'LibreOffice 26.2.2.2',
      id: 'TheDocumentFoundation.Libr…',
      installedVersion: '26.2.2.2',
      availableVersion: '26.2.3.2',
      source: 'winget'
    }
  ]);
});

test('parses Korean winget count metadata and unknown-version warning', () => {
  const output = `
이름                                                   장치 ID                           버전                         사용 가능                     원본
---------------------------------------------------------------------------------------------------------------------------------------------------------------
DBeaver 26.0.3                                        DBeaver.DBeaver.Community         26.0.3                       26.0.4                        winget
Miniforge3 24.11.3-0 (Python 3.12.8 64-bit)           CondaForge.Miniforge3             24.11.3-0                    26.3.2-0                      winget
Warp                                                   Warp.Warp                         v0.2026.04.22.08.46.stable_03 v0.2026.04.29.08.57.stable_02 winget
Microsoft Azure CLI (64-bit)                          Microsoft.AzureCLI                2.85.0                       2.86.0                        winget
Microsoft Build of OpenJDK 21.0.10+7 (x64)            Microsoft.OpenJDK.21              21.0.10.7                    21.0.11.10                    winget
Oh My Posh                                            JanDeDobbeleer.OhMyPosh           29.11.0                      29.13.0                       winget
Microsoft Build of OpenJDK 17.0.18+8 (x64)            Microsoft.OpenJDK.17              17.0.18.8                    17.0.19.10                    winget
LibreOffice 26.2.2.2                                  TheDocumentFoundation.LibreOffice 26.2.2.2                     26.2.3.2                      winget
GitHub CLI                                            GitHub.cli                        2.91.0                       2.92.0                        winget
Google Chrome                                         Google.Chrome.EXE                 147.0.7727.138               148.0.7778.97                 winget
Cursor (User)                                         Anysphere.Cursor                  3.2.11                       3.2.21                        winget
psmux                                                 marpocalo.psmux                   3.3.3                        3.3.4                         winget
Zed                                                   ZedIndustries.Zed                 0.232.3                      1.1.5                         winget
Ollama version 0.21.2                                 Ollama.Ollama                     0.21.2                       0.23.1                        winget
Microsoft Visual Studio Code (User)                   Microsoft.VisualStudioCode        1.118.1                      1.119.0                       winget
15 업그레이드를 사용할 수 있습니다.
1 패키지에 확인할 수 없는 버전 번호가 있습니다. 모든 결과를 보려면 --include-unknown 사용하세요.
`;

  const result = parseWingetUpgradeResult(output);

  assert.equal(result.packages.length, 15);
  assert.equal(result.declaredUpgradeCount, 15);
  assert.equal(result.unknownVersionCount, 1);
  assert.equal(result.countMismatch, false);
  assert.equal(result.packages[2].availableVersion, 'v0.2026.04.29.08.57.stable_02');
});

test('ignores output that is not a winget table', () => {
  const output = '사용 가능한 업그레이드가 없습니다.';

  assert.deepEqual(parseWingetUpgradeOutput(output), []);
});

test('removes progress and terminal control sequences before parsing', () => {
  const dirty = '\u001b[2K\rName Id Version Available Source\u001b[0m';

  assert.equal(sanitizeWingetOutput(dirty), 'Name Id Version Available Source');
});

test('emits carriage-return log frames as terminal line replacements', () => {
  const entries = [];
  const processor = createTerminalLogProcessor((entry) => entries.push(entry));

  processor.write('-\r');
  processor.write('\\\r|\r');
  processor.write('찾음 Warp [Warp.Warp] 버전 v0\n');
  processor.flush();

  assert.deepEqual(entries, [
    { text: '-', replace: false },
    { text: '\\', replace: true },
    { text: '|', replace: true },
    { text: '찾음 Warp [Warp.Warp] 버전 v0', replace: true }
  ]);
});

test('emits CRLF log lines as append-only lines', () => {
  const entries = [];
  const processor = createTerminalLogProcessor((entry) => entries.push(entry));

  processor.write('첫 번째 줄\r\n두 번째 줄\n');
  processor.flush();

  assert.deepEqual(entries, [
    { text: '첫 번째 줄', replace: false },
    { text: '두 번째 줄', replace: false }
  ]);
});

test('builds safe exact-id upgrade arguments', () => {
  assert.deepEqual(buildUpgradeArgs('Git.Git', {
    silent: true,
    includeUnknown: true,
    includePinned: true
  }), [
    'upgrade',
    '--id',
    'Git.Git',
    '--exact',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
    '--silent',
    '--include-unknown',
    '--include-pinned'
  ]);
});

test('never emits --allow-reboot even when a stale allowReboot option is passed', () => {
  const args = buildUpgradeArgs('Git.Git', { allowReboot: true });
  assert.ok(!args.includes('--allow-reboot'));
});

test('builds list arguments with visibility options', () => {
  assert.deepEqual(buildListArgs({ includeUnknown: true, includePinned: true }), [
    'upgrade',
    '--accept-source-agreements',
    '--include-unknown',
    '--include-pinned'
  ]);
});

test('builds search arguments for resolving truncated package ids', () => {
  assert.deepEqual(buildSearchArgs('Microsoft.VisualStudio.202', 'winget'), [
    'search',
    '--id',
    'Microsoft.VisualStudio.202',
    '--source',
    'winget',
    '--accept-source-agreements',
    '--disable-interactivity'
  ]);
});

test('builds list arguments for resolving a truncated installed package id', () => {
  assert.deepEqual(buildListByIdArgs('Microsoft.VCRedist.2015+.x', 'winget'), [
    'list',
    '--id',
    'Microsoft.VCRedist.2015+.x',
    '--source',
    'winget',
    '--accept-source-agreements',
    '--disable-interactivity'
  ]);
});

test('resolves a truncated id from the installed list, ignoring a same-prefix package that is already current', () => {
  // Both x64 and x86 are installed and share the truncated prefix, but only x64
  // has an available upgrade (x86 is current). winget search cannot tell them
  // apart; the installed list can.
  const listOutput = `
이름                                                    장치 ID                      버전          사용 가능     원본
-----------------------------------------------------------------------------------------------------------------------
Microsoft Visual C++ v14 Redistributable (x64) - 14.50… Microsoft.VCRedist.2015+.x64 14.50.35719.0 14.51.36231.0 winget
Microsoft Visual C++ 2015-2022 Redistributable (x86) -… Microsoft.VCRedist.2015+.x86 14.51.36231.0               winget
`;

  assert.equal(
    resolvePackageIdFromListOutput(
      listOutput,
      'Microsoft.VCRedist.2015+.x',
      'winget',
      '14.50.35719.0',
      '14.51.36231.0'
    ),
    'Microsoft.VCRedist.2015+.x64'
  );
});

test('disambiguates multiple upgradable same-prefix packages by installed version', () => {
  const listOutput = `
Name                           Id                Version   Available  Source
------------------------------------------------------------------------------
Foo Bar (x64)                  Vendor.Foo.x64    1.0.0     2.0.0      winget
Foo Bar (x86)                  Vendor.Foo.x86    1.5.0     2.0.0      winget
`;

  assert.equal(
    resolvePackageIdFromListOutput(listOutput, 'Vendor.Foo.x', 'winget', '1.5.0', '2.0.0'),
    'Vendor.Foo.x86'
  );
});

test('does not resolve from the installed list when the prefix stays ambiguous', () => {
  const listOutput = `
Name                           Id                Version   Available  Source
------------------------------------------------------------------------------
Foo Bar (x64)                  Vendor.Foo.x64    1.0.0     2.0.0      winget
Foo Bar (x86)                  Vendor.Foo.x86    1.0.0     2.0.0      winget
`;

  assert.equal(
    resolvePackageIdFromListOutput(listOutput, 'Vendor.Foo.x', 'winget', '1.0.0', '2.0.0'),
    null
  );
});

test('resolves a truncated package id from winget search output', () => {
  const output = `
Name                           Id                                      Version   Source
--------------------------------------------------------------------------------------
Visual Studio Build Tools 2022 Microsoft.VisualStudio.2022.BuildTools 17.14.32 winget
`;

  assert.equal(
    resolvePackageIdFromSearchOutput(output, 'Microsoft.VisualStudio.202', 'winget'),
    'Microsoft.VisualStudio.2022.BuildTools'
  );
});

test('does not resolve a truncated package id when search results are ambiguous', () => {
  const output = `
Name                         Id                                      Version   Source
------------------------------------------------------------------------------------
Visual Studio Community 2022 Microsoft.VisualStudio.2022.Community  17.14.32 winget
Visual Studio Build Tools 2022 Microsoft.VisualStudio.2022.BuildTools 17.14.32 winget
`;

  assert.equal(resolvePackageIdFromSearchOutput(output, 'Microsoft.VisualStudio.2022', 'winget'), null);
});

test('uses the truncated display name to disambiguate package id search results', () => {
  const output = `
Name                           Id                                      Version   Source
--------------------------------------------------------------------------------------
Visual Studio Community 2022   Microsoft.VisualStudio.2022.Community   17.14.32 winget
Visual Studio Build Tools 2022 Microsoft.VisualStudio.2022.BuildTools  17.14.32 winget
`;

  assert.equal(
    resolvePackageIdFromSearchOutput(
      output,
      'Microsoft.VisualStudio.202',
      'winget',
      'Visual Studio Build Tools …'
    ),
    'Microsoft.VisualStudio.2022.BuildTools'
  );
});

test('resolves a truncated package id when the upgrade name includes the installed version', () => {
  const output = `
이름          장치 ID                      버전
------------------------------------------------
Clawd on Desk rullerzhou-afk.clawd-on-desk 0.8.0
`;

  assert.equal(
    resolvePackageIdFromSearchOutput(
      output,
      'rullerzhou-afk.clawd-on-de',
      'winget',
      'Clawd on Desk 0.7.1'
    ),
    'rullerzhou-afk.clawd-on-desk'
  );
});

test('resolves Visual Studio Build Tools when winget search omits source and compacts the name', () => {
  const output2022 = `
이름                                           장치 ID                                    버전
--------------------------------------------------------------------------------------------------
Visual Studio BuildTools 2022                  Microsoft.VisualStudio.2022.BuildTools     17.14.32
Visual Studio Community 2022                   Microsoft.VisualStudio.2022.Community      17.14.32
Visual Studio Enterprise 2022                  Microsoft.VisualStudio.2022.Enterprise     17.14.32
Visual Studio 2022 Remote Debugger for Devices Microsoft.VisualStudio.2022.OnecoreMsvsmon 17.14.6
Visual Studio Professional 2022                Microsoft.VisualStudio.2022.Professional   17.14.32
Remote Tools for Visual Studio 2022            Microsoft.VisualStudio.2022.RemoteTools    17.14.8
`;
  const output2019 = `
이름                                   장치 ID                                  버전
----------------------------------------------------------------------------------------
Visual Studio Enterprise 2017          Microsoft.VisualStudio.2017.Enterprise   15.9.70
Visual Studio BuildTools 2019          Microsoft.VisualStudio.2019.BuildTools   16.11.56
Microsoft Visual Studio Community 2019 Microsoft.VisualStudio.2019.Community    16.11.53
Visual Studio Enterprise 2019          Microsoft.VisualStudio.2019.Enterprise   16.11.56
Visual Studio Professional 2019        Microsoft.VisualStudio.2019.Professional 16.11.56
`;

  assert.equal(
    resolvePackageIdFromSearchOutput(
      output2022,
      'Microsoft.VisualStudio.202',
      'winget',
      'Visual Studio Build Tools …'
    ),
    'Microsoft.VisualStudio.2022.BuildTools'
  );
  assert.equal(
    resolvePackageIdFromSearchOutput(
      output2019,
      'Microsoft.VisualStudio.201',
      'winget',
      'Visual Studio Build Tools …'
    ),
    'Microsoft.VisualStudio.2019.BuildTools'
  );
});

const EXPORT_JSON = JSON.stringify({
  $schema: 'https://aka.ms/winget-packages.schema.2.0.json',
  CreationDate: '2026-06-17T00:00:00.000-00:00',
  Sources: [
    {
      Packages: [
        { PackageIdentifier: 'Microsoft.DotNet.DesktopRuntime.10', Version: '10.0.8' },
        { PackageIdentifier: 'Microsoft.DotNet.DesktopRuntime.8', Version: '8.0.27' },
        { PackageIdentifier: 'Microsoft.DotNet.DesktopRuntime.9', Version: '9.0.16' },
        { PackageIdentifier: 'Microsoft.VCRedist.2015+.x86', Version: '14.51.36231.0' },
        { PackageIdentifier: 'Microsoft.VCRedist.2015+.x64', Version: '14.50.35719.0' },
        { PackageIdentifier: 'Microsoft.DotNet.AspNetCore.8', Version: '8.0.27' }
      ],
      SourceDetails: {
        Argument: 'https://cdn.winget.microsoft.com/cache',
        Identifier: 'Microsoft.Winget.Source_8wekyb3d8bbwe',
        Name: 'winget',
        Type: 'Microsoft.PreIndexed.Package'
      }
    }
  ],
  WinGetVersion: '1.13.0'
});

test('builds export arguments that include installed versions', () => {
  assert.deepEqual(buildExportArgs('C:\\Temp\\winget-gui-export.json'), [
    'export',
    '--output',
    'C:\\Temp\\winget-gui-export.json',
    '--include-versions',
    '--accept-source-agreements',
    '--disable-interactivity'
  ]);
});

test('buildExportArgs requires an output path', () => {
  assert.throws(() => buildExportArgs(''), /output path/);
});

test('parses winget export packages with full ids and installed versions', () => {
  const packages = parseWingetExportPackages(EXPORT_JSON);

  assert.equal(packages.length, 6);
  assert.deepEqual(packages[0], {
    id: 'Microsoft.DotNet.DesktopRuntime.10',
    version: '10.0.8',
    source: 'winget'
  });
});

test('parses winget export json that begins with a UTF-8 BOM', () => {
  const withBom = String.fromCharCode(0xfeff) + EXPORT_JSON;
  const packages = parseWingetExportPackages(withBom);

  assert.equal(packages.length, 6);
  assert.equal(packages[0].id, 'Microsoft.DotNet.DesktopRuntime.10');
});

test('returns an empty list for malformed or empty winget export json', () => {
  assert.deepEqual(parseWingetExportPackages('not json'), []);
  assert.deepEqual(parseWingetExportPackages(''), []);
  assert.deepEqual(parseWingetExportPackages(null), []);
  assert.deepEqual(parseWingetExportPackages('{}'), []);
});

test('resolves a truncated id from winget export by installed version', () => {
  const packages = parseWingetExportPackages(EXPORT_JSON);

  assert.equal(
    resolvePackageIdFromExport(packages, 'Microsoft.DotNet.DesktopRu', 'winget', '9.0.16'),
    'Microsoft.DotNet.DesktopRuntime.9'
  );
  assert.equal(
    resolvePackageIdFromExport(packages, 'Microsoft.DotNet.DesktopRu', 'winget', '8.0.27'),
    'Microsoft.DotNet.DesktopRuntime.8'
  );
});

test('disambiguates the VCRedist x64/x86 pair from winget export by installed version', () => {
  const packages = parseWingetExportPackages(EXPORT_JSON);

  assert.equal(
    resolvePackageIdFromExport(packages, 'Microsoft.VCRedist.2015+.x', 'winget', '14.51.36231.0'),
    'Microsoft.VCRedist.2015+.x86'
  );
  assert.equal(
    resolvePackageIdFromExport(packages, 'Microsoft.VCRedist.2015+.x', 'winget', '14.50.35719.0'),
    'Microsoft.VCRedist.2015+.x64'
  );
});

test('resolves a unique-prefix truncated id from winget export without a version', () => {
  const packages = parseWingetExportPackages(EXPORT_JSON);

  assert.equal(
    resolvePackageIdFromExport(packages, 'Microsoft.DotNet.AspNetCor', 'winget', ''),
    'Microsoft.DotNet.AspNetCore.8'
  );
});

test('does not resolve from winget export when prefix and version stay ambiguous', () => {
  const packages = [
    { id: 'Vendor.Foo.x64', version: '1.0.0', source: 'winget' },
    { id: 'Vendor.Foo.x86', version: '1.0.0', source: 'winget' }
  ];

  assert.equal(resolvePackageIdFromExport(packages, 'Vendor.Foo.x', 'winget', '1.0.0'), null);
});

test('does not resolve from winget export when the source does not match', () => {
  const packages = [{ id: 'Some.StorePackage', version: '1.0.0', source: 'msstore' }];

  assert.equal(resolvePackageIdFromExport(packages, 'Some.Store', 'winget', '1.0.0'), null);
});

test('returns null when winget export has no matching prefix', () => {
  const packages = parseWingetExportPackages(EXPORT_JSON);

  assert.equal(resolvePackageIdFromExport(packages, 'Nonexistent.Package', 'winget', '1.0.0'), null);
});

test('requires an exact installed-version match for a single export candidate', () => {
  // The real upgradable package is missing from export; only a same-prefix
  // sibling with a different version remains. It must not be resolved to it.
  const packages = [
    { id: 'Microsoft.DotNet.DesktopRuntime.10', version: '10.0.8', source: 'winget' }
  ];

  assert.equal(
    resolvePackageIdFromExport(packages, 'Microsoft.DotNet.DesktopRu', 'winget', '8.0.27'),
    null
  );
});

test('does not resolve a single export candidate on a lenient version prefix', () => {
  // versionsMatch('9', '9.1') would be true; a non-truncated installed version
  // must demand exact equality so a sibling is never mis-picked.
  const packages = [{ id: 'Vendor.Tool.Stable', version: '9', source: 'winget' }];

  assert.equal(resolvePackageIdFromExport(packages, 'Vendor.Tool', 'winget', '9.1'), null);
});

test('falls back to lenient version matching when the upgrade table truncated the version', () => {
  const packages = [
    { id: 'Warp.Warp.Preview', version: 'v0.2026.06.03.09.49.stable_02', source: 'winget' }
  ];

  assert.equal(
    resolvePackageIdFromExport(packages, 'Warp.Warp.Pre', 'winget', 'v0.2026.06.03.09.49.stable…'),
    'Warp.Warp.Preview'
  );
});

test('decodes winget export output from utf-8 and utf-16le buffers', () => {
  assert.equal(decodeWingetExportBuffer(Buffer.from(EXPORT_JSON, 'utf8')), EXPORT_JSON);

  const utf16le = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(EXPORT_JSON, 'utf16le')
  ]);
  assert.equal(parseWingetExportPackages(decodeWingetExportBuffer(utf16le)).length, 6);
});

test('summarizes a winget MSI uninstall failure for hover details', () => {
  const detail = summarizeWingetFailure({
    ok: false,
    code: 1,
    stdout: `
찾음 Microsoft Build of OpenJDK with Hotspot 17 [Microsoft.OpenJDK.17] 버전 17.0.19.10
이 응용 프로그램의 라이선스는 그 소유자가 사용자에게 부여했습니다.
설치 관리자 해시를 확인했습니다.
패키지 제거를 시작하는 중...
설치 종료 코드로 인해 제거하지 못함: 1603
`,
    stderr: ''
  });

  assert.equal(detail, '설치 종료 코드로 인해 제거하지 못함: 1603');
});

test('classifies a winget MSI uninstall failure as installer failure', () => {
  const kind = classifyWingetFailure({
    ok: false,
    code: 1,
    stdout: `
찾음 Microsoft Build of OpenJDK with Hotspot 17 [Microsoft.OpenJDK.17] 버전 17.0.19.10
설치 관리자 해시를 확인했습니다.
패키지 제거를 시작하는 중...
설치 종료 코드로 인해 제거하지 못함: 1603
`,
    stderr: ''
  });

  assert.equal(kind, 'installer');
});

test('classifies a winget MSI administrator failure as requiring elevation', () => {
  const kind = classifyWingetFailure({
    ok: false,
    code: 1,
    stdout: `
패키지 제거를 시작하는 중...
설치 종료 코드로 인해 제거하지 못함: 1603
`,
    stderr: `
Product: Microsoft Build of OpenJDK  21.0.10+7 (x64) -- Error 1730.
You must be an Administrator to remove this application.
`
  });

  assert.equal(kind, 'requires-admin');
});

test('classifies installer exit code 2 with a manifest mismatch as a hash failure', () => {
  const kind = classifyWingetFailure({
    ok: false,
    code: 1,
    stdout: `
설치 관리자가 종료 코드로 인해 실패함: 2
다운로드한 설치 파일의 해시가 매니페스트와 다릅니다. 원본이 갱신될 때까지 기다리거나 나중에 다시 시도하세요.
`,
    stderr: ''
  });

  assert.equal(kind, 'hash');
});

test('summarizes a winget applicability failure with the explanatory line', () => {
  const detail = summarizeWingetFailure({
    ok: false,
    code: 1,
    stdout: `
적용 가능한 업그레이드를 찾을 수 없습니다.
구성된 원본에서 최신 패키지 버전을 사용할 수 있지만 시스템 또는 요구 사항에는 적용되지 않습니다.
`,
    stderr: ''
  });

  assert.equal(
    detail,
    '적용 가능한 업그레이드를 찾을 수 없습니다.\n구성된 원본에서 최신 패키지 버전을 사용할 수 있지만 시스템 또는 요구 사항에는 적용되지 않습니다.'
  );
});
