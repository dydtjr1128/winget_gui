const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildListArgs,
  buildUpgradeArgs,
  createTerminalLogProcessor,
  parseWingetUpgradeOutput,
  parseWingetUpgradeResult,
  sanitizeWingetOutput
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
    includePinned: true,
    allowReboot: false
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

test('builds list arguments with visibility options', () => {
  assert.deepEqual(buildListArgs({ includeUnknown: true, includePinned: true }), [
    'upgrade',
    '--accept-source-agreements',
    '--include-unknown',
    '--include-pinned'
  ]);
});
