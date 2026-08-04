import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { ErColumn } from '@shared/types'
import { IconCollapse, IconExpand } from '../actionIcons'

export interface ErTableNodeData {
  name: string
  columns: ErColumn[]
  /** When true, the column list is hidden (header only). */
  collapsed: boolean
  /** True while this node matches the active search (for highlighting). */
  matched: boolean
  onToggleCollapse: (name: string) => void
  [key: string]: unknown
}

/**
 * An ER-diagram table node: a header (the table name) over a list of column
 * rows. Each row carries a source (right) + target (left) handle so a foreign
 * key can be drawn column-to-column, and shows PK / FK / NOT NULL markers.
 * Modeled on ViewTableNode; the header `.er-drag` is the only drag region.
 */
export function ErTableNode({ data }: NodeProps): JSX.Element {
  const d = data as unknown as ErTableNodeData
  const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation()
  return (
    <div className={'er-node' + (d.matched ? ' er-node-match' : '')}>
      <div className="er-node-head er-drag" title="Drag to move — double-click to edit table">
        {/* Always-present node-level handles so edges can still attach when the
            column list is collapsed (React Flow drops edges with no handle). */}
        <Handle type="target" position={Position.Left} id="__node:target" className="er-handle er-handle-node er-handle-l" />
        <Handle type="source" position={Position.Right} id="__node:source" className="er-handle er-handle-node er-handle-r" />
        <span className="er-node-title">{d.name}</span>
        <button
          className="er-collapse nodrag nopan"
          title={d.collapsed ? 'Expand columns' : 'Collapse columns'}
          onPointerDown={stop}
          onMouseDown={stop}
          onClick={(e) => {
            stop(e)
            d.onToggleCollapse(d.name)
          }}
        >
          {d.collapsed ? <IconCollapse size={12} /> : <IconExpand size={12} />}
        </button>
      </div>
      {!d.collapsed && (
        <div className="er-node-cols nodrag nopan">
          {d.columns.map((c) => (
            <div
              className={'er-node-col' + (c.isPrimaryKey ? ' er-pk' : '')}
              key={c.name}
              title={`${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`}
            >
              <Handle type="target" position={Position.Left} id={`${c.name}:target`} className="er-handle er-handle-l" />
              <span className="er-col-key">
                {c.isPrimaryKey ? '🔑' : c.isForeignKey ? '◇' : ''}
              </span>
              <span className={'er-col-name' + (c.nullable ? '' : ' er-notnull')}>{c.name}</span>
              <span className="er-col-type">{c.type}</span>
              <Handle type="source" position={Position.Right} id={`${c.name}:source`} className="er-handle er-handle-r" />
            </div>
          ))}
          {d.columns.length === 0 && <div className="er-node-col er-empty">(no columns)</div>}
        </div>
      )}
    </div>
  )
}
