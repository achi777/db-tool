import { useStore } from '../store'
import { buildAlterIndex, buildCreateIndex } from '@shared/indexDdl'
import type { IndexCreateSpec } from '@shared/types'
import { IconApply, IconMoveUp, IconMoveDown, IconRemove, IconDelete } from '../actionIcons'

/** Form editor for a standalone index: name, ordered columns, UNIQUE toggle. */
export function IndexEditor(): JSX.Element {
  const tab = useStore((s) => s.getActiveTab())
  const engineOf = useStore((s) => s.engineOf)
  const catalogByConn = useStore((s) => s.catalogByConn)
  const setIndexEditor = useStore((s) => s.setIndexEditor)
  const applyIndexEditor = useStore((s) => s.applyIndexEditor)
  const openObjectOp = useStore((s) => s.openObjectOp)

  if (!tab?.indexEditor) return <div className="empty">No index open.</div>
  const ie = tab.indexEditor
  const spec = ie.spec
  const engine = engineOf(tab.connectionId) ?? 'postgres'
  const isEdit = ie.mode === 'edit'
  const isPg = engine === 'postgres' // advanced method/partial/expression are PG-only
  const usingExpr = isPg && !!(spec.expression && spec.expression.trim())

  const catalog = tab.connectionId ? catalogByConn[tab.connectionId] : undefined
  const tableCols =
    catalog?.tables.find((c) => c.name === spec.table && (engine === 'sqlite' || c.schema === spec.schema))?.columns ?? []
  const available = tableCols.map((c) => c.name).filter((n) => !spec.columns.includes(n))

  const patch = (p: Partial<IndexCreateSpec>): void => setIndexEditor(tab.id, { spec: { ...spec, ...p }, message: null })
  const setCols = (columns: string[]): void => patch({ columns })

  let previewSql = ''
  let previewErr: string | null = null
  try {
    previewSql = isEdit ? buildAlterIndex(engine, spec, ie.original as IndexCreateSpec).sql : buildCreateIndex(engine, spec).sql
  } catch (err) {
    previewErr = (err as Error).message
  }

  const move = (i: number, dir: -1 | 1): void => {
    const j = i + dir
    if (j < 0 || j >= spec.columns.length) return
    const next = [...spec.columns]
    ;[next[i], next[j]] = [next[j], next[i]]
    setCols(next)
  }

  return (
    <div className="idx-editor">
      <div className="idx-toolbar">
        <span className="obj-kind">{isEdit ? 'EDIT' : 'NEW'} index</span>
        <label className="seq-field">
          <span>name</span>
          <input value={spec.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="param-check">
          <input type="checkbox" checked={spec.unique} onChange={(e) => patch({ unique: e.target.checked })} /> UNIQUE
        </label>
        {isPg && (
          <label className="seq-field" title="PostgreSQL index access method">
            <span>method</span>
            <select value={spec.method ?? 'btree'} onChange={(e) => patch({ method: e.target.value as IndexCreateSpec['method'] })}>
              <option value="btree">btree</option>
              <option value="hash">hash</option>
              <option value="gin">gin</option>
              <option value="gist">gist</option>
              <option value="brin">brin</option>
            </select>
          </label>
        )}
        <span className="on-tbl">ON <b>{spec.table}</b></span>
        <span className="spacer" />
        {isEdit && (
          <button
            className="icon-text-btn danger-btn"
            onClick={() => void openObjectOp(tab.connectionId as string, { kind: 'dropIndex', schema: spec.schema, table: spec.table, name: spec.originalName ?? spec.name })}
            title="Drop this index"
          >
            <IconDelete /> Drop…
          </button>
        )}
        <button className="primary icon-text-btn" disabled={ie.applying || !!previewErr} onClick={() => void applyIndexEditor(tab.id)}>
          <IconApply /> {ie.applying ? 'Applying…' : isEdit ? 'Apply (recreate)' : 'Create index'}
        </button>
      </div>

      <div className="idx-body">
        <div className="idx-cols">
          <div className="section-title" style={{ marginTop: 0 }}>Columns (in order)</div>
          {spec.columns.length === 0 && <div className="idx-empty">No columns yet — add one below.</div>}
          {spec.columns.map((c, i) => (
            <div className="idx-col-row" key={c}>
              <span className="idx-col-name">{i + 1}. {c}</span>
              <button disabled={i === 0} onClick={() => move(i, -1)} title="Move up"><IconMoveUp /></button>
              <button disabled={i === spec.columns.length - 1} onClick={() => move(i, 1)} title="Move down"><IconMoveDown /></button>
              <button className="idx-col-x" onClick={() => setCols(spec.columns.filter((x) => x !== c))} title="Remove"><IconRemove /></button>
            </div>
          ))}
          <div className="idx-add">
            <select
              value=""
              disabled={usingExpr}
              onChange={(e) => {
                if (e.target.value) setCols([...spec.columns, e.target.value])
              }}
            >
              <option value="">+ add column…</option>
              {available.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>

          {isPg && (
            <div className="idx-pg-adv">
              <div className="section-title">Expression index (optional)</div>
              <input
                className="idx-expr"
                placeholder="e.g. lower(email) — overrides the columns above"
                value={spec.expression ?? ''}
                onChange={(e) => patch({ expression: e.target.value })}
              />
              <div className="section-title">Partial index — WHERE (optional)</div>
              <input
                className="idx-expr"
                placeholder="e.g. active AND deleted_at IS NULL"
                value={spec.where ?? ''}
                onChange={(e) => patch({ where: e.target.value })}
              />
              {usingExpr && <div className="idx-empty">Using the expression above; the column list is ignored.</div>}
            </div>
          )}
        </div>

        <div className="idx-preview">
          <div className="section-title" style={{ marginTop: 0 }}>Statements to run</div>
          <pre className="ddl-pre">{previewErr ? `-- ${previewErr}` : previewSql}</pre>
          {previewErr && <div className="ddl-danger">⚠ {previewErr}</div>}
          {ie.message && <div className={'msg ' + (ie.message.startsWith('❌') ? 'err' : 'ok')}>{ie.message}</div>}
        </div>
      </div>
    </div>
  )
}
