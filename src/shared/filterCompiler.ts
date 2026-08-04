// Pure filter compiler shared by MAIN (execution) and the RENDERER (preview).
// Turns quick filters (flat AND) + a visual builder tree (nested AND/OR/NOT)
// into a single WHERE. For EXECUTION every value is a BOUND PARAMETER; for
// PREVIEW the same logic inlines readable literals. Identifiers are quoted and
// (on execution) validated against the table's real columns.
import type { ColumnFilter, Engine, FilterGroup, FilterNode } from './types'
import { sqlDialect, isMysqlFamily } from './types'
import { guardRawWhere } from './rawWhere'

// Conservative, common reserved-word list (superset across engines). When an
// identifier matches one of these — case-insensitively — the DISPLAY renderer
// quotes it even if it otherwise looks plain, so the shown SQL never breaks.
const RESERVED = new Set([
  'ADD', 'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC', 'BEGIN', 'BETWEEN', 'BY', 'CASE', 'CAST', 'CHECK',
  'COLUMN', 'COMMENT', 'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT', 'CURRENT_DATE', 'CURRENT_TIMESTAMP',
  'DATE', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'ELSE', 'END', 'EXISTS', 'FETCH', 'FLOAT',
  'FOR', 'FOREIGN', 'FROM', 'FULL', 'GRANT', 'GROUP', 'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT', 'INT',
  'INTEGER', 'INTO', 'IS', 'JOIN', 'KEY', 'LEFT', 'LEVEL', 'LIKE', 'LIMIT', 'LONG', 'NOT', 'NULL',
  'NUMBER', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'REFERENCES', 'RENAME', 'RIGHT', 'ROW',
  'ROWID', 'ROWNUM', 'ROWS', 'SELECT', 'SESSION', 'SET', 'SIZE', 'SMALLINT', 'TABLE', 'THEN', 'TIME',
  'TIMESTAMP', 'TO', 'TRIGGER', 'UNION', 'UNIQUE', 'UPDATE', 'USER', 'USING', 'VALUES', 'VARCHAR',
  'VIEW', 'WHEN', 'WHERE', 'WITH'
])

/**
 * Quote an identifier for DISPLAY (the read-only filter SQL panel): use the
 * correct quote char per engine — backticks for MySQL/MariaDB, double quotes for
 * PostgreSQL/SQLite/Oracle — and quote ONLY when necessary so the shown SQL is
 * clean AND copy-paste-runnable:
 *   - not a safe plain identifier (letters/digits/_, not starting with a digit)
 *     → quote; reserved word → quote;
 *   - Oracle folds unquoted to UPPERCASE → emit unquoted only if already
 *     all-uppercase; PostgreSQL folds to lowercase → unquoted only if all
 *     lowercase; MySQL/MariaDB/SQLite are case-insensitive enough → unquoted.
 * DISPLAY ONLY — the executed query still quotes everything via `compileFilter`.
 */
export function displayQuote(engine: Engine, name: string): string {
  const d = sqlDialect(engine)
  // SQL Server uses [bracket] identifiers ( ] escaped by doubling ).
  const quoted =
    d === 'mssql'
      ? '[' + name.split(']').join(']]') + ']'
      : (isMysqlFamily(engine) ? '`' : '"') +
        name.split(isMysqlFamily(engine) ? '`' : '"').join(isMysqlFamily(engine) ? '``' : '""') +
        (isMysqlFamily(engine) ? '`' : '"')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return quoted
  if (RESERVED.has(name.toUpperCase())) return quoted
  if (d === 'oracle') return name === name.toUpperCase() ? name : quoted
  if (d === 'postgres') return name === name.toLowerCase() ? name : quoted
  return name // mysql / mariadb / sqlite / mssql — case-insensitive enough to leave bare
}

/** Structural shape shared by ColumnFilter and FilterCondition. */
interface Cond {
  column: string
  operator: ColumnFilter['operator']
  value?: string | null
  value2?: string | null
  values?: string[] | null
}

/** Escape LIKE wildcards so the user's %/_ are treated literally. */
function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (c) => '\\' + c)
}

/** `add` binds a value and returns its placeholder (exec) or a literal (preview). */
export type AddParam = (v: unknown) => string

/** A param-binding adder ($1.. for PG, ? otherwise) with its collected params. */
export function paramAdder(engine: Engine): { params: unknown[]; add: AddParam } {
  engine = sqlDialect(engine)
  const params: unknown[] = []
  const add: AddParam = (v) => {
    params.push(v)
    return placeholder(engine, params.length)
  }
  return { params, add }
}

/** The bind placeholder for the Nth (1-based) parameter, per dialect. */
function placeholder(engine: Engine, n: number): string {
  if (engine === 'postgres') return `$${n}`
  if (engine === 'oracle') return `:${n}` // node-oracledb positional bind
  if (engine === 'mssql') return `@p${n}` // node-mssql named bind (registered as p1..pN)
  return '?'
}

/** An inline literal adder (numbers as-is, strings single-quoted + escaped). */
export function inlineAdder(): AddParam {
  return (v) => {
    const s = String(v)
    return /^-?\d+(\.\d+)?$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`
  }
}

function likeParts(engine: Engine): { op: string; esc: string } {
  return {
    op: engine === 'postgres' ? 'ILIKE' : 'LIKE',
    // MySQL processes backslashes in string literals, so '\\' == one backslash.
    esc: engine === 'mysql' ? "ESCAPE '\\\\'" : "ESCAPE '\\'"
  }
}

/** Compile one condition to SQL, or null if it's empty/incomplete. */
function buildCondition(
  engine: Engine,
  cond: Cond,
  validColumns: Set<string> | null,
  qid: (id: string) => string,
  add: AddParam
): string | null {
  if (validColumns && !validColumns.has(cond.column)) {
    throw new Error(`Unknown filter column: ${cond.column}`)
  }
  const col = qid(cond.column)
  const v = cond.value
  const hasVal = v != null && v !== ''
  const { op: likeOp, esc } = likeParts(engine)
  // Oracle LIKE is case-sensitive (no ILIKE, no CI collation like MySQL), so
  // wrap both sides in UPPER() to give the same case-insensitive `contains`.
  const likeCol = engine === 'oracle' ? `UPPER(${col})` : col
  const likeVal = (ph: string): string => (engine === 'oracle' ? `UPPER(${ph})` : ph)

  switch (cond.operator) {
    case 'isNull':
      return `${col} IS NULL`
    case 'isNotNull':
      return `${col} IS NOT NULL`
    case 'eq':
      return hasVal ? `${col} = ${add(v)}` : null
    case 'ne':
      return hasVal ? `${col} <> ${add(v)}` : null
    case 'lt':
      return hasVal ? `${col} < ${add(v)}` : null
    case 'lte':
      return hasVal ? `${col} <= ${add(v)}` : null
    case 'gt':
      return hasVal ? `${col} > ${add(v)}` : null
    case 'gte':
      return hasVal ? `${col} >= ${add(v)}` : null
    case 'contains':
      return hasVal ? `${likeCol} ${likeOp} ${likeVal(add('%' + escapeLike(v) + '%'))} ${esc}` : null
    case 'startsWith':
      return hasVal ? `${likeCol} ${likeOp} ${likeVal(add(escapeLike(v) + '%'))} ${esc}` : null
    case 'endsWith':
      return hasVal ? `${likeCol} ${likeOp} ${likeVal(add('%' + escapeLike(v)))} ${esc}` : null
    case 'in':
    case 'notIn': {
      const vals = (cond.values ?? []).map((x) => x.trim()).filter((x) => x !== '')
      if (vals.length === 0) return null
      const list = vals.map((x) => add(x)).join(', ')
      return `${col} ${cond.operator === 'notIn' ? 'NOT IN' : 'IN'} (${list})`
    }
    case 'between':
      return hasVal && cond.value2 != null && cond.value2 !== ''
        ? `${col} BETWEEN ${add(v)} AND ${add(cond.value2)}`
        : null
    default:
      return null
  }
}

/** Recursively compile a builder node; null if it contributes nothing. */
export function compileNode(
  engine: Engine,
  node: FilterNode,
  validColumns: Set<string> | null,
  qid: (id: string) => string,
  add: AddParam
): string | null {
  engine = sqlDialect(engine)
  if (node.kind === 'condition') {
    return buildCondition(engine, node, validColumns, qid, add)
  }
  const parts = node.children
    .map((ch) => compileNode(engine, ch, validColumns, qid, add))
    .filter((p): p is string => !!p)
  if (parts.length === 0) return null
  const joined = parts.join(` ${node.combiner} `)
  if (node.negated) return `NOT (${joined})`
  return parts.length > 1 ? `(${joined})` : joined
}

/**
 * Compile quick filters + a builder tree into ONE parameterized WHERE.
 * Effective filter = (quick filters AND-combined) AND (builder tree).
 * A single shared param counter keeps PG's $1.. numbering correct.
 *
 * `rawWhere` (the "Custom WHERE" mode) takes precedence: when present it is the
 * ONLY predicate. It can't be parameterized, so it's run through `guardRawWhere`
 * (rejects ';'/comments/DDL-DML) and wrapped in parens. Throws on a rejected
 * predicate — the caller surfaces the message to the user.
 */
export function compileFilter(
  engine: Engine,
  quickFilters: ColumnFilter[],
  tree: FilterGroup | null,
  validColumns: Set<string>,
  qid: (id: string) => string,
  rawWhere?: string | null
): { sql: string; params: unknown[] } {
  engine = sqlDialect(engine)
  if (rawWhere && rawWhere.trim()) {
    const g = guardRawWhere(rawWhere)
    if (!g.ok) throw new Error(g.reason)
    return { sql: `WHERE (${g.where})`, params: [] }
  }
  const params: unknown[] = []
  const add: AddParam = (v) => {
    params.push(v)
    return placeholder(engine, params.length)
  }
  const parts: string[] = []
  for (const f of quickFilters) {
    const c = buildCondition(engine, f, validColumns, qid, add)
    if (c) parts.push(c)
  }
  if (tree) {
    const t = compileNode(engine, tree, validColumns, qid, add)
    if (t) parts.push(t)
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params }
}

/**
 * Display-only WHERE (values INLINED + escaped per dialect) for the read-only
 * "filter SQL" panel — covers all three filter modes. Custom WHERE is shown as
 * its raw predicate. Returns '' when there is no filter. NEVER executed — the
 * real query still runs with bound parameters via `compileFilter`.
 */
export function displayWhere(
  engine: Engine,
  quickFilters: ColumnFilter[],
  tree: FilterGroup | null,
  rawWhere?: string | null
): string {
  const raw = engine
  engine = sqlDialect(engine)
  if (rawWhere && rawWhere.trim()) return `WHERE (${rawWhere.trim()})`
  // Display quoting uses the ORIGINAL engine (so MariaDB → backticks, Oracle →
  // uppercase-unquoted), quoting only when necessary.
  const qid = (s: string): string => displayQuote(raw, s)
  const add = inlineAdder()
  const parts: string[] = []
  for (const f of quickFilters) {
    const c = buildCondition(engine, f, null, qid, add)
    if (c) parts.push(c)
  }
  if (tree) {
    const t = compileNode(engine, tree, null, qid, add)
    if (t) parts.push(t)
  }
  return parts.length ? 'WHERE ' + parts.join(' AND ') : ''
}

/** Human-readable WHERE with values inlined — for the builder's live preview. */
export function previewWhere(
  engine: Engine,
  quickFilters: ColumnFilter[],
  tree: FilterGroup | null
): string {
  const raw = engine
  engine = sqlDialect(engine)
  const qid = (s: string): string => displayQuote(raw, s)
  const add: AddParam = (v) => {
    const s = String(v)
    return /^-?\d+(\.\d+)?$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`
  }
  const parts: string[] = []
  for (const f of quickFilters) {
    const c = buildCondition(engine, f, null, qid, add)
    if (c) parts.push(c)
  }
  if (tree) {
    const t = compileNode(engine, tree, null, qid, add)
    if (t) parts.push(t)
  }
  return parts.length ? 'WHERE ' + parts.join(' AND ') : '(no filter — all rows)'
}
