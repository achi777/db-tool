import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { IconClose, IconApply, IconDelete, IconRefresh } from '../actionIcons'
import type { ObjectOp } from '@shared/types'

/**
 * PostgreSQL Extensions manager (TASK 67): lists INSTALLED + AVAILABLE extensions.
 * Install / update run directly (non-destructive); Drop routes through the
 * confirm dialog. Some extensions need superuser — the server error is surfaced.
 */
export function ExtensionsDialog(): JSX.Element | null {
  const ext = useStore((s) => s.extDialog)
  const close = useStore((s) => s.closeExtensions)
  const refresh = useStore((s) => s.refreshExtensions)
  const refreshTree = useStore((s) => s.refreshTree)
  const openObjectOp = useStore((s) => s.openObjectOp)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const notInstalled = useMemo(
    () => (ext?.available ?? []).filter((a) => a.installedVersion == null),
    [ext?.available]
  )
  const filtered = useMemo(
    () => notInstalled.filter((a) => !filter || a.name.toLowerCase().includes(filter.toLowerCase())),
    [notInstalled, filter]
  )

  if (!ext) return null
  const connId = ext.connectionId

  const runOp = async (op: ObjectOp, label: string): Promise<void> => {
    setBusy(true)
    setMsg(null)
    const res = await window.dbApi.applyObjectOp({ connectionId: connId, op })
    setBusy(false)
    if (!res.ok || !res.data.ok) {
      setMsg(`❌ ${label} failed: ${res.ok ? res.data.message : res.error}`)
      return
    }
    setMsg(`✅ ${label} done.`)
    await refresh(connId)
    void refreshTree(connId)
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal io-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div className="modal-title">PostgreSQL Extensions</div>

        {ext.loading ? (
          <div className="msg">Loading…</div>
        ) : (
          <>
            <div className="io-row">
              <label>Installed ({ext.installed.length})</label>
              <div className="io-preview" style={{ maxHeight: 180, overflow: 'auto' }}>
                {ext.installed.length === 0 && <div className="io-src">(none)</div>}
                {ext.installed.map((e) => (
                  <div key={e.name} className="io-map-row" style={{ justifyContent: 'space-between' }}>
                    <span><b>{e.name}</b> <span className="sys-tag">{e.installedVersion}</span>{e.comment ? <span className="io-src" style={{ marginLeft: 8 }}>{e.comment.slice(0, 50)}</span> : null}</span>
                    <span>
                      {e.defaultVersion && e.defaultVersion !== e.installedVersion && (
                        <button className="icon-text-btn" disabled={busy} title={`Update to ${e.defaultVersion}`} onClick={() => void runOp({ kind: 'updateExtension', name: e.name }, `Update ${e.name}`)}>
                          <IconApply />Update
                        </button>
                      )}
                      <button className="icon-text-btn danger-btn" disabled={busy} title="Drop (with confirm)" onClick={() => { close(); void openObjectOp(connId, { kind: 'dropExtension', name: e.name }) }}>
                        <IconDelete />Drop…
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="io-row">
              <label>Available</label>
              <div className="io-opts">
                <input placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <button className="icon-text-btn" title="Reload" onClick={() => void refresh(connId)}><IconRefresh />Reload</button>
              </div>
            </div>
            <div className="io-preview" style={{ maxHeight: 220, overflow: 'auto' }}>
              {filtered.length === 0 && <div className="io-src">(no matching available extensions)</div>}
              {filtered.slice(0, 200).map((e) => (
                <div key={e.name} className="io-map-row" style={{ justifyContent: 'space-between' }}>
                  <span><b>{e.name}</b> <span className="io-src">{e.defaultVersion}</span>{e.comment ? <span className="io-src" style={{ marginLeft: 8 }}>{e.comment.slice(0, 60)}</span> : null}</span>
                  <button className="icon-text-btn primary" disabled={busy} title={`CREATE EXTENSION ${e.name}`} onClick={() => void runOp({ kind: 'createExtension', name: e.name }, `Install ${e.name}`)}>
                    <IconApply />Install
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {msg && <div className={'msg ' + (msg.startsWith('❌') ? 'err' : 'ok')}>{msg}</div>}
        {ext.message && <div className="msg err">{ext.message}</div>}

        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="icon-text-btn" title="Close" onClick={close}><IconClose />Close</button>
        </div>
      </div>
    </div>
  )
}
