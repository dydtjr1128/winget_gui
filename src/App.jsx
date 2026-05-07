import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppWindow,
  CheckCircle2,
  CircleAlert,
  Download,
  LayoutList,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  RefreshCw,
  Search,
  Settings2,
  Terminal,
  X
} from 'lucide-react';
import logoUrl from './assets/winget-gui-logo.png';

const api = window.wingetApi ?? null;
const windowApi = window.windowApi ?? {
  minimize: async () => {},
  toggleMaximize: async () => false,
  close: async () => {},
  isMaximized: async () => false,
  onMaximizedChange: () => () => {}
};
const hasNativeApi = Boolean(window.wingetApi);
const emptyListMeta = {
  declaredUpgradeCount: null,
  unknownVersionCount: 0,
  parsedCount: 0,
  countMismatch: false
};

function nowLabel() {
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date());
}

function formatLogLine(line) {
  return `[${nowLabel()}] ${line}`;
}

function matchesPackage(item, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  return [item.name, item.id, item.installedVersion, item.availableVersion, item.source]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

function packageInitial(name) {
  return String(name || '?').trim().slice(0, 1).toUpperCase();
}

function statusLabel(status) {
  if (status === 'running') return '진행 중';
  if (status === 'success') return '완료';
  if (status === 'failed') return '실패';
  return '대기';
}

const optionTooltips = {
  silent: '설치 프로그램이 지원하면 확인 창 없이 조용히 설치합니다.',
  includeUnknown: '현재 버전을 알 수 없는 패키지도 목록과 업데이트 대상에 포함합니다.',
  includePinned: 'winget에서 고정된 항목도 차단되지 않는 경우 목록에 포함합니다.',
  allowReboot: '패키지가 요구하면 업데이트 중 재부팅을 허용합니다.'
};

function StatusIcon({ status }) {
  if (status === 'running') {
    return <Loader2 className="status-icon spin" aria-label="진행 중" />;
  }
  if (status === 'success') {
    return <CheckCircle2 className="status-icon success" aria-label="완료" />;
  }
  if (status === 'failed') {
    return <CircleAlert className="status-icon failed" aria-label="실패" />;
  }
  return <span className="status-dot idle" aria-label="대기" />;
}

function SelectAllCheckbox({ checked, indeterminate, disabled, onChange }) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <label className="select-all-header">
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-label="표시된 항목 모두 선택"
      />
      <span>선택</span>
    </label>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    windowApi.isMaximized().then(setMaximized);
    return windowApi.onMaximizedChange(setMaximized);
  }, []);

  return (
    <div className="window-controls" aria-label="창 제어">
      <button className="window-button" onClick={() => windowApi.minimize()} aria-label="최소화">
        <Minus size={15} />
      </button>
      <button
        className="window-button"
        onClick={async () => setMaximized(await windowApi.toggleMaximize())}
        aria-label={maximized ? '이전 크기로' : '최대화'}
      >
        {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
      <button className="window-button close" onClick={() => windowApi.close()} aria-label="닫기">
        <X size={16} />
      </button>
    </div>
  );
}

function BrandLogo({ compact = false }) {
  return (
    <img
      className={compact ? 'brand-logo compact' : 'brand-logo'}
      src={logoUrl}
      alt=""
      aria-hidden="true"
    />
  );
}

function ProgressBanner({ active, label, progress }) {
  if (!active) {
    return null;
  }

  const isDeterminate = typeof progress === 'number';

  return (
    <div className="progress-banner" role="status" aria-live="polite">
      <div className="progress-copy">
        <span>{label}</span>
        {isDeterminate ? <strong>{Math.min(progress, 100)}%</strong> : null}
      </div>
      <div className={isDeterminate ? 'progress-track determinate' : 'progress-track'}>
        <span style={isDeterminate ? { width: `${Math.min(progress, 100)}%` } : undefined} />
      </div>
    </div>
  );
}

function NativeOnlyScreen() {
  return (
    <div className="desktop-app">
      <header className="titlebar">
        <div className="titlebar-drag">
          <div className="titlebar-brand">
            <BrandLogo compact />
            <span>Winget GUI</span>
          </div>
        </div>
        <WindowControls />
      </header>
      <main className="native-only">
        <div className="native-only-panel">
          <div className="native-only-icon">
            <AppWindow size={34} />
          </div>
          <h1>PC용 앱으로 실행하세요</h1>
          <p>브라우저 화면에서는 winget에 접근하지 않습니다.</p>
          <code>npm start</code>
        </div>
      </main>
    </div>
  );
}

export default function App() {
  const [packages, setPackages] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [lastLoadedAt, setLastLoadedAt] = useState('');
  const [listMeta, setListMeta] = useState(emptyListMeta);
  const [activeQueueTotal, setActiveQueueTotal] = useState(0);
  const [activeQueueIds, setActiveQueueIds] = useState([]);
  const [options, setOptions] = useState({
    silent: true,
    includeUnknown: false,
    includePinned: false,
    allowReboot: false
  });

  const addLog = (line) => {
    const cleaned = String(line ?? '').trim();
    if (!cleaned) {
      return;
    }
    setLogs((current) => [...current.slice(-399), formatLogLine(cleaned)]);
  };

  const visiblePackages = useMemo(
    () => packages.filter((item) => matchesPackage(item, query)),
    [packages, query]
  );

  const selectedPackages = useMemo(() => packages.filter((item) => item.selected), [packages]);
  const allVisibleSelected =
    visiblePackages.length > 0 && visiblePackages.every((item) => item.selected);
  const someVisibleSelected = visiblePackages.some((item) => item.selected);
  const finishedCount = packages.filter((item) => item.status === 'success').length;
  const failedCount = packages.filter((item) => item.status === 'failed').length;
  const pendingCount = Math.max(packages.length - finishedCount - failedCount, 0);
  const wingetCount = listMeta.declaredUpgradeCount ?? packages.length;
  const unknownVersionCount = listMeta.unknownVersionCount ?? 0;
  const activeQueueIdSet = useMemo(() => new Set(activeQueueIds), [activeQueueIds]);
  const activeQueueCompleted = packages.filter(
    (item) =>
      activeQueueIdSet.has(item.id) && (item.status === 'success' || item.status === 'failed')
  ).length;
  const queueProgress =
    activeQueueTotal > 0 ? Math.round((activeQueueCompleted / activeQueueTotal) * 100) : null;
  const busy = loading || running;
  const progressActive = loading || running;
  const progressLabel = running ? '선택한 패키지를 순차 업데이트하는 중' : 'winget 목록을 동기화하는 중';
  const countAlert = listMeta.countMismatch
    ? `winget은 ${wingetCount}개라고 보고했지만 표에는 ${packages.length}개가 표시됐습니다.`
    : unknownVersionCount > 0 && !options.includeUnknown
      ? `버전 미확인 ${unknownVersionCount}개는 숨겨질 수 있습니다.`
      : '';

  useEffect(() => {
    if (!api) {
      return undefined;
    }

    const unsubscribe = [
      api.onLog(addLog),
      api.onPackageStart((item) => {
        setPackages((current) =>
          current.map((pkg) => (pkg.id === item.id ? { ...pkg, status: 'running' } : pkg))
        );
      }),
      api.onPackageComplete((result) => {
        setPackages((current) =>
          current.map((pkg) =>
            pkg.id === result.id
              ? { ...pkg, selected: false, status: result.ok ? 'success' : 'failed' }
              : pkg
          )
        );
      }),
      api.onQueueComplete(() => {
        setRunning(false);
        setActiveQueueTotal(0);
        setActiveQueueIds([]);
      })
    ];

    refreshList();

    return () => unsubscribe.forEach((dispose) => dispose());
  }, []);

  useEffect(() => {
    if (!api || !lastLoadedAt || busy) {
      return;
    }

    refreshList();
  }, [options.includeUnknown, options.includePinned]);

  async function refreshList() {
    if (busy || !api) {
      return;
    }

    setLoading(true);
    addLog('winget upgrade 목록 조회');
    try {
      const result = await api.listUpgrades({
        includeUnknown: options.includeUnknown,
        includePinned: options.includePinned
      });
      const nextPackages = Array.isArray(result.packages) ? result.packages : [];
      setPackages(
        nextPackages.map((item) => ({
          ...item,
          selected: false,
          status: 'idle'
        }))
      );
      setActiveQueueTotal(0);
      setActiveQueueIds([]);
      setListMeta({
        declaredUpgradeCount:
          typeof result.declaredUpgradeCount === 'number' ? result.declaredUpgradeCount : null,
        unknownVersionCount:
          typeof result.unknownVersionCount === 'number' ? result.unknownVersionCount : 0,
        parsedCount: typeof result.parsedCount === 'number' ? result.parsedCount : nextPackages.length,
        countMismatch: Boolean(result.countMismatch)
      });
      setLastLoadedAt(nowLabel());
      if (!result.ok) {
        addLog(`목록 조회 종료 코드: ${result.code}`);
      }
      if (nextPackages.length === 0) {
        addLog('업데이트 가능한 항목이 없습니다.');
      }
      if (result.countMismatch) {
        addLog(
          `개수 확인 필요: winget ${result.declaredUpgradeCount}개, 표 표시 ${nextPackages.length}개`
        );
      }
      if (result.unknownVersionCount > 0 && !options.includeUnknown) {
        addLog(`버전 미확인 ${result.unknownVersionCount}개: 옵션을 켜고 새로고침하면 포함됩니다.`);
      }
    } catch (error) {
      addLog(error.message);
      setListMeta(emptyListMeta);
    } finally {
      setLoading(false);
    }
  }

  function toggleSelected(id) {
    if (busy) {
      return;
    }
    setPackages((current) =>
      current.map((item) => (item.id === id ? { ...item, selected: !item.selected } : item))
    );
  }

  function toggleVisibleSelection() {
    if (busy) {
      return;
    }
    const visibleIds = new Set(visiblePackages.map((item) => item.id));
    setPackages((current) =>
      current.map((item) =>
        visibleIds.has(item.id) ? { ...item, selected: !allVisibleSelected } : item
      )
    );
  }

  function updateOption(key) {
    if (busy) {
      return;
    }

    setOptions((current) => ({ ...current, [key]: !current[key] }));
    if (key === 'includeUnknown' || key === 'includePinned') {
      addLog('목록 표시 옵션이 바뀌었습니다. 다시 조회합니다.');
    }
  }

  async function runSelectedUpdates() {
    if (selectedPackages.length === 0 || busy) {
      return;
    }

    setRunning(true);
    setActiveQueueTotal(selectedPackages.length);
    setActiveQueueIds(selectedPackages.map((item) => item.id));
    setPackages((current) =>
      current.map((item) => (item.selected ? { ...item, status: 'idle' } : item))
    );
    addLog(`선택 업데이트 시작: ${selectedPackages.length}개`);

    try {
      await api.upgradeSelected(
        selectedPackages.map((item) => item.id),
        options
      );
      addLog('선택 업데이트 완료');
      setRunning(false);
      setActiveQueueTotal(0);
      setActiveQueueIds([]);
    } catch (error) {
      addLog(error.message);
      setRunning(false);
      setActiveQueueTotal(0);
      setActiveQueueIds([]);
    }
  }

  async function cancelUpdates() {
    await api.cancelUpgrade();
    addLog('진행 중인 업데이트 취소 요청');
    setRunning(false);
    setActiveQueueTotal(0);
    setActiveQueueIds([]);
  }

  if (!hasNativeApi) {
    return <NativeOnlyScreen />;
  }

  return (
    <div className="desktop-app">
      <header className="titlebar">
        <div className="titlebar-drag">
          <div className="titlebar-brand">
            <BrandLogo compact />
            <span>Winget GUI</span>
          </div>
        </div>
        <WindowControls />
      </header>

      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-header">
            <BrandLogo />
            <span className="sidebar-kicker">winget upgrade</span>
            <h1>업데이트</h1>
          </div>

          <section className="summary-panel" aria-label="업데이트 요약">
            <div className="summary-row primary">
              <span>winget 기준</span>
              <strong>{wingetCount}</strong>
            </div>
            <div className="summary-row">
              <span>표시됨</span>
              <strong>{packages.length}</strong>
            </div>
            <div className="summary-row">
              <span>선택됨</span>
              <strong>{selectedPackages.length}</strong>
            </div>
            <div className="summary-row">
              <span>대기</span>
              <strong>{pendingCount}</strong>
            </div>
            <div className="summary-row">
              <span>완료</span>
              <strong>{finishedCount}</strong>
            </div>
            <div className="summary-row">
              <span>실패</span>
              <strong>{failedCount}</strong>
            </div>
            {unknownVersionCount > 0 ? (
              <div className="summary-row subtle">
                <span>버전 미확인</span>
                <strong>{unknownVersionCount}</strong>
              </div>
            ) : null}
          </section>

          <section className="option-panel" id="options" aria-label="업데이트 옵션">
            <div className="panel-title">
              <Settings2 size={16} />
              <span>업데이트 옵션</span>
            </div>
            <label className="check-option" data-tooltip={optionTooltips.silent}>
              <input
                type="checkbox"
                checked={options.silent}
                onChange={() => updateOption('silent')}
                disabled={busy}
              />
              <span>무인 설치 <em>(--silent)</em></span>
            </label>
            <label className="check-option" data-tooltip={optionTooltips.includeUnknown}>
              <input
                type="checkbox"
                checked={options.includeUnknown}
                onChange={() => updateOption('includeUnknown')}
                disabled={busy}
              />
              <span>버전 미확인 포함 <em>(--include-unknown)</em></span>
            </label>
            <label className="check-option" data-tooltip={optionTooltips.includePinned}>
              <input
                type="checkbox"
                checked={options.includePinned}
                onChange={() => updateOption('includePinned')}
                disabled={busy}
              />
              <span>고정 항목 포함 <em>(--include-pinned)</em></span>
            </label>
            <label className="check-option" data-tooltip={optionTooltips.allowReboot}>
              <input
                type="checkbox"
                checked={options.allowReboot}
                onChange={() => updateOption('allowReboot')}
                disabled={busy}
              />
              <span>재부팅 허용 <em>(--allow-reboot)</em></span>
            </label>
          </section>

          <div className="sidebar-footer">
            <span>마지막 조회</span>
            <strong>{lastLoadedAt || '-'}</strong>
          </div>
        </aside>

        <main className="workspace">
          <section className="workspace-header" id="updates">
            <div>
              <div className="heading-row">
                <h2>패키지 업데이트</h2>
                {countAlert && !progressActive ? (
                  <div className="count-alert" role="status">
                    <CircleAlert size={15} />
                    <span>{countAlert}</span>
                  </div>
                ) : null}
              </div>
              <p>
                winget 기준 {wingetCount}개 중 {packages.length}개 표시
              </p>
            </div>
            <div className="header-actions">
              {running ? (
                <button className="button danger" onClick={cancelUpdates}>
                  <X size={17} />
                  취소
                </button>
              ) : null}
              <button className="button secondary" onClick={refreshList} disabled={busy}>
                <RefreshCw size={17} className={loading ? 'spin' : ''} />
                새로고침
              </button>
              <button
                className="button primary"
                onClick={runSelectedUpdates}
                disabled={selectedPackages.length === 0 || busy}
              >
                <Download size={17} />
                선택 업데이트
              </button>
            </div>
          </section>

          <div className="floating-progress">
            <ProgressBanner
              active={progressActive}
              label={progressLabel}
              progress={running ? queueProgress : null}
            />
          </div>

          <section className="command-strip" aria-label="목록 도구">
            <div className="search-field">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="검색"
                disabled={busy}
              />
            </div>
            <div className="list-count">
              <LayoutList size={17} />
              <span>
                {visiblePackages.length}/{packages.length} 표시
              </span>
            </div>
          </section>

          <section className="table-region" aria-label="winget 업데이트 목록">
            <table>
              <thead>
                <tr>
                  <th className="select-column">
                    <SelectAllCheckbox
                      checked={allVisibleSelected}
                      indeterminate={someVisibleSelected && !allVisibleSelected}
                      disabled={visiblePackages.length === 0 || busy}
                      onChange={toggleVisibleSelection}
                    />
                  </th>
                  <th>앱</th>
                  <th>패키지 ID</th>
                  <th>현재</th>
                  <th>업데이트</th>
                  <th>원본</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {visiblePackages.map((item) => (
                  <tr
                    key={item.id}
                    className={item.selected ? 'selected-row' : ''}
                    onClick={() => toggleSelected(item.id)}
                  >
                    <td className="select-column">
                      <input
                        type="checkbox"
                        checked={item.selected}
                        onChange={() => toggleSelected(item.id)}
                        onClick={(event) => event.stopPropagation()}
                        disabled={busy}
                        aria-label={`${item.name} 선택`}
                      />
                    </td>
                    <td>
                      <div className="package-cell">
                        <span className="package-avatar">{packageInitial(item.name)}</span>
                        <span className="app-name">{item.name}</span>
                      </div>
                    </td>
                    <td className="mono id-cell">{item.id}</td>
                    <td className="mono muted">{item.installedVersion}</td>
                    <td className="mono available">{item.availableVersion}</td>
                    <td className="muted">{item.source || '-'}</td>
                    <td>
                      <div className="status-cell">
                        <StatusIcon status={item.status} />
                        <span>{statusLabel(item.status)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {visiblePackages.length === 0 ? (
              <div className="empty-state">
                <CheckCircle2 size={30} />
                <strong>표시할 항목이 없습니다</strong>
                <span>{loading ? '목록을 불러오는 중입니다.' : '검색 조건을 바꾸거나 새로고침하세요.'}</span>
              </div>
            ) : null}
          </section>

          <section className="log-panel" id="logs" aria-label="로그">
            <div className="log-header">
              <div>
                <Terminal size={16} />
                <span>로그</span>
              </div>
              <button className="text-button" onClick={() => setLogs([])}>
                지우기
              </button>
            </div>
            <pre>{logs.length > 0 ? logs.join('\n') : '아직 로그가 없습니다.'}</pre>
          </section>
        </main>
      </div>
    </div>
  );
}
