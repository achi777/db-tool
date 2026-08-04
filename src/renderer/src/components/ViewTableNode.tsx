import { Handle, Position, type NodeProps } from '@xyflow/react'

export interface ViewTableNodeData {
  alias: string
  table: string
  columns: { name: string; type: string }[]
  outputs: string[]
  onToggle: (col: string) => void
  [key: string]: unknown
}

/**
 * A table on the view-builder canvas. Each column row has a target Handle on the
 * left (id `col:target`) and a source Handle on the right (id `col:source`),
 * both with unique stable ids so React Flow can bind an edge to the exact column.
 *
 * The handles are normal-sized dots (with an enlarged invisible hit-area) rather
 * than full-row overlays: React Flow measures small handles reliably and the
 * canvas uses a generous `connectionRadius`, so a drag started near one edge and
 * dropped near another column's row snaps and binds. The header (`vb-drag`) is
 * the only drag region; the checkbox stops pointer-down propagation so a single
 * click always toggles.
 */
export function ViewTableNode({ data }: NodeProps): JSX.Element {
  const d = data as unknown as ViewTableNodeData
  const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation()
  return (
    <div className="vb-node">
      <div className="vb-node-head vb-drag" title="Drag to move">
        <span className="vb-node-alias">{d.alias}</span> {d.table}
      </div>
      <div className="vb-node-cols nodrag nopan">
        {d.columns.map((c) => {
          const checked = d.outputs.includes(c.name)
          return (
            <div className={'vb-node-col' + (checked ? ' included' : '')} key={c.name}>
              <Handle
                type="target"
                position={Position.Left}
                id={`${c.name}:target`}
                className="vb-handle vb-handle-l"
              />
              {/* Native toggle for when the click lands on the checkbox; a
                  geometry fallback in ViewBuilder.onCanvasClick handles clicks
                  that leak to the pane (unreliable hit-testing into the RF
                  viewport). The label stops propagation so the two never race. */}
              <label
                className="vb-col-check nodrag nopan"
                title="Include in output"
                onPointerDown={stop}
                onMouseDown={stop}
                onClick={stop}
              >
                <input
                  type="checkbox"
                  className="nodrag nopan"
                  checked={checked}
                  onChange={() => d.onToggle(c.name)}
                  onPointerDown={stop}
                />
              </label>
              <span className="vb-col-name">{c.name}</span>
              <span className="vb-col-type">{c.type}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={`${c.name}:source`}
                className="vb-handle vb-handle-r"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
