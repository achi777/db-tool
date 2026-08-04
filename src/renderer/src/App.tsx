import { useEffect } from 'react'
import { ConnectionManager } from './components/ConnectionManager'
import { ObjectTree } from './components/ObjectTree'
import { SidebarRail } from './components/SidebarRail'
import { EditorTabs } from './components/EditorTabs'
import { QueryWorkspace } from './components/QueryWorkspace'
import { TableDesigner } from './components/TableDesigner'
import { ObjectEditor } from './components/ObjectEditor'
import { ViewBuilder } from './components/ViewBuilder'
import { ErDiagram } from './components/ErDiagram'
import { SequenceEditor } from './components/SequenceEditor'
import { TriggerEditor } from './components/TriggerEditor'
import { IndexEditor } from './components/IndexEditor'
import { HistoryPanel } from './components/HistoryPanel'
import { TreeContextMenu } from './components/TreeContextMenu'
import { ObjectOpDialog } from './components/ObjectOpDialog'
import { ExportDialog } from './components/ExportDialog'
import { ImportWizard } from './components/ImportWizard'
import { DbDumpDialog } from './components/DbDumpDialog'
import { RestoreDialog } from './components/RestoreDialog'
import { TransferWizard } from './components/TransferWizard'
import { ExtensionsDialog } from './components/ExtensionsDialog'
import { AboutButton } from './components/AboutButton'
import { ShortcutsModal } from './components/ShortcutsModal'
import { Sun, Moon, Keyboard } from 'lucide-react'
import { useStore } from './store'
import { useShortcuts } from './useShortcuts'
import { useMenuActions } from './useMenuActions'

export default function App(): JSX.Element {
  const init = useStore((s) => s.init)
  const ready = useStore((s) => s.ready)
  const activeTab = useStore((s) => s.getActiveTab())
  const connections = useStore((s) => s.connections)
  const defaults = useStore((s) => s.defaults)

  useEffect(() => {
    void init()
  }, [init])

  useShortcuts()
  useMenuActions()

  const result = activeTab?.result ?? null
  const statusMessage = activeTab?.statusMessage ?? null
  const activeName =
    [...connections, ...defaults].find((c) => c.id === activeTab?.connectionId)?.name ?? '—'
  const isDesigner = activeTab?.kind === 'designer'
  const isObject = activeTab?.kind === 'object'
  const isViewBuilder = activeTab?.kind === 'viewbuilder'
  const isErDiagram = activeTab?.kind === 'erdiagram'
  const isSequence = activeTab?.kind === 'sequence'
  const isTrigger = activeTab?.kind === 'trigger'
  const isIndex = activeTab?.kind === 'index'
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)

  if (!ready) return <div className="empty">Loading…</div>

  return (
    <div className={'app' + (sidebarCollapsed ? ' collapsed' : '')}>
      {sidebarCollapsed ? (
        <SidebarRail />
      ) : (
        <>
          <ConnectionManager />
          <ObjectTree />
        </>
      )}
      <div className="main">
        <EditorTabs />
        {isDesigner ? (
          <TableDesigner />
        ) : isObject ? (
          <ObjectEditor />
        ) : isViewBuilder ? (
          <ViewBuilder />
        ) : isErDiagram ? (
          <ErDiagram />
        ) : isSequence ? (
          <SequenceEditor />
        ) : isTrigger ? (
          <TriggerEditor />
        ) : isIndex ? (
          <IndexEditor />
        ) : (
          <QueryWorkspace />
        )}
      </div>
      <HistoryPanel />
      <TreeContextMenu />
      <ObjectOpDialog />
      <ExportDialog />
      <ImportWizard />
      <DbDumpDialog />
      <RestoreDialog />
      <TransferWizard />
      <ExtensionsDialog />
      <ShortcutsModal />
      <div className="statusbar">
        <span>Connection: {activeName}</span>
        {!isDesigner && result && result.hasResultSet && (
          <span>
            {result.rowCount} rows · {result.durationMs} ms
          </span>
        )}
        <span className="spacer" />
        <MenuNotice />
        {statusMessage && <span>{statusMessage}</span>}
        <ShortcutsButton />
        <ThemeToggle />
        <AboutButton />
      </div>
    </div>
  )
}

/** Transient status-bar notice posted by native-menu no-ops (TASK 72). */
function MenuNotice(): JSX.Element | null {
  const notice = useStore((s) => s.notice)
  const setNotice = useStore((s) => s.setNotice)
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice, setNotice])
  if (!notice) return null
  return <span className="menu-notice">{notice}</span>
}

/** Status-bar button that opens the keyboard-shortcuts reference (also F1). */
function ShortcutsButton(): JSX.Element {
  const setOpen = useStore((s) => s.setShortcutsOpen)
  return (
    <button className="about-btn" title="Keyboard shortcuts (F1)" aria-label="Keyboard shortcuts" onClick={() => setOpen(true)}>
      <Keyboard size={14} />
    </button>
  )
}

/** Sun/Moon status-bar button to switch between light and dark themes. */
function ThemeToggle(): JSX.Element {
  const theme = useStore((s) => s.theme)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const dark = theme === 'dark'
  return (
    <button
      className="about-btn"
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label="Toggle theme"
      onClick={toggleTheme}
    >
      {dark ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  )
}
