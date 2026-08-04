import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Panel,
  MarkerType,
  ConnectionLineType,
  ConnectionMode,
  useReactFlow,
  useUpdateNodeInternals,
  getNodesBounds,
  getViewportForBounds,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnectEnd
} from '@xyflow/react'
import { toPng, toSvg } from 'html-to-image'
import '@xyflow/react/dist/style.css'
import type {
  DdlRequest,
  DdlPreview,
  ErLayout,
  ErModel,
  FkAction,
  ForeignKeySpec,
  ObjectOpRequest,
  TableSpec
} from '@shared/types'
import { useStore } from '../store'
import { ErTableNode } from './ErTableNode'
import { autoLayout } from '../erLayout'
import {
  IconRefresh,
  IconLayout,
  IconFit,
  IconNew,
  IconExportImage,
  IconSearchGo,
  IconPreview,
  IconDelete,
  IconApply,
  IconReset
} from '../actionIcons'

const nodeTypes = { table: ErTableNode }
const FK_ACTIONS: FkAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']

/** A drawn-but-unconfirmed foreign key (child column -> parent column). */
interface FkDraft {
  childTable: string
  childCol: string
  parentTable: string
  parentCol: string
}

/** A destructive/DDL action awaiting preview + confirm. */
type PendingAction =
  | { title: string; kind: 'ddl'; req: DdlRequest; targetName: string }
  | { title: string; kind: 'objectOp'; req: ObjectOpRequest; targetName: string }

export function ErDiagram(): JSX.Element {
  return (
    <ReactFlowProvider>
      <ErDiagramInner />
    </ReactFlowProvider>
  )
}

function ErDiagramInner(): JSX.Element {
  const tab = useStore((s) => s.getActiveTab())
  const engineOf = useStore((s) => s.engineOf)
  const openNewTableDesigner = useStore((s) => s.openNewTableDesigner)
  const openEditTableDesigner = useStore((s) => s.openEditTableDesigner)
  const refreshErSchema = useStore((s) => s.refreshErSchema)
  const themeMode = useStore((s) => s.theme)
  // Theme-aware colors for React Flow inline styles (edges/minimap/export).
  const erColors = useMemo(() => {
    const dark = themeMode === 'dark'
    return {
      edge: dark ? '#7c9cff' : '#3b6fe0',
      label: dark ? '#b9c0e0' : '#3a4055',
      labelBg: dark ? '#22222f' : '#eceef2',
      miniNode: dark ? '#3a3a52' : '#c8ccd6',
      miniMask: dark ? 'rgba(20,20,30,0.6)' : 'rgba(210,215,225,0.5)',
      exportBg: dark ? '#1e1e2a' : '#f6f7f9'
    }
  }, [themeMode])
  const rf = useReactFlow()
  const updateNodeInternals = useUpdateNodeInternals()

  const connId = tab?.connectionId ?? null
  const schema = tab?.erSchema ?? ''
  const engine = engineOf(connId) ?? 'postgres'

  const [model, setModel] = useState<ErModel | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  // Interaction state
  const [fkDraft, setFkDraft] = useState<FkDraft | null>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'node'; table: string } | { x: number; y: number; kind: 'edge'; edgeId: string } | null>(null)
  // Suppress the synthetic click a connection drag's mouse-up fires.
  const connEndAt = useRef(0)
  const wrapRef = useRef<HTMLDivElement>(null)

  // --- Load model + persisted layout -----------------------------------------
  const loadModel = useCallback(
    async (opts?: { keepPositions?: boolean }): Promise<void> => {
      if (!connId || !schema) return
      setLoading(true)
      setError(null)
      const res = await window.dbApi.getErModel(connId, schema)
      if (!res.ok) {
        setError(res.error)
        setLoading(false)
        return
      }
      const m = res.data
      setModel(m)
      // Resolve positions: keep any existing, load saved, auto-layout the rest.
      let saved: ErLayout | null = null
      if (!opts?.keepPositions) {
        const lay = await window.dbApi.loadErLayout(connId, schema)
        if (lay.ok) saved = lay.data
      }
      setCollapsed((prev) => {
        const base = opts?.keepPositions ? prev : new Set(saved?.collapsed ?? [])
        return base
      })
      setPositions((prev) => {
        const start = opts?.keepPositions ? { ...prev } : { ...(saved?.positions ?? {}) }
        const missing = m.tables.filter((t) => !start[t.name])
        if (missing.length) {
          const collapsedSet = new Set(opts?.keepPositions ? [...collapsed] : saved?.collapsed ?? [])
          const auto = autoLayout(m, collapsedSet)
          for (const t of missing) if (auto[t.name]) start[t.name] = auto[t.name]
        }
        // Drop positions for tables that no longer exist.
        const names = new Set(m.tables.map((t) => t.name))
        for (const k of Object.keys(start)) if (!names.has(k)) delete start[k]
        return start
      })
      setLoading(false)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connId, schema]
  )

  useEffect(() => {
    void loadModel()
  }, [loadModel])

  // React Flow computes edge paths from measured handle bounds; in this
  // Electron/Chromium build that measurement can race the first paint, leaving
  // FK edges unrendered. Force RF to re-read each node's handle positions once
  // after the model loads (a single settle, on the next frame) so the edges
  // appear without repeatedly re-measuring (which would make them flicker).
  useEffect(() => {
    if (!model) return
    const id = setTimeout(() => {
      for (const t of model.tables) updateNodeInternals(t.name)
    }, 250)
    return () => clearTimeout(id)
  }, [model, updateNodeInternals])

  // --- Persist layout (debounced) --------------------------------------------
  const persistRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const schedulePersist = useCallback(
    (pos: Record<string, { x: number; y: number }>, col: Set<string>) => {
      if (!connId || !schema) return
      if (persistRef.current) clearTimeout(persistRef.current)
      persistRef.current = setTimeout(() => {
        void window.dbApi.saveErLayout(connId, schema, { positions: pos, collapsed: [...col] })
      }, 500)
    },
    [connId, schema]
  )

  // --- Derived matched set for search ----------------------------------------
  const matched = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q || !model) return new Set<string>()
    return new Set(model.tables.filter((t) => t.name.toLowerCase().includes(q)).map((t) => t.name))
  }, [search, model])

  const toggleCollapse = useCallback(
    (name: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(name)) next.delete(name)
        else next.add(name)
        schedulePersist(positions, next)
        return next
      })
    },
    [positions, schedulePersist]
  )

  // --- Nodes / edges ---------------------------------------------------------
  const nodes: Node[] = useMemo(() => {
    if (!model) return []
    return model.tables.map((t, i) => ({
      id: t.name,
      type: 'table',
      dragHandle: '.er-drag',
      position: positions[t.name] ?? { x: 40 + (i % 6) * 260, y: 40 + Math.floor(i / 6) * 220 },
      data: {
        name: t.name,
        columns: t.columns,
        collapsed: collapsed.has(t.name),
        matched: matched.has(t.name),
        onToggleCollapse: toggleCollapse
      }
    }))
  }, [model, positions, collapsed, matched, toggleCollapse])

  const edges: Edge[] = useMemo(() => {
    if (!model) return []
    const names = new Set(model.tables.map((t) => t.name))
    const out: Edge[] = []
    for (const t of model.tables) {
      t.foreignKeys.forEach((fk, fi) => {
        if (!names.has(fk.refTable)) return // FK to a table outside this schema view
        const childCol = fk.columns[0] ?? ''
        const refCol = fk.refColumns[0] ?? ''
        // Attach every edge to the always-present node-level handles (table→
        // table). These handles never change when a node collapses/expands, so
        // React Flow doesn't have to re-measure per-column handle geometry — that
        // measurement is unreliable in this Electron/Chromium build and would
        // leave FK edges unrendered. The per-column handles remain only for the
        // FK-drawing gesture (resolved geometrically, not by RF hit-testing).
        out.push({
          id: `fk:${t.name}:${fk.name ?? fi}:${childCol}`,
          source: t.name,
          sourceHandle: '__node:source',
          target: fk.refTable,
          targetHandle: '__node:target',
          type: 'smoothstep',
          label: `${childCol} → ${refCol}`,
          labelStyle: { fill: erColors.label, fontSize: 9 },
          labelBgStyle: { fill: erColors.labelBg },
          labelShowBg: true,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: erColors.edge },
          style: { stroke: erColors.edge, strokeWidth: 1.5 },
          data: { childTable: t.name, fkName: fk.name ?? null, fkIndex: fi }
        })
      })
    }
    return out
  }, [model, erColors])

  // --- Drag/position changes -------------------------------------------------
  const onNodesChange = (changes: NodeChange[]): void => {
    // Only react to real position changes. RF also emits 'dimensions' changes
    // during measurement — returning a fresh object for those would re-render →
    // re-measure → loop, which continuously resets the FK edges.
    if (!changes.some((c) => c.type === 'position' && c.position)) return
    setPositions((prev) => {
      const next = { ...prev }
      for (const ch of changes) {
        if (ch.type === 'position' && ch.position) next[ch.id] = ch.position
      }
      schedulePersist(next, collapsed)
      return next
    })
  }

  // --- FK by drawing (geometry, like ViewBuilder) ----------------------------
  const strip = (h: string | null | undefined): string => (h ?? '').replace(/:(source|target)$/, '')

  const columnAt = (clientX: number, clientY: number): { table: string; col: string } | null => {
    const rows = document.querySelectorAll<HTMLElement>('.react-flow__node .er-node-col')
    let best: { table: string; col: string } | null = null
    let bestDist = Infinity
    rows.forEach((row) => {
      const r = row.getBoundingClientRect()
      if (clientY < r.top - 4 || clientY > r.bottom + 4) return
      if (clientX < r.left - 24 || clientX > r.right + 24) return
      const d = Math.abs(clientY - (r.top + r.bottom) / 2)
      if (d >= bestDist) return
      const table = row.closest<HTMLElement>('.react-flow__node')?.getAttribute('data-id') ?? ''
      const col = strip(row.querySelector<HTMLElement>('.react-flow__handle[data-handleid]')?.getAttribute('data-handleid'))
      if (table && col) {
        best = { table, col }
        bestDist = d
      }
    })
    return best
  }

  const proposeFk = (childTable: string, childCol: string, parentTable: string, parentCol: string): void => {
    if (!childTable || !parentTable || childTable === parentTable) return
    setFkDraft({ childTable, childCol, parentTable, parentCol })
  }

  const onConnectEnd: OnConnectEnd = (event, state) => {
    connEndAt.current = Date.now()
    if (state.isValid) return
    const from = state.fromHandle
    if (!from || !from.nodeId) return
    const pt = 'clientX' in event ? event : event.changedTouches?.[0]
    if (!pt) return
    const target = columnAt(pt.clientX, pt.clientY)
    if (!target || target.table === from.nodeId) return
    const fromCol = strip(from.id)
    // Drag START is treated as the child (FK-bearing) side by default.
    if (from.type === 'source') proposeFk(from.nodeId, fromCol, target.table, target.col)
    else proposeFk(target.table, target.col, from.nodeId, fromCol)
  }

  const onConnect = (conn: Connection): void => {
    if (!conn.source || !conn.target || conn.source === conn.target) return
    proposeFk(conn.source, strip(conn.sourceHandle), conn.target, strip(conn.targetHandle))
  }

  // --- Edge hit-testing for right-click (geometry, like ViewBuilder) ---------
  const edgeAt = (clientX: number, clientY: number): string | null => {
    let best: string | null = null
    let bestD = 20
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

  const onCanvasContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const t = e.target as HTMLElement
    const nodeEl = t.closest<HTMLElement>('.react-flow__node')
    if (nodeEl) {
      const table = nodeEl.getAttribute('data-id')
      if (table) {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY, kind: 'node', table })
        return
      }
    }
    const edgeId = edgeAt(e.clientX, e.clientY)
    if (edgeId) {
      e.preventDefault()
      setMenu({ x: e.clientX, y: e.clientY, kind: 'edge', edgeId })
    }
  }

  // Close menu on Escape / any left click.
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  const onNodeDoubleClick = (_e: unknown, node: Node): void => {
    if (connId) void openEditTableDesigner(connId, schema, node.id)
  }

  // --- Build DDL requests for edit ops ---------------------------------------
  const buildAddFkReq = async (draft: FkDraft, name: string, onDelete: FkAction, onUpdate: FkAction): Promise<DdlRequest | null> => {
    if (!connId) return null
    const res = await window.dbApi.getTableSpec(connId, schema, draft.childTable)
    if (!res.ok) {
      setStatus(`❌ ${res.error}`)
      return null
    }
    const original = res.data
    const fk: ForeignKeySpec = {
      name: name.trim() || null,
      columns: [draft.childCol],
      refSchema: engine === 'sqlite' ? null : schema,
      refTable: draft.parentTable,
      refColumns: [draft.parentCol],
      onDelete,
      onUpdate
    }
    const spec: TableSpec = { ...original, foreignKeys: [...original.foreignKeys, fk] }
    return { connectionId: connId, mode: 'alter', spec, original }
  }

  const dropFkReq = async (edgeId: string): Promise<void> => {
    if (!connId || !model) return
    const edge = edges.find((e) => e.id === edgeId)
    if (!edge) return
    const childTable = edge.data?.childTable as string
    const fkName = edge.data?.fkName as string | null
    const fkIndex = edge.data?.fkIndex as number
    const res = await window.dbApi.getTableSpec(connId, schema, childTable)
    if (!res.ok) {
      setStatus(`❌ ${res.error}`)
      return
    }
    const original = res.data
    // Match by name when available, else by position among the table's FKs.
    const foreignKeys = original.foreignKeys.filter((fk, i) => (fkName ? fk.name !== fkName : i !== fkIndex))
    if (foreignKeys.length === original.foreignKeys.length) {
      setStatus('❌ Could not identify that foreign key to drop.')
      return
    }
    const spec: TableSpec = { ...original, foreignKeys }
    setPending({
      title: `Drop foreign key on ${childTable}`,
      kind: 'ddl',
      req: { connectionId: connId, mode: 'alter', spec, original },
      targetName: childTable
    })
  }

  const dropTable = (table: string): void => {
    if (!connId) return
    setPending({
      title: `Drop table ${table}`,
      kind: 'objectOp',
      req: { connectionId: connId, op: { kind: 'dropTable', schema, table } },
      targetName: table
    })
  }

  // --- Export ----------------------------------------------------------------
  const doExport = async (format: 'png' | 'svg'): Promise<void> => {
    if (!model) return
    const viewport = document.querySelector<HTMLElement>('.er-canvas .react-flow__viewport')
    if (!viewport) return
    const bounds = getNodesBounds(nodes)
    const pad = 40
    const imgW = Math.min(4096, Math.max(400, Math.round(bounds.width + pad * 2)))
    const imgH = Math.min(4096, Math.max(300, Math.round(bounds.height + pad * 2)))
    const t = getViewportForBounds(bounds, imgW, imgH, 0.2, 2, pad)
    const opts = {
      backgroundColor: erColors.exportBg,
      width: imgW,
      height: imgH,
      style: {
        width: `${imgW}px`,
        height: `${imgH}px`,
        transform: `translate(${t.x}px, ${t.y}px) scale(${t.zoom})`
      }
    }
    setStatus('Rendering image…')
    try {
      const dataUrl = format === 'png' ? await toPng(viewport, opts) : await toSvg(viewport, opts)
      const name = `er_${schema || 'diagram'}.${format}`
      const res = await window.dbApi.saveDiagramImage(dataUrl, name)
      if (!res.ok) setStatus(`❌ ${res.error}`)
      else if (res.data) setStatus(`✅ Saved ${res.data}`)
      else setStatus(null)
    } catch (err) {
      setStatus(`❌ Export failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // --- Layout actions --------------------------------------------------------
  const reLayout = (): void => {
    if (!model) return
    const auto = autoLayout(model, collapsed)
    setPositions(auto)
    schedulePersist(auto, collapsed)
    setTimeout(() => rf.fitView({ maxZoom: 1, duration: 300 }), 30)
  }

  const focusSearch = (): void => {
    if (!model) return
    const first = model.tables.find((t) => matched.has(t.name))
    if (!first) return
    const p = positions[first.name]
    if (p) rf.setCenter(p.x + 115, p.y + 60, { zoom: 1, duration: 300 })
  }

  if (!tab || tab.kind !== 'erdiagram') return <div className="er-empty-state">No diagram.</div>

  return (
    <div className="er-wrap">
      <div className="er-toolbar">
        <button className="icon-text-btn" onClick={() => void loadModel({ keepPositions: true })} title="Reload tables from the database">
          <IconRefresh /> Refresh
        </button>
        <button className="icon-text-btn" onClick={reLayout} title="Auto-arrange all tables"><IconLayout /> Re-layout</button>
        <button
          className="icon-text-btn"
          onClick={() => {
            if (!model) return
            const auto = autoLayout(model, collapsed)
            setPositions(auto)
            setCollapsed(new Set())
            schedulePersist(auto, new Set())
            setTimeout(() => rf.fitView({ maxZoom: 1, duration: 300 }), 30)
          }}
          title="Discard manual layout and re-run auto-layout"
        >
          <IconReset /> Reset layout
        </button>
        <button className="icon-text-btn" onClick={() => rf.fitView({ maxZoom: 1, duration: 300 })} title="Fit diagram to view"><IconFit /> Fit</button>
        <span className="er-sep" />
        <button className="icon-text-btn" onClick={() => connId && openNewTableDesigner(connId, schema)} title="Create a new table"><IconNew /> New table</button>
        <button className="icon-text-btn" onClick={() => void doExport('png')} disabled={!model}><IconExportImage /> Export PNG</button>
        <button className="icon-text-btn" onClick={() => void doExport('svg')} disabled={!model}><IconExportImage /> Export SVG</button>
        <span className="er-sep" />
        <input
          className="er-search"
          type="text"
          value={search}
          placeholder="Find table…"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') focusSearch()
          }}
        />
        <button className="icon-text-btn" onClick={focusSearch} disabled={matched.size === 0} title="Focus first match"><IconSearchGo /> Go</button>
        <span className="er-count">
          {model ? `${model.tables.length} tables${matched.size ? ` · ${matched.size} match` : ''}` : ''}
        </span>
        {status && <span className="er-status">{status}</span>}
      </div>

      <div className="er-canvas" ref={wrapRef} onContextMenu={onCanvasContextMenu}>
        {loading && <div className="er-loading">Loading schema…</div>}
        {error && <div className="er-error">⚠ {error}</div>}
        {/* Mount ReactFlow only once the model is ready so nodes + edges are
            present in RF's first measurement pass (feeding them in async after
            an empty mount leaves FK edges unrendered in this Electron build). */}
        {model && (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onNodeDoubleClick={onNodeDoubleClick}
            connectionMode={ConnectionMode.Loose}
            connectionLineType={ConnectionLineType.SmoothStep}
            connectionLineStyle={{ stroke: erColors.edge, strokeWidth: 2 }}
            connectionRadius={55}
            fitView
            fitViewOptions={{ maxZoom: 1 }}
            colorMode={themeMode}
            minZoom={0.1}
            defaultEdgeOptions={{ type: 'smoothstep' }}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable nodeColor={erColors.miniNode} maskColor={erColors.miniMask} />
            {model.tables.length === 0 && (
              <Panel position="top-center">
                <div className="er-hint">No tables in this schema yet. Use “＋ New table”.</div>
              </Panel>
            )}
          </ReactFlow>
        )}
      </div>

      {menu && <ErContextMenu menu={menu} onClose={() => setMenu(null)}
        onEditTable={(t) => connId && void openEditTableDesigner(connId, schema, t)}
        onDropTable={dropTable}
        onDropFk={(id) => void dropFkReq(id)} />}

      {fkDraft && (
        <FkParamsDialog
          draft={fkDraft}
          engine={engine}
          onCancel={() => setFkDraft(null)}
          onSubmit={async (name, onDelete, onUpdate) => {
            const req = await buildAddFkReq(fkDraft, name, onDelete, onUpdate)
            setFkDraft(null)
            if (req) setPending({ title: `Create foreign key on ${fkDraft.childTable}`, kind: 'ddl', req, targetName: fkDraft.childTable })
          }}
        />
      )}

      {pending && (
        <ConfirmActionDialog
          action={pending}
          onClose={() => setPending(null)}
          onApplied={async () => {
            setPending(null)
            if (connId) await refreshErSchema(connId, schema)
            await loadModel({ keepPositions: true })
          }}
        />
      )}
    </div>
  )
}

// --- Context menu -------------------------------------------------------------

function ErContextMenu(props: {
  menu: { x: number; y: number; kind: 'node'; table: string } | { x: number; y: number; kind: 'edge'; edgeId: string }
  onClose: () => void
  onEditTable: (table: string) => void
  onDropTable: (table: string) => void
  onDropFk: (edgeId: string) => void
}): JSX.Element {
  const { menu } = props
  const x = Math.min(menu.x, window.innerWidth - 200)
  const y = Math.min(menu.y, window.innerHeight - 120)
  return (
    <>
      <div className="vb-menu-backdrop" onClick={props.onClose} onContextMenu={(e) => { e.preventDefault(); props.onClose() }} />
      <div className="context-menu" style={{ left: x, top: y }}>
        {menu.kind === 'node' ? (
          <>
            <div className="context-item" onClick={() => { props.onEditTable(menu.table); props.onClose() }}>Edit table…</div>
            <div className="context-item danger" onClick={() => { props.onDropTable(menu.table); props.onClose() }}>Drop table…</div>
          </>
        ) : (
          <div className="context-item danger" onClick={() => { props.onDropFk(menu.edgeId); props.onClose() }}>Drop foreign key…</div>
        )}
      </div>
    </>
  )
}

// --- FK params dialog ---------------------------------------------------------

function FkParamsDialog(props: {
  draft: FkDraft
  engine: string
  onCancel: () => void
  onSubmit: (name: string, onDelete: FkAction, onUpdate: FkAction) => void
}): JSX.Element {
  const { draft } = props
  const [name, setName] = useState(`fk_${draft.childTable}_${draft.childCol}`)
  const [onDelete, setOnDelete] = useState<FkAction>('NO ACTION')
  const [onUpdate, setOnUpdate] = useState<FkAction>('NO ACTION')
  return (
    <div className="modal-backdrop" onClick={props.onCancel}>
      <div className="modal er-fk-modal" onClick={(e) => e.stopPropagation()}>
        <h3>New foreign key</h3>
        <p className="er-fk-rel">
          <b>{draft.childTable}</b>.{draft.childCol} &nbsp;→&nbsp; <b>{draft.parentTable}</b>.{draft.parentCol}
        </p>
        <label className="er-field">
          <span>Constraint name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="(auto)" />
        </label>
        <div className="er-fk-actions">
          <label className="er-field">
            <span>ON DELETE</span>
            <select value={onDelete} onChange={(e) => setOnDelete(e.target.value as FkAction)}>
              {FK_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="er-field">
            <span>ON UPDATE</span>
            <select value={onUpdate} onChange={(e) => setOnUpdate(e.target.value as FkAction)}>
              {FK_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
        </div>
        {props.engine === 'sqlite' && (
          <div className="ddl-note">ℹ SQLite rebuilds the table to add a foreign key (data preserved).</div>
        )}
        <div className="modal-buttons">
          <button onClick={props.onCancel}>Cancel</button>
          <button className="primary icon-text-btn" onClick={() => props.onSubmit(name, onDelete, onUpdate)}><IconPreview /> Preview DDL…</button>
        </div>
      </div>
    </div>
  )
}

// --- Confirm-action (DDL preview) dialog --------------------------------------

function ConfirmActionDialog(props: {
  action: PendingAction
  onClose: () => void
  onApplied: () => void | Promise<void>
}): JSX.Element {
  const { action } = props
  const [preview, setPreview] = useState<DdlPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  useEffect(() => {
    let alive = true
    void (async () => {
      const res =
        action.kind === 'ddl'
          ? await window.dbApi.previewDdl(action.req)
          : await window.dbApi.previewObjectOp(action.req)
      if (!alive) return
      if (res.ok) setPreview(res.data)
      else setError(res.error)
    })()
    return () => {
      alive = false
    }
  }, [action])

  const destructive = preview?.destructive ?? false
  const confirmed = !destructive || confirmText.trim() === action.targetName
  const canApply = !!preview && preview.statements.length > 0 && !applying && confirmed

  const apply = async (): Promise<void> => {
    setApplying(true)
    setError(null)
    const res = action.kind === 'ddl' ? await window.dbApi.applyDdl(action.req) : await window.dbApi.applyObjectOp(action.req)
    if (!res.ok || !res.data.ok) {
      const msg = res.ok ? `Statement ${(res.data.failedAt ?? 0) + 1} failed: ${res.data.message}` : res.error
      setError(msg ?? 'Failed')
      setApplying(false)
      return
    }
    await props.onApplied()
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal er-ddl-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{action.title}</h3>
        <pre className="ddl-pre">{preview?.sql ?? (error ? '' : 'Generating…')}</pre>
        {preview?.notes.map((n, i) => <div className="ddl-note" key={i}>ℹ {n}</div>)}
        {preview?.destructiveReasons.map((r, i) => <div className="ddl-danger" key={i}>⚠ {r}</div>)}
        {destructive && (
          <label className="er-field er-confirm">
            <span>Type <b>{action.targetName}</b> to confirm</span>
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
          </label>
        )}
        {error && <div className="ddl-danger">❌ {error}</div>}
        <div className="modal-buttons">
          <button onClick={props.onClose}>Cancel</button>
          <button className={(destructive ? 'danger-btn' : 'primary') + ' icon-text-btn'} disabled={!canApply} onClick={() => void apply()}>
            {destructive ? <IconDelete /> : <IconApply />} {applying ? 'Applying…' : destructive ? 'Apply (destructive)' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}
