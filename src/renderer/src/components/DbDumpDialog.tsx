import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { IconClose, IconDump } from '../actionIcons'

/** Dialog to dump a whole database/schema (DDL + optional data) to a .sql file. */
export function DbDumpDialog(): JSX.Element | null {
  const ctx = useStore((s) => s.ioDbDump)
  const close = useStore((s) => s.closeIo)
  const [includeData, setIncludeData] = useState(true)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const off = window.dbApi.onIoProgress((p) => {
      if (p.phase === 'dump') setProgress(p.done)
    })
    return off
  }, [])

  if (!ctx) return null

  const doDump = async (): Promise<void> => {
    setRunning(true)
    setMessage(null)
    setProgress(0)
    const res = await window.dbApi.dumpDatabase({ connectionId: ctx.connectionId, schema: ctx.schema, includeData })
    setRunning(false)
    setProgress(null)
    if (!res.ok) {
      setMessage(`❌ ${res.error}`)
      return
    }
    if (res.data.canceled) return
    if (!res.data.ok) {
      setMessage(`❌ ${res.data.error}`)
      return
    }
    setMessage(`✅ Dumped ${res.data.tables} table(s), ${res.data.rows} row(s) → ${res.data.path}`)
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal io-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Dump database → SQL file</div>
        <div className="io-row">
          <label>Database</label>
          <div><b>{ctx.schema}</b></div>
        </div>
        <div className="io-row">
          <label>Contents</label>
          <div>
            <label className="param-check">
              <input type="checkbox" checked={includeData} onChange={(e) => setIncludeData(e.target.checked)} /> Include data (INSERT statements)
            </label>
            <div className="pg-hint">Emits <code>CREATE TABLE</code> for every table (in FK-dependency order){includeData ? ' + row data' : ' — schema only'}.</div>
          </div>
        </div>

        {running && <div className="msg">Dumping…{progress != null ? ` ${progress} rows` : ''}</div>}
        {message && <div className={'msg ' + (message.startsWith('❌') ? 'err' : 'ok')}>{message}</div>}

        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="icon-text-btn" title="Close" onClick={close}><IconClose />Close</button>
          <button className="primary icon-text-btn" title="Dump…" disabled={running} onClick={() => void doDump()}>
            <IconDump />{running ? 'Dumping…' : 'Dump…'}
          </button>
        </div>
      </div>
    </div>
  )
}
