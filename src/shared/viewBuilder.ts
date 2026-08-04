// Pure SELECT generator for the Visual View Builder. Shared by the renderer
// (live SQL + preview + save) and the smoke test. Identifiers are quoted per
// dialect; WHERE/HAVING reuse the TASK 10 filter compiler. Two modes:
//   'params' -> { sql, params } (bound params for preview execution)
//   'inline' -> string          (safely-escaped literals for the stored VIEW)
import type { Engine, JoinType, ViewModel, VbOutput, VbTable } from './types'
import { sqlDialect } from './types'
import { compileNode, inlineAdder, paramAdder, type AddParam } from './filterCompiler'

function quoteId(engine: Engine, id: string): string {
  return engine === 'mysql' ? '`' + id.replace(/`/g, '``') + '`' : '"' + id.replace(/"/g, '""') + '"'
}

export interface ResolvedOutput {
  /** The output id this refers to. */
  id: string
  /** Alias to emit (`... AS "alias"`); null emits the bare (qualified) column. */
  alias: string | null
  /** Effective output NAME shown in the UI (alias, or the column when bare). */
  displayName: string
  /** True when the alias was auto-generated to resolve a duplicate output name. */
  auto: boolean
}

/**
 * Compute unique effective output names for a view model. Views require UNIQUE
 * output column names, so when joined tables share a column name (e.g. both
 * `id`) and both are selected, we auto-alias the duplicates Navicat-style:
 *   `<table>_<col>` → `<nodeAlias>_<col>` (e.g. self-joins) → `<...>_<n>`.
 * User-set aliases are respected (never auto-overridden); if two user aliases
 * still collide, both are returned as-is and the UI flags + blocks save.
 * Reused by the SELECT generator and the output-columns panel so they agree.
 */
export function resolveOutputAliases(model: ViewModel): ResolvedOutput[] {
  const byId = new Map(model.tables.map((t) => [t.id, t]))
  const lc = (s: string): string => s.toLowerCase()
  const userAlias = (o: VbOutput): string | null => (o.alias && o.alias.trim() ? o.alias.trim() : null)
  const preferred = (o: VbOutput): string => userAlias(o) ?? o.column

  // Count preferred names (case-insensitively); '*' outputs never collide here.
  const counts = new Map<string, number>()
  for (const o of model.outputs) {
    if (o.column === '*') continue
    counts.set(lc(preferred(o)), (counts.get(lc(preferred(o))) ?? 0) + 1)
  }
  const needsAuto = (o: VbOutput): boolean =>
    o.column !== '*' && !userAlias(o) && (counts.get(lc(preferred(o))) ?? 0) > 1

  // Reserve every name that will NOT be auto-generated (user aliases + uniques).
  const reserve = new Set<string>()
  for (const o of model.outputs) {
    if (o.column === '*' || needsAuto(o)) continue
    reserve.add(lc(preferred(o)))
  }
  // If several auto-candidates share the same `<table>_<col>` (self-join), skip
  // straight to `<alias>_<col>` for all of them.
  const tblColCount = new Map<string, number>()
  for (const o of model.outputs) {
    if (!needsAuto(o)) continue
    const t = byId.get(o.tableId)
    tblColCount.set(lc(`${t?.table ?? 't'}_${o.column}`), (tblColCount.get(lc(`${t?.table ?? 't'}_${o.column}`)) ?? 0) + 1)
  }
  const gen = (o: VbOutput): string => {
    const t = byId.get(o.tableId)
    const tblCol = `${t?.table ?? 't'}_${o.column}`
    const aliasCol = `${t?.alias ?? 't'}_${o.column}`
    let name: string
    if ((tblColCount.get(lc(tblCol)) ?? 0) <= 1 && !reserve.has(lc(tblCol))) name = tblCol
    else if (!reserve.has(lc(aliasCol))) name = aliasCol
    else {
      let n = 2
      while (reserve.has(lc(`${aliasCol}_${n}`))) n++
      name = `${aliasCol}_${n}`
    }
    reserve.add(lc(name))
    return name
  }

  return model.outputs.map((o) => {
    if (needsAuto(o)) {
      const name = gen(o)
      return { id: o.id, alias: name, displayName: name, auto: true }
    }
    const ua = userAlias(o)
    return { id: o.id, alias: ua, displayName: ua ?? o.column, auto: false }
  })
}

function qTable(engine: Engine, t: VbTable): string {
  return engine === 'sqlite' ? quoteId(engine, t.table) : `${quoteId(engine, t.schema)}.${quoteId(engine, t.table)}`
}

/** Join types offered per engine (SQLite: INNER/LEFT/CROSS; MySQL: +RIGHT; PG: all). */
export function supportedJoinTypes(engine: Engine): JoinType[] {
  engine = sqlDialect(engine)
  if (engine === 'sqlite') return ['INNER', 'LEFT', 'CROSS']
  if (engine === 'mysql') return ['INNER', 'LEFT', 'RIGHT', 'CROSS']
  return ['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS']
}

export interface GeneratedSelect {
  sql: string
  params: unknown[]
}

/** Generate the SELECT. `mode` controls WHERE/HAVING value rendering. */
export function generateViewSelect(engine: Engine, model: ViewModel, mode: 'params' | 'inline'): GeneratedSelect {
  engine = sqlDialect(engine)
  const tables = model.tables
  if (tables.length === 0) return { sql: '', params: [] }

  const byId = new Map(tables.map((t) => [t.id, t]))
  const aliasOf = (id: string): string => byId.get(id)?.alias ?? 't'
  const qcol = (tableId: string, col: string): string =>
    col === '*' ? `${quoteId(engine, aliasOf(tableId))}.*` : `${quoteId(engine, aliasOf(tableId))}.${quoteId(engine, col)}`
  // Table aliases: Oracle rejects `AS` before a TABLE alias (ORA-00933); it wants
  // `<table> <alias>`. Every other engine accepts `AS`, so keep it there. (Column
  // aliases still use `AS` everywhere — that IS valid in Oracle.)
  const tableRef = (t: VbTable): string =>
    engine === 'oracle'
      ? `${qTable(engine, t)} ${quoteId(engine, t.alias)}`
      : `${qTable(engine, t)} AS ${quoteId(engine, t.alias)}`

  // Shared value adder so PG's $1.. numbering stays correct across WHERE + HAVING.
  const pa = mode === 'params' ? paramAdder(engine) : { params: [] as unknown[], add: inlineAdder() }
  const add: AddParam = pa.add

  // --- FROM + JOINs (BFS from the first table) ---
  const included = new Set<string>([tables[0].id])
  const fromParts: string[] = [tableRef(tables[0])]
  const usedJoins = new Set<string>()
  const onFor = (leftId: string, rightId: string, conds: { leftCol: string; rightCol: string }[]): string =>
    conds.map((c) => `${qcol(leftId, c.leftCol)} = ${qcol(rightId, c.rightCol)}`).join(' AND ')

  let progress = true
  while (progress) {
    progress = false
    for (const j of model.joins) {
      if (usedJoins.has(j.id)) continue
      const lIn = included.has(j.leftId)
      const rIn = included.has(j.rightId)
      if (lIn === rIn) continue // both in (extra edge) or neither reachable yet
      const newId = lIn ? j.rightId : j.leftId
      const reverse = !lIn // we're adding the LEFT side as the new table
      let type: JoinType = j.type
      if (reverse) type = type === 'LEFT' ? 'RIGHT' : type === 'RIGHT' ? 'LEFT' : type
      const nt = byId.get(newId)
      if (!nt) continue
      if (type === 'CROSS' || j.conds.length === 0) {
        fromParts.push(`CROSS JOIN ${tableRef(nt)}`)
      } else {
        fromParts.push(`${type} JOIN ${tableRef(nt)} ON ${onFor(j.leftId, j.rightId, j.conds)}`)
      }
      included.add(newId)
      usedJoins.add(j.id)
      progress = true
    }
  }
  // Any tables not connected by a join -> CROSS JOIN (cartesian).
  for (const t of tables) {
    if (!included.has(t.id)) {
      fromParts.push(`CROSS JOIN ${tableRef(t)}`)
      included.add(t.id)
    }
  }

  // --- SELECT list (auto-alias duplicate output names so the VIEW is valid) ---
  const aliasById = new Map(resolveOutputAliases(model).map((r) => [r.id, r.alias]))
  const selectItems =
    model.outputs.length === 0
      ? ['*']
      : model.outputs.map((o) => {
          const base = o.aggregate === 'COUNT' && o.column === '*' ? 'COUNT(*)' : o.aggregate ? `${o.aggregate}(${qcol(o.tableId, o.column)})` : qcol(o.tableId, o.column)
          const alias = aliasById.get(o.id) ?? null
          return alias ? `${base} AS ${quoteId(engine, alias)}` : base
        })

  // --- WHERE ---
  const dottedQid = (s: string): string => s.split('.').map((p) => (p === '*' ? '*' : quoteId(engine, p))).join('.')
  const whereClause = model.where ? compileNode(engine, model.where, null, dottedQid, add) : null

  // --- GROUP BY (explicit, else auto from non-aggregated outputs when any agg used) ---
  let groupCols: string[] = model.groupBy.map((g) => qcol(g.tableId, g.column))
  if (groupCols.length === 0 && model.outputs.some((o) => o.aggregate)) {
    groupCols = model.outputs.filter((o) => !o.aggregate).map((o) => qcol(o.tableId, o.column))
  }

  // --- HAVING (columns are already aggregate expressions) ---
  const havingClause = model.having ? compileNode(engine, model.having, null, (s) => s, add) : null

  // --- ORDER BY ---
  const orderCols = model.orderBy.map((o) => `${qcol(o.tableId, o.column)} ${o.dir}`)

  // --- assemble (compileNode returns a bare predicate — add the keywords) ---
  let sql = `SELECT ${model.distinct ? 'DISTINCT ' : ''}${selectItems.join(', ')}\nFROM ${fromParts.join('\n  ')}`
  if (whereClause) sql += `\nWHERE ${whereClause}`
  if (groupCols.length > 0) sql += `\nGROUP BY ${groupCols.join(', ')}`
  if (havingClause) sql += `\nHAVING ${havingClause}`
  if (orderCols.length > 0) sql += `\nORDER BY ${orderCols.join(', ')}`

  return { sql, params: pa.params }
}
