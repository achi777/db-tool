import { useStore } from '../store'
import { buildAlterSequence, buildCreateSequence } from '@shared/sequenceDdl'
import type { SequenceSpec } from '@shared/types'
import { IconApply, IconDelete } from '../actionIcons'

const DATA_TYPES = ['smallint', 'integer', 'bigint']

/**
 * Form-based editor + details view for a sequence (PostgreSQL / MariaDB /
 * Oracle). Create / alter incl. RESTART. Oracle IDENTITY-backing (ISEQ$$)
 * sequences open READ-ONLY: inputs disabled, no Apply/Drop, with an explanation.
 */
export function SequenceEditor(): JSX.Element {
  const tab = useStore((s) => s.getActiveTab())
  const setSequenceEditor = useStore((s) => s.setSequenceEditor)
  const applySequenceEditor = useStore((s) => s.applySequenceEditor)
  const openObjectOp = useStore((s) => s.openObjectOp)
  const engineOf = useStore((s) => s.engineOf)

  if (!tab?.sequenceEditor) return <div className="empty">No sequence open.</div>
  const se = tab.sequenceEditor
  const engine = engineOf(tab.connectionId) ?? 'postgres'
  const spec = se.spec
  const isEdit = se.mode === 'edit'
  const isOracle = engine === 'oracle'
  // Oracle IDENTITY-backing system sequences are read-only (no edit/drop).
  const readOnly = !!se.details?.system

  const patchSpec = (p: Partial<SequenceSpec>): void =>
    setSequenceEditor(tab.id, { spec: { ...spec, ...p }, message: null })

  // Live DDL preview (safe against invalid numeric input).
  let previewSql = ''
  let previewErr: string | null = null
  try {
    const preview = isEdit
      ? buildAlterSequence(engine, spec, se.original as SequenceSpec, { oracleRestartSupported: se.details?.restartSupported !== false })
      : buildCreateSequence(engine, spec)
    previewSql = preview.sql || '-- no changes'
  } catch (err) {
    previewErr = (err as Error).message
  }

  const num = (label: string, value: string, onChange: (v: string) => void, ph?: string): JSX.Element => (
    <label className="seq-field">
      <span>{label}</span>
      <input value={value} inputMode="numeric" placeholder={ph} disabled={readOnly} onChange={(e) => onChange(e.target.value)} />
    </label>
  )

  return (
    <div className="seq-editor">
      <div className="seq-toolbar">
        <span className="obj-kind">{readOnly ? 'VIEW' : isEdit ? 'EDIT' : 'NEW'} sequence</span>
        <label className="seq-field">
          <span>name</span>
          <input value={spec.name} disabled={readOnly} onChange={(e) => patchSpec({ name: e.target.value })} />
        </label>
        <span className="spacer" />
        {readOnly ? (
          <span className="sys-readonly">🔒 system / IDENTITY-backing sequence — read-only</span>
        ) : (
          <>
            {isEdit && (
              <button
                className="icon-text-btn danger-btn"
                onClick={() => void openObjectOp(tab.connectionId as string, { kind: 'dropSequence', schema: spec.schema, name: spec.originalName ?? spec.name })}
                title="Drop this sequence"
              >
                <IconDelete /> Drop…
              </button>
            )}
            <button className="primary icon-text-btn" disabled={se.applying || !!previewErr} onClick={() => void applySequenceEditor(tab.id)}>
              <IconApply /> {se.applying ? 'Applying…' : isEdit ? 'Apply changes' : 'Create sequence'}
            </button>
          </>
        )}
      </div>

      <div className="seq-body">
        <div className="seq-form">
          {/* Oracle sequences are always NUMBER (no AS-type) — hide the data type there. */}
          {!isOracle && (
            <label className="seq-field">
              <span>data type</span>
              <select value={spec.dataType} disabled={readOnly} onChange={(e) => patchSpec({ dataType: e.target.value })}>
                {DATA_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
          )}
          {num('increment', spec.increment, (v) => patchSpec({ increment: v }))}
          {/* Oracle cannot ALTER START WITH — only shown for create / non-Oracle. */}
          {(!isOracle || !isEdit) && num('start', spec.start, (v) => patchSpec({ start: v }))}
          {num('min value', spec.minValue ?? '', (v) => patchSpec({ minValue: v.trim() === '' ? null : v }), 'NO MINVALUE')}
          {num('max value', spec.maxValue ?? '', (v) => patchSpec({ maxValue: v.trim() === '' ? null : v }), 'NO MAXVALUE')}
          {num('cache', spec.cache, (v) => patchSpec({ cache: v }))}
          <label className="param-check">
            <input type="checkbox" checked={spec.cycle} disabled={readOnly} onChange={(e) => patchSpec({ cycle: e.target.checked })} /> CYCLE
          </label>
          {/* OWNED BY is PostgreSQL-only. */}
          {!isOracle && engine !== 'mariadb' && (
            <label className="seq-field">
              <span>owned by (schema.table.column)</span>
              <input
                value={spec.ownedBy ?? ''}
                placeholder="none"
                disabled={readOnly}
                onChange={(e) => patchSpec({ ownedBy: e.target.value.trim() === '' ? null : e.target.value })}
              />
            </label>
          )}
          {isEdit && !readOnly && (
            <label className="seq-field seq-restart">
              <span>RESTART with (optional)</span>
              <input
                value={spec.restart ?? ''}
                inputMode="numeric"
                placeholder="leave blank to keep the counter"
                onChange={(e) => patchSpec({ restart: e.target.value.trim() === '' ? null : e.target.value })}
              />
            </label>
          )}
        </div>

        <div className="seq-side">
          {isEdit && se.details && (
            <div className="seq-details">
              <div className="section-title" style={{ marginTop: 0 }}>Current state</div>
              <div className="seq-detail-row"><span>owner / schema</span><b>{se.details.schema}</b></div>
              <div className="seq-detail-row"><span>increment by</span><b>{se.details.increment}</b></div>
              <div className="seq-detail-row"><span>min / max</span><b>{se.details.minValue || '—'} / {se.details.maxValue || '—'}</b></div>
              <div className="seq-detail-row"><span>cache</span><b>{Number(se.details.cache) <= 1 ? 'NOCACHE' : se.details.cache}</b></div>
              <div className="seq-detail-row"><span>cycle</span><b>{se.details.cycle ? 'YES' : 'NO'}</b></div>
              {se.details.ordered !== undefined && (
                <div className="seq-detail-row"><span>order</span><b>{se.details.ordered ? 'YES' : 'NO'}</b></div>
              )}
              <div className="seq-detail-row">
                <span>{isOracle ? 'last number' : 'last value'}</span>
                <b>{se.details.lastValue ?? '— (unused)'}</b>
              </div>
              {!isOracle && (
                <div className="seq-detail-row"><span>owned by</span><b>{se.details.ownedBy ?? '— (none)'}</b></div>
              )}
              {isOracle && (
                <div className="seq-caveat">
                  ℹ last number reflects the cached high-water mark (ALL_SEQUENCES.LAST_NUMBER), not
                  necessarily the exact next value; it isn&apos;t read via NEXTVAL (which would consume a number).
                </div>
              )}
            </div>
          )}
          {!readOnly && (
            <>
              <div className="section-title">Statements to run</div>
              <pre className="ddl-pre">{previewErr ? `-- ${previewErr}` : previewSql}</pre>
              {previewErr && <div className="ddl-danger">⚠ {previewErr}</div>}
              {se.message && (
                <div className={'msg ' + (se.message.startsWith('❌') ? 'err' : 'ok')}>{se.message}</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
