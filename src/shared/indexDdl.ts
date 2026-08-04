// Pure DDL generation for standalone (basic) indexes: CREATE [UNIQUE] INDEX,
// DROP INDEX, and rename. Shared by renderer (preview) and main (execute).
// Scope: B-tree default, UNIQUE, multi-column. Advanced types are out of scope.
import type { DdlPreview, Engine, IndexCreateSpec } from './types'
import { sqlDialect } from './types'

function q(engine: Engine, id: string): string {
  if (engine === 'mysql') return '`' + id.replace(/`/g, '``') + '`'
  if (engine === 'mssql') return '[' + id.replace(/]/g, ']]') + ']'
  return '"' + id.replace(/"/g, '""') + '"'
}

function qtable(engine: Engine, schema: string, table: string): string {
  return engine === 'sqlite' ? q(engine, table) : `${q(engine, schema)}.${q(engine, table)}`
}

/** Qualified index name: PG is schema-scoped; MySQL/SQLite use the bare name. */
function qindex(engine: Engine, schema: string, name: string): string {
  return engine === 'postgres' ? `${q(engine, schema)}.${q(engine, name)}` : q(engine, name)
}

function validate(spec: IndexCreateSpec): void {
  if (!spec.name.trim()) throw new Error('Index name is required.')
  const hasExpr = !!(spec.expression && spec.expression.trim())
  const cols = spec.columns.filter((c) => c && c.trim())
  if (!hasExpr && cols.length === 0) throw new Error('Select at least one column (or enter an expression).')
}

/**
 * CREATE [UNIQUE] INDEX name ON table [USING method] (cols | expression) [WHERE …].
 * The method / expression / WHERE clauses are PostgreSQL-only (ignored on other
 * engines); a plain multi-column B-tree index is unchanged from before.
 */
export function buildCreateIndex(engine: Engine, spec: IndexCreateSpec): DdlPreview {
  engine = sqlDialect(engine)
  validate(spec)
  const pg = engine === 'postgres'
  const unique = spec.unique ? 'UNIQUE ' : ''
  const notes: string[] = []
  // Key list: a PG expression (e.g. lower(email)) replaces the column list.
  const hasExpr = pg && !!(spec.expression && spec.expression.trim())
  const keyList = hasExpr
    ? `(${spec.expression!.trim()})`
    : `(${spec.columns.filter((c) => c && c.trim()).map((c) => q(engine, c)).join(', ')})`
  const using = pg && spec.method && spec.method !== 'btree' ? ` USING ${spec.method}` : ''
  const where = pg && spec.where && spec.where.trim() ? ` WHERE (${spec.where.trim()})` : ''
  if (!pg && (spec.method || spec.expression || spec.where)) {
    notes.push('Index method / expression / partial-WHERE are PostgreSQL-only and were ignored.')
  }
  // The index NAME is always unqualified in CREATE INDEX (even in PG, where the
  // index is created in the table's schema); the TABLE is schema-qualified.
  const sql = `CREATE ${unique}INDEX ${q(engine, spec.name)} ON ${qtable(engine, spec.schema, spec.table)}${using} ${keyList}${where};`
  return { sql, statements: [sql], destructive: false, destructiveReasons: [], notes }
}

/** DROP INDEX (dialect-correct form). */
export function buildDropIndex(engine: Engine, schema: string, table: string, name: string): DdlPreview {
  engine = sqlDialect(engine)
  let sql: string
  // MySQL AND SQL Server both need `ON table`; PG/Oracle are schema-scoped.
  if (engine === 'mysql' || engine === 'mssql') sql = `DROP INDEX ${q(engine, name)} ON ${qtable(engine, schema, table)};`
  else sql = `DROP INDEX ${qindex(engine, schema, name)};`
  return { sql, statements: [sql], destructive: true, destructiveReasons: [`drops index "${name}"`], notes: [] }
}

/**
 * ALTER an index. No engine has ALTER INDEX for column changes, so a column/
 * unique change is DROP + CREATE. A pure rename uses the native rename where
 * available (PG: ALTER INDEX … RENAME TO; MySQL: ALTER TABLE … RENAME INDEX);
 * SQLite rename is drop + recreate.
 */
export function buildAlterIndex(engine: Engine, spec: IndexCreateSpec, original: IndexCreateSpec): DdlPreview {
  engine = sqlDialect(engine)
  validate(spec)
  const renamedOnly =
    spec.name !== (spec.originalName ?? original.name) &&
    spec.unique === original.unique &&
    JSON.stringify(spec.columns.filter(Boolean)) === JSON.stringify(original.columns.filter(Boolean)) &&
    (spec.method ?? 'btree') === (original.method ?? 'btree') &&
    (spec.where ?? '') === (original.where ?? '') &&
    (spec.expression ?? '') === (original.expression ?? '')
  const oldName = spec.originalName ?? original.name

  if (renamedOnly && engine !== 'sqlite') {
    // PG/Oracle: ALTER INDEX … RENAME TO. SQL Server: sp_rename with 'INDEX'.
    // MySQL/MariaDB: ALTER TABLE … RENAME INDEX.
    let sql: string
    if (engine === 'postgres' || engine === 'oracle')
      sql = `ALTER INDEX ${qindex(engine, spec.schema, oldName)} RENAME TO ${q(engine, spec.name)};`
    else if (engine === 'mssql')
      sql = `EXEC sp_rename '${spec.schema}.${spec.table}.${oldName}', '${spec.name}', 'INDEX';`
    else sql = `ALTER TABLE ${qtable(engine, spec.schema, spec.table)} RENAME INDEX ${q(engine, oldName)} TO ${q(engine, spec.name)};`
    return { sql, statements: [sql], destructive: false, destructiveReasons: [], notes: ['Renames the index in place.'] }
  }

  // Column/unique change (or SQLite rename): DROP + CREATE.
  const drop = buildDropIndex(engine, spec.schema, spec.table, oldName)
  const create = buildCreateIndex(engine, spec)
  return {
    sql: `${drop.sql}\n\n${create.sql}`,
    statements: [...drop.statements, ...create.statements],
    destructive: true,
    destructiveReasons: [`re-creates index "${oldName}" (DROP + CREATE)`],
    notes: []
  }
}
