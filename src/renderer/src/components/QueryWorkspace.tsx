import { useStore } from '../store'
import { IconRun, IconHistory } from '../actionIcons'
import { SqlEditor } from './SqlEditor'
import { DataGrid } from './DataGrid'

/** The query editor workspace: connection picker + Run + editor + result grid. */
export function QueryWorkspace(): JSX.Element {
  const activeTab = useStore((s) => s.getActiveTab())
  const connections = useStore((s) => s.connections)
  const defaults = useStore((s) => s.defaults)
  const connectedIds = useStore((s) => s.connectedIds)
  const setTabConnection = useStore((s) => s.setTabConnection)
  const runActiveTab = useStore((s) => s.runActiveTab)
  const toggleHistory = useStore((s) => s.toggleHistory)
  const historyOpen = useStore((s) => s.historyOpen)

  const allConns = [
    ...connections,
    ...defaults.filter((d) => !connections.some((c) => c.id === d.id))
  ]
  const canRun = !!activeTab?.connectionId && !activeTab?.running

  return (
    <>
      <div className="editor-area">
        <div className="toolbar">
          <button className="icon-text-btn primary" title="Run (Ctrl+Enter)" onClick={() => void runActiveTab()} disabled={!canRun}>
            <IconRun />{activeTab?.running ? 'Running…' : 'Run'}
          </button>
          <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Ctrl/Cmd+Enter</span>
          <span style={{ marginLeft: 8, color: 'var(--text-dim)', fontSize: 11 }}>Connection:</span>
          <select
            style={{ width: 220 }}
            value={activeTab?.connectionId ?? ''}
            onChange={(e) => activeTab && setTabConnection(activeTab.id, e.target.value || null)}
          >
            <option value="">— none —</option>
            {allConns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} [{c.engine}]{connectedIds.includes(c.id) ? ' •' : ''}
              </option>
            ))}
          </select>
          <span className="spacer" />
          <button className={'icon-text-btn ' + (historyOpen ? 'primary' : '')} onClick={toggleHistory}>
            <IconHistory />History
          </button>
        </div>
        <SqlEditor />
      </div>
      <DataGrid />
    </>
  )
}
