// Validate + resolve a reverse-parsed view model against a connection's catalog.
// The parser (main) leaves table schemas empty and can't know if the referenced
// tables/columns actually exist; this fills in canonical schema/name and rejects
// (→ SQL-editor fallback) any model that references something not in the catalog.
import type { FilterNode, SchemaCatalog, ViewModel } from './types'

export type ResolveResult = { ok: true; model: ViewModel } | { ok: false; reason: string }

export function resolveViewModel(model: ViewModel, catalog: SchemaCatalog): ResolveResult {
  const lc = (s: string): string => s.toLowerCase()
  const findTable = (name: string, schema: string): SchemaCatalog['tables'][number] | null => {
    const matches = catalog.tables.filter((t) => lc(t.name) === lc(name) && (!schema || lc(t.schema) === lc(schema)))
    return matches[0] ?? null
  }

  const resolvedTables = []
  const colsByAlias = new Map<string, Set<string>>()
  const aliasById = new Map<string, string>()
  for (const vt of model.tables) {
    const ct = findTable(vt.table, vt.schema)
    if (!ct) return { ok: false, reason: `references table "${vt.table}" which isn't in this connection` }
    const rt = { ...vt, table: ct.name, schema: ct.schema }
    resolvedTables.push(rt)
    aliasById.set(rt.id, rt.alias)
    colsByAlias.set(rt.alias, new Set(ct.columns.map((c) => lc(c.name))))
  }

  const hasCol = (alias: string | null, col: string): boolean => {
    if (col === '*') return true
    if (!alias) return false
    const set = colsByAlias.get(alias)
    return !!set && set.has(lc(col))
  }

  for (const o of model.outputs) {
    if (!hasCol(aliasById.get(o.tableId) ?? null, o.column)) {
      return { ok: false, reason: `column "${o.column}" isn't in the catalog` }
    }
  }
  for (const j of model.joins) {
    const la = aliasById.get(j.leftId) ?? null
    const ra = aliasById.get(j.rightId) ?? null
    for (const c of j.conds) {
      if (!hasCol(la, c.leftCol) || !hasCol(ra, c.rightCol)) return { ok: false, reason: 'a join column isn\'t in the catalog' }
    }
  }
  for (const g of model.groupBy) {
    if (!hasCol(aliasById.get(g.tableId) ?? null, g.column)) return { ok: false, reason: `GROUP BY column "${g.column}" isn't in the catalog` }
  }
  for (const o of model.orderBy) {
    if (!hasCol(aliasById.get(o.tableId) ?? null, o.column)) return { ok: false, reason: `ORDER BY column "${o.column}" isn't in the catalog` }
  }

  const checkFilter = (node: FilterNode): string | null => {
    if (node.kind === 'group') {
      for (const ch of node.children) {
        const r = checkFilter(ch)
        if (r) return r
      }
      return null
    }
    const dot = node.column.indexOf('.')
    const alias = dot >= 0 ? node.column.slice(0, dot) : null
    const col = dot >= 0 ? node.column.slice(dot + 1) : node.column
    if (!hasCol(alias, col)) return `WHERE column "${node.column}" isn't in the catalog`
    return null
  }
  if (model.where) {
    const r = checkFilter(model.where)
    if (r) return { ok: false, reason: r }
  }

  return { ok: true, model: { ...model, tables: resolvedTables } }
}
