import type { ColumnSpec, Engine, FilterCondition, FilterGroup, FilterNode, FilterOperator } from '@shared/types'
import { OP_LABEL, opsFor, columnKind, boolTokens } from '../filterOps'
import { IconNew } from '../actionIcons'

/** Reusable recursive editor for a nested AND/OR filter tree (used by the
 * modal filter builder and inline in the view builder's WHERE). Controlled. */
export function FilterTreeEditor(props: {
  node: FilterGroup
  engine: Engine
  columns: ColumnSpec[]
  isRoot?: boolean
  onChange: (n: FilterNode) => void
  onRemove?: () => void
}): JSX.Element {
  const { node, engine, columns, isRoot, onChange, onRemove } = props

  const setChild = (i: number, child: FilterNode): void =>
    onChange({ ...node, children: node.children.map((c, idx) => (idx === i ? child : c)) })
  const removeChild = (i: number): void =>
    onChange({ ...node, children: node.children.filter((_, idx) => idx !== i) })
  const addCondition = (): void => {
    const col = columns[0]
    const op = opsFor(engine, col)[0] ?? 'eq'
    const cond: FilterCondition = { kind: 'condition', column: col?.name ?? '', operator: op }
    onChange({ ...node, children: [...node.children, cond] })
  }
  const addGroup = (): void =>
    onChange({ ...node, children: [...node.children, { kind: 'group', combiner: 'AND', children: [] }] })

  return (
    <div className={'fb-group' + (node.negated ? ' negated' : '')}>
      <div className="fb-group-head">
        <div className="fb-combiner">
          <button className={node.combiner === 'AND' ? 'active' : ''} onClick={() => onChange({ ...node, combiner: 'AND' })}>
            AND
          </button>
          <button className={node.combiner === 'OR' ? 'active' : ''} onClick={() => onChange({ ...node, combiner: 'OR' })}>
            OR
          </button>
        </div>
        <label className="param-check">
          <input type="checkbox" checked={!!node.negated} onChange={(e) => onChange({ ...node, negated: e.target.checked })} /> NOT
        </label>
        <span className="spacer" />
        <button className="icon-text-btn" onClick={addCondition} disabled={columns.length === 0}><IconNew />Condition</button>
        <button className="icon-text-btn" onClick={addGroup}><IconNew />Group</button>
        {!isRoot && (
          <span className="del-x" onClick={onRemove} title="Remove group">×</span>
        )}
      </div>

      <div className="fb-children">
        {node.children.length === 0 && <div className="fb-empty">Empty group — add a condition.</div>}
        {node.children.map((child, i) =>
          child.kind === 'group' ? (
            <FilterTreeEditor key={i} node={child} engine={engine} columns={columns} onChange={(n) => setChild(i, n)} onRemove={() => removeChild(i)} />
          ) : (
            <ConditionRow key={i} node={child} engine={engine} columns={columns} onChange={(n) => setChild(i, n)} onRemove={() => removeChild(i)} />
          )
        )}
      </div>
    </div>
  )
}

function ConditionRow(props: {
  node: FilterCondition
  engine: Engine
  columns: ColumnSpec[]
  onChange: (n: FilterCondition) => void
  onRemove: () => void
}): JSX.Element {
  const { node, engine, columns, onChange, onRemove } = props
  const col = columns.find((c) => c.name === node.column)
  const ops = opsFor(engine, col)
  const isBool = columnKind(engine, col) === 'Boolean'
  const { t: boolT, f: boolF } = boolTokens(engine)

  const onColumn = (name: string): void => {
    const next = columns.find((c) => c.name === name)
    const nextOps = opsFor(engine, next)
    onChange({ kind: 'condition', column: name, operator: nextOps.includes(node.operator) ? node.operator : nextOps[0], value: null, value2: null, values: null })
  }

  const noValue = node.operator === 'isNull' || node.operator === 'isNotNull'
  const twoValues = node.operator === 'between'
  const listValues = node.operator === 'in' || node.operator === 'notIn'

  return (
    <div className="fb-cond">
      <select value={node.column} onChange={(e) => onColumn(e.target.value)}>
        {columns.map((c) => (
          <option key={c.name} value={c.name}>{c.name}</option>
        ))}
      </select>
      <select value={node.operator} onChange={(e) => onChange({ ...node, operator: e.target.value as FilterOperator })}>
        {ops.map((o) => (
          <option key={o} value={o}>{OP_LABEL[o]}</option>
        ))}
      </select>
      {!noValue && isBool && (
        <select value={node.value ?? boolT} onChange={(e) => onChange({ ...node, value: e.target.value })}>
          <option value={boolT}>true</option>
          <option value={boolF}>false</option>
        </select>
      )}
      {!noValue && !isBool && listValues && (
        <input placeholder="a, b, c" value={(node.values ?? []).join(', ')} onChange={(e) => onChange({ ...node, values: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
      )}
      {!noValue && !isBool && twoValues && (
        <>
          <input placeholder="from" value={node.value ?? ''} onChange={(e) => onChange({ ...node, value: e.target.value })} />
          <input placeholder="to" value={node.value2 ?? ''} onChange={(e) => onChange({ ...node, value2: e.target.value })} />
        </>
      )}
      {!noValue && !isBool && !twoValues && !listValues && (
        <input placeholder="value" value={node.value ?? ''} onChange={(e) => onChange({ ...node, value: e.target.value })} />
      )}
      <span className="del-x" onClick={onRemove} title="Remove condition">×</span>
    </div>
  )
}
