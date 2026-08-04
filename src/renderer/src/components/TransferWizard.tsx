import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { IconClose, IconPreview, IconCopy, IconRefresh } from '../actionIcons'
import type {
  TransferIfExists,
  TransferPlan,
  TransferRequest,
  TransferResult,
  TransferColumnOverride
} from '@shared/types'

type Overrides = Record<string, Record<string, TransferColumnOverride>>

/**
 * Cross-engine Data Transfer wizard: copy tables from ANY connection to ANY
 * other (all six engines). Source is READ-ONLY. Pick source tables → target
 * connection/schema → review the type-translation plan + warnings → run.
 */
export function TransferWizard(): JSX.Element | null {
  const ctx = useStore((s) => s.ioTransfer)
  const close = useStore((s) => s.closeIo)
  const connections = useStore((s) => s.connections)
  const connectedIds = useStore((s) => s.connectedIds)
  const engineOf = useStore((s) => s.engineOf)
  const refreshTree = useStore((s) => s.refreshTree)

  const connected = useMemo(
    () => connections.filter((c) => connectedIds.includes(c.id)),
    [connections, connectedIds]
  )

  // --- source ---
  const [sourceConn, setSourceConn] = useState('')
  const [sourceSchema, setSourceSchema] = useState('')
  const [sourceSchemas, setSourceSchemas] = useState<string[]>([])
  const [sourceTables, setSourceTables] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])

  // --- target ---
  const [targetConn, setTargetConn] = useState('')
  const [targetSchema, setTargetSchema] = useState('')
  const [targetSchemas, setTargetSchemas] = useState<string[]>([])

  const [ifExists, setIfExists] = useState<TransferIfExists>('drop')
  const [overrides, setOverrides] = useState<Overrides>({})

  const [plan, setPlan] = useState<TransferPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<TransferResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // Seed from the launch context, once.
  useEffect(() => {
    if (!ctx) return
    setSourceConn(ctx.connectionId)
    setSourceSchema(ctx.schema)
    if (ctx.table) setSelected([ctx.table])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.connectionId, ctx?.schema])

  useEffect(() => {
    const off = window.dbApi.onIoProgress((p) => {
      if (p.phase === 'transfer') setProgress(p.done)
    })
    return off
  }, [])

  // Load schemas for the chosen source connection.
  useEffect(() => {
    if (!sourceConn) return
    void (async () => {
      const res = await window.dbApi.listSchemas(sourceConn)
      if (res.ok) {
        setSourceSchemas(res.data)
        if (!res.data.includes(sourceSchema)) setSourceSchema(res.data[0] ?? '')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceConn])

  // Load tables for the chosen source schema.
  useEffect(() => {
    if (!sourceConn || !sourceSchema) {
      setSourceTables([])
      return
    }
    void (async () => {
      const res = await window.dbApi.listTables(sourceConn, sourceSchema)
      if (res.ok) setSourceTables(res.data.filter((t) => t.type === 'table').map((t) => t.name))
    })()
    setPlan(null)
    setResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceConn, sourceSchema])

  // Load schemas for the chosen target connection.
  useEffect(() => {
    if (!targetConn) {
      setTargetSchemas([])
      return
    }
    void (async () => {
      const res = await window.dbApi.listSchemas(targetConn)
      if (res.ok) {
        setTargetSchemas(res.data)
        setTargetSchema((s) => (res.data.includes(s) ? s : res.data[0] ?? ''))
      }
    })()
    setPlan(null)
    setResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetConn])

  const toggleTable = (name: string): void => {
    setSelected((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]))
    setPlan(null)
    setResult(null)
  }

  const buildPlan = async (): Promise<void> => {
    setMessage(null)
    setResult(null)
    if (!sourceConn || !sourceSchema || !targetConn || !targetSchema) {
      setMessage('❌ Choose a source connection/schema and a target connection/schema.')
      return
    }
    if (selected.length === 0) {
      setMessage('❌ Select at least one source table.')
      return
    }
    setPlanning(true)
    const res = await window.dbApi.transferPlan({
      sourceConnectionId: sourceConn,
      targetConnectionId: targetConn,
      sourceSchema,
      targetSchema,
      tables: selected
    })
    setPlanning(false)
    if (!res.ok) {
      setMessage(`❌ ${res.error}`)
      return
    }
    setPlan(res.data)
    setOverrides({})
  }

  const setOverride = (table: string, col: string, patch: TransferColumnOverride): void => {
    setOverrides((o) => ({
      ...o,
      [table]: { ...(o[table] ?? {}), [col]: { ...(o[table]?.[col] ?? {}), ...patch } }
    }))
  }

  const run = async (): Promise<void> => {
    if (!plan) return
    setRunning(true)
    setMessage(null)
    setProgress(0)
    setResult(null)
    const req: TransferRequest = {
      sourceConnectionId: sourceConn,
      targetConnectionId: targetConn,
      sourceSchema,
      targetSchema,
      tables: selected,
      ifExists,
      overrides
    }
    const res = await window.dbApi.transferRun(req)
    setRunning(false)
    setProgress(null)
    if (!res.ok) {
      setMessage(`❌ ${res.error}`)
      return
    }
    setResult(res.data)
    // The transfer created/replaced tables on the target — if it's an open
    // connection, refresh its tree + autocomplete so the new tables show up
    // without a manual Refresh or reconnect.
    if (connectedIds.includes(targetConn)) void refreshTree(targetConn)
  }

  if (!ctx) return null

  const sameTarget = sourceConn === targetConn && sourceSchema === targetSchema
  const engineLabel = (id: string): string => (id ? ` (${engineOf(id)})` : '')

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal io-modal io-transfer" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 860 }}>
        <div className="modal-title">Data Transfer — copy tables to another connection</div>

        <div className="io-row">
          <label>Source</label>
          <div className="io-opts">
            <select value={sourceConn} onChange={(e) => setSourceConn(e.target.value)}>
              <option value="">(connection)</option>
              {connected.map((c) => <option key={c.id} value={c.id}>{c.name}{engineLabel(c.id)}</option>)}
            </select>
            <select value={sourceSchema} onChange={(e) => setSourceSchema(e.target.value)} disabled={!sourceConn}>
              {sourceSchemas.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {sourceConn && (
          <div className="io-row">
            <label>Tables</label>
            <div className="io-map" style={{ maxHeight: 150, overflow: 'auto' }}>
              {sourceTables.length === 0 && <span className="io-src">(no tables)</span>}
              {sourceTables.map((t) => (
                <label className="param-check" key={t} style={{ display: 'block' }}>
                  <input type="checkbox" checked={selected.includes(t)} onChange={() => toggleTable(t)} /> {t}
                </label>
              ))}
              {sourceTables.length > 0 && (
                <button className="icon-text-btn" title="Select all" style={{ marginTop: 4 }}
                  onClick={() => { setSelected(selected.length === sourceTables.length ? [] : [...sourceTables]); setPlan(null) }}>
                  {selected.length === sourceTables.length ? 'Clear all' : 'Select all'}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="io-row">
          <label>Target</label>
          <div className="io-opts">
            <select value={targetConn} onChange={(e) => setTargetConn(e.target.value)}>
              <option value="">(connection)</option>
              {connected.map((c) => <option key={c.id} value={c.id}>{c.name}{engineLabel(c.id)}</option>)}
            </select>
            <select value={targetSchema} onChange={(e) => { setTargetSchema(e.target.value); setPlan(null) }} disabled={!targetConn}>
              {targetSchemas.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {sameTarget && targetConn && (
          <div className="msg err">❌ Source and target are the same connection + schema. Pick a different target so the source is never written to.</div>
        )}

        <div className="io-row">
          <label>If target exists</label>
          <div>
            <label className="param-check"><input type="radio" checked={ifExists === 'drop'} onChange={() => setIfExists('drop')} /> Drop &amp; recreate</label>
            <label className="param-check"><input type="radio" checked={ifExists === 'append'} onChange={() => setIfExists('append')} /> Append (keep structure)</label>
            <label className="param-check"><input type="radio" checked={ifExists === 'skip'} onChange={() => setIfExists('skip')} /> Skip</label>
          </div>
        </div>

        <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="icon-text-btn" title="Preview plan" disabled={planning || sameTarget} onClick={() => void buildPlan()}>
            <IconPreview />{planning ? 'Planning…' : 'Preview plan'}
          </button>
          {plan && <button className="icon-text-btn" title="Re-plan" onClick={() => void buildPlan()}><IconRefresh />Refresh</button>}
        </div>

        {plan && (
          <div className="io-row">
            <label>Plan ({plan.sourceEngine} → {plan.targetEngine})</label>
            <div className="io-preview" style={{ maxHeight: 260, overflow: 'auto' }}>
              {plan.notes.length > 0 && (
                <ul className="io-notes" style={{ margin: '2px 0 8px 0' }}>
                  {plan.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}
              {plan.tables.map((tp) => (
                <div key={tp.table} style={{ marginBottom: 10 }}>
                  <div style={{ fontWeight: 600 }}>
                    {tp.table}
                    {tp.existsInTarget && <span className="io-warn"> · exists in target ({ifExists})</span>}
                    {tp.rowCountEstimate != null && <span className="io-src"> · ~{tp.rowCountEstimate} rows</span>}
                    {tp.foreignKeys > 0 && <span className="io-src"> · {tp.foreignKeys} FK</span>}
                  </div>
                  <table>
                    <thead><tr><th>column</th><th>source</th><th>→ target</th><th>skip</th></tr></thead>
                    <tbody>
                      {tp.columns.map((c) => {
                        const ov = overrides[tp.table]?.[c.name]
                        return (
                          <tr key={c.name} className={c.needsReview ? 'io-review' : undefined}>
                            <td>{c.name}</td>
                            <td>{c.sourceType}</td>
                            <td>
                              <input
                                className="io-type"
                                value={ov?.targetType ?? c.targetType}
                                onChange={(e) => setOverride(tp.table, c.name, { targetType: e.target.value })}
                                style={{ width: 150 }}
                              />
                              {c.warnings.length > 0 && (
                                <div className="io-warn" style={{ whiteSpace: 'normal' }}>⚠ {c.warnings.join('; ')}</div>
                              )}
                              {c.needsReview && <div className="io-warn">⚠ unrecognized type — review or override</div>}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <input type="checkbox" checked={!!ov?.skip} onChange={(e) => setOverride(tp.table, c.name, { skip: e.target.checked })} />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {tp.skippedForeignKeys.length > 0 && (
                    <div className="io-warn">FKs not recreated: {tp.skippedForeignKeys.join('; ')}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {running && <div className="msg">Transferring…{progress != null ? ` ${progress} rows` : ''}</div>}
        {message && <div className={'msg ' + (message.startsWith('❌') ? 'err' : 'ok')}>{message}</div>}
        {result && (
          <div className={'msg ' + (result.ok ? 'ok' : 'err')}>
            {result.ok ? `✅ Transfer complete — ${result.totalRows} row(s).` : `❌ Transfer had failures — ${result.totalRows} row(s) copied.`}
            {result.error && <div>{result.error}</div>}
            <div className="io-errs">
              {result.tables.map((t) => (
                <div key={t.table}>
                  {t.status === 'failed' ? '❌' : t.status === 'skipped' ? '⏭' : '✅'} {t.table}: {t.status}, {t.rows} rows
                  {t.error && <span className="err"> — {t.error}</span>}
                  {t.warnings.map((w, i) => <span key={i} className="io-warn"> · {w}</span>)}
                </div>
              ))}
              {result.fkWarnings.length > 0 && <div className="io-warn">FK warnings: {result.fkWarnings.join('; ')}</div>}
              {result.sourceUnchanged && <div className="ok">Source was not modified (read-only).</div>}
            </div>
          </div>
        )}

        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="icon-text-btn" title="Close" onClick={close}><IconClose />Close</button>
          <button className="primary icon-text-btn" title="Run transfer" disabled={running || !plan || sameTarget} onClick={() => void run()}>
            <IconCopy />{running ? 'Transferring…' : 'Run transfer'}
          </button>
        </div>
      </div>
    </div>
  )
}
