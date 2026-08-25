# AGENTS.md — Winget GUI 에이전트 & 기여 규칙

이 저장소에서 작업하는 에이전트/기여자는 아래 규칙을 따른다.

## 프로젝트 개요 & 검증 방법

- Electron 데스크톱 앱이다. 브라우저 단독 웹앱이 아니다.
- 실제 `winget` 동작은 Electron 메인 프로세스와 preload IPC를 통해서만 가능하다.
- 기능 검증은 `npm run dev:app`, `npm start`, 또는 `release\Winget GUI Portable\Winget GUI.exe` 로 한다.
- `npm run dev` 와 `dist/index.html` 은 렌더러 레이아웃 확인용이며, winget 목록/업데이트 흐름은 검증할 수 없다.
- "패키지 업데이트가 동작한다"고 말하기 전에 Windows에서 패키징된 앱(또는 Electron 앱)을 실제 실행해 데스크톱 UI와 로그 흐름을 확인한다.
- 포터블 재빌드: `npm run portable`. 실행 중인 앱이 있으면 파일 잠금으로 실패할 수 있으니 먼저 종료한다.
- 머지 전 `npm test` 전부 통과가 필수이며, 동작 변경에는 회귀 테스트를 함께 추가한다.

## 브랜치 & 워크플로

- 기본 브랜치는 `main`이며 직접 커밋하지 않는다. 모든 변경은 PR로 들어간다.
- 브랜치 이름은 `feature/<kebab-case-주제>` 형태로 만든다(버그 수정·문서·chore 포함 전부 동일 접두사).
- 기능 추가/버그 수정은 GitHub **이슈를 먼저 등록**하고 시작하며, PR 본문에 `Closes #N`을 넣는다. 문서/단순 chore는 이슈를 생략할 수 있다.
- 머지는 **스쿼시 머지**만 사용한다. 스쿼시 커밋 제목은 `<type>: 한국어 제목 (#PR번호)` 형식.
- 머지 후 원격 feature 브랜치는 삭제한다.

## 커밋 메시지

- 형식: `<type>: 한국어 제목` — type은 `feat` / `fix` / `chore` (필요 시 `docs`, `refactor`, `test`).
- 코드·명령어·식별자·에러 메시지 원문은 번역하지 않고 그대로 둔다.
- `Co-Authored-By` 등 트레일러는 넣지 않는다.

## 버전 & 태그

- **적절한 이슈 수정(feat/fix PR)이 머지될 때마다 버전을 올리고 태그를 단다.** 오타·문서·단순 chore는 버전 범프를 생략한다.
- 절차:
  1. 수정 PR 스쿼시 머지 후, `npm version <X.Y.Z> --no-git-tag-version` 로 패치 버전을 올리고 `chore: 버전 X.Y.Z로 갱신` 커밋을 별도 PR(스쿼시 머지)로 올린다. 변경 파일은 `package.json` + `package-lock.json`.
  2. 범프 커밋이 `main`에 머지되면 **그 커밋에** lightweight 태그 `vX.Y.Z`를 달고 푸시한다:
     `git tag vX.Y.Z <머지 커밋>` → `git push origin vX.Y.Z`
- 태그 이후 배포 산출물이 필요하면 `npm run portable` 로 생성한다.

## 코드 구조 메모

- `electron/winget/parser.cjs` 는 순수 함수만 둔다(프로세스/파일시스템 접근 금지) — 단위 테스트 대상.
- 프로세스/파일시스템 접근은 `electron/winget/runner.cjs` 에만 둔다.
- 사용자 노출 문자열은 `src/i18n.mjs` 의 ko/en 두 블록에 항상 쌍으로 추가한다.
- 소스에 제어 문자를 넣을 때는 `\uXXXX` 리터럴 대신 `String.fromCharCode(...)` 또는 `\xXX` 를 쓴다(기존 관례, 보이지 않는 문자 유입 방지).
