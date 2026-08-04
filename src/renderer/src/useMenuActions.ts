import { useEffect } from 'react'
import { useStore } from './store'
import type { MenuAction } from '@shared/types'

/**
 * Bridges the native application menu (TASK 72) to EXISTING store actions. The
 * menu is purely additive: every action here maps to the same handler an in-app
 * button already invokes. Context-dependent items (import/export/transfer/…)
 * resolve the target from the active tab, falling back to the first connected
 * database; when nothing suitable is open they post a transient status-bar notice
 * rather than doing something surprising.
 */

/** Resolve {connId, schema, table} for a context-dependent menu action. */
function resolveCtx(s: ReturnType<typeof useStore.getState>): {
  connId: string | null
  schema: string | null
  table: string | null
} {
  const at = s.getActiveTab()
  let connId = at?.connectionId ?? null
  if (!connId || !s.connectedIds.includes(connId)) connId = s.connectedIds[0] ?? null

  let schema: string | null = null
  let table: string | null = null
  if (at?.gridTable && at.connectionId === connId) {
    schema = at.gridTable.schema
    table = at.gridTable.table
  }
  if (!schema && connId) schema = s.treeByConn[connId]?.schemas?.[0] ?? null
  return { connId, schema, table }
}

export function useMenuActions(): void {
  useEffect(() => {
    const dispatch = (action: MenuAction): void => {
      const s = useStore.getState()
      switch (action) {
        case 'newConnection':
          s.requestNewConnection()
          break
        case 'newTab':
          s.addTab()
          break
        case 'closeTab':
          if (s.activeTabId) s.closeTab(s.activeTabId)
          break
        case 'runQuery':
          void s.runActiveTab()
          break
        case 'refreshSchema': {
          const { connId } = resolveCtx(s)
          if (connId) void s.refreshTree(connId)
          else s.setNotice('Connect to a database first.')
          break
        }
        case 'toggleSidebar':
          s.toggleSidebar()
          break
        case 'toggleFilterSql':
          s.toggleFilterSql()
          break
        case 'toggleHistory':
          s.toggleHistory()
          break
        case 'themeLight':
          s.setTheme('light')
          break
        case 'themeDark':
          s.setTheme('dark')
          break
        case 'import': {
          const { connId, schema, table } = resolveCtx(s)
          if (connId && schema && table) s.openImport(connId, schema, table)
          else s.setNotice('Open a table (double-click it in the tree) to import into it.')
          break
        }
        case 'export': {
          const { connId, schema, table } = resolveCtx(s)
          if (connId && schema && table) s.openExport(connId, schema, table, false)
          else s.setNotice('Open a table (double-click it in the tree) to export it.')
          break
        }
        case 'dump': {
          const { connId, schema } = resolveCtx(s)
          if (connId && schema) s.openDbDump(connId, schema)
          else s.setNotice('Connect to a database first.')
          break
        }
        case 'restore': {
          const { connId, schema } = resolveCtx(s)
          if (connId && schema) s.openRestore(connId, schema)
          else s.setNotice('Connect to a database first.')
          break
        }
        case 'transfer': {
          const { connId, schema, table } = resolveCtx(s)
          if (connId && schema) s.openTransfer(connId, schema, table ?? undefined)
          else s.setNotice('Connect to a database first.')
          break
        }
        case 'erDiagram': {
          const { connId, schema } = resolveCtx(s)
          if (connId && schema) s.openErDiagram(connId, schema)
          else s.setNotice('Connect to a database first.')
          break
        }
        case 'savedFilters': {
          const at = s.getActiveTab()
          if (at?.gridTable) s.requestSavedFilters()
          else s.setNotice('Open a table to save or apply a named filter.')
          break
        }
        case 'find': {
          // Focus the active editor and open CodeMirror's search panel.
          const cm = document.querySelector('.cm-content') as HTMLElement | null
          if (cm) {
            cm.focus()
            const evt = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true })
            cm.dispatchEvent(evt)
          } else {
            s.setNotice('Open a query tab to search its SQL.')
          }
          break
        }
        case 'shortcuts':
          s.setShortcutsOpen(true)
          break
        case 'about':
          s.setAboutOpen(true)
          break
        default:
          break
      }
    }
    const off = window.dbApi.onMenuAction(dispatch)
    return off
  }, [])
}
