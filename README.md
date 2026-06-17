# Winget GUI

Windows `winget`을 GUI 형태로 만들어 원하는 패키지만 골라 업데이트하는 Electron 데스크톱 앱입니다.

![Winget GUI 패키지 목록 화면](docs/images/winget-gui-package-list.png)

![Winget GUI 업데이트 진행 화면](docs/images/winget-gui-update-progress.png)

## 주요 기능

- `winget upgrade` 결과를 패키지 이름, ID, 현재 버전, 업데이트 버전, 원본 기준으로 표시
- 원하는 항목만 체크해서 순차 업데이트
- 이름, 패키지 ID, 버전 검색
- `winget`이 보고한 개수와 실제 표 표시 개수를 분리 표시
- 버전 미확인 패키지 개수 안내 및 `--include-unknown` 옵션 지원
- 무인 설치, 고정 항목 포함 옵션 지원
- 실행 시 자동으로 관리자 권한(UAC) 요청 — 설치/제거에 권한이 필요한 패키지를 안정적으로 업데이트
- 업데이트 상태와 `winget` 로그 표시
- 터미널의 진행률/스피너처럼 같은 줄을 갱신하는 로그 처리

## 요구 사항

- Windows 10/11
- `winget` 사용 가능 환경
- 개발 또는 패키징 시 Node.js와 npm

## 실행

의존성을 설치한 뒤 데스크톱 앱을 실행합니다.

```powershell
npm install
npm start
```

`npm start`는 렌더러를 빌드한 뒤 Electron 앱으로 실행합니다. 브라우저에서 `dist/index.html`만 열면 Windows `winget` API에 접근할 수 없어 실제 기능은 동작하지 않습니다.

개발 중 hot reload가 필요하면 아래 명령을 사용합니다.

```powershell
npm run dev:app
```

## 포터블 exe 만들기

```powershell
npm run portable
```

성공하면 아래 파일이 생성됩니다.

```text
release\Winget GUI Portable\Winget GUI.exe
```

`release\Winget GUI Portable` 폴더를 통째로 옮기면 설치 없이 exe 더블클릭으로 실행할 수 있습니다.

## 관리자 권한

배포된 exe(포터블/설치본)는 실행 시 매니페스트에 의해 자동으로 관리자 권한(UAC)을 요청합니다. 설치/제거에 관리자 권한이 필요한 패키지를 업데이트할 수 있도록 항상 승격된 상태로 시작합니다.

`npm start`, `npm run dev:app`로 실행하는 개발 모드에서는 매니페스트가 적용되지 않아 일반 권한으로 시작합니다. 필요하면 앱 안의 "관리자 재시작" 버튼으로 승격할 수 있습니다.

> ⚠️ 항상 관리자 권한으로 실행되므로, 포터블 폴더(`resources/app` 안의 JS 포함)가 변조되면 그 코드가 관리자 권한으로 실행됩니다. 일반 사용자가 임의로 쓸 수 없는 위치에 두고 실행하세요. 현재 빌드는 코드 서명되지 않았으니 신뢰할 수 있는 경로에서만 사용하는 것을 권장합니다.

## GitHub 릴리즈 만들기

GitHub Actions는 `v*` 형식의 태그가 push되면 자동으로 릴리즈를 생성합니다.

```powershell
git tag v<package.json 버전>
git push origin v<package.json 버전>
```

태그 이름은 `package.json`의 `version`과 일치해야 합니다.

릴리즈에는 다음 Windows x64 실행 파일이 첨부됩니다.

```text
Winget-GUI-Portable-0.1.0-x64.exe
Winget-GUI-Setup-0.1.0-x64.exe
```

포터블 exe는 설치 없이 실행하는 단일 파일이고, Setup exe는 설치 경로를 선택할 수 있는 설치 파일입니다. 코드 서명 인증서를 연결하지 않은 상태에서는 Windows SmartScreen 경고가 표시될 수 있습니다.

GitHub Actions는 릴리즈 exe에 GitHub Artifact Attestation도 생성합니다. 이 증명은 Windows 코드 서명을 대체하지는 않지만, exe가 이 공개 저장소의 GitHub Actions에서 빌드된 산출물인지 확인하는 데 사용할 수 있습니다.

```powershell
gh attestation verify .\Winget-GUI-Portable-0.1.0-x64.exe --repo dydtjr1128/winget_gui
```

### Windows SmartScreen 안내

릴리즈 exe가 코드 서명되지 않았거나 Microsoft SmartScreen 평판이 아직 충분하지 않으면 `알 수 없는 게시자` 경고가 표시될 수 있습니다. 이 경고는 앱 아이콘이나 패키징 오류가 아니라 Windows 보안 정책에 따른 배포 신뢰도 문제입니다.

개발자가 경고를 줄이려면 Windows 코드 서명 인증서로 릴리즈 exe를 서명해야 합니다. 서명하면 `알 수 없는 게시자` 대신 검증된 게시자 이름을 표시할 수 있지만, Microsoft SmartScreen 평판은 게시자 신뢰와 파일 해시 다운로드 이력을 함께 평가하므로 새 빌드에서는 경고가 계속 표시될 수 있습니다. Microsoft는 2024년 이후 EV 인증서도 새 파일의 SmartScreen 경고를 즉시 우회하지 않는다고 안내합니다. 서명 인증서가 없는 초기 릴리즈에서는 사용자가 SmartScreen의 `추가 정보`에서 실행을 선택해야 할 수 있습니다.

## 업데이트 동작

선택한 패키지는 각 항목마다 정확한 패키지 ID로 순차 업데이트됩니다.

```powershell
winget upgrade --id <패키지ID> --exact --accept-package-agreements --accept-source-agreements --disable-interactivity --silent
```

앱 옵션에 따라 다음 인자가 추가될 수 있습니다.

| 옵션 | winget 인자 | 설명 |
| --- | --- | --- |
| 무인 설치 | `--silent` | 설치 프로그램이 지원하면 확인 창 없이 실행합니다. |
| 버전 미확인 포함 | `--include-unknown` | 현재 버전을 알 수 없는 패키지도 목록과 업데이트 대상에 포함합니다. |
| 고정 항목 포함 | `--include-pinned` | winget에서 고정된 항목도 차단되지 않는 경우 포함합니다. |

## 검증

```powershell
npm test
npm run build
```

포터블 exe까지 확인하려면 다음 명령을 실행합니다.

```powershell
npm run portable
```

## 프로젝트 구조

```text
electron/              Electron 메인 프로세스, preload, winget 실행 로직
src/                   React 렌더러 UI
public/                정적 앱 아이콘
docs/images/           README용 스크린샷
scripts/               포터블 패키징 스크립트
tests/                 winget 파서와 패키징 테스트
release/               생성된 포터블 앱 출력물
```
