// Data-driven column TYPE catalog per engine. Shared by BOTH the renderer
// (to render the type picker + parameter inputs + validation) and the MAIN
// DDL generator (to emit exact typed columns). Single source of truth so the
// preview and the executed DDL never diverge.
import type { ColumnSpec, Engine, SqlDialect } from './types'
import { sqlDialect } from './types'

export type ParamKind =
  | 'length' // CHAR(n) / VARCHAR(n) / BINARY(n)
  | 'precisionScale' // DECIMAL(p,s) / NUMERIC(p,s)
  | 'enumValues' // MySQL ENUM(...)
  | 'setValues' // MySQL SET(...)
  | 'timezone' // PG TIME/TIMESTAMP WITH TIME ZONE
  | 'none'

export type TypeCategory =
  | 'Numeric'
  | 'String'
  | 'Date/Time'
  | 'Boolean'
  | 'JSON'
  | 'Binary'
  | 'UUID'
  | 'Geometric'
  | 'Network'
  | 'Other'

export interface TypeDef {
  /** Canonical name emitted in DDL, e.g. 'VARCHAR', 'TIMESTAMP'. */
  name: string
  category: TypeCategory
  params: ParamKind[]
  defaults?: { length?: number; scale?: number }
  /** Lowercase aliases used to match a DB-reported type back to this def. */
  aliases?: string[]
  notes?: string
}

const N = (name: string): TypeDef => ({ name, category: 'Numeric', params: ['none'] })

// --- PostgreSQL ---------------------------------------------------------------
const PG: TypeDef[] = [
  { name: 'SMALLINT', category: 'Numeric', params: ['none'], aliases: ['int2'] },
  { name: 'INTEGER', category: 'Numeric', params: ['none'], aliases: ['int', 'int4'] },
  { name: 'BIGINT', category: 'Numeric', params: ['none'], aliases: ['int8'] },
  { name: 'DECIMAL', category: 'Numeric', params: ['precisionScale'], aliases: ['dec'] },
  { name: 'NUMERIC', category: 'Numeric', params: ['precisionScale'] },
  { name: 'REAL', category: 'Numeric', params: ['none'], aliases: ['float4'] },
  { name: 'DOUBLE PRECISION', category: 'Numeric', params: ['none'], aliases: ['float8', 'double'] },
  { name: 'SMALLSERIAL', category: 'Numeric', params: ['none'], aliases: ['serial2'] },
  { name: 'SERIAL', category: 'Numeric', params: ['none'], aliases: ['serial4'] },
  { name: 'BIGSERIAL', category: 'Numeric', params: ['none'], aliases: ['serial8'] },
  { name: 'MONEY', category: 'Numeric', params: ['none'] },
  { name: 'CHAR', category: 'String', params: ['length'], aliases: ['character', 'bpchar'] },
  { name: 'VARCHAR', category: 'String', params: ['length'], defaults: { length: 255 }, aliases: ['character varying'] },
  { name: 'TEXT', category: 'String', params: ['none'] },
  { name: 'BOOLEAN', category: 'Boolean', params: ['none'], aliases: ['bool'] },
  { name: 'DATE', category: 'Date/Time', params: ['none'] },
  { name: 'TIME', category: 'Date/Time', params: ['timezone'], aliases: ['timetz', 'time without time zone', 'time with time zone'] },
  { name: 'TIMESTAMP', category: 'Date/Time', params: ['timezone'], aliases: ['timestamptz', 'timestamp without time zone', 'timestamp with time zone'] },
  { name: 'INTERVAL', category: 'Date/Time', params: ['none'] },
  { name: 'UUID', category: 'UUID', params: ['none'] },
  { name: 'JSON', category: 'JSON', params: ['none'] },
  { name: 'JSONB', category: 'JSON', params: ['none'] },
  { name: 'BYTEA', category: 'Binary', params: ['none'] },
  { name: 'INET', category: 'Network', params: ['none'] },
  { name: 'CIDR', category: 'Network', params: ['none'] },
  { name: 'MACADDR', category: 'Network', params: ['none'] },
  { name: 'POINT', category: 'Geometric', params: ['none'] },
  { name: 'LINE', category: 'Geometric', params: ['none'] },
  { name: 'LSEG', category: 'Geometric', params: ['none'] },
  { name: 'BOX', category: 'Geometric', params: ['none'] },
  { name: 'PATH', category: 'Geometric', params: ['none'] },
  { name: 'POLYGON', category: 'Geometric', params: ['none'] },
  { name: 'CIRCLE', category: 'Geometric', params: ['none'] },
  { name: 'BIT', category: 'Other', params: ['length'] },
  { name: 'BIT VARYING', category: 'Other', params: ['length'], aliases: ['varbit'] },
  { name: 'XML', category: 'Other', params: ['none'] }
]

// --- MySQL 8 ------------------------------------------------------------------
const MYSQL: TypeDef[] = [
  { name: 'TINYINT', category: 'Numeric', params: ['length'], notes: 'TINYINT(1) is the conventional boolean' },
  { name: 'SMALLINT', category: 'Numeric', params: ['none'] },
  { name: 'MEDIUMINT', category: 'Numeric', params: ['none'] },
  { name: 'INT', category: 'Numeric', params: ['none'], aliases: ['integer'] },
  { name: 'BIGINT', category: 'Numeric', params: ['none'] },
  { name: 'DECIMAL', category: 'Numeric', params: ['precisionScale'], aliases: ['dec', 'fixed', 'numeric'] },
  { name: 'FLOAT', category: 'Numeric', params: ['none'] },
  { name: 'DOUBLE', category: 'Numeric', params: ['none'], aliases: ['double precision', 'real'] },
  { name: 'BIT', category: 'Numeric', params: ['length'] },
  { name: 'CHAR', category: 'String', params: ['length'] },
  { name: 'VARCHAR', category: 'String', params: ['length'], defaults: { length: 255 } },
  { name: 'TINYTEXT', category: 'String', params: ['none'] },
  { name: 'TEXT', category: 'String', params: ['none'] },
  { name: 'MEDIUMTEXT', category: 'String', params: ['none'] },
  { name: 'LONGTEXT', category: 'String', params: ['none'] },
  { name: 'ENUM', category: 'String', params: ['enumValues'] },
  { name: 'SET', category: 'String', params: ['setValues'] },
  { name: 'DATE', category: 'Date/Time', params: ['none'] },
  { name: 'TIME', category: 'Date/Time', params: ['none'] },
  { name: 'DATETIME', category: 'Date/Time', params: ['none'] },
  { name: 'TIMESTAMP', category: 'Date/Time', params: ['none'] },
  { name: 'YEAR', category: 'Date/Time', params: ['none'] },
  { name: 'BINARY', category: 'Binary', params: ['length'] },
  { name: 'VARBINARY', category: 'Binary', params: ['length'], defaults: { length: 255 } },
  { name: 'TINYBLOB', category: 'Binary', params: ['none'] },
  { name: 'BLOB', category: 'Binary', params: ['none'] },
  { name: 'MEDIUMBLOB', category: 'Binary', params: ['none'] },
  { name: 'LONGBLOB', category: 'Binary', params: ['none'] },
  { name: 'JSON', category: 'JSON', params: ['none'] },
  { name: 'GEOMETRY', category: 'Geometric', params: ['none'] },
  { name: 'POINT', category: 'Geometric', params: ['none'] },
  { name: 'LINESTRING', category: 'Geometric', params: ['none'] },
  { name: 'POLYGON', category: 'Geometric', params: ['none'] }
]

// --- SQLite (affinity-based) --------------------------------------------------
const SQLITE: TypeDef[] = [
  { name: 'INTEGER', category: 'Numeric', params: ['none'], notes: 'INTEGER PRIMARY KEY is the rowid alias' },
  { name: 'REAL', category: 'Numeric', params: ['none'] },
  { name: 'NUMERIC', category: 'Numeric', params: ['precisionScale'] },
  { name: 'DECIMAL', category: 'Numeric', params: ['precisionScale'] },
  { name: 'BIGINT', category: 'Numeric', params: ['none'] },
  { name: 'DOUBLE', category: 'Numeric', params: ['none'] },
  { name: 'FLOAT', category: 'Numeric', params: ['none'] },
  { name: 'TEXT', category: 'String', params: ['none'] },
  { name: 'VARCHAR', category: 'String', params: ['length'], defaults: { length: 255 } },
  { name: 'CHAR', category: 'String', params: ['length'] },
  { name: 'BOOLEAN', category: 'Boolean', params: ['none'] },
  { name: 'DATE', category: 'Date/Time', params: ['none'] },
  { name: 'DATETIME', category: 'Date/Time', params: ['none'] },
  { name: 'TIME', category: 'Date/Time', params: ['none'] },
  { name: 'BLOB', category: 'Binary', params: ['none'] }
]

// --- Oracle (basic set for display/autocomplete this stage) -------------------
const ORACLE: TypeDef[] = [
  { name: 'NUMBER', category: 'Numeric', params: ['precisionScale'] },
  { name: 'FLOAT', category: 'Numeric', params: ['length'] },
  { name: 'BINARY_FLOAT', category: 'Numeric', params: ['none'] },
  { name: 'BINARY_DOUBLE', category: 'Numeric', params: ['none'] },
  { name: 'VARCHAR2', category: 'String', params: ['length'], defaults: { length: 255 } },
  { name: 'NVARCHAR2', category: 'String', params: ['length'] },
  { name: 'CHAR', category: 'String', params: ['length'] },
  { name: 'NCHAR', category: 'String', params: ['length'] },
  { name: 'CLOB', category: 'String', params: ['none'] },
  { name: 'NCLOB', category: 'String', params: ['none'] },
  { name: 'DATE', category: 'Date/Time', params: ['none'] },
  { name: 'TIMESTAMP', category: 'Date/Time', params: ['none'] },
  { name: 'BLOB', category: 'Binary', params: ['none'] },
  { name: 'RAW', category: 'Binary', params: ['length'] }
]

// --- Microsoft SQL Server -----------------------------------------------------
const MSSQL: TypeDef[] = [
  { name: 'TINYINT', category: 'Numeric', params: ['none'] },
  { name: 'SMALLINT', category: 'Numeric', params: ['none'] },
  { name: 'INT', category: 'Numeric', params: ['none'], aliases: ['integer'] },
  { name: 'BIGINT', category: 'Numeric', params: ['none'] },
  { name: 'DECIMAL', category: 'Numeric', params: ['precisionScale'], aliases: ['dec'] },
  { name: 'NUMERIC', category: 'Numeric', params: ['precisionScale'] },
  { name: 'MONEY', category: 'Numeric', params: ['none'] },
  { name: 'SMALLMONEY', category: 'Numeric', params: ['none'] },
  { name: 'FLOAT', category: 'Numeric', params: ['none'] },
  { name: 'REAL', category: 'Numeric', params: ['none'] },
  { name: 'CHAR', category: 'String', params: ['length'] },
  { name: 'VARCHAR', category: 'String', params: ['length'], defaults: { length: 255 } },
  { name: 'NCHAR', category: 'String', params: ['length'] },
  { name: 'NVARCHAR', category: 'String', params: ['length'], defaults: { length: 255 } },
  { name: 'TEXT', category: 'String', params: ['none'] },
  { name: 'NTEXT', category: 'String', params: ['none'] },
  { name: 'BIT', category: 'Boolean', params: ['none'] },
  { name: 'DATE', category: 'Date/Time', params: ['none'] },
  { name: 'TIME', category: 'Date/Time', params: ['none'] },
  { name: 'SMALLDATETIME', category: 'Date/Time', params: ['none'] },
  { name: 'DATETIME', category: 'Date/Time', params: ['none'] },
  { name: 'DATETIME2', category: 'Date/Time', params: ['none'] },
  { name: 'DATETIMEOFFSET', category: 'Date/Time', params: ['none'] },
  { name: 'UNIQUEIDENTIFIER', category: 'UUID', params: ['none'] },
  { name: 'BINARY', category: 'Binary', params: ['length'] },
  { name: 'VARBINARY', category: 'Binary', params: ['length'] },
  { name: 'IMAGE', category: 'Binary', params: ['none'] },
  { name: 'XML', category: 'Other', params: ['none'] },
  // SQL Server has no native JSON type — JSON is stored/validated in NVARCHAR.
  { name: 'JSON', category: 'JSON', params: ['none'], aliases: ['nvarchar(max)'], notes: 'SQL Server stores JSON as NVARCHAR(MAX).' }
]

// Keyed by SQL dialect — MariaDB reuses the MySQL type set (via sqlDialect()).
export const TYPE_CATALOG: Record<SqlDialect, TypeDef[]> = {
  postgres: PG,
  mysql: MYSQL,
  sqlite: SQLITE,
  oracle: ORACLE,
  mssql: MSSQL
}

export const CATEGORY_ORDER: TypeCategory[] = [
  'Numeric',
  'String',
  'Boolean',
  'Date/Time',
  'JSON',
  'UUID',
  'Binary',
  'Network',
  'Geometric',
  'Other'
]

/** SQLite uses type affinity — surfaced as a UI note. */
export const SQLITE_AFFINITY_NOTE =
  'SQLite uses type affinity: declared types map to INTEGER / REAL / TEXT / BLOB / NUMERIC.'

/** Find a TypeDef by canonical name or alias (case-insensitive). */
export function findType(engine: Engine, typeName: string): TypeDef | undefined {
  const n = typeName.trim().toLowerCase()
  return TYPE_CATALOG[sqlDialect(engine)].find(
    (t) => t.name.toLowerCase() === n || (t.aliases ?? []).some((a) => a.toLowerCase() === n)
  )
}

/** The parameter inputs a given column's type needs (empty if plain). */
export function paramsFor(engine: Engine, typeName: string): ParamKind[] {
  const def = findType(engine, typeName)
  return def ? def.params.filter((p) => p !== 'none') : []
}

function quoteEnum(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

/**
 * Render the full SQL type string for a column, e.g. `VARCHAR(255)`,
 * `NUMERIC(10,2)`, `TIMESTAMP WITH TIME ZONE`, `INT UNSIGNED`,
 * `ENUM('a','b')`, `TEXT[]`. Pure — used by both preview and generator.
 */
export function renderColumnType(engine: Engine, col: ColumnSpec): string {
  engine = sqlDialect(engine)
  const def = findType(engine, col.type)
  const params = def?.params ?? []
  let base = def?.name ?? col.type // fall back to raw free text

  let s = base
  if (params.includes('length') && col.length != null) {
    s += `(${col.length})`
  } else if (params.includes('precisionScale') && col.length != null) {
    s += col.scale != null ? `(${col.length},${col.scale})` : `(${col.length})`
  } else if (
    (params.includes('enumValues') || params.includes('setValues')) &&
    col.enumValues &&
    col.enumValues.length > 0
  ) {
    s += `(${col.enumValues.map(quoteEnum).join(', ')})`
  }

  // MySQL numeric flags.
  if (engine === 'mysql') {
    if (col.unsigned) s += ' UNSIGNED'
    if (col.zerofill) s += ' ZEROFILL'
  }

  // PostgreSQL time zone + array modifier.
  if (engine === 'postgres') {
    if (params.includes('timezone') && col.withTimeZone) s += ' WITH TIME ZONE'
    if (col.isArray) s += '[]'
  }

  return s
}

/**
 * Parse a DB-reported single type string like `varchar(255)`, `decimal(10,2)`,
 * `int unsigned`, `enum('a','b')` into base + params. Used by MySQL and SQLite
 * round-trip (PostgreSQL uses information_schema columns instead).
 */
export function parseTypeString(raw: string): Partial<ColumnSpec> {
  const out: Partial<ColumnSpec> = {}
  let s = raw.trim()

  // Trailing flags (MySQL).
  if (/\bunsigned\b/i.test(s)) {
    out.unsigned = true
    s = s.replace(/\bunsigned\b/gi, '')
  }
  if (/\bzerofill\b/i.test(s)) {
    out.zerofill = true
    s = s.replace(/\bzerofill\b/gi, '')
  }
  s = s.trim()

  const paren = s.indexOf('(')
  if (paren === -1) {
    out.type = s.trim().toUpperCase()
    return out
  }
  const base = s.slice(0, paren).trim().toUpperCase()
  const inner = s.slice(paren + 1, s.lastIndexOf(')'))
  out.type = base

  if (base === 'ENUM' || base === 'SET') {
    // Split quoted values: 'a','b','c'
    const vals: string[] = []
    const re = /'((?:[^']|'')*)'/g
    let m: RegExpExecArray | null
    while ((m = re.exec(inner)) !== null) vals.push(m[1].replace(/''/g, "'"))
    out.enumValues = vals
  } else {
    const parts = inner.split(',').map((p) => Number(p.trim()))
    if (parts.length >= 1 && Number.isFinite(parts[0])) out.length = parts[0]
    if (parts.length >= 2 && Number.isFinite(parts[1])) out.scale = parts[1]
  }
  return out
}

/** Validate a column's type parameters. Returns human-readable errors. */
export function validateColumn(engine: Engine, col: ColumnSpec): string[] {
  engine = sqlDialect(engine)
  const errors: string[] = []
  if (!col.name.trim()) errors.push('column needs a name')
  const params = paramsFor(engine, col.type)

  if (params.includes('length')) {
    if (col.length != null && col.length <= 0) errors.push(`${col.name}: length must be > 0`)
    // MySQL VARCHAR/VARBINARY require an explicit length.
    if (engine === 'mysql' && /^(VARCHAR|VARBINARY)$/i.test(col.type) && col.length == null) {
      errors.push(`${col.name}: ${col.type.toUpperCase()} requires a length`)
    }
  }
  if (params.includes('precisionScale')) {
    if (col.length != null && col.length <= 0) errors.push(`${col.name}: precision must be > 0`)
    if (col.length != null && col.scale != null && col.scale > col.length) {
      errors.push(`${col.name}: scale (${col.scale}) can't exceed precision (${col.length})`)
    }
  }
  if (params.includes('enumValues') || params.includes('setValues')) {
    if (!col.enumValues || col.enumValues.length === 0) {
      errors.push(`${col.name}: ${col.type.toUpperCase()} needs at least one value`)
    }
  }
  return errors
}
