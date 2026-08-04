import { useEffect } from 'react'
import { useStore } from '../store'

function timeAgo(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleString()
}

export function HistoryPanel(): JSX.Element | null {
  const open = useStore((s) => s.historyOpen)
  const history = useStore((s) => s.history)
  const search = useStore((s) => s.historySearch)
  const setSearch = useStore((s) => s.setHistorySearch)
  const loadHistory = useStore((s) => s.loadHistory)
  const loadInto = useStore((s) => s.loadHistoryIntoActive)
  const toggle = useStore((s) => s.toggleHistory)
  const activeTab = useStore((s) => s.getActiveTab())

  // Reload when the active tab's connection changes (history is per-connection).
  useEffect(() => {
    if (open) void loadHistory()
  }, [open, activeTab?.connectionId, loadHistory])

  if (!open) return null

  return (
    <div className="history-drawer">
      <div className="history-header">
        <span>Query history{activeTab?.connectionId ? '' : ' (all connections)'}</span>
        <span className="spacer" />
        <span className="refresh-link" title="Close" onClick={toggle}>
          ×
        </span>
      </div>
      <div className="history-search">
        <input
          placeholder="Search SQL…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="history-list">
        {history.length === 0 ? (
          <div className="empty">No history yet.</div>
        ) : (
          history.map((h) => (
            <div
              key={h.id}
              className="history-item"
              title="Click: load into editor · Double-click: load and run"
              onClick={() => void loadInto(h, false)}
              onDoubleClick={() => void loadInto(h, true)}
            >
              <div className="history-sql">{h.sql}</div>
              <div className="history-meta">
                <span className={'badge ' + h.engine}>{h.engine}</span>
                <span>{h.connectionName}</span>
                <span className={h.ok ? 'ok-dot' : 'err-dot'}>{h.ok ? 'ok' : 'error'}</span>
                {h.ok && <span>{h.rowCount} rows</span>}
                <span>{h.durationMs} ms</span>
                <span className="spacer" />
                <span>{timeAgo(h.ts)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
