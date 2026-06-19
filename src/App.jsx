import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  ShieldAlert,
  X
} from 'lucide-react';
import logoUrl from './assets/winget-gui-logo.png';
import {
  createTranslator,
  defaultLanguagePreference,
  formatTimeLabel,
  languagePreferences,
  resolveLocalePreference
} from './i18n.mjs';
import LogPanel from './LogPanel.jsx';
import { logStore } from './logStore.mjs';

const api = window.wingetApi ?? null;
const windowApi = window.windowApi ?? {
  minimize: async () => {},
  toggleMaximize: async () => false,
  close: async () => {},
  isMaximized: async () => false,
  onMaximizedChange: () => () => {}
};
const appApi = window.appApi ?? {
  isElevated: async () => false,
  restartElevated: async () => ({
    ok: false,
    message: 'Administrator elevation is available only in the desktop app.'
  })
};
const hasNativeApi = Boolean(window.wingetApi);
const emptyListMeta = {
  declaredUpgradeCount: null,
  unknownVersionCount: 0,
  parsedCount: 0,
  countMismatch: false,
  wingetMissing: false
};
const languagePreferenceStorageKey = 'winget-gui-language-preference';

function browserLanguageSource() {
  if (typeof navigator === 'undefined') {
    return [];
  }

  return [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language
  ].filter(Boolean);
}

function readStoredLanguagePreference() {
  if (typeof localStorage === 'undefined') {
    return defaultLanguagePreference;
  }

  try {
    const stored = localStorage.getItem(languagePreferenceStorageKey);
    return languagePreferences.includes(stored) ? stored : defaultLanguagePreference;
  } catch {
    return defaultLanguagePreference;
  }
}

function writeStoredLanguagePreference(preference) {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(languagePreferenceStorageKey, preference);
  } catch {
    // Keep the selected language for this session even when persistence is unavailable.
  }
}

function nowLabel(locale) {
  return formatTimeLabel(new Date(), locale);
}

function formatLogLine(line, locale) {
  return `[${nowLabel(locale)}] ${line}`;
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

function statusLabel(status, t) {
  if (status === 'running') return t('status.running');
  if (status === 'success') return t('status.success');
  if (status === 'failed') return t('status.failed');
  return t('status.idle');
}

function isPackageSelectable(item) {
  // A completed (success) upgrade is no longer a valid target — re-running it
  // just makes winget report "no applicable upgrade". It drops off the list on
  // the next refresh anyway. Failed items stay selectable so they can be retried.
  return item.idResolutionStatus !== 'unresolved' && item.status !== 'success';
}

function failureKindFor(item) {
  return item.failureKind || 'generic';
}

function failureKindLabel(kind, t) {
  return t(`failure.kind.${kind || 'generic'}`);
}

function failureAdviceFor(kind, t) {
  return t(`failure.advice.${kind || 'generic'}`);
}

function statusTextFor(item, t) {
  if (item.idResolutionStatus === 'unresolved') {
    return t('status.needsAttention');
  }

  if (item.status === 'failed') {
    return failureKindLabel(failureKindFor(item), t);
  }

  return statusLabel(item.status, t);
}

function statusDetailFor(item, t) {
  if (item.idResolutionStatus === 'unresolved') {
    return t('status.idResolutionDetail', { id: item.id });
  }

  if (item.status !== 'failed') {
    return '';
  }

  const kind = failureKindFor(item);
  const detail = String(item.failureDetail ?? '').trim();
  const advice = failureAdviceFor(kind, t);

  return [failureKindLabel(kind, t), detail, advice].filter(Boolean).join('\n');
}

function statusClassNameFor(item, detail) {
  const classes = ['status-cell'];

  if (detail) {
    classes.push('has-detail');
  }

  if (item.idResolutionStatus === 'unresolved') {
    classes.push('needs-attention', 'failure-id-resolution');
  } else if (item.status === 'failed') {
    classes.push(`failure-${failureKindFor(item)}`);
  }

  return classes.join(' ');
}

function StatusIcon({ status, t }) {
  if (status === 'running') {
    return <Loader2 className="status-icon spin" aria-label={t('status.running')} />;
  }
  if (status === 'success') {
    return <CheckCircle2 className="status-icon success" aria-label={t('status.success')} />;
  }
  if (status === 'failed') {
    return <CircleAlert className="status-icon failed" aria-label={t('status.failed')} />;
  }
  return <span className="status-dot idle" aria-label={t('status.idle')} />;
}

function StatusCell({ item, t }) {
  const label = statusTextFor(item, t);
  const detail = statusDetailFor(item, t);
  const title = detail ? `${t('status.failureDetail')}\n${detail}` : label;

  return (
    <div
      className={statusClassNameFor(item, detail)}
      title={title}
      data-detail={detail || undefined}
      tabIndex={detail ? 0 : undefined}
      aria-label={detail ? `${label}: ${detail}` : label}
    >
      <StatusIcon status={item.status} t={t} />
      <span>{label}</span>
    </div>
  );
}

function SelectAllCheckbox({ checked, indeterminate, disabled, onChange, t }) {
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
        aria-label={t('aria.selectAllVisible')}
      />
      <span>{t('table.select')}</span>
    </label>
  );
}

function WindowControls({ t }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    windowApi.isMaximized().then(setMaximized);
    return windowApi.onMaximizedChange(setMaximized);
  }, []);

  return (
    <div className="window-controls" aria-label={t('aria.windowControls')}>
      <button className="window-button" onClick={() => windowApi.minimize()} aria-label={t('aria.minimize')}>
        <Minus size={15} />
      </button>
      <button
        className="window-button"
        onClick={async () => setMaximized(await windowApi.toggleMaximize())}
        aria-label={maximized ? t('aria.restore') : t('aria.maximize')}
      >
        {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
      <button className="window-button close" onClick={() => windowApi.close()} aria-label={t('aria.close')}>
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

function NativeOnlyScreen({ t }) {
  return (
    <div className="desktop-app">
      <header className="titlebar">
        <div className="titlebar-drag">
          <div className="titlebar-brand">
            <BrandLogo compact />
            <span>Winget GUI</span>
          </div>
        </div>
        <WindowControls t={t} />
      </header>
      <main className="native-only">
        <div className="native-only-panel">
          <div className="native-only-icon">
            <AppWindow size={34} />
          </div>
          <h1>{t('native.title')}</h1>
          <p>{t('native.body')}</p>
          <code>npm start</code>
        </div>
      </main>
    </div>
  );
}

function SortableHeader({ label, sortKey, sort, onSort }) {
  const active = sort.key === sortKey;
  const indicator = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <th
      className="sortable-header"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(sortKey)}
      style={{ cursor: 'pointer', userSelect: 'none' }}
    >
      {label}
      {indicator}
    </th>
  );
}

export default function App() {
  const [languagePreference, setLanguagePreference] = useState(readStoredLanguagePreference);
  const [systemLanguages, setSystemLanguages] = useState(browserLanguageSource);
  const resolvedLocale = useMemo(
    () => resolveLocalePreference(languagePreference, systemLanguages),
    [languagePreference, systemLanguages]
  );
  const translator = useMemo(() => createTranslator(resolvedLocale), [resolvedLocale]);
  const { locale: activeLocale, t } = translator;
  const localeRef = useRef(activeLocale);
  const tRef = useRef(t);
  const lastSelectedId = useRef(null);
  const shortcutsRef = useRef({});
  const [packages, setPackages] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [elevating, setElevating] = useState(false);
  const [isElevated, setIsElevated] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState('');
  const [listMeta, setListMeta] = useState(emptyListMeta);
  const [activeQueueTotal, setActiveQueueTotal] = useState(0);
  const [activeQueueIds, setActiveQueueIds] = useState([]);
  const [options, setOptions] = useState({
    silent: true,
    includeUnknown: false,
    includePinned: false,
    ignoreHash: false
  });
  const [sort, setSort] = useState({ key: null, dir: 'asc' });

  useEffect(() => {
    localeRef.current = activeLocale;
    tRef.current = t;
    if (typeof document !== 'undefined') {
      document.documentElement.lang = activeLocale;
      document.title = t('app.title');
    }
  }, [activeLocale, t]);

  useEffect(() => {
    let cancelled = false;

    window.localeApi?.getSystemLocale?.()
      .then((systemLocale) => {
        if (cancelled) {
          return;
        }

        setSystemLanguages([systemLocale, ...browserLanguageSource()].filter(Boolean));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    appApi.isElevated()
      .then((value) => {
        if (!cancelled) {
          setIsElevated(Boolean(value));
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const optionTooltips = useMemo(
    () => ({
      silent: t('tooltips.silent'),
      includeUnknown: t('tooltips.includeUnknown'),
      includePinned: t('tooltips.includePinned'),
      ignoreHash: t('tooltips.ignoreHash')
    }),
    [t]
  );

  const addLog = useCallback((entry) => {
    const isTerminalEntry = entry && typeof entry === 'object';
    const text = isTerminalEntry ? entry.text : entry;
    const replace = Boolean(isTerminalEntry && entry.replace);
    const cleaned = String(text ?? '').trim();
    if (!cleaned) {
      return;
    }
    logStore.addEntry(formatLogLine(cleaned, localeRef.current), replace);
  }, []);

  useEffect(() => {
    shortcutsRef.current = { refreshList, selectAllVisible };
  });

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'F5') {
        event.preventDefault();
        shortcutsRef.current.refreshList?.();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A')) {
        const tag = event.target?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          event.preventDefault();
          shortcutsRef.current.selectAllVisible?.();
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const visiblePackages = useMemo(
    () => packages.filter((item) => matchesPackage(item, query)),
    [packages, query]
  );

  const selectedPackages = useMemo(
    () => packages.filter((item) => item.selected && isPackageSelectable(item)),
    [packages]
  );
  const selectableVisiblePackages = useMemo(
    () => visiblePackages.filter((item) => isPackageSelectable(item)),
    [visiblePackages]
  );
  const sortedVisiblePackages = useMemo(() => {
    if (!sort.key) {
      return visiblePackages;
    }
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...visiblePackages].sort((a, b) => {
      const left = String(a[sort.key] ?? '');
      const right = String(b[sort.key] ?? '');
      return factor * left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [visiblePackages, sort]);
  const allVisibleSelected =
    selectableVisiblePackages.length > 0 &&
    selectableVisiblePackages.every((item) => item.selected);
  const someVisibleSelected = selectableVisiblePackages.some((item) => item.selected);
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
  const busy = loading || running || elevating;
  const progressActive = loading || running || elevating;
  const progressLabel = elevating
    ? t('progress.elevating')
    : running
      ? t('progress.updating')
      : t('progress.syncing');
  const requiresAdminFailure = packages.some(
    (item) => item.status === 'failed' && failureKindFor(item) === 'requires-admin'
  );
  const countAlert = listMeta.countMismatch
    ? t('alerts.countMismatch', { wingetCount, displayedCount: packages.length })
    : unknownVersionCount > 0 && !options.includeUnknown
      ? t('alerts.unknownHidden', { count: unknownVersionCount })
      : '';
  const failureSummary = useMemo(() => {
    const failedPackages = packages.filter((item) => item.status === 'failed');
    if (failedPackages.length === 0) {
      return '';
    }

    const counts = failedPackages.reduce((accumulator, item) => {
      const kind = failureKindFor(item);
      accumulator[kind] = (accumulator[kind] ?? 0) + 1;
      return accumulator;
    }, {});
    const summary = Object.entries(counts)
      .map(([kind, count]) => t(`failure.summary.${kind}`, { count }))
      .join(', ');

    return t('alerts.failureSummary', { count: failedPackages.length, summary });
  }, [packages, t]);

  useEffect(() => {
    if (!api) {
      return undefined;
    }

    const unsubscribe = [
      api.onLog(addLog),
      api.onPackageStart((item) => {
        setPackages((current) =>
          current.map((pkg) =>
            pkg.id === item.id
              ? { ...pkg, status: 'running', failureKind: '', failureDetail: '' }
              : pkg
          )
        );
      }),
      api.onPackageComplete((result) => {
        setPackages((current) =>
          current.map((pkg) =>
            pkg.id === result.id
              ? {
                  ...pkg,
                  selected: false,
                  status: result.ok ? 'success' : 'failed',
                  failureKind: result.ok ? '' : result.failureKind || 'generic',
                  failureDetail: result.ok ? '' : String(result.failureDetail ?? '').trim()
                }
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
    addLog(tRef.current('logs.fetchList'));
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
          status: 'idle',
          failureKind: '',
          failureDetail: ''
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
        countMismatch: Boolean(result.countMismatch),
        wingetMissing: Boolean(result.wingetMissing)
      });
      setLastLoadedAt(nowLabel(localeRef.current));
      if (result.wingetMissing) {
        addLog(tRef.current('logs.wingetMissing'));
      } else if (!result.ok) {
        addLog(tRef.current('logs.listExitCode', { code: result.code }));
      }
      if (!result.wingetMissing && nextPackages.length === 0) {
        addLog(tRef.current('logs.noUpdates'));
      }
      if (result.countMismatch) {
        addLog(
          tRef.current('logs.countMismatch', {
            wingetCount: result.declaredUpgradeCount,
            displayedCount: nextPackages.length
          })
        );
      }
      if (result.unknownVersionCount > 0 && !options.includeUnknown) {
        addLog(tRef.current('logs.unknownVersions', { count: result.unknownVersionCount }));
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
      current.map((item) =>
        item.id === id && isPackageSelectable(item)
          ? { ...item, selected: !item.selected }
          : item
      )
    );
  }

  // Selects every selectable row shown between the anchor (previous click) and
  // the shift-clicked target, inclusive — the usual file-list range behavior.
  function selectRange(anchorId, targetId) {
    const anchorIndex = sortedVisiblePackages.findIndex((item) => item.id === anchorId);
    const targetIndex = sortedVisiblePackages.findIndex((item) => item.id === targetId);

    if (anchorIndex === -1 || targetIndex === -1) {
      toggleSelected(targetId);
      return;
    }

    const [start, end] =
      anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    const rangeIds = new Set(
      sortedVisiblePackages
        .slice(start, end + 1)
        .filter(isPackageSelectable)
        .map((item) => item.id)
    );

    setPackages((current) =>
      current.map((item) => (rangeIds.has(item.id) ? { ...item, selected: true } : item))
    );
  }

  function handleRowClick(event, id) {
    if (busy) {
      return;
    }

    if (event.shiftKey && lastSelectedId.current && lastSelectedId.current !== id) {
      // Shift-click selects from the anchor (the last plain click) to here, and
      // leaves the anchor fixed — so repeated shift-clicks keep extending the
      // range from that same point, like a file list.
      window.getSelection?.()?.removeAllRanges();
      selectRange(lastSelectedId.current, id);
      return;
    }

    // A plain click toggles this row and becomes the new anchor.
    toggleSelected(id);
    lastSelectedId.current = id;
  }

  function toggleVisibleSelection() {
    if (busy) {
      return;
    }
    const visibleIds = new Set(selectableVisiblePackages.map((item) => item.id));
    setPackages((current) =>
      current.map((item) =>
        visibleIds.has(item.id) ? { ...item, selected: !allVisibleSelected } : item
      )
    );
  }

  function selectAllVisible() {
    if (busy) {
      return;
    }
    const visibleIds = new Set(selectableVisiblePackages.map((item) => item.id));
    setPackages((current) =>
      current.map((item) => (visibleIds.has(item.id) ? { ...item, selected: true } : item))
    );
  }

  function toggleSort(key) {
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' }
    );
  }

  function updateLanguagePreference(nextPreference) {
    if (!languagePreferences.includes(nextPreference)) {
      return;
    }

    setLanguagePreference(nextPreference);
    writeStoredLanguagePreference(nextPreference);
  }

  function updateOption(key) {
    if (busy) {
      return;
    }

    setOptions((current) => ({ ...current, [key]: !current[key] }));
    if (key === 'includeUnknown' || key === 'includePinned') {
      addLog(tRef.current('logs.optionsChanged'));
    }
  }

  async function runUpdates(ids) {
    if (ids.length === 0 || busy || !api) {
      return;
    }

    const idSet = new Set(ids);
    setRunning(true);
    setActiveQueueTotal(ids.length);
    setActiveQueueIds(ids);
    setPackages((current) =>
      current.map((item) =>
        idSet.has(item.id) ? { ...item, status: 'idle', failureKind: '', failureDetail: '' } : item
      )
    );
    addLog(tRef.current('logs.updateStart', { count: ids.length }));

    try {
      await api.upgradeSelected(ids, options);
      addLog(tRef.current('logs.updateComplete'));
    } catch (error) {
      addLog(error.message);
    } finally {
      setRunning(false);
      setActiveQueueTotal(0);
      setActiveQueueIds([]);
    }
  }

  function runSelectedUpdates() {
    runUpdates(selectedPackages.map((item) => item.id));
  }

  function retryFailed() {
    runUpdates(
      packages
        .filter((item) => item.status === 'failed' && isPackageSelectable(item))
        .map((item) => item.id)
    );
  }

  async function cancelUpdates() {
    await api.cancelUpgrade();
    addLog(tRef.current('logs.cancelRequested'));
    setRunning(false);
    setActiveQueueTotal(0);
    setActiveQueueIds([]);
  }

  async function restartAsAdmin() {
    if (busy || isElevated) {
      return;
    }

    setElevating(true);
    addLog(tRef.current('logs.elevationRequested'));

    try {
      const result = await appApi.restartElevated();

      if (result?.alreadyElevated) {
        setIsElevated(true);
        setElevating(false);
        addLog(tRef.current('logs.alreadyElevated'));
        return;
      }

      if (!result?.ok) {
        const message = result?.message || result?.code || 'unknown';
        addLog(tRef.current('logs.elevationFailed', { message }));
        setElevating(false);
      }
    } catch (error) {
      addLog(tRef.current('logs.elevationFailed', { message: error.message }));
      setElevating(false);
    }
  }

  if (!hasNativeApi) {
    return <NativeOnlyScreen t={t} />;
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
        <WindowControls t={t} />
      </header>

      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-header">
            <BrandLogo />
            <span className="sidebar-kicker">{t('sidebar.kicker')}</span>
            <h1>{t('sidebar.title')}</h1>
          </div>

          <section className="summary-panel" aria-label={t('aria.updateSummary')}>
            <div className="summary-row primary">
              <span>{t('summary.wingetCount')}</span>
              <strong>{wingetCount}</strong>
            </div>
            <div className="summary-row">
              <span>{t('summary.displayed')}</span>
              <strong>{packages.length}</strong>
            </div>
            <div className="summary-row">
              <span>{t('summary.selected')}</span>
              <strong>{selectedPackages.length}</strong>
            </div>
            <div className="summary-row">
              <span>{t('summary.pending')}</span>
              <strong>{pendingCount}</strong>
            </div>
            <div className="summary-row">
              <span>{t('summary.completed')}</span>
              <strong>{finishedCount}</strong>
            </div>
            <div className="summary-row">
              <span>{t('summary.failed')}</span>
              <strong>{failedCount}</strong>
            </div>
            {unknownVersionCount > 0 ? (
              <div className="summary-row subtle">
                <span>{t('summary.unknownVersion')}</span>
                <strong>{unknownVersionCount}</strong>
              </div>
            ) : null}
          </section>

          <section className="option-panel" id="options" aria-label={t('aria.updateOptions')}>
            <div className="panel-title">
              <Settings2 size={16} />
              <span>{t('options.title')}</span>
            </div>
            <label className="language-control">
              <span>{t('language.title')}</span>
              <select
                value={languagePreference}
                onChange={(event) => updateLanguagePreference(event.target.value)}
              >
                {languagePreferences.map((preference) => (
                  <option key={preference} value={preference}>
                    {t(`language.${preference}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="check-option" data-tooltip={optionTooltips.silent}>
              <input
                type="checkbox"
                checked={options.silent}
                onChange={() => updateOption('silent')}
                disabled={busy}
              />
              <span>{t('options.silent')} <em>(--silent)</em></span>
            </label>
            <label className="check-option" data-tooltip={optionTooltips.includeUnknown}>
              <input
                type="checkbox"
                checked={options.includeUnknown}
                onChange={() => updateOption('includeUnknown')}
                disabled={busy}
              />
              <span>{t('options.includeUnknown')} <em>(--include-unknown)</em></span>
            </label>
            <label className="check-option" data-tooltip={optionTooltips.includePinned}>
              <input
                type="checkbox"
                checked={options.includePinned}
                onChange={() => updateOption('includePinned')}
                disabled={busy}
              />
              <span>{t('options.includePinned')} <em>(--include-pinned)</em></span>
            </label>
            <label className="check-option" data-tooltip={optionTooltips.ignoreHash}>
              <input
                type="checkbox"
                checked={options.ignoreHash}
                onChange={() => updateOption('ignoreHash')}
                disabled={busy}
              />
              <span>{t('options.ignoreHash')} <em>(--ignore-security-hash)</em></span>
            </label>
          </section>

          <div className="sidebar-footer">
            <span>{t('summary.lastLoaded')}</span>
            <strong>{lastLoadedAt || '-'}</strong>
          </div>
        </aside>

        <main className="workspace">
          <section className="workspace-header" id="updates">
            <div>
              <div className="heading-row">
                <h2>{t('workspace.title')}</h2>
                {countAlert && !progressActive ? (
                  <div className="count-alert" role="status">
                    <CircleAlert size={15} />
                    <span>{countAlert}</span>
                  </div>
                ) : null}
                {failureSummary && !progressActive ? (
                  <div className="failure-alert" role="status">
                    <CircleAlert size={15} />
                    <span>{failureSummary}</span>
                  </div>
                ) : null}
              </div>
              <p>
                {t('workspace.subtitle', { wingetCount, displayedCount: packages.length })}
              </p>
            </div>
            <div className="header-actions">
              {running || loading ? (
                <button className="button danger" onClick={cancelUpdates}>
                  <X size={17} />
                  {t('actions.cancel')}
                </button>
              ) : null}
              <button className="button secondary" onClick={refreshList} disabled={busy}>
                <RefreshCw size={17} className={loading ? 'spin' : ''} />
                {t('actions.refresh')}
              </button>
              {!isElevated ? (
                <button
                  className={requiresAdminFailure ? 'button warning' : 'button secondary'}
                  onClick={restartAsAdmin}
                  disabled={busy}
                  title={t('tooltips.restartAsAdmin')}
                >
                  <ShieldAlert size={17} />
                  {elevating ? t('actions.elevating') : t('actions.restartAsAdmin')}
                </button>
              ) : null}
              {failedCount > 0 && !busy ? (
                <button className="button secondary" onClick={retryFailed}>
                  <RefreshCw size={17} />
                  {t('actions.retryFailed')} ({failedCount})
                </button>
              ) : null}
              <button
                className="button primary"
                onClick={runSelectedUpdates}
                disabled={selectedPackages.length === 0 || busy}
              >
                <Download size={17} />
                {t('actions.updateSelected')}
                {selectedPackages.length > 0 ? ` (${selectedPackages.length})` : ''}
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

          <section className="command-strip" aria-label={t('aria.listTools')}>
            <div className="search-field">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('command.searchPlaceholder')}
                disabled={busy}
              />
            </div>
            <div className="list-count">
              <LayoutList size={17} />
              <span>
                {t('command.visibleCount', {
                  visibleCount: visiblePackages.length,
                  totalCount: packages.length
                })}
              </span>
            </div>
          </section>

          <section className="table-region" aria-label={t('aria.updateList')}>
            <table>
              <thead>
                <tr>
                  <th className="select-column">
                    <SelectAllCheckbox
                      checked={allVisibleSelected}
                      indeterminate={someVisibleSelected && !allVisibleSelected}
                      disabled={selectableVisiblePackages.length === 0 || busy}
                      onChange={toggleVisibleSelection}
                      t={t}
                    />
                  </th>
                  <SortableHeader label={t('table.app')} sortKey="name" sort={sort} onSort={toggleSort} />
                  <SortableHeader label={t('table.packageId')} sortKey="id" sort={sort} onSort={toggleSort} />
                  <SortableHeader label={t('table.current')} sortKey="installedVersion" sort={sort} onSort={toggleSort} />
                  <SortableHeader label={t('table.update')} sortKey="availableVersion" sort={sort} onSort={toggleSort} />
                  <SortableHeader label={t('table.source')} sortKey="source" sort={sort} onSort={toggleSort} />
                  <th>{t('table.status')}</th>
                </tr>
              </thead>
              <tbody>
                {sortedVisiblePackages.map((item) => (
                  <tr
                    key={item.id}
                    className={[
                      item.selected ? 'selected-row' : '',
                      item.idResolutionStatus === 'unresolved' ? 'blocked-row' : '',
                      item.status === 'success' ? 'row-success' : '',
                      item.status === 'failed' ? 'row-failed' : ''
                    ].filter(Boolean).join(' ')}
                    onClick={(event) => handleRowClick(event, item.id)}
                  >
                    <td className="select-column">
                      <input
                        type="checkbox"
                        checked={item.selected}
                        readOnly
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRowClick(event, item.id);
                        }}
                        disabled={busy || !isPackageSelectable(item)}
                        aria-label={t('aria.selectPackage', { name: item.name })}
                      />
                    </td>
                    <td>
                      <div className="package-cell">
                        <span className="package-avatar">{packageInitial(item.name)}</span>
                        <span className="app-name" title={item.name}>{item.name}</span>
                      </div>
                    </td>
                    <td
                      className="mono id-cell"
                      title={
                        item.resolvedFromId
                          ? t('table.resolvedIdTitle', { originalId: item.resolvedFromId, id: item.id })
                          : item.id
                      }
                    >
                      {item.id}
                    </td>
                    <td className="mono muted">{item.installedVersion}</td>
                    <td className="mono available">{item.availableVersion}</td>
                    <td className="muted">{item.source || '-'}</td>
                    <td className="status-column">
                      <StatusCell item={item} t={t} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {visiblePackages.length === 0 ? (
              <div className="empty-state">
                {listMeta.wingetMissing ? (
                  <>
                    <CircleAlert size={30} />
                    <strong>{t('empty.wingetMissingTitle')}</strong>
                    <span>{t('empty.wingetMissingBody')}</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={30} />
                    <strong>{t('empty.title')}</strong>
                    <span>{loading ? t('empty.loading') : t('empty.suggestion')}</span>
                  </>
                )}
              </div>
            ) : null}
          </section>

          <LogPanel t={t} />
        </main>
      </div>
    </div>
  );
}
