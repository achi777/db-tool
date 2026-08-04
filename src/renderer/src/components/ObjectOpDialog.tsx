import { useState } from 'react'
import type { ObjectOp } from '@shared/types'
import { useStore } from '../store'
import { IconDelete, IconApply } from '../actionIcons'

/** The "name to type to confirm" for destructive ops. */
function targetName(op: ObjectOp): string {
  switch (op.kind) {
    case 'dropSchema':
    case 'createSchema':
    case 'renameSchema':
    case 'dropView':
    case 'dropRoutine':
    case 'dropPackage':
    case 'dropPackageBody':
    case 'dropSequence':
    case 'dropTrigger':
    case 'dropIndex':
    case 'dropMatView':
    case 'refreshMatView':
    case 'dropType':
    case 'createExtension':
    case 'updateExtension':
    case 'dropExtension':
      return op.name
    case 'dropTable':
    case 'truncateTable':
    case 'renameTable':
      return op.table
  }
}

/** Modal for object-level ops: create schema/db, drop, truncate, rename. */
export function ObjectOpDialog(): JSX.Element | null {
  const state = useStore((s) => s.objectOp)
  const update = useStore((s) => s.updateObjectOp)
  const apply = useStore((s) => s.applyObjectOpNow)
  const close = useStore((s) => s.closeObjectOp)
  const [confirmText, setConfirmText] = useState('')

  if (!state) return null
  const { op, preview, applying, message } = state
  const destructive = preview?.destructive ?? false
  const needsName = op.kind === 'createSchema'
  const needsNewName = op.kind === 'renameTable' || op.kind === 'renameSchema'

  const confirmed = !destructive || confirmText.trim() === targetName(op)
  const nameOk = !needsName || (op.kind === 'createSchema' && op.name.trim().length > 0)
  const canApply = !!preview && preview.statements.length > 0 && !applying && confirmed && nameOk

  const title: Record<ObjectOp['kind'], string> = {
    createSchema: 'New database / schema',
    dropSchema: 'Drop database / schema',
    renameSchema: 'Rename schema',
    dropTable: 'Drop table',
    truncateTable: 'Truncate table',
    renameTable: 'Rename table',
    dropView: 'Drop view',
    dropRoutine: 'Drop routine',
    dropPackage: 'Drop package',
    dropPackageBody: 'Drop package body',
    dropSequence: 'Drop sequence',
    dropTrigger: 'Drop trigger',
    dropIndex: 'Drop index',
    dropMatView: 'Drop materialized view',
    refreshMatView: 'Refresh materialized view',
    dropType: 'Drop type',
    createExtension: 'Create extension',
    updateExtension: 'Update extension',
    dropExtension: 'Drop extension'
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title[op.kind]}</div>

        {needsName && op.kind === 'createSchema' && (
          <div className="field">
            <label>Name</label>
            <input
              autoFocus
              value={op.name}
              onChange={(e) => void update({ ...op, name: e.target.value })}
              placeholder="my_database"
            />
          </div>
        )}
        {needsNewName && op.kind === 'renameTable' && (
          <div className="field">
            <label>New name</label>
            <input autoFocus value={op.newName} onChange={(e) => void update({ ...op, newName: e.target.value })} />
          </div>
        )}

        <div className="section-title" style={{ marginTop: 4 }}>SQL</div>
        <pre className="ddl-pre">{preview?.sql || '-- …'}</pre>

        {preview?.notes?.map((n, i) => <div key={i} className="ddl-note">ℹ {n}</div>)}
        {preview?.destructiveReasons?.map((r, i) => <div key={i} className="ddl-danger">⚠ {r}</div>)}

        {destructive && (
          <div className="field" style={{ marginTop: 8 }}>
            <label>
              This is destructive. Type <b>{targetName(op)}</b> to confirm:
            </label>
            <input autoFocus value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </div>
        )}

        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
          <button onClick={close}>Cancel</button>
          <button
            className={(destructive ? 'danger-btn' : 'primary') + ' icon-text-btn'}
            onClick={() => void apply()}
            disabled={!canApply}
          >
            {destructive ? <IconDelete /> : <IconApply />} {applying ? 'Applying…' : destructive ? 'Delete' : 'Apply'}
          </button>
        </div>
        {message && <div className="msg err">{message}</div>}
      </div>
    </div>
  )
}
