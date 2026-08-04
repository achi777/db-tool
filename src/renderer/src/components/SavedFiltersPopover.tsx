import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { IconApply, IconClose, IconDelete, IconEdit, IconSave } from '../actionIcons'
import type { SavedFilter } from '@shared/types'

export interface SavedAnchor {
  x: number
  y: number
}

function mkId(): string {
  return 'sf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * Saved-filters popover (TASK 70): save the current table's filter under a name,
 * and list / apply / rename / delete previously-saved ones. Filters are keyed by
 * engine::schema::table so only this table's saves are shown.
 */
export function SavedFiltersPopover(props: { anchor: SavedAnchor; onClose: () => void }): JSX.Element {
  const { anchor, onClose } = props
  const key = useStore((s) => s.savedFilterKey())
  const capture = useStore((s) => s.captureCurrentFilter)
  const applySaved = useStore((s) => s.applySavedFilter)

  const [list, setList] = useState<SavedFilter[]>([])
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!key) return
    void window.dbApi.listSavedFilters(key).then((r) => { if (r.ok) setList(r.data) })
  }, [key])

  const save = async (): Promise<void> => {
    setMsg(null)
    const nm = name.trim()
    if (!nm) { setMsg('Enter a name for the filter.'); return }
    if (!key) return
    const state = capture()
    if (!state) return
    // Same name (case-insensitive) overwrites — that is the "update" path.
    const existing = list.find((f) => f.name.toLowerCase() === nm.toLowerCase())
    const filter: SavedFilter = { id: existing?.id ?? mkId(), name: nm, updatedAt: Date.now(), state }
    const res = await window.dbApi.saveSavedFilter(key, filter)
    if (!res.ok) { setMsg(`❌ ${res.error}`); return }
    setList(res.data)
    setName('')
    setMsg(existing ? `Updated “${nm}”.` : `Saved “${nm}”.`)
  }

  const update = async (f: SavedFilter): Promise<void> => {
    if (!key) return
    const state = capture()
    if (!state) return
    const res = await window.dbApi.saveSavedFilter(key, { ...f, updatedAt: Date.now(), state })
    if (res.ok) { setList(res.data); setMsg(`Updated “${f.name}” to the current filter.`) }
  }

  const commitRename = async (f: SavedFilter): Promise<void> => {
    const nm = editName.trim()
    setEditingId(null)
    if (!nm || nm === f.name || !key) return
    if (list.some((x) => x.id !== f.id && x.name.toLowerCase() === nm.toLowerCase())) { setMsg('A filter with that name already exists.'); return }
    const res = await window.dbApi.saveSavedFilter(key, { ...f, name: nm, updatedAt: Date.now() })
    if (res.ok) setList(res.data)
  }

  const del = async (id: string): Promise<void> => {
    if (!key) return
    const res = await window.dbApi.deleteSavedFilter(key, id)
    if (res.ok) setList(res.data)
    setConfirmId(null)
  }

  const apply = async (f: SavedFilter): Promise<void> => {
    const r = await applySaved(f.state)
    // On a clean apply, close; if some conditions were dropped, keep the popover
    // open so the warning is visible.
    if (r.warning) setMsg(`⚠ ${r.warning}`)
    else onClose()
  }

  const left = Math.min(anchor.x, window.innerWidth - 340)
  const top = Math.min(anchor.y, window.innerHeight - 360)

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div className="funnel-popover sf-popover" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
        <div className="funnel-pop-head">
          <span className="funnel-pop-title"><IconSave size={14} /> Saved filters</span>
          <span className="spacer" />
          <span className="del-x" onClick={onClose} title="Close"><IconClose size={15} /></span>
        </div>

        <div className="sf-save-row">
          <input
            value={name}
            placeholder="Name this filter…"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
          />
          <button className="icon-text-btn primary" onClick={() => void save()} title="Save the current filter"><IconSave /> Save</button>
        </div>

        <div className="sf-list">
          {list.length === 0 && <div className="fb-empty">No saved filters for this table yet.</div>}
          {list.map((f) => (
            <div className="sf-item" key={f.id}>
              {editingId === f.id ? (
                <input
                  className="sf-rename"
                  value={editName}
                  autoFocus
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(f); if (e.key === 'Escape') setEditingId(null) }}
                  onBlur={() => void commitRename(f)}
                />
              ) : (
                <span className="sf-name" title={`Apply “${f.name}”`} onClick={() => void apply(f)}>{f.name}</span>
              )}
              <span className="spacer" />
              {confirmId === f.id ? (
                <>
                  <span className="sf-confirm">Delete?</span>
                  <button className="icon-only danger-btn" onClick={() => void del(f.id)} title="Confirm delete"><IconDelete /></button>
                  <button className="icon-only" onClick={() => setConfirmId(null)} title="Cancel"><IconClose /></button>
                </>
              ) : (
                <>
                  <button className="icon-only" onClick={() => void apply(f)} title="Apply"><IconApply /></button>
                  <button className="icon-only" onClick={() => void update(f)} title="Overwrite with the current filter"><IconSave /></button>
                  <button className="icon-only" onClick={() => { setEditingId(f.id); setEditName(f.name) }} title="Rename"><IconEdit /></button>
                  <button className="icon-only danger" onClick={() => setConfirmId(f.id)} title="Delete"><IconDelete /></button>
                </>
              )}
            </div>
          ))}
        </div>

        {msg && <div className="sf-msg">{msg}</div>}
      </div>
    </>
  )
}
