// A tiny external log store so the (high-frequency) winget log stream lives
// outside React state. The log panel subscribes via useSyncExternalStore, so a
// new log line re-renders only the log panel — not the whole app and its
// package table, which previously re-rendered on every line during an upgrade.

const defaultMaxLines = 400;

export function createLogStore(max = defaultMaxLines) {
  let lines = [];
  const listeners = new Set();

  function emit() {
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    // `replace` mirrors a terminal carriage-return frame: it overwrites the last
    // line instead of appending (used for winget progress/spinner output).
    addEntry(line, replace = false) {
      const text = String(line ?? '');
      if (!text) {
        return;
      }

      if (replace && lines.length > 0) {
        lines = [...lines.slice(0, -1), text];
      } else {
        lines = [...lines.slice(-(max - 1)), text];
      }
      emit();
    },
    clear() {
      if (lines.length === 0) {
        return;
      }
      lines = [];
      emit();
    },
    getSnapshot() {
      return lines;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export const logStore = createLogStore();
