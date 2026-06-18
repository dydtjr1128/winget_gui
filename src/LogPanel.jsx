import { useSyncExternalStore } from 'react';
import { Terminal } from 'lucide-react';
import { logStore } from './logStore.mjs';

// Subscribes to the external log store so log updates re-render only this panel,
// not the whole app (and its package table).
export default function LogPanel({ t }) {
  const logs = useSyncExternalStore(logStore.subscribe, logStore.getSnapshot);

  return (
    <section className="log-panel" id="logs" aria-label={t('aria.logs')}>
      <div className="log-header">
        <div>
          <Terminal size={16} />
          <span>{t('log.title')}</span>
        </div>
        <button className="text-button" onClick={() => logStore.clear()}>
          {t('actions.clear')}
        </button>
      </div>
      <pre>{logs.length > 0 ? logs.join('\n') : t('logs.empty')}</pre>
    </section>
  );
}
