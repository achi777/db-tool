import { useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql } from '@codemirror/lang-sql'
import { EditorView } from '@codemirror/view'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { IconCopy, IconOpenExternal } from '../actionIcons'
import { useStore } from '../store'
import { displayWhere, displayQuote } from '@shared/filterCompiler'

/**
 * Read-only bottom panel showing the effective SELECT + WHERE (+ ORDER BY) for
 * the CURRENT table browse, with values INLINED + escaped per dialect so it's
 * copy-runnable. Display only — the real query still runs with bound params, and
 * this string is never executed. Independent of the SQL editor.
 */
export function FilterSqlPanel(): JSX.Element | null {
  const activeTab = useStore((s) => s.getActiveTab())
  const engineOf = useStore((s) => s.engineOf)
  const collapsed = useStore((s) => s.filterSqlCollapsed)
  const toggle = useStore((s) => s.toggleFilterSql)
  const openSqlInNewTab = useStore((s) => s.openSqlInNewTab)
  const theme = useStore((s) => s.theme)

  const [copied, setCopied] = useState(false)

  const gridTable = activeTab?.gridTable ?? null
  const engine = engineOf(activeTab?.connectionId) ?? 'postgres'

  const sqlText = useMemo(() => {
    if (!gridTable) return ''
    // Display quoting: correct quote char per engine, and quote only when needed
    // (Oracle uppercase / PG lowercase identifiers appear unquoted).
    const qid = (s: string): string => displayQuote(engine, s)
    const qtable = engine === 'sqlite' ? qid(gridTable.table) : `${qid(gridTable.schema)}.${qid(gridTable.table)}`

    // Matches the executor: Custom WHERE is exclusive; otherwise per-column
    // filters AND the funnel's builder tree combine.
    const custom = activeTab?.filterMode === 'custom'
    const quick = custom ? [] : activeTab?.filters ?? []
    const tree = custom ? null : activeTab?.builderTree ?? null
    const raw = custom ? activeTab?.customWhere ?? null : null
    const where = displayWhere(engine, quick, tree, raw)

    // ORDER BY: explicit sort, else the primary key (stable, readable).
    const sort = activeTab?.sort ?? null
    const pk = activeTab?.gridSpec?.primaryKey ?? []
    const orderBy = sort
      ? `ORDER BY ${qid(sort.column)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}`
      : pk.length
        ? `ORDER BY ${pk.map(qid).join(', ')}`
        : ''

    return ['SELECT *', `FROM ${qtable}`, where, orderBy].filter(Boolean).join('\n')
  }, [gridTable, engine, activeTab?.filterMode, activeTab?.filters, activeTab?.builderTree, activeTab?.customWhere, activeTab?.sort, activeTab?.gridSpec])

  const extensions = useMemo(() => [sql(), EditorView.editable.of(false), EditorView.lineWrapping], [])

  if (!gridTable) return null

  const modeLabel = activeTab?.filterMode === 'custom' ? 'Custom WHERE' : 'Filters'
  const hasFilter = /\bWHERE\b/.test(sqlText)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(sqlText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className={'fsql-panel' + (collapsed ? ' collapsed' : '')}>
      <div className="fsql-header" onClick={() => toggle()} title={collapsed ? 'Show filter SQL' : 'Hide filter SQL'}>
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span className="fsql-title">Filter SQL</span>
        <span className="fsql-hint">read-only · {hasFilter ? modeLabel : 'no filter'}</span>
        <span className="spacer" />
        {!collapsed && (
          <>
            <button
              className="fsql-btn"
              onClick={(e) => {
                e.stopPropagation()
                void copy()
              }}
              title="Copy to clipboard"
            >
              <IconCopy size={13} /> {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              className="fsql-btn"
              onClick={(e) => {
                e.stopPropagation()
                openSqlInNewTab(activeTab?.connectionId ?? null, sqlText)
              }}
              title="Open this SQL in a new query tab (does not auto-sync)"
            >
              <IconOpenExternal size={13} /> To editor
            </button>
          </>
        )}
      </div>
      {!collapsed && (
        <div className="fsql-body">
          <CodeMirror value={sqlText} theme={theme} editable={false} extensions={extensions} basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }} />
        </div>
      )}
    </div>
  )
}
