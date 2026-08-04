import { PanelLeftOpen } from 'lucide-react'
import { useStore } from '../store'
import { IconDatabase, engineColor } from '../treeIcons'

/**
 * The collapsed sidebar: a narrow icon rail. Shows an expand toggle + one icon
 * per connection (engine colour + connected/disconnected dot + name tooltip).
 * Clicking a connection icon EXPANDS the sidebar and focuses that connection
 * (binds it to the active tab, connecting if needed) — the simplest, most
 * predictable behaviour.
 */
export function SidebarRail(): JSX.Element {
  const connections = useStore((s) => s.connections)
  const connectedIds = useStore((s) => s.connectedIds)
  const activeTab = useStore((s) => s.getActiveTab())
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed)
  const useConnectionInActiveTab = useStore((s) => s.useConnectionInActiveTab)
  const activeConn = activeTab?.connectionId ?? null

  const onIcon = (id: string): void => {
    setSidebarCollapsed(false)
    void useConnectionInActiveTab(id)
  }

  return (
    <div className="sidebar-rail">
      <button className="rail-toggle" title="Expand sidebar" onClick={() => setSidebarCollapsed(false)}>
        <PanelLeftOpen size={16} />
      </button>
      <div className="rail-conns">
        {connections.map((c) => {
          const isConnected = connectedIds.includes(c.id)
          const isActive = activeConn === c.id
          return (
            <button
              key={c.id}
              className={'rail-conn' + (isActive ? ' active' : '')}
              title={`${c.name} — ${c.engine}${isConnected ? ' (connected)' : ''}`}
              onClick={() => onIcon(c.id)}
            >
              <span className={'conn-state ' + (isConnected ? 'on' : 'off')} />
              <IconDatabase style={{ color: engineColor(c.engine) }} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
