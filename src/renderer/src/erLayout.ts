import Dagre from '@dagrejs/dagre'
import type { ErModel } from '@shared/types'

export const ER_NODE_WIDTH = 230
export const ER_HEAD_H = 30
export const ER_ROW_H = 22

/** Estimated rendered height of a table node (header + rows, or header only). */
export function erNodeHeight(colCount: number, collapsed: boolean): number {
  if (collapsed) return ER_HEAD_H
  return ER_HEAD_H + Math.max(1, colCount) * ER_ROW_H + 6
}

/**
 * Auto-layout the ER model with dagre. Returns top-left positions keyed by
 * table name (the React Flow node id). FK edges drive the ranking so referenced
 * tables sit toward one side of their dependents.
 */
export function autoLayout(model: ErModel, collapsed: Set<string>): Record<string, { x: number; y: number }> {
  const g = new Dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const t of model.tables) {
    g.setNode(t.name, {
      width: ER_NODE_WIDTH,
      height: erNodeHeight(t.columns.length, collapsed.has(t.name))
    })
  }
  const names = new Set(model.tables.map((t) => t.name))
  for (const t of model.tables) {
    for (const fk of t.foreignKeys) {
      // Edge child -> parent; only if both endpoints are in this schema view.
      if (names.has(fk.refTable) && fk.refTable !== t.name) g.setEdge(t.name, fk.refTable)
    }
  }

  Dagre.layout(g)

  const positions: Record<string, { x: number; y: number }> = {}
  for (const t of model.tables) {
    const n = g.node(t.name)
    if (!n) continue
    // dagre gives center coords; React Flow wants top-left.
    positions[t.name] = { x: Math.round(n.x - n.width / 2), y: Math.round(n.y - n.height / 2) }
  }
  return positions
}
