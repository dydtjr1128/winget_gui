# Winget GUI

Electron 기반 Windows용 winget 업데이트 선택 GUI입니다.
브라우저용 웹사이트가 아니라 Electron으로 실행되는 PC용 데스크톱 앱입니다.

## 기능

- `winget upgrade` 목록을 표로 표시
- `winget`이 보고한 개수, 실제 표 표시 개수, 버전 미확인 숨김 개수를 분리 표시
- 원하는 패키지만 체크해서 순차 업데이트
- 이름, 패키지 ID, 버전 검색
- 무인 설치, 버전 미확인 포함, 고정 항목 포함, 재부팅 허용 옵션
- 업데이트 진행 상태와 로그 표시

## 실행

```powershell
npm install
npm start
```

`npm start`는 렌더러를 빌드한 뒤 Electron 데스크톱 앱으로 바로 실행합니다.

개발 중 hot reload가 필요하면:

```powershell
npm run dev:app
```

브라우저에서 `dist/index.html`만 열면 winget API가 없으므로 실제 기능은 동작하지 않습니다.

## 포터블 앱 만들기

```powershell
npm run portable
```

위 명령은 `release\Winget GUI Portable\Winget GUI.exe`를 생성합니다.
해당 폴더를 통째로 옮기면 설치 없이 exe 더블클릭으로 실행할 수 있습니다.

## 검증

```powershell
npm test
npm run build
npm audit --omit=dev
```

실제 업데이트는 각 패키지마다 아래 형태로 실행됩니다.

```powershell
winget upgrade --id <패키지ID> --exact --accept-package-agreements --accept-source-agreements --disable-interactivity --silent
```
