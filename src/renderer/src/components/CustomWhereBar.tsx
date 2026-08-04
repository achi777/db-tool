import { useEffect, useMemo, useState } from 'react'
import { IconApply, IconClear } from '../actionIcons'
import CodeMirror from '@uiw/react-codemirror'
import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { buildSqlExtension } from '../sqlAutocomplete'
import { useStore } from '../store'

/**
 * Custom WHERE mode input: a small SQL field (dialect highlighting + column
 * autocomplete from the catalog) whose text becomes the WHERE predicate of the
 * read-only paginated browse. Apply with the button or Ctrl/Cmd+Enter. The text
 * is raw SQL for the active connection's dialect and is guarded server-side.
 */
export function CustomWhereBar(): JSX.Element | null {
  const activeTab = useStore((s) => s.getActiveTab())
  const setCustomWhere = useStore((s) => s.setCustomWhere)
  const clearActive = useStore((s) => s.clearAllFilters)
  const catalogByConn = useStore((s) => s.catalogByConn)
  const engineOf = useStore((s) => s.engineOf)
  const theme = useStore((s) => s.theme)

  const connId = activeTab?.connectionId ?? null
  const catalog = connId ? catalogByConn[connId] : undefined
  const engine = engineOf(connId) ?? 'postgres'
  const applied = activeTab?.customWhere ?? ''
  const err = activeTab?.customWhereError ?? null

  // The Custom WHERE input is a predicate over the CURRENTLY BROWSED table, so
  // there is no FROM clause to infer columns from — feed that table's columns
  // (name+type) into the completion source directly. Prefer the catalog (types
  // match the main editor); fall back to the grid's loaded table spec.
  const browsed = activeTab?.gridTable ?? null
  const gridSpec = activeTab?.gridSpec ?? null
  const tableColumns = useMemo(() => {
    if (!browsed) return undefined
    const t = catalog?.tables.find(
      (c) => c.name === browsed.table && (engine === 'sqlite' || c.schema === browsed.schema)
    )
    if (t) return t.columns.map((c) => ({ name: c.name, type: c.type }))
    if (gridSpec) return gridSpec.columns.map((c) => ({ name: c.name, type: c.type }))
    return undefined
  }, [browsed?.table, browsed?.schema, catalog, engine, gridSpec])

  const [text, setText] = useState(applied)
  // Re-sync when the applied value changes externally (tab switch / Clear).
  useEffect(() => setText(applied), [applied, activeTab?.id])

  const extensions = useMemo(() => {
    const applyKey = keymap.of([
      { key: 'Mod-Enter', run: (view) => { void setCustomWhere(view.state.doc.toString()); return true } }
    ])
    // Reconfigures whenever the browsed table's columns change (react-codemirror
    // reconfigures on a new extensions reference — same pattern as the main editor).
    return [buildSqlExtension(catalog ?? null, engine, { columns: tableColumns }), Prec.highest(applyKey)]
  }, [catalog, engine, tableColumns, setCustomWhere])

  if (!activeTab) return null
  return (
    <div className="cw-bar">
      <div className="cw-input">
        <CodeMirror
          value={text}
          theme={theme}
          height="auto"
          extensions={extensions}
          placeholder={`e.g.  amount > 100 AND status = 'active'`}
          onChange={setText}
          basicSetup={{ lineNumbers: false, foldGutter: false, autocompletion: true, highlightActiveLine: false }}
        />
      </div>
      <button className="icon-text-btn primary" onClick={() => void setCustomWhere(text)} title="Apply (Ctrl+Enter)">
        <IconApply /> Apply
      </button>
      <button className="icon-text-btn" disabled={!applied} onClick={() => void clearActive()} title="Clear the custom WHERE">
        <IconClear /> Clear
      </button>
      <span className="cw-note">
        raw <b>{engine.toUpperCase()}</b> SQL — WHERE predicate only, filters this table view (read-only)
      </span>
      {err && <span className="cw-err">⚠ {err}</span>}
    </div>
  )
}
