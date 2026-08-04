import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { IconClose, IconExport } from '../actionIcons'
import type { ExportFormat, ExportRequest } from '@shared/types'

const FORMATS: { key: ExportFormat; label: string }[] = [
  { key: 'csv', label: 'CSV' },
  { key: 'json', label: 'JSON' },
  { key: 'xlsx', label: 'Excel (.xlsx)' },
  { key: 'sql', label: 'SQL (INSERTs)' }
]

/** Dialog to export a table / the active-filter result to CSV/JSON/Excel/SQL. */
export function ExportDialog(): JSX.Element | null {
  const ctx = useStore((s) => s.ioExport)
  const close = useStore((s) => s.closeIo)
  const catalogByConn = useStore((s) => s.catalogByConn)
  const engineOf = useStore((s) => s.engineOf)

  const allColumns = useMemo(() => {
    if (!ctx) return [] as string[]
    const cat = catalogByConn[ctx.connectionId]
    const engine = engineOf(ctx.connectionId)
    const t = cat?.tables.find((c) => c.name === ctx.table && (engine === 'sqlite' || c.schema === ctx.schema))
    return t ? t.columns.map((c) => c.name) : []
  }, [ctx, catalogByConn, engineOf])

  const [format, setFormat] = useState<ExportFormat>('csv')
  const [scope, setScope] = useState<'filter' | 'all'>('all')
  const [cols, setCols] = useState<Set<string>>(new Set())
  const [csvDelimiter, setCsvDelimiter] = useState(',')
  const [csvBom, setCsvBom] = useState(true)
  const [csvNull, setCsvNull] = useState<'empty' | 'slashN'>('empty')
  const [jsonPretty, setJsonPretty] = useState(true)
  const [sqlMultiRow, setSqlMultiRow] = useState(true)
  const [sqlCreateTable, setSqlCreateTable] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setCols(new Set(allColumns))
    setScope(ctx?.filter ? 'filter' : 'all')
    if (ctx?.presetFormat) setFormat(ctx.presetFormat)
  }, [allColumns, ctx])

  useEffect(() => {
    const off = window.dbApi.onIoProgress((p) => {
      if (p.phase === 'export') setProgress(p.done)
    })
    return off
  }, [])

  if (!ctx) return null

  const toggleCol = (c: string): void =>
    setCols((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  const doExport = async (): Promise<void> => {
    const chosen = allColumns.filter((c) => cols.has(c))
    if (chosen.length === 0) {
      setMessage('❌ Select at least one column.')
      return
    }
    setRunning(true)
    setMessage(null)
    setProgress(0)
    const req: ExportRequest = {
      connectionId: ctx.connectionId,
      schema: ctx.schema,
      table: ctx.table,
      format,
      scope,
      columns: chosen.length === allColumns.length ? [] : chosen,
      filters: scope === 'filter' ? ctx.filter?.filters ?? [] : [],
      tree: scope === 'filter' ? ctx.filter?.tree ?? null : null,
      customWhere: scope === 'filter' ? ctx.filter?.customWhere ?? null : null,
      options: {
        csvDelimiter,
        csvBom,
        csvNull,
        jsonPretty,
        sqlMultiRow,
        sqlCreateTable
      }
    }
    const res = await window.dbApi.exportData(req)
    setRunning(false)
    setProgress(null)
    if (!res.ok) {
      setMessage(`❌ ${res.error}`)
      return
    }
    if (res.data.canceled) {
      setMessage(null)
      return
    }
    if (!res.data.ok) {
      setMessage(`❌ ${res.data.error}`)
      return
    }
    setMessage(`✅ Exported ${res.data.rows} row(s) → ${res.data.path}`)
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal io-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Export {ctx.table}</div>

        <div className="io-row">
          <label>Format</label>
          <div className="io-formats">
            {FORMATS.map((f) => (
              <label key={f.key} className={'io-fmt' + (format === f.key ? ' active' : '')}>
                <input type="radio" checked={format === f.key} onChange={() => setFormat(f.key)} /> {f.label}
              </label>
            ))}
          </div>
        </div>

        <div className="io-row">
          <label>Scope</label>
          <div>
            <label className="param-check">
              <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> Entire table
            </label>
            <label className="param-check" title={ctx.filter ? '' : 'No active filter on this table'}>
              <input type="radio" checked={scope === 'filter'} disabled={!ctx.filter} onChange={() => setScope('filter')} /> Current filter result
            </label>
          </div>
        </div>

        <div className="io-row">
          <label>Columns</label>
          <div className="io-cols">
            {allColumns.map((c) => (
              <label key={c} className="param-check">
                <input type="checkbox" checked={cols.has(c)} onChange={() => toggleCol(c)} /> {c}
              </label>
            ))}
          </div>
        </div>

        {format === 'csv' && (
          <div className="io-row">
            <label>CSV options</label>
            <div className="io-opts">
              <label>delimiter <input className="io-tiny" value={csvDelimiter} maxLength={1} onChange={(e) => setCsvDelimiter(e.target.value || ',')} /></label>
              <label className="param-check"><input type="checkbox" checked={csvBom} onChange={(e) => setCsvBom(e.target.checked)} /> UTF-8 BOM (Excel)</label>
              <label>NULL as
                <select value={csvNull} onChange={(e) => setCsvNull(e.target.value as 'empty' | 'slashN')}>
                  <option value="empty">empty</option>
                  <option value="slashN">\N</option>
                </select>
              </label>
            </div>
          </div>
        )}
        {format === 'json' && (
          <div className="io-row">
            <label>JSON options</label>
            <label className="param-check"><input type="checkbox" checked={jsonPretty} onChange={(e) => setJsonPretty(e.target.checked)} /> Pretty-print</label>
          </div>
        )}
        {format === 'sql' && (
          <div className="io-row">
            <label>SQL options</label>
            <div className="io-opts">
              <label className="param-check"><input type="checkbox" checked={sqlMultiRow} onChange={(e) => setSqlMultiRow(e.target.checked)} /> Multi-row INSERTs</label>
              <label className="param-check"><input type="checkbox" checked={sqlCreateTable} onChange={(e) => setSqlCreateTable(e.target.checked)} /> Prepend CREATE TABLE</label>
            </div>
          </div>
        )}

        {running && <div className="msg">Exporting…{progress != null ? ` ${progress} rows` : ''}</div>}
        {message && <div className={'msg ' + (message.startsWith('❌') ? 'err' : 'ok')}>{message}</div>}

        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="icon-text-btn" title="Close" onClick={close}><IconClose />Close</button>
          <button className="primary icon-text-btn" title="Export…" disabled={running} onClick={() => void doExport()}>
            <IconExport />{running ? 'Exporting…' : 'Export…'}
          </button>
        </div>
      </div>
    </div>
  )
}
