# Winget GUI

An Electron desktop app that puts a GUI on top of Windows `winget`, so you can pick exactly which packages to update instead of upgrading everything at once.

![Winget GUI 패키지 목록 화면](docs/images/winget-gui-package-list.png)

![Winget GUI 업데이트 진행 화면](docs/images/winget-gui-update-progress.png)

## Features

- Shows everything from `winget upgrade` with name, package ID, installed version, available version, and source
- Check only the packages you want and update them one at a time
- Search by name, ID, or version
- Uninstall selected apps, or reinstall apps that winget can't upgrade in place
- Options for silent install, unknown versions, pinned packages, and skipping the hash check
- Per-package status plus the raw `winget` log
- UI in Korean and English

## Requirements

- Windows 10/11 with `winget` available
- Node.js and npm for development or packaging

## Running

```powershell
npm install
npm start
```

`npm start` builds the renderer and launches the Electron app. Opening `dist/index.html` in a browser won't do anything useful — the app needs Electron to talk to `winget`.

For development with hot reload:

```powershell
npm run dev:app
```

## Building a portable exe

```powershell
npm run portable
```

This produces:

```text
release\Winget GUI Portable\Winget GUI.exe
```

Copy the `Winget GUI Portable` folder anywhere and double-click the exe. No installation needed.

## Administrator rights

The packaged exe always asks for elevation (UAC) on launch, since installing and removing packages often requires admin rights.

In development mode (`npm start`, `npm run dev:app`) the manifest doesn't apply, so the app starts unelevated. Use the "Restart as Admin" button inside the app if you need elevation there.

Because the app always runs elevated, anything that tampers with the portable folder would run as administrator too. The build isn't code-signed, so keep it in a location regular users can't write to.

## How updates run

Each selected package is updated one at a time by its exact ID:

```powershell
winget upgrade --id <PackageId> --exact --accept-package-agreements --accept-source-agreements --disable-interactivity --silent
```

Depending on the options you enable, these flags are added:

| Option | winget flag | What it does |
| --- | --- | --- |
| Silent install | `--silent` | Skips installer prompts when the installer supports it. |
| Include unknown versions | `--include-unknown` | Includes packages whose installed version can't be detected. |
| Include pinned | `--include-pinned` | Includes pinned packages when winget doesn't block them. |
| Ignore hash check | `--ignore-security-hash` | Installs even when the installer hash doesn't match the manifest. Use only for sources you trust. |

When winget reports that a package's install technology changed (so an in-place upgrade is impossible), the app offers a reinstall instead: it uninstalls the app and then installs the latest version fresh, after a confirmation dialog.

## Tests

```powershell
npm test
```

## Project layout

```text
electron/              Electron main process, preload, winget execution logic
src/                   React renderer UI
public/                Static app icon
docs/images/           Screenshots for the README
scripts/               Portable packaging script
tests/                 Parser, runner, and packaging tests
release/               Portable build output
```
