// Reverse-parse a view's SELECT into the Visual View Builder model, guarded by a
// strict capability check. Only a "simple" single-SELECT subset is accepted
// (base tables, equi-joins, plain/aggregate output columns, an AND/OR WHERE of
// simple comparisons, GROUP BY / ORDER BY / DISTINCT). Anything else — subquery,
// CTE, UNION, window fn, HAVING, complex expression, unknown operator — returns
// { supported: false, reason } so the caller falls back to the SQL editor.
//
// Table schemas in the returned model are left empty; the renderer resolves them
// (and validates every table/column) against the connection catalog.
//
// Uses node-sql-parser (a real parser, per-dialect) rather than regex. Runs in
// the MAIN process; the AST never needs the DB.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from 'node:module'
import type {
  Engine,
  FilterCondition,
  FilterGroup,
  FilterNode,
  FilterOperator,
  JoinType,
  ParseViewResult,
  VbJoin,
  VbOutput,
  VbTable,
  ViewModel,
  SqlDialect
} from '@shared/types'
import { sqlDialect } from '@shared/types'

// node-sql-parser is CommonJS; load it via require so it works in the ESM main.
const { Parser } = createRequire(import.meta.url)('node-sql-parser') as typeof import('node-sql-parser')

class Unsupported extends Error {}
function bail(reason: string): never {
  throw new Unsupported(reason)
}

// node-sql-parser has no dedicated Oracle grammar; PL/SQL reverse-parsing is a
// later Oracle stage, so map it to the closest ANSI-ish grammar for now.
const DIALECT: Record<SqlDialect, string> = { postgres: 'postgresql', mysql: 'mysql', sqlite: 'sqlite', oracle: 'postgresql', mssql: 'transactsql' }

/** Extract a column_ref's table qualifier (string | {value} | null). */
function refTable(cr: any): string | null {
  const t = cr?.table
  if (t == null) return null
  if (typeof t === 'string') return t
  if (typeof t === 'object' && typeof t.value === 'string') return t.value
  return null
}

/** Extract a column_ref's column name across the dialect shapes. */
function refCol(cr: any): string | null {
  const c = cr?.column
  if (typeof c === 'string') return c
  if (c && typeof c === 'object') {
    if (typeof c.value === 'string') return c.value
    if (c.expr && typeof c.expr.value === 'string') return c.expr.value
  }
  return null
}

/** True when an aggregate argument is `*` (COUNT(*)). */
function isStar(node: any): boolean {
  if (!node) return false
  if (node.type === 'star') return true
  if (node.type === 'column_ref' && refCol(node) === '*') return true
  if (typeof node === 'string' && node === '*') return true
  return false
}

function litValue(n: any): string {
  switch (n?.type) {
    case 'number':
      return String(n.value)
    case 'single_quote_string':
    case 'string':
    case 'double_quote_string':
      return String(n.value)
    case 'bool':
      return n.value ? 'true' : 'false'
    case 'null':
      bail('NULL literal in comparison (use IS NULL)')
      break
    default:
      bail(`unsupported literal (${n?.type ?? 'unknown'})`)
  }
  return ''
}

const AGGS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])

export function reverseParseView(engine: Engine, rawSql: string): ParseViewResult {
  const sql = rawSql.trim().replace(/;\s*$/, '')
  if (!sql) return { supported: false, reason: 'empty definition' }

  let ast: any
  try {
    ast = new Parser().astify(sql, { database: DIALECT[sqlDialect(engine)] })
  } catch (e) {
    return { supported: false, reason: `could not parse (${(e as Error).message})` }
  }
  if (Array.isArray(ast)) {
    if (ast.length !== 1) return { supported: false, reason: 'multiple statements' }
    ast = ast[0]
  }

  try {
    if (ast?.type !== 'select') bail('not a SELECT')
    if (ast.with) bail('common table expression (WITH)')
    if (ast._next || ast.set_op) bail('UNION/INTERSECT/EXCEPT')
    if (ast.having) bail('HAVING clause')
    // MySQL renders the FROM join wrapped in parentheses, so `from` comes back as
    // { expr: [...], parentheses, joins } instead of a plain array — unwrap it.
    const fromEntries: any[] = Array.isArray(ast.from)
      ? ast.from
      : Array.isArray(ast.from?.expr)
        ? ast.from.expr
        : []
    if (fromEntries.length === 0) bail('no FROM tables')

    // --- FROM: base tables + aliases (alias = AS name, else table name) ---
    const tables: VbTable[] = []
    const byRef = new Map<string, VbTable>()
    fromEntries.forEach((f: any, i: number) => {
      if (f.expr || f.ast) bail('subquery in FROM')
      if (!f.table || typeof f.table !== 'string') bail('non-table FROM entry')
      const alias = (typeof f.as === 'string' && f.as) || f.table
      if (byRef.has(alias)) bail('duplicate table alias')
      const vt: VbTable = { id: `vt-${i}`, schema: typeof f.db === 'string' ? f.db : '', table: f.table, alias }
      tables.push(vt)
      byRef.set(alias, vt)
    })

    const resolveTable = (ref: string | null): VbTable => {
      if (ref == null) {
        if (tables.length === 1) return tables[0]
        bail('unqualified column with multiple tables')
      }
      const vt = byRef.get(ref)
      if (!vt) bail(`column references unknown table "${ref}"`)
      return vt
    }
    const qualCol = (cr: any): { alias: string; col: string } => {
      const col = refCol(cr)
      if (!col || col === '*') bail('unsupported column reference')
      return { alias: resolveTable(refTable(cr)).alias, col }
    }

    // --- JOINs (from entries after the first carry join + on) ---
    const joins: VbJoin[] = []
    for (let i = 1; i < fromEntries.length; i++) {
      const f = fromEntries[i]
      const newTable = tables[i]
      const jt = mapJoinType(f.join)
      if (!jt) bail(`unsupported join (${f.join ?? 'implicit'})`)
      if (jt === 'CROSS' || !f.on) {
        joins.push({ id: `j-${i}`, type: 'CROSS', leftId: tables[i - 1].id, rightId: newTable.id, conds: [] })
        continue
      }
      // ON must be equi-conditions (a.x = b.y), ANDed.
      const eqs: { a: { alias: string; col: string }; b: { alias: string; col: string } }[] = []
      const collectEq = (n: any): void => {
        if (n?.type !== 'binary_expr') bail('non-equi join condition')
        const op = String(n.operator).toUpperCase()
        if (op === 'AND') {
          collectEq(n.left)
          collectEq(n.right)
          return
        }
        if (op !== '=') bail('non-equi join condition')
        if (n.left?.type !== 'column_ref' || n.right?.type !== 'column_ref') bail('join condition not column=column')
        eqs.push({ a: qualCol(n.left), b: qualCol(n.right) })
      }
      collectEq(f.on)
      // Orient each equality so the newly-joined table is the "right" side.
      const conds = eqs.map((e) => {
        const aIsNew = e.a.alias === newTable.alias
        const bIsNew = e.b.alias === newTable.alias
        if (aIsNew === bIsNew) bail('join condition does not connect the joined table')
        const right = aIsNew ? e.a : e.b
        const left = aIsNew ? e.b : e.a
        return { leftCol: left.col, rightCol: right.col }
      })
      // The "left" (existing) side table — take it from the first cond.
      const firstLeftAlias = eqs[0] ? (eqs[0].a.alias === newTable.alias ? eqs[0].b.alias : eqs[0].a.alias) : tables[i - 1].alias
      const leftTable = byRef.get(firstLeftAlias) ?? tables[i - 1]
      joins.push({ id: `j-${i}`, type: jt, leftId: leftTable.id, rightId: newTable.id, conds })
    }

    // --- SELECT list -> outputs (empty outputs == SELECT *) ---
    const outputs: VbOutput[] = []
    const cols = ast.columns
    const isSelectStar =
      cols === '*' ||
      (Array.isArray(cols) && cols.length === 1 && (cols[0]?.expr?.type === 'star' || isStar(cols[0]?.expr)))
    if (!isSelectStar) {
      if (!Array.isArray(cols)) bail('unsupported select list')
      cols.forEach((c: any, idx: number) => {
        const as = typeof c.as === 'string' && c.as ? c.as : null
        const expr = c.expr
        if (expr?.type === 'column_ref') {
          const { alias, col } = qualCol(expr)
          const vt = resolveTable(refTable(expr) ?? alias)
          outputs.push({ id: `o-${idx}`, tableId: vt.id, column: col, alias: as, aggregate: null })
        } else if (expr?.type === 'aggr_func') {
          const name = String(expr.name).toUpperCase()
          if (!AGGS.has(name)) bail(`unsupported function ${name}`)
          if (expr.over) bail('window function')
          const arg = expr.args?.expr
          if (isStar(arg)) {
            outputs.push({ id: `o-${idx}`, tableId: tables[0].id, column: '*', alias: as, aggregate: name as any })
          } else if (arg?.type === 'column_ref') {
            const { col } = qualCol(arg)
            const vt = resolveTable(refTable(arg))
            outputs.push({ id: `o-${idx}`, tableId: vt.id, column: col, alias: as, aggregate: name as any })
          } else {
            bail('unsupported aggregate argument')
          }
        } else {
          bail('complex output expression')
        }
      })
    }

    // --- WHERE -> filter tree ---
    let where: FilterGroup | null = null
    if (ast.where) {
      const node = mapWhere(ast.where, qualCol)
      where = node.kind === 'group' ? node : { kind: 'group', combiner: 'AND', children: [node] }
    }

    // --- GROUP BY ---
    const groupBy: { tableId: string; column: string }[] = []
    const gb = ast.groupby
    const gbCols: any[] = Array.isArray(gb) ? gb : Array.isArray(gb?.columns) ? gb.columns : []
    for (const g of gbCols) {
      if (g?.type !== 'column_ref') bail('unsupported GROUP BY expression')
      const { col } = qualCol(g)
      groupBy.push({ tableId: resolveTable(refTable(g)).id, column: col })
    }

    // --- ORDER BY ---
    const orderBy: { tableId: string; column: string; dir: 'ASC' | 'DESC' }[] = []
    if (Array.isArray(ast.orderby)) {
      for (const o of ast.orderby) {
        if (o?.expr?.type !== 'column_ref') bail('unsupported ORDER BY expression')
        const { col } = qualCol(o.expr)
        orderBy.push({ tableId: resolveTable(refTable(o.expr)).id, column: col, dir: String(o.type).toUpperCase() === 'DESC' ? 'DESC' : 'ASC' })
      }
    }

    const distinct = ast.distinct?.type === 'DISTINCT' || ast.distinct === 'DISTINCT'

    const model: ViewModel = { tables, joins, outputs, distinct, where, groupBy, having: null, orderBy }
    return { supported: true, model }
  } catch (e) {
    if (e instanceof Unsupported) return { supported: false, reason: e.message }
    return { supported: false, reason: `could not map (${(e as Error).message})` }
  }
}

function mapJoinType(join: any): JoinType | null {
  if (!join) return null
  const j = String(join).toUpperCase()
  if (j.includes('CROSS')) return 'CROSS'
  if (j.includes('FULL')) return 'FULL'
  if (j.includes('LEFT')) return 'LEFT'
  if (j.includes('RIGHT')) return 'RIGHT'
  if (j.includes('INNER') || j === 'JOIN') return 'INNER'
  return null
}

function cond(column: string, operator: FilterOperator, extra?: Partial<FilterCondition>): FilterCondition {
  return { kind: 'condition', column, operator, ...extra }
}

function mapWhere(node: any, qualCol: (cr: any) => { alias: string; col: string }): FilterNode {
  if (node?.type !== 'binary_expr') bail('unsupported WHERE expression')
  const op = String(node.operator).toUpperCase()
  if (op === 'AND' || op === 'OR') {
    const children: FilterNode[] = []
    const collect = (n: any): void => {
      if (n?.type === 'binary_expr' && String(n.operator).toUpperCase() === op) {
        collect(n.left)
        collect(n.right)
      } else {
        children.push(mapWhere(n, qualCol))
      }
    }
    collect(node.left)
    collect(node.right)
    return { kind: 'group', combiner: op as 'AND' | 'OR', children }
  }
  // comparison / predicate
  if (node.left?.type !== 'column_ref') bail('WHERE left side is not a column')
  const { alias, col } = qualCol(node.left)
  const column = `${alias}.${col}`
  const right = node.right
  switch (op) {
    case '=':
      return cond(column, 'eq', { value: litValue(right) })
    case '<>':
    case '!=':
      return cond(column, 'ne', { value: litValue(right) })
    case '<':
      return cond(column, 'lt', { value: litValue(right) })
    case '<=':
      return cond(column, 'lte', { value: litValue(right) })
    case '>':
      return cond(column, 'gt', { value: litValue(right) })
    case '>=':
      return cond(column, 'gte', { value: litValue(right) })
    case 'IN':
      return cond(column, 'in', { values: listValues(right) })
    case 'NOT IN':
      return cond(column, 'notIn', { values: listValues(right) })
    case 'LIKE':
      return likeCondition(column, right)
    case 'BETWEEN': {
      const parts = listValues(right)
      if (parts.length !== 2) bail('unsupported BETWEEN')
      return cond(column, 'between', { value: parts[0], value2: parts[1] })
    }
    case 'IS':
      if (right?.type === 'null') return cond(column, 'isNull')
      bail('unsupported IS expression')
      break
    case 'IS NOT':
      if (right?.type === 'null') return cond(column, 'isNotNull')
      bail('unsupported IS NOT expression')
      break
    default:
      bail(`unsupported operator (${op})`)
  }
  return bail('unreachable')
}

function listValues(right: any): string[] {
  const items = right?.type === 'expr_list' ? right.value : Array.isArray(right?.value) ? right.value : null
  if (!Array.isArray(items)) bail('unsupported list expression')
  return items.map((v: any) => litValue(v))
}

/** Map a LIKE pattern to contains / startsWith / endsWith, else fall back. */
function likeCondition(column: string, right: any): FilterCondition {
  if (right?.type !== 'single_quote_string' && right?.type !== 'string') bail('unsupported LIKE pattern')
  const p = String(right.value)
  if (/[_]/.test(p)) bail('LIKE with wildcard "_"')
  const starts = p.startsWith('%')
  const ends = p.endsWith('%')
  const core = p.replace(/^%/, '').replace(/%$/, '')
  if (/%/.test(core)) bail('LIKE with interior "%"')
  if (starts && ends) return cond(column, 'contains', { value: core })
  if (ends) return cond(column, 'startsWith', { value: core })
  if (starts) return cond(column, 'endsWith', { value: core })
  bail('LIKE without wildcards')
}
