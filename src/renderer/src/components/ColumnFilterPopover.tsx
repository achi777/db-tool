import { useEffect, useMemo, useState } from 'react'
import { IconColumnFilter, IconClear, IconApply } from '../actionIcons'
import type { ColumnFilter, ColumnSpec, Engine, FilterOperator } from '@shared/types'
import { findType } from '@shared/typeCatalog'
import { OP_LABEL, opsFor } from '../filterOps'
import { useStore } from '../store'

export interface PopoverAnchor {
  column: string
  x: number
  y: number
}

export function ColumnFilterPopover(props: {
  anchor: PopoverAnchor
  engine: Engine
  columns: ColumnSpec[]
  onClose: () => void
}): JSX.Element {
  const { anchor, engine, columns, onClose } = props
  const at = useStore((s) => s.getActiveTab())
  const setColumnFilter = useStore((s) => s.setColumnFilter)

  const col = useMemo(() => columns.find((c) => c.name === anchor.column), [columns, anchor.column])
  const isBoolean = col ? findType(engine, col.type)?.category === 'Boolean' : false
  const ops = useMemo(() => opsFor(engine, col), [engine, col])
  const current = at?.filters.find((f) => f.column === anchor.column)

  const [operator, setOperator] = useState<FilterOperator>(current?.operator ?? ops[0] ?? 'eq')
  const [value, setValue] = useState(current?.value ?? '')
  const [value2, setValue2] = useState(current?.value2 ?? '')
  const [inText, setInText] = useState((current?.values ?? []).join(', '))
  // boolean tri-state: '', 'true', 'false' (any = clear)
  const boolTrue = engine === 'postgres' ? 'true' : '1'
  const boolFalse = engine === 'postgres' ? 'false' : '0'
  const [boolVal, setBoolVal] = useState(
    current?.operator === 'eq' ? (current.value === boolTrue ? 'true' : 'false') : ''
  )

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const needsNoValue = operator === 'isNull' || operator === 'isNotNull'
  const needsTwo = operator === 'between'
  const needsList = operator === 'in'

  const apply = (): void => {
    if (isBoolean) {
      if (boolVal === '') void setColumnFilter(anchor.column, null)
      else void setColumnFilter(anchor.column, { column: anchor.column, operator: 'eq', value: boolVal === 'true' ? boolTrue : boolFalse })
      onClose()
      return
    }
    let filter: ColumnFilter | null
    if (needsNoValue) {
      filter = { column: anchor.column, operator }
    } else if (needsList) {
      const values = inText.split(',').map((s) => s.trim()).filter(Boolean)
      filter = values.length ? { column: anchor.column, operator, values } : null
    } else if (needsTwo) {
      filter = value !== '' && value2 !== '' ? { column: anchor.column, operator, value, value2 } : null
    } else {
      filter = value !== '' ? { column: anchor.column, operator, value } : null
    }
    void setColumnFilter(anchor.column, filter)
    onClose()
  }

  const clear = (): void => {
    void setColumnFilter(anchor.column, null)
    onClose()
  }

  // Keep the popover on-screen.
  const left = Math.min(anchor.x, window.innerWidth - 280)
  const top = Math.min(anchor.y, window.innerHeight - 200)

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div className="filter-popover" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
        <div className="filter-pop-title"><IconColumnFilter size={13} /> Filter · {anchor.column}</div>

        {isBoolean ? (
          <select value={boolVal} onChange={(e) => setBoolVal(e.target.value)}>
            <option value="">(any)</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <>
            <select value={operator} onChange={(e) => setOperator(e.target.value as FilterOperator)}>
              {ops.map((o) => (
                <option key={o} value={o}>
                  {OP_LABEL[o]}
                </option>
              ))}
            </select>

            {needsList && (
              <input
                autoFocus
                placeholder="a, b, c"
                value={inText}
                onChange={(e) => setInText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && apply()}
              />
            )}
            {needsTwo && (
              <div className="filter-pop-row">
                <input placeholder="from" value={value} onChange={(e) => setValue(e.target.value)} />
                <input placeholder="to" value={value2} onChange={(e) => setValue2(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} />
              </div>
            )}
            {!needsNoValue && !needsTwo && !needsList && (
              <input
                autoFocus
                placeholder="value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && apply()}
              />
            )}
          </>
        )}

        <div className="filter-pop-actions">
          <button className="icon-text-btn" onClick={clear} title="Clear this column's filter">
            <IconClear size={13} /> Clear
          </button>
          <button className="icon-text-btn primary" onClick={apply} title="Apply">
            <IconApply size={13} /> Apply
          </button>
        </div>
      </div>
    </>
  )
}
