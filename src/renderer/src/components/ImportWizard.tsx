import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { IconChooseFile, IconRefresh, IconClose, IconImport } from '../actionIcons'
import type { ImportFormat, ImportParseOptions, ImportPreview, ImportRequest, ImportResult } from '@shared/types'

function formatFromPath(p: string): ImportFormat {
  const ext = p.toLowerCase().split('.').pop()
  if (ext === 'json') return 'json'
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx'
  return 'csv'
}

/** Wizard to import CSV/JSON/Excel into a table: file → preview → mapping → run. */
export function ImportWizard(): JSX.Element | null {
  const ctx = useStore((s) => s.ioImport)
  const close = useStore((s) => s.closeIo)
  const catalogByConn = useStore((s) => s.catalogByConn)
  const engineOf = useStore((s) => s.engineOf)
  const refreshPage = useStore((s) => s.refreshPage)

  const targetColumns = useMemo(() => {
    if (!ctx) return [] as string[]
    const cat = catalogByConn[ctx.connectionId]
    const engine = engineOf(ctx.connectionId)
    const t = cat?.tables.find((c) => c.name === ctx.table && (engine === 'sqlite' || c.schema === ctx.schema))
    return t ? t.columns.map((c) => c.name) : []
  }, [ctx, catalogByConn, engineOf])

  const [filePath, setFilePath] = useState<string | null>(null)
  const [format, setFormat] = useState<ImportFormat>('csv')
  const [hasHeader, setHasHeader] = useState(true)
  const [delimiter, setDelimiter] = useState('')
  const [sheet, setSheet] = useState<string | undefined>(undefined)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<'abort' | 'skip'>('skip')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const off = window.dbApi.onIoProgress((p) => {
      if (p.phase === 'import') setProgress(p.done)
    })
    return off
  }, [])

  const parseOpts = (): ImportParseOptions => ({ format, hasHeader, delimiter: delimiter || undefined, sheet })

  const loadPreview = async (path: string, opts: ImportParseOptions): Promise<void> => {
    setMessage(null)
    const res = await window.dbApi.importPreview(path, opts, 30)
    if (!res.ok) {
      setMessage(`❌ ${res.error}`)
      return
    }
    const pv = res.data
    if (!pv.ok) {
      setMessage(`❌ ${pv.error}`)
      return
    }
    setPreview(pv)
    if (opts.format === 'xlsx' && pv.sheets && !sheet) setSheet(pv.sheets[0])
    // Auto-map source → target by (case-insensitive) name.
    const auto: Record<string, string> = {}
    for (const src of pv.columns) {
      const hit = targetColumns.find((t) => t.toLowerCase() === src.toLowerCase())
      auto[src] = hit ?? ''
    }
    setMapping(auto)
  }

  const pickFile = async (): Promise<void> => {
    const res = await window.dbApi.importPickFile()
    if (!res.ok || !res.data) return
    const path = res.data
    const fmt = formatFromPath(path)
    setFilePath(path)
    setFormat(fmt)
    setResult(null)
    await loadPreview(path, { format: fmt, hasHeader, delimiter: delimiter || undefined })
  }

  const reparse = async (): Promise<void> => {
    if (filePath) await loadPreview(filePath, parseOpts())
  }

  const doImport = async (): Promise<void> => {
    if (!ctx || !filePath) return
    const mapped = Object.values(mapping).filter(Boolean)
    if (mapped.length === 0) {
      setMessage('❌ Map at least one column to the target table.')
      return
    }
    setRunning(true)
    setMessage(null)
    setProgress(0)
    setResult(null)
    const req: ImportRequest = {
      connectionId: ctx.connectionId,
      schema: ctx.schema,
      table: ctx.table,
      filePath,
      parse: parseOpts(),
      mapping,
      mode,
      batchSize: 500
    }
    const res = await window.dbApi.importExecute(req)
    setRunning(false)
    setProgress(null)
    if (!res.ok) {
      setMessage(`❌ ${res.error}`)
      return
    }
    setResult(res.data)
    void refreshPage()
  }

  if (!ctx) return null

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal io-modal io-import" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Import into {ctx.table}</div>

        <div className="io-row">
          <label>File</label>
          <div className="io-file">
            <button className="icon-text-btn" title="Choose file…" onClick={() => void pickFile()}><IconChooseFile />Choose file…</button>
            <span className="io-path">{filePath ?? '(none)'}</span>
          </div>
        </div>

        {filePath && (
          <div className="io-row">
            <label>Parse</label>
            <div className="io-opts">
              <label>format
                <select value={format} onChange={(e) => { setFormat(e.target.value as ImportFormat) }} onBlur={() => void reparse()}>
                  <option value="csv">CSV</option>
                  <option value="json">JSON</option>
                  <option value="xlsx">Excel</option>
                </select>
              </label>
              {format === 'csv' && (
                <>
                  <label className="param-check"><input type="checkbox" checked={hasHeader} onChange={(e) => { setHasHeader(e.target.checked); }} onBlur={() => void reparse()} /> header row</label>
                  <label>delimiter <input className="io-tiny" placeholder="auto" value={delimiter} maxLength={1} onChange={(e) => setDelimiter(e.target.value)} /></label>
                </>
              )}
              {format === 'xlsx' && preview?.sheets && (
                <label>sheet
                  <select value={sheet} onChange={(e) => setSheet(e.target.value)}>
                    {preview.sheets.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              )}
              <button className="icon-text-btn" title="Re-parse" onClick={() => void reparse()}><IconRefresh />Re-parse</button>
            </div>
          </div>
        )}

        {preview && (
          <>
            <div className="io-row">
              <label>Preview ({preview.totalRows} rows)</label>
              <div className="io-preview">
                <table>
                  <thead>
                    <tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 8).map((row, i) => (
                      <tr key={i}>{preview.columns.map((_, j) => <td key={j}>{row[j] == null ? '∅' : String(row[j]).slice(0, 40)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="io-row">
              <label>Column mapping</label>
              <div className="io-map">
                {preview.columns.map((src) => (
                  <div className="io-map-row" key={src}>
                    <span className="io-src">{src}</span>
                    <span className="io-arrow">→</span>
                    <select value={mapping[src] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [src]: e.target.value }))}>
                      <option value="">(ignore)</option>
                      {targetColumns.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>

            <div className="io-row">
              <label>On error</label>
              <div>
                <label className="param-check"><input type="radio" checked={mode === 'skip'} onChange={() => setMode('skip')} /> Skip bad rows (collect errors)</label>
                <label className="param-check"><input type="radio" checked={mode === 'abort'} onChange={() => setMode('abort')} /> Abort + roll back on first error</label>
              </div>
            </div>
          </>
        )}

        {running && <div className="msg">Importing…{progress != null ? ` ${progress}` : ''}</div>}
        {message && <div className={'msg ' + (message.startsWith('❌') ? 'err' : 'ok')}>{message}</div>}
        {result && (
          <div className={'msg ' + (result.ok && result.errors.length === 0 ? 'ok' : 'err')}>
            {result.ok ? `✅ Inserted ${result.inserted}` : `❌ ${result.error}`}
            {result.skipped > 0 && `, skipped ${result.skipped}`}
            {result.errors.length > 0 && (
              <div className="io-errs">
                {result.errors.slice(0, 5).map((e, i) => <div key={i}>row {e.row}: {e.message}</div>)}
                {result.errors.length > 5 && <div>…and {result.errors.length - 5} more</div>}
              </div>
            )}
          </div>
        )}

        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="icon-text-btn" title="Close" onClick={close}><IconClose />Close</button>
          <button className="primary icon-text-btn" title="Import" disabled={running || !preview} onClick={() => void doImport()}>
            <IconImport />{running ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
