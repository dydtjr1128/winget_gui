export const supportedLocales = ['ko', 'en'];
export const languagePreferences = ['system', ...supportedLocales];
export const fallbackLocale = 'en';
export const defaultLanguagePreference = 'system';

const localeFormatTags = {
  ko: 'ko-KR',
  en: 'en-US'
};

const dictionaries = {
  ko: {
    'app.title': 'Winget GUI',
    'status.running': '진행 중',
    'status.success': '완료',
    'status.failed': '실패',
    'status.idle': '대기',
    'status.needsAttention': 'ID 확인',
    'status.failureDetail': '실패 오류',
    'status.idResolutionDetail': 'winget 출력에서 패키지 ID가 잘렸고 전체 ID를 자동 확인하지 못했습니다. 새로고침 후 다시 시도하거나 winget search로 ID를 확인하세요: {id}',
    'failure.kind.installer': '설치 오류',
    'failure.kind.requires-admin': '관리자 권한 필요',
    'failure.kind.not-found': 'ID 오류',
    'failure.kind.not-applicable': '적용 불가',
    'failure.kind.hash': '해시 오류',
    'failure.kind.id-resolution': 'ID 확인',
    'failure.kind.generic': '업데이트 실패',
    'failure.advice.installer': '기존 앱이 실행 중이거나 제거 단계에서 관리자 권한/대화형 확인이 필요할 수 있습니다. 관련 앱을 종료하고 무인 설치를 끄거나 관리자 권한으로 다시 시도하세요.',
    'failure.advice.requires-admin': '기존 버전을 제거하려면 관리자 권한이 필요합니다. 앱을 관리자 권한으로 재시작한 뒤 실패 항목을 다시 실행하세요.',
    'failure.advice.not-found': '목록의 패키지 ID와 설치된 패키지가 맞지 않습니다. 새로고침으로 ID를 다시 확인한 뒤 재시도하세요.',
    'failure.advice.not-applicable': 'winget 원본에는 새 버전이 있지만 현재 시스템 조건에는 맞지 않습니다. 아키텍처, 설치 범위, 고정 상태를 확인하세요.',
    'failure.advice.hash': '다운로드한 설치 파일의 해시가 winget 매니페스트와 다릅니다. 보통 원본 갱신 지연이 원인이니 잠시 후 다시 시도하세요. 원본을 신뢰한다면 옵션의 "해시 검증 무시"를 켜고 재시도할 수 있습니다(무결성 검증을 건너뜁니다).',
    'failure.advice.id-resolution': '패키지 ID가 잘린 상태라 안전하게 실행하지 않았습니다. 새로고침하거나 원본 ID를 확인하세요.',
    'failure.advice.generic': '로그의 마지막 오류를 확인하고 같은 항목만 다시 시도하세요.',
    'failure.summary.installer': '설치 오류 {count}',
    'failure.summary.requires-admin': '관리자 권한 {count}',
    'failure.summary.not-found': 'ID 오류 {count}',
    'failure.summary.not-applicable': '적용 불가 {count}',
    'failure.summary.hash': '해시 오류 {count}',
    'failure.summary.id-resolution': 'ID 확인 {count}',
    'failure.summary.generic': '기타 {count}',
    'language.title': '표시 언어',
    'language.system': '시스템 언어',
    'language.ko': '한국어',
    'language.en': 'English',
    'tooltips.silent': '설치 프로그램이 지원하면 확인 창 없이 조용히 설치합니다.',
    'tooltips.includeUnknown': '현재 버전을 알 수 없는 패키지도 목록과 업데이트 대상에 포함합니다.',
    'tooltips.includePinned': 'winget에서 고정된 항목도 차단되지 않는 경우 목록에 포함합니다.',
    'tooltips.ignoreHash': '설치 파일 해시가 매니페스트와 달라도 설치를 강행합니다(--ignore-security-hash). 무결성 검증을 건너뛰므로 신뢰할 수 있는 원본에만 사용하세요. winget 전역 설정 InstallerHashOverride를 켭니다.',
    'tooltips.restartAsAdmin': 'UAC 확인 후 Winget GUI를 관리자 권한으로 다시 시작합니다.',
    'aria.selectAllVisible': '표시된 항목 모두 선택',
    'aria.windowControls': '창 제어',
    'aria.minimize': '최소화',
    'aria.restore': '이전 크기로',
    'aria.maximize': '최대화',
    'aria.close': '닫기',
    'aria.updateSummary': '업데이트 요약',
    'aria.updateOptions': '업데이트 옵션',
    'aria.listTools': '목록 도구',
    'aria.updateList': 'winget 업데이트 목록',
    'aria.logs': '로그',
    'aria.selectPackage': '{name} 선택',
    'native.title': 'PC용 앱으로 실행하세요',
    'native.body': '브라우저 화면에서는 winget에 접근하지 않습니다.',
    'progress.updating': '선택한 패키지를 순차 업데이트하는 중',
    'progress.syncing': 'winget 목록을 동기화하는 중',
    'progress.elevating': '관리자 권한을 요청하는 중',
    'logs.fetchList': 'winget upgrade 목록 조회',
    'logs.listExitCode': '목록 조회 종료 코드: {code}',
    'logs.noUpdates': '업데이트 가능한 항목이 없습니다.',
    'logs.wingetMissing': 'winget 실행 파일을 찾을 수 없습니다. 앱 설치 관리자(App Installer)를 설치하세요.',
    'logs.countMismatch': '개수 확인 필요: winget {wingetCount}개, 표 표시 {displayedCount}개',
    'logs.unknownVersions': '버전 미확인 {count}개: 옵션을 켜고 새로고침하면 포함됩니다.',
    'logs.optionsChanged': '목록 표시 옵션이 바뀌었습니다. 다시 조회합니다.',
    'logs.updateStart': '선택 업데이트 시작: {count}개',
    'logs.updateComplete': '선택 업데이트 완료',
    'logs.cancelRequested': '진행 중인 업데이트 취소 요청',
    'logs.elevationRequested': '관리자 권한으로 앱 재시작 요청',
    'logs.elevationFailed': '관리자 권한 재시작 실패: {message}',
    'logs.alreadyElevated': '이미 관리자 권한으로 실행 중입니다.',
    'logs.empty': '아직 로그가 없습니다.',
    'alerts.countMismatch': 'winget은 {wingetCount}개라고 보고했지만 표에는 {displayedCount}개가 표시됐습니다.',
    'alerts.unknownHidden': '버전 미확인 {count}개는 숨겨질 수 있습니다.',
    'alerts.failureSummary': '실패 {count}개: {summary}',
    'sidebar.kicker': 'winget upgrade',
    'sidebar.title': '업데이트',
    'summary.wingetCount': 'winget 기준',
    'summary.displayed': '표시됨',
    'summary.selected': '선택됨',
    'summary.pending': '대기',
    'summary.completed': '완료',
    'summary.failed': '실패',
    'summary.unknownVersion': '버전 미확인',
    'summary.lastLoaded': '마지막 조회',
    'options.title': '업데이트 옵션',
    'options.silent': '무인 설치',
    'options.includeUnknown': '버전 미확인 포함',
    'options.includePinned': '고정 항목 포함',
    'options.ignoreHash': '해시 검증 무시',
    'workspace.title': '패키지 업데이트',
    'workspace.subtitle': 'winget 기준 {wingetCount}개 중 {displayedCount}개 표시',
    'actions.cancel': '취소',
    'actions.refresh': '새로고침',
    'actions.updateSelected': '선택 업데이트',
    'actions.retryFailed': '실패 재시도',
    'actions.restartAsAdmin': '관리자 재시작',
    'actions.elevating': '권한 요청 중',
    'actions.clear': '지우기',
    'command.searchPlaceholder': '검색',
    'command.visibleCount': '{visibleCount}/{totalCount} 표시',
    'table.select': '선택',
    'table.app': '앱',
    'table.packageId': '패키지 ID',
    'table.resolvedIdTitle': 'winget 출력의 잘린 ID {originalId}를 전체 ID {id}로 보강했습니다.',
    'table.current': '현재',
    'table.update': '업데이트',
    'table.source': '원본',
    'table.status': '상태',
    'empty.title': '표시할 항목이 없습니다',
    'empty.loading': '목록을 불러오는 중입니다.',
    'empty.suggestion': '검색 조건을 바꾸거나 새로고침하세요.',
    'empty.wingetMissingTitle': 'winget을 찾을 수 없습니다',
    'empty.wingetMissingBody': 'Windows 10/11에서 Microsoft Store의 "앱 설치 관리자(App Installer)"를 설치한 뒤 새로고침하세요.',
    'log.title': '로그'
  },
  en: {
    'app.title': 'Winget GUI',
    'status.running': 'Running',
    'status.success': 'Complete',
    'status.failed': 'Failed',
    'status.idle': 'Waiting',
    'status.needsAttention': 'Check ID',
    'status.failureDetail': 'Failure details',
    'status.idResolutionDetail': 'The package ID was truncated in winget output, and the full ID could not be resolved automatically. Refresh and try again, or confirm it with winget search: {id}',
    'failure.kind.installer': 'Installer error',
    'failure.kind.requires-admin': 'Administrator required',
    'failure.kind.not-found': 'ID error',
    'failure.kind.not-applicable': 'Not applicable',
    'failure.kind.hash': 'Hash error',
    'failure.kind.id-resolution': 'Check ID',
    'failure.kind.generic': 'Update failed',
    'failure.advice.installer': 'The existing app may be running, or the uninstall step may need elevation or interactive confirmation. Close related apps, turn off silent install, or retry as administrator.',
    'failure.advice.requires-admin': 'Removing the existing version requires administrator permission. Restart the app as administrator, then rerun the failed item.',
    'failure.advice.not-found': 'The package ID from the list does not match an installed package. Refresh to resolve the ID before retrying.',
    'failure.advice.not-applicable': 'The source has a newer version, but it does not apply to this system. Check architecture, install scope, and pinning.',
    'failure.advice.hash': 'The downloaded installer hash does not match the winget manifest, usually a temporary upstream lag. Retry later, or if you trust the source enable "Ignore hash check" in options and retry (this skips integrity verification).',
    'failure.advice.id-resolution': 'The package ID was truncated, so the app did not run an unsafe command. Refresh or confirm the source ID.',
    'failure.advice.generic': 'Review the last error in the log and retry only this item.',
    'failure.summary.installer': 'installer {count}',
    'failure.summary.requires-admin': 'admin required {count}',
    'failure.summary.not-found': 'ID {count}',
    'failure.summary.not-applicable': 'not applicable {count}',
    'failure.summary.hash': 'hash {count}',
    'failure.summary.id-resolution': 'ID check {count}',
    'failure.summary.generic': 'other {count}',
    'language.title': 'Display Language',
    'language.system': 'System language',
    'language.ko': '한국어',
    'language.en': 'English',
    'tooltips.silent': 'Installs quietly without prompts when the installer supports it.',
    'tooltips.includeUnknown': 'Includes packages whose current version cannot be detected.',
    'tooltips.includePinned': 'Includes pinned winget packages when winget does not block them.',
    'tooltips.ignoreHash': 'Installs even when the installer hash does not match the manifest (--ignore-security-hash). Skips integrity verification; use only for trusted sources. Enables the global winget setting InstallerHashOverride.',
    'tooltips.restartAsAdmin': 'Restarts Winget GUI as administrator after UAC confirmation.',
    'aria.selectAllVisible': 'Select all visible items',
    'aria.windowControls': 'Window controls',
    'aria.minimize': 'Minimize',
    'aria.restore': 'Restore',
    'aria.maximize': 'Maximize',
    'aria.close': 'Close',
    'aria.updateSummary': 'Update summary',
    'aria.updateOptions': 'Update options',
    'aria.listTools': 'List tools',
    'aria.updateList': 'winget update list',
    'aria.logs': 'Logs',
    'aria.selectPackage': 'Select {name}',
    'native.title': 'Run this as the desktop app',
    'native.body': 'The browser view cannot access winget.',
    'progress.updating': 'Updating selected packages in order',
    'progress.syncing': 'Syncing the winget list',
    'progress.elevating': 'Requesting administrator permission',
    'logs.fetchList': 'Fetching winget upgrade list',
    'logs.listExitCode': 'List command exit code: {code}',
    'logs.noUpdates': 'No updates are available.',
    'logs.wingetMissing': 'The winget executable was not found. Install App Installer.',
    'logs.countMismatch': 'Count check needed: winget {wingetCount}, table {displayedCount}',
    'logs.unknownVersions': '{count} unknown-version packages: enable the option and refresh to include them.',
    'logs.optionsChanged': 'List display options changed. Fetching again.',
    'logs.updateStart': 'Selected update started: {count}',
    'logs.updateComplete': 'Selected update complete',
    'logs.cancelRequested': 'Requested cancellation of the active update',
    'logs.elevationRequested': 'Requested app restart as administrator',
    'logs.elevationFailed': 'Administrator restart failed: {message}',
    'logs.alreadyElevated': 'The app is already running as administrator.',
    'logs.empty': 'No logs yet.',
    'alerts.countMismatch': 'winget reported {wingetCount}, but the table shows {displayedCount}.',
    'alerts.unknownHidden': '{count} unknown-version packages may be hidden.',
    'alerts.failureSummary': '{count} failed: {summary}',
    'sidebar.kicker': 'winget upgrade',
    'sidebar.title': 'Updates',
    'summary.wingetCount': 'winget count',
    'summary.displayed': 'Displayed',
    'summary.selected': 'Selected',
    'summary.pending': 'Waiting',
    'summary.completed': 'Complete',
    'summary.failed': 'Failed',
    'summary.unknownVersion': 'Unknown version',
    'summary.lastLoaded': 'Last checked',
    'options.title': 'Update Options',
    'options.silent': 'Silent install',
    'options.includeUnknown': 'Include unknown versions',
    'options.includePinned': 'Include pinned packages',
    'options.ignoreHash': 'Ignore hash check',
    'workspace.title': 'Package Updates',
    'workspace.subtitle': 'Showing {displayedCount} of {wingetCount} from winget',
    'actions.cancel': 'Cancel',
    'actions.refresh': 'Refresh',
    'actions.updateSelected': 'Update Selected',
    'actions.retryFailed': 'Retry Failed',
    'actions.restartAsAdmin': 'Restart as Admin',
    'actions.elevating': 'Requesting',
    'actions.clear': 'Clear',
    'command.searchPlaceholder': 'Search',
    'command.visibleCount': '{visibleCount}/{totalCount} shown',
    'table.select': 'Select',
    'table.app': 'App',
    'table.packageId': 'Package ID',
    'table.resolvedIdTitle': 'Resolved the truncated winget ID {originalId} to the full ID {id}.',
    'table.current': 'Current',
    'table.update': 'Update',
    'table.source': 'Source',
    'table.status': 'Status',
    'empty.title': 'No items to show',
    'empty.loading': 'Loading the list.',
    'empty.suggestion': 'Change the search or refresh.',
    'empty.wingetMissingTitle': 'winget was not found',
    'empty.wingetMissingBody': 'Install "App Installer" from the Microsoft Store on Windows 10/11, then refresh.',
    'log.title': 'Logs'
  }
};

function supportedLocaleFor(locale) {
  const normalized = String(locale ?? '').trim().toLowerCase().replace('_', '-');
  if (!normalized) {
    return null;
  }

  const primary = normalized.split('-')[0];
  if (supportedLocales.includes(primary)) {
    return primary;
  }

  return null;
}

function normalizedPreference(preference) {
  return languagePreferences.includes(preference) ? preference : defaultLanguagePreference;
}

function interpolate(template, values) {
  if (!values) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match
  );
}

export function normalizeLocale(locale) {
  return supportedLocaleFor(locale) ?? fallbackLocale;
}

export function detectPreferredLocale(source = globalThis.navigator) {
  const languages = Array.isArray(source)
    ? source
    : Array.isArray(source?.languages) && source.languages.length > 0
      ? source.languages
      : [source?.language];

  for (const language of languages) {
    const locale = supportedLocaleFor(language);
    if (locale) {
      return locale;
    }
  }

  return fallbackLocale;
}

export function resolveLocalePreference(preference = defaultLanguagePreference, systemSource) {
  const normalized = normalizedPreference(preference);
  if (normalized !== 'system') {
    return normalized;
  }

  return detectPreferredLocale(systemSource);
}

export function createTranslator(locale) {
  const activeLocale = normalizeLocale(locale);
  const dictionary = dictionaries[activeLocale] ?? dictionaries[fallbackLocale];

  return {
    locale: activeLocale,
    formatLocale: localeFormatTags[activeLocale] ?? localeFormatTags[fallbackLocale],
    t(key, values) {
      const template = dictionary[key] ?? dictionaries[fallbackLocale][key] ?? key;
      return interpolate(template, values);
    }
  };
}

export function formatTimeLabel(date = new Date(), locale = fallbackLocale) {
  const { formatLocale } = createTranslator(locale);

  return new Intl.DateTimeFormat(formatLocale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}
