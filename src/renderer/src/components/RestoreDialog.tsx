import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { IconChooseFile, IconClose, IconRestore } from '../actionIcons'
import type { ExecSqlResult, SqlFilePreview } from '@shared/types'

/** Dialog to execute a .sql file against a connection (restore), with an
 *  explicit-target confirmation since it runs arbitrary SQL. */
export function RestoreDialog(): JSX.Element | null {
  const ctx = useStore((s) => s.ioRestore)
  const close = useStore((s) => s.closeIo)
  const connections = useStore((s) => s.connections)
  const defaults = useStore((s) => s.defaults)
  const refreshTree = useStore((s) => s.refreshTree)

  const [filePath, setFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<SqlFilePreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<ExecSqlResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const off = window.dbApi.onIoProgress((p) => {
      if (p.phase === 'restore') setProgress(p.done)
    })
    return off
  }, [])

  if (!ctx) return null
  const connName = [...connections, ...defaults].find((c) => c.id === ctx.connectionId)?.name ?? ctx.connectionId

  const pickFile = async (): Promise<void> => {
    const res = await window.dbApi.pickSqlFile()
    if (!res.ok || !res.data) return
    setFilePath(res.data)
    setResult(null)
    setConfirmed(false)
    setMessage(null)
    const pv = await window.dbApi.previewSqlFile(res.data)
    setPreview(pv.ok ? pv.data : { ok: false, statements: 0, bytes: 0, sample: [], error: pv.error })
  }

  const doRun = async (): Promise<void> => {
    if (!filePath) return
    setRunning(true)
    setMessage(null)
    setProgress(0)
    setResult(null)
    const res = await window.dbApi.executeSqlFile({ connectionId: ctx.connectionId, filePath })
    setRunning(false)
    setProgress(null)
    if (!res.ok) {
      setMessage(`❌ ${res.error}`)
      return
    }
    setResult(res.data)
    // Structure/data may have changed — cache-bust the tree + autocomplete.
    void refreshTree(ctx.connectionId)
  }

  const canRun = !!filePath && !!preview?.ok && confirmed && !running

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal io-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Execute SQL file (restore)</div>

        <div className="io-row">
          <label>Target</label>
          <div><b>{connName}</b> · {ctx.schema}</div>
        </div>

        <div className="io-row">
          <label>SQL file</label>
          <div className="io-file">
            <button className="icon-text-btn" title="Choose .sql file…" onClick={() => void pickFile()}><IconChooseFile />Choose .sql file…</button>
            <span className="io-path">{filePath ?? '(none)'}</span>
          </div>
        </div>

        {preview && (
          <div className="io-row">
            <label>Preview</label>
            <div>
              {preview.ok ? (
                <>
                  <div className="pg-hint">{preview.statements} statement(s) · {Math.round(preview.bytes / 1024)} KB</div>
                  <pre className="ddl-pre" style={{ maxHeight: '30vh' }}>{preview.sample.join(';\n\n')}{preview.statements > preview.sample.length ? '\n\n… more' : ''}</pre>
                </>
              ) : (
                <div className="ddl-danger">⚠ {preview.error}</div>
              )}
            </div>
          </div>
        )}

        {preview?.ok && (
          <label className="param-check ddl-danger" style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            I understand this runs every statement against <b>&nbsp;{connName}&nbsp;</b>
          </label>
        )}

        {running && <div className="msg">Executing…{progress != null ? ` ${progress}` : ''}</div>}
        {message && <div className={'msg ' + (message.startsWith('❌') ? 'err' : 'ok')}>{message}</div>}
        {result && (
          <div className={'msg ' + (result.ok ? 'ok' : 'err')}>
            {result.ok
              ? `✅ Executed ${result.executed}/${result.total} statement(s).`
              : `❌ Statement ${(result.failedAt ?? 0) + 1} failed: ${result.message} (rolled back where supported)`}
          </div>
        )}

        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="icon-text-btn" title="Close" onClick={close}><IconClose />Close</button>
          <button className="danger-btn icon-text-btn" title="Execute SQL file" disabled={!canRun} onClick={() => void doRun()}>
            <IconRestore />{running ? 'Executing…' : 'Execute SQL file'}
          </button>
        </div>
      </div>
    </div>
  )
}
