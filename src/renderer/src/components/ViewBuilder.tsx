import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  ConnectionLineType,
  ConnectionMode,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type OnConnectEnd
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ColumnSpec, FilterGroup, VbAggregate, VbTable, ViewModel } from '@shared/types'
import { generateViewSelect, resolveOutputAliases, supportedJoinTypes } from '@shared/viewBuilder'
import { useStore } from '../store'
import { ViewTableNode } from './ViewTableNode'
import { FilterTreeEditor } from './FilterTreeEditor'

const nodeTypes = { table: ViewTableNode }
const AGGS: (VbAggregate | '')[] = ['', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX']

export function ViewBuilder(): JSX.Element {
  const tab = useStore((s) => s.getActiveTab())
  const engineOf = useStore((s) => s.engineOf)
  const catalogByConn = useStore((s) => s.catalogByConn)
  const refreshCatalog = useStore((s) => s.refreshCatalog)
  const setViewModel = useStore((s) => s.setViewModel)
  const previewViewBuilder = useStore((s) => s.previewViewBuilder)
  const saveViewBuilder = useStore((s) => s.saveViewBuilder)
  const themeMode = useStore((s) => s.theme)
  const vbColors = useMemo(() => {
    const dark = themeMode === 'dark'
    return {
      edge: dark ? '#7c9cff' : '#3b6fe0',
      edgeSel: dark ? '#4caf8f' : '#1f8a6d',
      label: dark ? '#e4e4ef' : '#1f2330',
      labelBg: dark ? '#2a2a3c' : '#eceef2'
    }
  }, [themeMode])

  const [rfNodes, setRfNodes] = useState<Node[]>([])
  const [addSel, setAddSel] = useState('')
  // Prefill the save-as name when editing an existing view (see openViewInBuilder).
  const [saveName, setSaveName] = useState(tab?.vbName ?? '')
  const [message, setMessage] = useState<string | null>(null)
  const [selectedJoin, setSelectedJoin] = useState<string | null>(null)
  // Right-click context menu for a join edge (screen coords + target join id).
  const [edgeMenu, setEdgeMenu] = useState<{ x: number; y: number; joinId: string } | null>(null)
  // Timestamp of the last connection drag end; used to suppress the synthetic
  // click that a drag's mouse-up fires on the canvas (would else toggle output).
  const connEndAt = useRef(0)

  // Close the edge context menu on Escape.
  useEffect(() => {
    if (!edgeMenu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setEdgeMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [edgeMenu])

  const connId = tab?.connectionId ?? null
  const engine = engineOf(connId) ?? 'postgres'
  const catalog = connId ? catalogByConn[connId] : undefined
  const model = tab?.viewModel
  const modelRef = useRef(model)
  modelRef.current = model

  useEffect(() => {
    if (connId && !catalog) void refreshCatalog(connId)
  }, [connId, catalog, refreshCatalog])

  const update = (m: ViewModel): void => tab && setViewModel(tab.id, m)

  const catColumns = (t: VbTable): { name: string; type: string }[] =>
    catalog?.tables.find((c) => c.name === t.table && (engine === 'sqlite' || c.schema === t.schema))?.columns ?? []

  const toggleOutput = (tableId: string, col: string): void => {
    const m = modelRef.current
    if (!m) return
    const exists = m.outputs.some((o) => o.tableId === tableId && o.column === col && !o.aggregate)
    update({
      ...m,
      outputs: exists
        ? m.outputs.filter((o) => !(o.tableId === tableId && o.column === col))
        : [...m.outputs, { id: `out-${tableId}-${col}`, tableId, column: col, alias: null, aggregate: null }]
    })
  }

  // --- React Flow nodes synced from the model ---
  // Uses useEffect + functional update so existing React Flow internal state
  // (measured dimensions, selection, drag tracking) is preserved across
  // model/catalog changes. Without this, RF cannot compute handle positions
  // and node dragging breaks (all nodes move together as a pane drag).
  useEffect(() => {
    if (!model) { setRfNodes([]); return }
    setRfNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]))
      return model.tables.map((t, i) => {
        const existing = byId.get(t.id)
        return {
          ...(existing ?? {}),
          id: t.id,
          type: 'table' as const,
          dragHandle: '.vb-drag',
          position: existing?.position ?? { x: 30 + i * 240, y: 30 },
          data: {
            alias: t.alias,
            table: t.table,
            columns: catColumns(t),
            outputs: model.outputs.filter((o) => o.tableId === t.id).map((o) => o.column),
            onToggle: (col: string) => toggleOutput(t.id, col)
          }
        } as Node
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, catalog])

  // Effective x of a node (from RF node state, else its default slot).
  const posX = (id: string): number => {
    const n = rfNodes.find((nd) => nd.id === id)
    return n?.position?.x ?? ((model?.tables.findIndex((t) => t.id === id) ?? 0) * 240 + 30)
  }

  const edges: Edge[] = useMemo(() => {
    if (!model) return []
    return model.joins.map((j) => {
      // Render source->(right, source-type handle) target->(left, target-type
      // handle), choosing whichever node is visually left so the line is clean
      // and stays bound to the exact column rows when a node moves.
      const leftIsLeft = posX(j.leftId) <= posX(j.rightId)
      const lc = j.conds[0]?.leftCol ?? ''
      const rc = j.conds[0]?.rightCol ?? ''
      const visLeftId = leftIsLeft ? j.leftId : j.rightId
      const visRightId = leftIsLeft ? j.rightId : j.leftId
      const visLeftCol = leftIsLeft ? lc : rc
      const visRightCol = leftIsLeft ? rc : lc
      const sel = selectedJoin === j.id
      return {
        id: j.id,
        source: visLeftId,
        sourceHandle: `${visLeftCol}:source`,
        target: visRightId,
        targetHandle: `${visRightCol}:target`,
        label: j.type,
        labelStyle: { fill: vbColors.label, fontSize: 10 },
        labelBgStyle: { fill: vbColors.labelBg },
        style: { stroke: sel ? vbColors.edgeSel : vbColors.edge, strokeWidth: sel ? 2.5 : 1.5 }
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, rfNodes, selectedJoin, vbColors])

  const onNodesChange = (changes: NodeChange[]): void => {
    if (!model) return
    // Apply ALL changes (position, dimensions, selection, etc.) so React Flow
    // retains its internal state — critical for handle hit-testing and per-node drag.
    setRfNodes((prev) => applyNodeChanges(changes, prev))
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id)
    if (removed.length) {
      update({
        ...model,
        tables: model.tables.filter((t) => !removed.includes(t.id)),
        joins: model.joins.filter((j) => !removed.includes(j.leftId) && !removed.includes(j.rightId)),
        outputs: model.outputs.filter((o) => !removed.includes(o.tableId)),
        groupBy: model.groupBy.filter((g) => !removed.includes(g.tableId)),
        orderBy: model.orderBy.filter((o) => !removed.includes(o.tableId))
      })
    }
  }

  const onEdgesChange = (changes: EdgeChange[]): void => {
    if (!model) return
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id)
    if (removed.length) update({ ...model, joins: model.joins.filter((j) => !removed.includes(j.id)) })
  }

  const strip = (h: string | null | undefined): string => (h ?? '').replace(/:(source|target)$/, '')

  // Permissive: only block connecting a table instance to itself.
  const isValidConnection = (conn: Connection | Edge): boolean =>
    !!conn.source && !!conn.target && conn.source !== conn.target

  const addJoin = (leftId: string, rightId: string, leftCol: string, rightCol: string): void => {
    if (!model || !leftId || !rightId || leftId === rightId || !leftCol || !rightCol) return
    const dup = model.joins.some(
      (j) => j.leftId === leftId && j.rightId === rightId && j.conds.some((c) => c.leftCol === leftCol && c.rightCol === rightCol)
    )
    if (dup) return
    const id = `j-${Date.now()}`
    update({ ...model, joins: [...model.joins, { id, type: 'INNER', leftId, rightId, conds: [{ leftCol, rightCol }] }] })
    setSelectedJoin(id)
  }

  const onConnect = (conn: Connection): void => {
    if (!conn.source || !conn.target) return
    addJoin(conn.source, conn.target, strip(conn.sourceHandle), strip(conn.targetHandle))
  }

  const removeJoin = (id: string): void => {
    if (!model) return
    update({ ...model, joins: model.joins.filter((j) => j.id !== id) })
    if (selectedJoin === id) setSelectedJoin(null)
  }

  // Resolve which column row (nodeId + column) sits under a client point, using
  // getBoundingClientRect geometry. This is reliable even in this Electron/
  // Chromium build where React Flow's pointer hit-testing INTO the transformed,
  // pointer-events:none viewport is not (clicks/drops leak to the pane).
  const columnAt = (clientX: number, clientY: number): { nodeId: string; col: string } | null => {
    const rows = document.querySelectorAll<HTMLElement>('.react-flow__node .vb-node-col')
    let best: { nodeId: string; col: string } | null = null
    let bestDist = Infinity
    rows.forEach((row) => {
      const r = row.getBoundingClientRect()
      if (clientY < r.top - 4 || clientY > r.bottom + 4) return
      if (clientX < r.left - 24 || clientX > r.right + 24) return
      const d = Math.abs(clientY - (r.top + r.bottom) / 2)
      if (d >= bestDist) return
      const nodeId = row.closest<HTMLElement>('.react-flow__node')?.getAttribute('data-id') ?? ''
      const col = strip(row.querySelector<HTMLElement>('.react-flow__handle[data-handleid]')?.getAttribute('data-handleid'))
      if (nodeId && col) {
        best = { nodeId, col }
        bestDist = d
      }
    })
    return best
  }

  // BUG-1 workaround: the connection START works, but React Flow fails to detect
  // the drop target here, so onConnect rarely fires. On connect-end we resolve
  // the target column ourselves by geometry and create the join (unless React
  // Flow already bound it).
  const onConnectEnd: OnConnectEnd = (event, state) => {
    connEndAt.current = Date.now()
    if (state.isValid) return
    const from = state.fromHandle
    if (!from || !from.nodeId) return
    const pt = 'clientX' in event ? event : event.changedTouches?.[0]
    if (!pt) return
    const target = columnAt(pt.clientX, pt.clientY)
    if (!target || target.nodeId === from.nodeId) return
    const fromCol = strip(from.id)
    if (from.type === 'source') addJoin(from.nodeId, target.nodeId, fromCol, target.col)
    else addJoin(target.nodeId, from.nodeId, target.col, fromCol)
  }

  // Nearest join edge to a client point, by sampling each edge's SVG path.
  // Reliable even where React Flow's own edge hit-testing leaks to the pane.
  const edgeAt = (clientX: number, clientY: number): string | null => {
    let best: string | null = null
    let bestD = 20 // px — forgiving so a right-click near the join line hits it
    document.querySelectorAll('.react-flow__edge').forEach((e) => {
      const path = (e.querySelector('.react-flow__edge-interaction') ??
        e.querySelector('.react-flow__edge-path')) as SVGPathElement | null
      const ctm = path?.getScreenCTM()
      if (!path || !ctm) return
      const len = path.getTotalLength()
      const n = Math.max(16, Math.min(240, Math.round(len / 5)))
      for (let i = 0; i <= n; i++) {
        const p = path.getPointAtLength((len * i) / n)
        const sx = p.x * ctm.a + p.y * ctm.c + ctm.e
        const sy = p.x * ctm.b + p.y * ctm.d + ctm.f
        const d = Math.hypot(sx - clientX, sy - clientY)
        if (d < bestD) {
          bestD = d
          best = e.getAttribute('data-id')
        }
      }
    })
    return best
  }

  const openEdgeMenu = (clientX: number, clientY: number, joinId: string): void => {
    setSelectedJoin(joinId)
    const MW = 170
    const MH = 76
    setEdgeMenu({ x: Math.min(clientX, window.innerWidth - MW - 8), y: Math.min(clientY, window.innerHeight - MH - 8), joinId })
  }

  // Right-click anywhere on the canvas: if it's on (near) a join edge, open the
  // delete/edit menu — React Flow's onEdgeContextMenu leaks to the pane here.
  const onCanvasContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const joinId = edgeAt(e.clientX, e.clientY)
    if (!joinId) return
    e.preventDefault()
    openEdgeMenu(e.clientX, e.clientY, joinId)
  }

  // BUG-2 workaround: checkbox clicks that leak to the pane still bubble to the
  // canvas. When the on-node checkbox handled it, its label stops propagation so
  // this never runs (no double toggle); otherwise we toggle by geometry here.
  const onCanvasClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (Date.now() - connEndAt.current < 400) return // click from a just-ended drag
    const t = e.target as HTMLElement
    // Skip the drag handle, connection handles, and the checkbox label (which
    // toggles natively and stops propagation, so this must not double-toggle).
    if (t.closest('.vb-node-head') || t.closest('.react-flow__handle') || t.closest('.vb-col-check')) return
    const hit = columnAt(e.clientX, e.clientY)
    if (hit) toggleOutput(hit.nodeId, hit.col)
  }

  const addTable = (): void => {
    if (!model || !addSel) return
    const [schema, table] = addSel.split(' ')
    const n = model.tables.length
    const id = `vt-${Date.now()}`
    update({ ...model, tables: [...model.tables, { id, schema, table, alias: `t${n + 1}` }] })
  }

  const autoJoinFk = async (): Promise<void> => {
    if (!model || !connId || model.tables.length < 2) return
    const specs = await Promise.all(
      model.tables.map((t) => window.dbApi.getTableSpec(connId, t.schema, t.table))
    )
    const joins = [...model.joins]
    for (let i = 0; i < model.tables.length; i++) {
      const res = specs[i]
      if (!res.ok) continue
      for (const fk of res.data.foreignKeys) {
        const other = model.tables.find((t, k) => k !== i && t.table === fk.refTable)
        if (!other) continue
        const already = joins.some(
          (j) => (j.leftId === model.tables[i].id && j.rightId === other.id) || (j.rightId === model.tables[i].id && j.leftId === other.id)
        )
        if (already) continue
        joins.push({
          id: `j-fk-${Date.now()}-${i}`,
          type: 'LEFT',
          leftId: model.tables[i].id,
          rightId: other.id,
          conds: fk.columns.map((c, idx) => ({ leftCol: c, rightCol: fk.refColumns[idx] }))
        })
      }
    }
    update({ ...model, joins })
  }

  const setOutput = (id: string, patch: Partial<{ alias: string | null; aggregate: VbAggregate | null }>): void => {
    if (!model) return
    update({ ...model, outputs: model.outputs.map((o) => (o.id === id ? { ...o, ...patch } : o)) })
  }
  const moveOutput = (i: number, dir: -1 | 1): void => {
    if (!model) return
    const j = i + dir
    if (j < 0 || j >= model.outputs.length) return
    const outs = [...model.outputs]
    ;[outs[i], outs[j]] = [outs[j], outs[i]]
    update({ ...model, outputs: outs })
  }

  const whereColumns: ColumnSpec[] = useMemo(() => {
    if (!model) return []
    return model.tables.flatMap((t) =>
      catColumns(t).map((c) => ({ name: `${t.alias}.${c.name}`, type: c.type, nullable: true }) as ColumnSpec)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, catalog])

  if (!tab?.viewModel || !model) return <div className="empty">No view builder open.</div>

  const generated = generateViewSelect(engine, model, 'inline')
  const joinTypes = supportedJoinTypes(engine)
  const canBuild = model.tables.length > 0

  // Effective output names (auto-aliased duplicates). Any names that STILL
  // collide can only be user-set aliases — flag them and block save.
  const resolvedOutputs = resolveOutputAliases(model)
  const resolvedById = new Map(resolvedOutputs.map((r) => [r.id, r]))
  const nameCounts = new Map<string, number>()
  for (const r of resolvedOutputs) nameCounts.set(r.displayName.toLowerCase(), (nameCounts.get(r.displayName.toLowerCase()) ?? 0) + 1)
  const dupOutputIds = new Set(resolvedOutputs.filter((r) => (nameCounts.get(r.displayName.toLowerCase()) ?? 0) > 1).map((r) => r.id))
  const hasDupOutputs = dupOutputIds.size > 0

  const doSave = async (): Promise<void> => {
    const r = await saveViewBuilder(tab.id, saveName)
    setMessage(r.message)
  }

  return (
    <div className="vb">
      <div className="vb-toolbar">
        <select value={addSel} onChange={(e) => setAddSel(e.target.value)} style={{ width: 180 }}>
          <option value="">— add table —</option>
          {catalog?.tables.map((t) => (
            <option key={t.schema + '.' + t.name} value={`${t.schema} ${t.name}`}>
              {t.name}
            </option>
          ))}
        </select>
        <button onClick={addTable} disabled={!addSel}>+ Table</button>
        <button onClick={() => void autoJoinFk()} disabled={model.tables.length < 2} title="Create joins from foreign keys">
          Auto-join (FK)
        </button>
        <label className="param-check">
          <input type="checkbox" checked={model.distinct} onChange={(e) => update({ ...model, distinct: e.target.checked })} /> DISTINCT
        </label>
        <span className="pg-hint">drag from any column row onto another table's column row to JOIN · joins: {joinTypes.join('/')}</span>
        <span className="spacer" />
        <button onClick={() => void previewViewBuilder(tab.id)} disabled={!canBuild || hasDupOutputs}>Preview results</button>
        <input placeholder="view name" value={saveName} onChange={(e) => setSaveName(e.target.value)} style={{ width: 130 }} />
        <button className="primary" onClick={() => void doSave()} disabled={!canBuild || !saveName.trim() || hasDupOutputs} title={hasDupOutputs ? 'Resolve duplicate output names first' : undefined}>Save as view</button>
      </div>
      {hasDupOutputs && <div className="msg err" style={{ margin: '0 10px' }}>⚠ Duplicate output name(s) — rename the highlighted alias(es) below to save.</div>}
      {message && <div className={'msg ' + (message.startsWith('❌') ? 'err' : 'ok')} style={{ margin: '0 10px' }}>{message}</div>}

      <div className="vb-main">
        <div className="vb-canvas" onClick={onCanvasClick} onContextMenu={onCanvasContextMenu}>
          <ReactFlow
            nodes={rfNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            connectionMode={ConnectionMode.Loose}
            onEdgeClick={(_e, edge) => setSelectedJoin(edge.id)}
            onEdgeContextMenu={(e, edge) => {
              e.preventDefault()
              openEdgeMenu(e.clientX, e.clientY, edge.id)
            }}
            onPaneClick={() => setSelectedJoin(null)}
            connectionLineType={ConnectionLineType.SmoothStep}
            connectionLineStyle={{ stroke: vbColors.edge, strokeWidth: 2 }}
            connectionRadius={55}
            fitView
            fitViewOptions={{ maxZoom: 1 }}
            colorMode={themeMode}
            defaultEdgeOptions={{ type: 'smoothstep' }}
          >
            <Background />
            <Controls />
          </ReactFlow>
          {model.tables.length === 0 && <div className="vb-canvas-hint">Add a table to start building.</div>}
        </div>

        <div className="vb-side">
          <div className="section-title" style={{ marginTop: 0 }}>Join types</div>
          {model.joins.length === 0 ? (
            <div className="ddl-note">No joins. Drag between column handles, or Auto-join (FK). Right-click a join line to delete it.</div>
          ) : (
            model.joins.map((j) => {
              const l = model.tables.find((t) => t.id === j.leftId)
              const r = model.tables.find((t) => t.id === j.rightId)
              return (
                <div
                  className={'vb-join-row' + (selectedJoin === j.id ? ' vb-join-sel' : '')}
                  key={j.id}
                  onClick={() => setSelectedJoin(j.id)}
                >
                  <span>{l?.alias}→{r?.alias}</span>
                  <select value={j.type} onChange={(e) => update({ ...model, joins: model.joins.map((x) => (x.id === j.id ? { ...x, type: e.target.value as typeof x.type } : x)) })}>
                    {joinTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <span className="vb-on">{j.conds.map((c) => `${c.leftCol}=${c.rightCol}`).join(', ')}</span>
                  <span className="del-x" onClick={(ev) => { ev.stopPropagation(); removeJoin(j.id) }} title="Remove join">×</span>
                </div>
              )
            })
          )}

          <div className="section-title">Output columns</div>
          {model.outputs.length === 0 ? (
            <div className="ddl-note">Tick column checkboxes on the canvas to add outputs.</div>
          ) : (
            model.outputs.map((o, i) => {
              const t = model.tables.find((x) => x.id === o.tableId)
              const r = resolvedById.get(o.id)
              const isDup = dupOutputIds.has(o.id)
              return (
                <div className={'vb-out-row' + (isDup ? ' vb-out-dup' : '')} key={o.id}>
                  <span className="vb-out-col">{t?.alias}.{o.column}</span>
                  <select value={o.aggregate ?? ''} onChange={(e) => setOutput(o.id, { aggregate: (e.target.value || null) as VbAggregate | null })}>
                    {AGGS.map((a) => <option key={a} value={a}>{a || '—'}</option>)}
                  </select>
                  <input
                    className={isDup ? 'vb-alias-dup' : undefined}
                    placeholder={r?.displayName ?? 'alias'}
                    value={o.alias ?? ''}
                    onChange={(e) => setOutput(o.id, { alias: e.target.value || null })}
                    style={{ width: 90 }}
                  />
                  {r?.auto && <span className="vb-auto-tag" title={`auto-aliased to “${r.displayName}” (duplicate name)`}>auto</span>}
                  {isDup && <span className="vb-dup-warn" title="Duplicate output name — rename to save">dup</span>}
                  <span className="del-x" onClick={() => moveOutput(i, -1)} title="up">↑</span>
                  <span className="del-x" onClick={() => moveOutput(i, 1)} title="down">↓</span>
                  <span className="del-x" onClick={() => update({ ...model, outputs: model.outputs.filter((x) => x.id !== o.id) })}>×</span>
                </div>
              )
            })
          )}

          <div className="section-title">WHERE</div>
          <FilterTreeEditor
            node={model.where ?? { kind: 'group', combiner: 'AND', children: [] }}
            engine={engine}
            columns={whereColumns}
            isRoot
            onChange={(n) => update({ ...model, where: n as FilterGroup })}
          />

          <div className="section-title">ORDER BY</div>
          <OrderByEditor model={model} update={update} columns={whereColumns} />
        </div>
      </div>

      <div className="vb-sql">
        <div className="section-title" style={{ marginTop: 0 }}>Generated SELECT</div>
        <pre className="ddl-pre">{generated.sql || '-- add a table and pick output columns'}</pre>
      </div>

      {edgeMenu && (
        <>
          <div
            className="vb-menu-backdrop"
            onClick={() => setEdgeMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setEdgeMenu(null)
            }}
          />
          <div className="context-menu" style={{ left: edgeMenu.x, top: edgeMenu.y }} onClick={(e) => e.stopPropagation()}>
            <div
              className="context-item danger"
              onClick={() => {
                removeJoin(edgeMenu.joinId)
                setEdgeMenu(null)
              }}
            >
              Delete join
            </div>
            <div
              className="context-item"
              onClick={() => {
                setSelectedJoin(edgeMenu.joinId)
                setEdgeMenu(null)
              }}
            >
              Edit join…
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function OrderByEditor(props: { model: ViewModel; update: (m: ViewModel) => void; columns: ColumnSpec[] }): JSX.Element {
  const { model, update, columns } = props
  const [sel, setSel] = useState('')
  const add = (): void => {
    if (!sel) return
    const [alias, column] = sel.split('.')
    const t = model.tables.find((x) => x.alias === alias)
    if (!t) return
    update({ ...model, orderBy: [...model.orderBy, { tableId: t.id, column, dir: 'ASC' }] })
    setSel('')
  }
  return (
    <div>
      <div className="vb-join-row">
        <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ flex: 1 }}>
          <option value="">— column —</option>
          {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        <button onClick={add} disabled={!sel}>+ Order</button>
      </div>
      {model.orderBy.map((o, i) => {
        const t = model.tables.find((x) => x.id === o.tableId)
        return (
          <div className="vb-out-row" key={i}>
            <span className="vb-out-col">{t?.alias}.{o.column}</span>
            <select value={o.dir} onChange={(e) => update({ ...model, orderBy: model.orderBy.map((x, k) => (k === i ? { ...x, dir: e.target.value as 'ASC' | 'DESC' } : x)) })}>
              <option value="ASC">ASC</option>
              <option value="DESC">DESC</option>
            </select>
            <span className="del-x" onClick={() => update({ ...model, orderBy: model.orderBy.filter((_, k) => k !== i) })}>×</span>
          </div>
        )
      })}
    </div>
  )
}
