import { useCallback, useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { useStore } from '../store'
import { buildSqlExtension } from '../sqlAutocomplete'

/** The CodeMirror editor bound to the active tab, with schema-aware completion. */
export function SqlEditor(): JSX.Element {
  const activeTab = useStore((s) => s.getActiveTab())
  const setTabSql = useStore((s) => s.setTabSql)
  const runActiveTab = useStore((s) => s.runActiveTab)
  const catalogByConn = useStore((s) => s.catalogByConn)
  const engineOf = useStore((s) => s.engineOf)
  const theme = useStore((s) => s.theme)

  const connId = activeTab?.connectionId ?? null
  const catalog = connId ? catalogByConn[connId] ?? null : null
  const engine = engineOf(connId)

  const doRun = useCallback(() => {
    void runActiveTab()
  }, [runActiveTab])

  // Rebuild the SQL extension (dialect + schema completion) whenever the active
  // connection's catalog or engine changes.
  const extensions = useMemo(() => {
    const runKeymap = Prec.highest(
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            doRun()
            return true
          }
        }
      ])
    )
    return [buildSqlExtension(catalog, engine), runKeymap]
  }, [catalog, engine, doRun])

  if (!activeTab) return <div className="empty">No tab open.</div>

  return (
    <CodeMirror
      value={activeTab.sql}
      theme={theme}
      extensions={extensions}
      onChange={(v) => setTabSql(activeTab.id, v)}
      basicSetup={{ lineNumbers: true, foldGutter: false, autocompletion: true }}
    />
  )
}
