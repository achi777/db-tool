import { useEffect, useState } from 'react'
import type { ColumnSpec, ForeignKeySpec, IndexSpec, TableSpec } from '@shared/types'
import { sqlDialect } from '@shared/types'
import {
  TYPE_CATALOG,
  CATEGORY_ORDER,
  SQLITE_AFFINITY_NOTE,
  findType,
  paramsFor,
  validateColumn
} from '@shared/typeCatalog'
import { useStore } from '../store'
import { IconNew, IconCopy, IconApply } from '../actionIcons'

export function TableDesigner(): JSX.Element {
  const tab = useStore((s) => s.getActiveTab())
  const setDesignerSpec = useStore((s) => s.setDesignerSpec)
  const applyDesigner = useStore((s) => s.applyDesigner)
  const engineOf = useStore((s) => s.engineOf)
  const catalogByConn = useStore((s) => s.catalogByConn)
  const [confirmText, setConfirmText] = useState('')
  // PostgreSQL user-defined types (enums/composites) offered in the type dropdown.
  const [userTypes, setUserTypes] = useState<string[]>([])
  const connId = tab?.connectionId ?? null
  const schema = tab?.designer?.spec.schema ?? ''
  const engineName = connId ? engineOf(connId) : null
  useEffect(() => {
    if (engineName !== 'postgres' || !connId || !schema) { setUserTypes([]); return }
    let cancelled = false
    void window.dbApi.listTypes(connId, schema).then((r) => {
      if (!cancelled && r.ok && r.data.supported) setUserTypes(r.data.types.map((t) => t.name))
    })
    return () => { cancelled = true }
  }, [engineName, connId, schema])

  if (!tab?.designer) return <div className="empty">No designer open.</div>
  const { spec, mode, preview, applying, message } = tab.designer
  const engine = engineOf(tab.connectionId) ?? 'postgres'
  const catalog = tab.connectionId ? catalogByConn[tab.connectionId] : undefined
  const catalogTypes = TYPE_CATALOG[sqlDialect(engine)]
  const defaultType = catalogTypes[0]?.name ?? 'TEXT'

  const update = (next: TableSpec): void => setDesignerSpec(tab.id, next)
  const setCol = (i: number, patch: Partial<ColumnSpec>): void =>
    update({ ...spec, columns: spec.columns.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) })

  // Changing a column's type resets the params to what the new type supports.
  const onTypeChange = (i: number, newType: string): void => {
    const def = findType(engine, newType)
    const p = def?.params ?? []
    const patch: Partial<ColumnSpec> = { type: def?.name ?? newType }
    patch.length = p.includes('length') || p.includes('precisionScale') ? (def?.defaults?.length ?? null) : null
    patch.scale = null
    patch.enumValues = p.includes('enumValues') || p.includes('setValues') ? (spec.columns[i].enumValues ?? []) : null
    if (!(engine === 'postgres' && p.includes('timezone'))) patch.withTimeZone = false
    if (!(engine === 'mysql' && def?.category === 'Numeric')) {
      patch.unsigned = false
      patch.zerofill = false
    }
    setCol(i, patch)
  }

  const addColumn = (): void =>
    update({
      ...spec,
      columns: [
        ...spec.columns,
        { name: `col_${spec.columns.length + 1}`, type: defaultType, nullable: true, originalName: null }
      ]
    })
  const removeColumn = (i: number): void => {
    const col = spec.columns[i]
    update({
      ...spec,
      columns: spec.columns.filter((_, idx) => idx !== i),
      primaryKey: spec.primaryKey.filter((n) => n !== col.name)
    })
  }
  const togglePk = (name: string): void => {
    const primaryKey = spec.primaryKey.includes(name)
      ? spec.primaryKey.filter((n) => n !== name)
      : [...spec.primaryKey, name]
    update({ ...spec, primaryKey })
  }

  // --- foreign keys ---
  const addFk = (): void => {
    const firstCol = spec.columns[0]?.name ?? ''
    const refTable = catalog?.tables[0]
    update({
      ...spec,
      foreignKeys: [
        ...spec.foreignKeys,
        {
          name: `fk_${spec.name}_${firstCol}`,
          columns: [firstCol],
          refSchema: refTable?.schema ?? null,
          refTable: refTable?.name ?? '',
          refColumns: [refTable?.columns[0]?.name ?? 'id'],
          onDelete: 'NO ACTION'
        }
      ]
    })
  }
  const setFk = (i: number, patch: Partial<ForeignKeySpec>): void =>
    update({ ...spec, foreignKeys: spec.foreignKeys.map((f, idx) => (idx === i ? { ...f, ...patch } : f)) })
  const removeFk = (i: number): void =>
    update({ ...spec, foreignKeys: spec.foreignKeys.filter((_, idx) => idx !== i) })

  // --- indexes ---
  const addIndex = (): void =>
    update({
      ...spec,
      indexes: [
        ...spec.indexes,
        { name: `idx_${spec.name}_${spec.columns[0]?.name ?? 'col'}`, columns: [spec.columns[0]?.name ?? ''], unique: false }
      ]
    })
  const setIndex = (i: number, patch: Partial<IndexSpec>): void =>
    update({ ...spec, indexes: spec.indexes.map((x, idx) => (idx === i ? { ...x, ...patch } : x)) })
  const removeIndex = (i: number): void =>
    update({ ...spec, indexes: spec.indexes.filter((_, idx) => idx !== i) })

  // Validation across all columns.
  const validationErrors = spec.columns.flatMap((c) => validateColumn(engine, c))

  const destructive = preview?.destructive ?? false
  const confirmed = !destructive || confirmText.trim() === spec.name
  const canApply =
    !!preview && preview.statements.length > 0 && !applying && confirmed && validationErrors.length === 0

  // Render the parameter inputs a given column's type needs.
  const renderParams = (c: ColumnSpec, i: number): JSX.Element => {
    const def = findType(engine, c.type)
    const p = paramsFor(engine, c.type)
    const showTz = engine === 'postgres' && p.includes('timezone')
    const showUnsigned = engine === 'mysql' && def?.category === 'Numeric'
    const showArray = engine === 'postgres'

    return (
      <div className="param-cell">
        {p.includes('length') && (
          <input
            type="number"
            title="length"
            placeholder="len"
            style={{ width: 60 }}
            value={c.length ?? ''}
            onChange={(e) => setCol(i, { length: e.target.value ? Number(e.target.value) : null })}
          />
        )}
        {p.includes('precisionScale') && (
          <>
            <input
              type="number"
              title="precision"
              placeholder="p"
              style={{ width: 48 }}
              value={c.length ?? ''}
              onChange={(e) => setCol(i, { length: e.target.value ? Number(e.target.value) : null })}
            />
            <input
              type="number"
              title="scale"
              placeholder="s"
              style={{ width: 48 }}
              value={c.scale ?? ''}
              onChange={(e) => setCol(i, { scale: e.target.value ? Number(e.target.value) : null })}
            />
          </>
        )}
        {(p.includes('enumValues') || p.includes('setValues')) && (
          <input
            title="comma-separated values"
            placeholder="a, b, c"
            style={{ minWidth: 120, flex: 1 }}
            value={(c.enumValues ?? []).join(', ')}
            onChange={(e) =>
              setCol(i, { enumValues: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
            }
          />
        )}
        {showTz && (
          <label className="param-check" title="WITH TIME ZONE">
            <input type="checkbox" checked={!!c.withTimeZone} onChange={(e) => setCol(i, { withTimeZone: e.target.checked })} /> tz
          </label>
        )}
        {showUnsigned && (
          <>
            <label className="param-check" title="UNSIGNED">
              <input type="checkbox" checked={!!c.unsigned} onChange={(e) => setCol(i, { unsigned: e.target.checked })} /> uns
            </label>
            <label className="param-check" title="ZEROFILL">
              <input type="checkbox" checked={!!c.zerofill} onChange={(e) => setCol(i, { zerofill: e.target.checked })} /> zf
            </label>
          </>
        )}
        {showArray && (
          <label className="param-check" title="array []">
            <input type="checkbox" checked={!!c.isArray} onChange={(e) => setCol(i, { isArray: e.target.checked })} /> []
          </label>
        )}
      </div>
    )
  }

  return (
    <div className="designer">
      <div className="designer-form">
        <div className="designer-row">
          <div className="field" style={{ flex: 1 }}>
            <label>Table name</label>
            <input value={spec.name} onChange={(e) => update({ ...spec, name: e.target.value })} />
          </div>
          <div className="field" style={{ width: 160 }}>
            <label>{engine === 'mysql' ? 'Database' : 'Schema'}</label>
            <input value={spec.schema} disabled />
          </div>
          <div style={{ alignSelf: 'flex-end', color: 'var(--text-dim)', fontSize: 11, paddingBottom: 6 }}>
            {mode === 'create' ? 'CREATE' : 'ALTER'} · {engine}
          </div>
        </div>

        <div className="section-title">Columns</div>
        <table className="designer-table">
          <thead>
            <tr>
              <th>Name</th>
              <th style={{ width: 150 }}>Type</th>
              <th>Params</th>
              <th style={{ width: 38 }}>Null</th>
              <th>Default</th>
              <th style={{ width: 34 }} title="Auto-increment">AI</th>
              <th style={{ width: 34 }}>PK</th>
              <th style={{ width: 26 }}></th>
            </tr>
          </thead>
          <tbody>
            {spec.columns.map((c, i) => (
              <tr key={i}>
                <td><input value={c.name} onChange={(e) => setCol(i, { name: e.target.value })} /></td>
                <td>
                  <select value={findType(engine, c.type) ? findType(engine, c.type)!.name : c.type} onChange={(e) => onTypeChange(i, e.target.value)}>
                    {CATEGORY_ORDER.map((cat) => {
                      const types = catalogTypes.filter((t) => t.category === cat)
                      if (types.length === 0) return null
                      return (
                        <optgroup key={cat} label={cat}>
                          {types.map((t) => (
                            <option key={t.name} value={t.name}>{t.name}</option>
                          ))}
                        </optgroup>
                      )
                    })}
                    {userTypes.length > 0 && (
                      <optgroup label="User types">
                        {userTypes.map((t) => (
                          <option key={'ut.' + t} value={t}>{t}</option>
                        ))}
                      </optgroup>
                    )}
                    {!findType(engine, c.type) && !userTypes.includes(c.type) && <option value={c.type}>{c.type} (raw)</option>}
                  </select>
                </td>
                <td>{renderParams(c, i)}</td>
                <td style={{ textAlign: 'center' }}><input type="checkbox" checked={c.nullable} onChange={(e) => setCol(i, { nullable: e.target.checked })} /></td>
                <td><input value={c.default ?? ''} placeholder="expr" onChange={(e) => setCol(i, { default: e.target.value || null })} /></td>
                <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!c.autoIncrement} onChange={(e) => setCol(i, { autoIncrement: e.target.checked })} /></td>
                <td style={{ textAlign: 'center' }}><input type="checkbox" checked={spec.primaryKey.includes(c.name)} onChange={() => togglePk(c.name)} /></td>
                <td style={{ textAlign: 'center' }}><span className="del-x" onClick={() => removeColumn(i)}>×</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="icon-text-btn" onClick={addColumn} title="Add column"><IconNew /> Column</button>
        {engine === 'sqlite' && <div className="ddl-note" style={{ marginTop: 6 }}>ℹ {SQLITE_AFFINITY_NOTE}</div>}
        {validationErrors.length > 0 && (
          <div className="validation-box">
            {validationErrors.map((e, i) => <div key={i} className="ddl-danger">⚠ {e}</div>)}
          </div>
        )}

        <div className="section-title">Foreign keys</div>
        {spec.foreignKeys.map((fk, i) => (
          <div className="designer-row fk-row" key={i}>
            <select value={fk.columns[0] ?? ''} onChange={(e) => setFk(i, { columns: [e.target.value] })}>
              {spec.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            <span>→</span>
            <select
              value={fk.refTable}
              onChange={(e) => {
                const rt = catalog?.tables.find((t) => t.name === e.target.value)
                setFk(i, { refTable: e.target.value, refSchema: rt?.schema ?? null, refColumns: [rt?.columns[0]?.name ?? 'id'] })
              }}
            >
              <option value="">— table —</option>
              {catalog?.tables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
            <select value={fk.refColumns[0] ?? ''} onChange={(e) => setFk(i, { refColumns: [e.target.value] })}>
              {(catalog?.tables.find((t) => t.name === fk.refTable)?.columns ?? []).map((col) => (
                <option key={col.name} value={col.name}>{col.name}</option>
              ))}
            </select>
            <select value={fk.onDelete ?? 'NO ACTION'} onChange={(e) => setFk(i, { onDelete: e.target.value as ForeignKeySpec['onDelete'] })}>
              {['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT'].map((a) => <option key={a} value={a}>ON DELETE {a}</option>)}
            </select>
            <span className="del-x" onClick={() => removeFk(i)}>×</span>
          </div>
        ))}
        <button className="icon-text-btn" onClick={addFk} disabled={!catalog} title="Add foreign key"><IconNew /> Foreign key</button>

        <div className="section-title">Indexes</div>
        {spec.indexes.map((idx, i) => (
          <div className="designer-row fk-row" key={i}>
            <input style={{ width: 200 }} value={idx.name ?? ''} placeholder="index name" onChange={(e) => setIndex(i, { name: e.target.value })} />
            <input style={{ flex: 1 }} value={idx.columns.join(', ')} placeholder="col1, col2" onChange={(e) => setIndex(i, { columns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            <label style={{ display: 'flex', gap: 4, alignItems: 'center', margin: 0 }}>
              <input type="checkbox" checked={idx.unique} onChange={(e) => setIndex(i, { unique: e.target.checked })} /> unique
            </label>
            <span className="del-x" onClick={() => removeIndex(i)}>×</span>
          </div>
        ))}
        <button className="icon-text-btn" onClick={addIndex} title="Add index"><IconNew /> Index</button>
      </div>

      <div className="designer-preview">
        <div className="section-title" style={{ marginTop: 0 }}>DDL preview</div>
        <pre className="ddl-pre">{preview?.sql || '-- (no changes)'}</pre>

        {preview?.notes?.map((n, i) => <div key={i} className="ddl-note">ℹ {n}</div>)}
        {preview?.destructiveReasons?.map((r, i) => <div key={i} className="ddl-danger">⚠ {r}</div>)}
        {validationErrors.length > 0 && <div className="ddl-danger">Fix {validationErrors.length} validation issue(s) above before applying.</div>}

        {destructive && (
          <div className="field" style={{ marginTop: 8 }}>
            <label>This change can lose data. Type the table name <b>{spec.name}</b> to confirm:</label>
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </div>
        )}

        <div className="row-actions">
          <button className="icon-text-btn" onClick={() => preview && navigator.clipboard.writeText(preview.sql)} disabled={!preview?.sql} title="Copy SQL">
            <IconCopy /> Copy SQL
          </button>
          <button className="primary icon-text-btn" onClick={() => void applyDesigner(tab.id)} disabled={!canApply} title="Apply">
            <IconApply /> {applying ? 'Applying…' : 'Apply'}
          </button>
        </div>
        {message && <div className={'msg ' + (message.startsWith('❌') ? 'err' : 'ok')}>{message}</div>}
      </div>
    </div>
  )
}
