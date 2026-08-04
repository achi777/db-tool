// DDL generation (MAIN process). Pure, synchronous functions that turn a
// structured TableSpec / ObjectOp into the exact SQL statements to run, plus a
// destructive-change analysis. Execution (with per-engine transaction handling)
// lives on the drivers' execStatements(). Generation is branched by engine so
// each dialect's rules are explicit — PostgreSQL, MySQL, and SQLite differ a lot
// (see the SQLite rebuild path below).
import type {
  ColumnSpec,
  DdlPreview,
  Engine,
  FkAction,
  ForeignKeySpec,
  IndexSpec,
  ObjectOp,
  TableSpec
} from '@shared/types'
import { sqlDialect } from '@shared/types'
import { renderColumnType } from '@shared/typeCatalog'

// --- identifier quoting -------------------------------------------------------

function quote(engine: Engine, id: string): string {
  if (engine === 'mysql') return '`' + id.replace(/`/g, '``') + '`'
  if (engine === 'mssql') return '[' + id.replace(/]/g, ']]') + ']'
  return '"' + id.replace(/"/g, '""') + '"'
}

/** Qualified table name. MySQL uses db.table; SQLite has no schema qualifier. */
function qualified(engine: Engine, schema: string, name: string): string {
  const q = (s: string): string => quote(engine, s)
  if (engine === 'sqlite') return q(name)
  return `${q(schema)}.${q(name)}`
}

// --- type + column rendering --------------------------------------------------
// Full type string (incl. length/precision/enum/unsigned/tz/array) comes from
// the shared type catalog so the preview and executed DDL always match.
function renderType(engine: Engine, col: ColumnSpec): string {
  if (engine === 'oracle') return oracleColumnType(col)
  if (engine === 'mssql') return mssqlColumnType(col)
  return renderColumnType(engine, col)
}

/**
 * Map a designer column type (SQL-Server-native OR a generic/other-engine type)
 * to a valid SQL Server type. Handles NVARCHAR(MAX) (length -1), generic
 * integer/varchar/text/boolean/uuid/json/blob, and DECIMAL(p,s). IDENTITY is
 * emitted by columnDef, not here.
 */
function mssqlColumnType(col: ColumnSpec): string {
  const t = (col.type || '').trim().toLowerCase()
  const len = col.length != null ? col.length : null
  const scale = col.scale
  const lenStr = len === -1 ? 'MAX' : String(len ?? 255)
  if (/^(nvarchar|varchar|character varying|nvarchar2|varchar2|string)$/.test(t)) return `NVARCHAR(${lenStr})`
  if (/^(nchar|char|character|bpchar)$/.test(t)) return `NCHAR(${len === -1 ? 'MAX' : String(len ?? 1)})`
  if (/^(text|clob|nclob|longtext|mediumtext|tinytext|ntext)$/.test(t)) return 'NVARCHAR(MAX)'
  if (/^(numeric|decimal|number|dec)$/.test(t)) {
    if (len != null && len > 0) return scale != null && scale !== 0 ? `DECIMAL(${len},${scale})` : `DECIMAL(${len})`
    return 'DECIMAL(18,2)'
  }
  if (/^(tinyint)$/.test(t)) return 'TINYINT'
  if (/^(smallint|int2)$/.test(t)) return 'SMALLINT'
  if (/^(int|integer|int4|mediumint|serial|serial4)$/.test(t)) return 'INT'
  if (/^(bigint|int8|bigserial|serial8)$/.test(t)) return 'BIGINT'
  if (/^(real|float4)$/.test(t)) return 'REAL'
  if (/^(double|double precision|float8|float)$/.test(t)) return 'FLOAT'
  if (/^(money|smallmoney)$/.test(t)) return t.toUpperCase()
  if (/^(bool|boolean|bit)$/.test(t)) return 'BIT'
  if (/^date$/.test(t)) return 'DATE'
  if (/^time$/.test(t)) return 'TIME'
  if (/^(timestamptz|timestamp with time zone|datetimeoffset)$/.test(t)) return 'DATETIMEOFFSET'
  if (/^(timestamp|datetime|datetime2|smalldatetime)$/.test(t)) return t === 'smalldatetime' ? 'SMALLDATETIME' : 'DATETIME2'
  if (/^(blob|bytea|binary|varbinary|longblob|mediumblob|image)$/.test(t)) return `VARBINARY(${len && len > 0 ? String(len) : 'MAX'})`
  if (/^(json|jsonb)$/.test(t)) return 'NVARCHAR(MAX)'
  if (/^(uuid|uniqueidentifier)$/.test(t)) return 'UNIQUEIDENTIFIER'
  if (/^xml$/.test(t)) return 'XML'
  // Already an exact SQL Server type the user typed — pass through uppercased.
  return (col.type || 'NVARCHAR(255)').toUpperCase()
}

/**
 * Map a designer column type (Oracle-native OR a generic/other-engine type) to a
 * valid Oracle type. Oracle has no AUTOINCREMENT/TEXT/BOOLEAN(<23c)/TIMESTAMPTZ
 * keyword, so generic types are translated (integer→NUMBER(10), varchar→
 * VARCHAR2(n), text→CLOB, boolean→NUMBER(1), timestamptz→TIMESTAMP WITH TIME
 * ZONE, json→CLOB, uuid→VARCHAR2(36), …). Length/precision are preserved.
 */
function oracleColumnType(col: ColumnSpec): string {
  const t = (col.type || '').trim().toLowerCase()
  const len = col.length && col.length > 0 ? col.length : null
  const scale = col.scale
  if (/^(varchar2|varchar|character varying|nvarchar2|string)$/.test(t)) return `VARCHAR2(${len ?? 255})`
  if (/^(char|character|nchar|bpchar)$/.test(t)) return `CHAR(${len ?? 1})`
  if (/^(text|clob|nclob|longtext|mediumtext|tinytext|ntext)$/.test(t)) return 'CLOB'
  if (/^(numeric|decimal|number|dec)$/.test(t)) {
    if (len != null) return scale != null && scale !== 0 ? `NUMBER(${len},${scale})` : `NUMBER(${len})`
    return 'NUMBER'
  }
  if (/^(smallint|int2|tinyint)$/.test(t)) return 'NUMBER(5)'
  if (/^(int|integer|int4|mediumint|serial|serial4)$/.test(t)) return 'NUMBER(10)'
  if (/^(bigint|int8|bigserial|serial8)$/.test(t)) return 'NUMBER(19)'
  if (/^(real|float4|binary_float)$/.test(t)) return 'BINARY_FLOAT'
  if (/^(double|double precision|float8|binary_double)$/.test(t)) return 'BINARY_DOUBLE'
  if (/^float$/.test(t)) return len != null ? `FLOAT(${len})` : 'FLOAT'
  if (/^(bool|boolean)$/.test(t)) return 'NUMBER(1)'
  if (/^date$/.test(t)) return 'DATE'
  if (/^(timestamptz|timestamp with time zone|timestamp with local time zone)$/.test(t)) return 'TIMESTAMP WITH TIME ZONE'
  if (/^(timestamp|datetime)$/.test(t)) return 'TIMESTAMP'
  if (/^time$/.test(t)) return 'TIMESTAMP' // Oracle has no TIME-only type
  if (/^(blob|bytea|binary|varbinary|longblob|mediumblob|image)$/.test(t)) return 'BLOB'
  if (/^raw$/.test(t)) return `RAW(${len ?? 2000})`
  if (/^(json|jsonb)$/.test(t)) return 'CLOB'
  if (/^uuid$/.test(t)) return 'VARCHAR2(36)'
  // Already an exact Oracle type the user typed — pass through uppercased.
  return (col.type || 'VARCHAR2(255)').toUpperCase()
}

/** Column definition line for CREATE / ADD COLUMN. */
function columnDef(engine: Engine, col: ColumnSpec, spec: TableSpec): string {
  const q = (s: string): string => quote(engine, s)
  const parts: string[] = [q(col.name)]

  const isSolePkAuto =
    !!col.autoIncrement && spec.primaryKey.length === 1 && spec.primaryKey[0] === col.name

  if (engine === 'postgres') {
    if (col.autoIncrement) {
      // Use serial types (a sequence-backed default); PK declared separately.
      const base = /big|int8/i.test(col.type) ? 'bigserial' : 'serial'
      parts.push(base)
    } else {
      parts.push(renderType(engine, col))
    }
    if (!col.nullable) parts.push('NOT NULL')
    if (col.default != null && col.default !== '' && !col.autoIncrement)
      parts.push(`DEFAULT ${col.default}`)
  } else if (engine === 'mysql') {
    parts.push(renderType(engine, col))
    if (!col.nullable) parts.push('NOT NULL')
    if (col.default != null && col.default !== '') parts.push(`DEFAULT ${col.default}`)
    if (col.autoIncrement) parts.push('AUTO_INCREMENT')
    if (col.comment) parts.push(`COMMENT ${sqlString(col.comment)}`)
  } else if (engine === 'oracle') {
    // Oracle: IDENTITY (12c+), NOT AUTOINCREMENT. The PK is declared ONCE at the
    // table level (see buildCreateTable), never inline here — fixes the doubled
    // PRIMARY KEY bug. Clause order: type, DEFAULT, NOT NULL.
    if (col.autoIncrement) {
      // IDENTITY columns are always NUMBER and implicitly NOT NULL; no DEFAULT.
      parts.push('NUMBER GENERATED BY DEFAULT AS IDENTITY')
      return parts.join(' ')
    }
    parts.push(renderType(engine, col))
    if (col.default != null && col.default !== '') parts.push(`DEFAULT ${col.default}`)
    if (!col.nullable) parts.push('NOT NULL')
  } else if (engine === 'mssql') {
    // SQL Server: IDENTITY(1,1) for auto-increment; PK declared at the table
    // level (like Oracle). Clause order: type, IDENTITY, NOT NULL, DEFAULT.
    if (col.autoIncrement) {
      const base = /big|int8/i.test(col.type) ? 'BIGINT' : 'INT'
      parts.push(`${base} IDENTITY(1,1)`)
      parts.push('NOT NULL')
      return parts.join(' ')
    }
    parts.push(renderType(engine, col))
    if (!col.nullable) parts.push('NOT NULL')
    if (col.default != null && col.default !== '') parts.push(`DEFAULT ${col.default}`)
  } else {
    // sqlite
    if (isSolePkAuto) {
      // Only INTEGER PRIMARY KEY AUTOINCREMENT is valid; PK handled inline here.
      parts.push('INTEGER PRIMARY KEY AUTOINCREMENT')
      if (!col.nullable) {
        /* PK is implicitly not null */
      }
      return parts.join(' ')
    }
    parts.push(renderType(engine, col))
    if (!col.nullable) parts.push('NOT NULL')
    if (col.default != null && col.default !== '') parts.push(`DEFAULT ${col.default}`)
  }
  return parts.join(' ')
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function fkClause(engine: Engine, fk: ForeignKeySpec): string {
  const q = (s: string): string => quote(engine, s)
  const cols = fk.columns.map(q).join(', ')
  const refCols = fk.refColumns.map(q).join(', ')
  const refTable =
    engine === 'sqlite'
      ? q(fk.refTable)
      : fk.refSchema
        ? `${q(fk.refSchema)}.${q(fk.refTable)}`
        : q(fk.refTable)
  let clause = `FOREIGN KEY (${cols}) REFERENCES ${refTable} (${refCols})`
  if (engine === 'oracle') {
    // Oracle FKs support ONLY `ON DELETE CASCADE` / `ON DELETE SET NULL`
    // (no RESTRICT/NO ACTION clause, and no ON UPDATE at all).
    if (fk.onDelete === 'CASCADE' || fk.onDelete === 'SET NULL') clause += ` ON DELETE ${fk.onDelete}`
    return clause
  }
  if (engine === 'mssql') {
    // SQL Server has no RESTRICT — normalize it to NO ACTION (same behavior).
    const norm = (a: FkAction): string => (a === 'RESTRICT' ? 'NO ACTION' : a)
    if (fk.onDelete) clause += ` ON DELETE ${norm(fk.onDelete)}`
    if (fk.onUpdate) clause += ` ON UPDATE ${norm(fk.onUpdate)}`
    return clause
  }
  if (fk.onDelete) clause += ` ON DELETE ${fk.onDelete}`
  if (fk.onUpdate) clause += ` ON UPDATE ${fk.onUpdate}`
  return clause
}

function indexName(spec: TableSpec, idx: IndexSpec): string {
  return idx.name && idx.name.trim()
    ? idx.name.trim()
    : `idx_${spec.name}_${idx.columns.join('_')}`
}

function createIndexStmt(engine: Engine, spec: TableSpec, idx: IndexSpec): string {
  const q = (s: string): string => quote(engine, s)
  const name = indexName(spec, idx)
  const cols = idx.columns.map(q).join(', ')
  const unique = idx.unique ? 'UNIQUE ' : ''
  const on = qualified(engine, spec.schema, spec.name)
  return `CREATE ${unique}INDEX ${q(name)} ON ${on} (${cols})`
}

// --- CREATE TABLE -------------------------------------------------------------

function buildCreateTable(engine: Engine, spec: TableSpec): { statements: string[]; notes: string[] } {
  const q = (s: string): string => quote(engine, s)
  const lines: string[] = spec.columns.map((c) => '  ' + columnDef(engine, c, spec))

  // Table-level PRIMARY KEY, unless SQLite already declared it inline.
  const sqliteInlinePk =
    engine === 'sqlite' &&
    spec.primaryKey.length === 1 &&
    spec.columns.some((c) => c.name === spec.primaryKey[0] && c.autoIncrement)
  if (spec.primaryKey.length > 0 && !sqliteInlinePk) {
    lines.push('  PRIMARY KEY (' + spec.primaryKey.map(q).join(', ') + ')')
  }
  // Inline foreign keys.
  for (const fk of spec.foreignKeys) {
    const named = fk.name ? `CONSTRAINT ${q(fk.name)} ` : ''
    lines.push('  ' + named + fkClause(engine, fk))
  }

  const tableName = qualified(engine, spec.schema, spec.name)
  let create = `CREATE TABLE ${tableName} (\n${lines.join(',\n')}\n)`
  if (engine === 'mysql') create += ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'

  const statements = [create]
  for (const idx of spec.indexes) statements.push(createIndexStmt(engine, spec, idx))

  // Comments: PG via COMMENT ON; MySQL is inline; SQLite unsupported.
  const notes: string[] = []
  if (engine === 'postgres') {
    if (spec.comment) statements.push(`COMMENT ON TABLE ${tableName} IS ${sqlString(spec.comment)}`)
    for (const c of spec.columns) {
      if (c.comment)
        statements.push(
          `COMMENT ON COLUMN ${tableName}.${q(c.name)} IS ${sqlString(c.comment)}`
        )
    }
  } else if (engine === 'sqlite') {
    if (spec.columns.some((c) => c.comment) || spec.comment)
      notes.push('SQLite does not support column/table comments; they are ignored.')
  } else if (engine === 'oracle') {
    if (spec.columns.some((c) => /^(bool|boolean)$/i.test(c.type)))
      notes.push('Oracle (<23c) has no BOOLEAN type; boolean columns are created as NUMBER(1).')
    if (spec.columns.some((c) => /^(json|jsonb)$/i.test(c.type)))
      notes.push('json columns are created as CLOB (use JSON on Oracle 21c+ if needed).')
  }
  return { statements, notes }
}

// --- ALTER TABLE (diff original -> spec) --------------------------------------

function colChanged(engine: Engine, o: ColumnSpec, n: ColumnSpec): boolean {
  return (
    renderType(engine, o).toLowerCase() !== renderType(engine, n).toLowerCase() ||
    o.nullable !== n.nullable ||
    (o.default ?? '') !== (n.default ?? '')
  )
}

interface Diff {
  adds: ColumnSpec[]
  drops: ColumnSpec[]
  mods: { orig: ColumnSpec; next: ColumnSpec; renamed: boolean; typeChanged: boolean; nowNotNull: boolean }[]
  pkChanged: boolean
  addedIndexes: IndexSpec[]
  droppedIndexes: IndexSpec[]
  addedFks: ForeignKeySpec[]
  droppedFks: ForeignKeySpec[]
}

function diffTable(engine: Engine, original: TableSpec, spec: TableSpec): Diff {
  const matched = new Set<string>()
  const adds: ColumnSpec[] = []
  const mods: Diff['mods'] = []
  for (const c of spec.columns) {
    const origName = c.originalName ?? c.name
    const o = original.columns.find((oc) => oc.name === origName)
    if (o) {
      matched.add(o.name)
      const renamed = o.name !== c.name
      if (renamed || colChanged(engine, o, c)) {
        mods.push({
          orig: o,
          next: c,
          renamed,
          typeChanged: renderType(engine, o).toLowerCase() !== renderType(engine, c).toLowerCase(),
          nowNotNull: o.nullable && !c.nullable
        })
      }
    } else {
      adds.push(c)
    }
  }
  const drops = original.columns.filter((o) => !matched.has(o.name))

  const pkChanged = original.primaryKey.join(',') !== spec.primaryKey.join(',')

  const idxKey = (i: IndexSpec): string => `${i.unique ? 'u' : ''}:${i.columns.join(',')}`
  const origIdx = new Map(original.indexes.map((i) => [idxKey(i), i]))
  const specIdx = new Map(spec.indexes.map((i) => [idxKey(i), i]))
  const addedIndexes = spec.indexes.filter((i) => !origIdx.has(idxKey(i)))
  const droppedIndexes = original.indexes.filter((i) => !specIdx.has(idxKey(i)))

  const fkKey = (f: ForeignKeySpec): string =>
    `${f.columns.join(',')}->${f.refTable}(${f.refColumns.join(',')})`
  const origFk = new Map(original.foreignKeys.map((f) => [fkKey(f), f]))
  const specFk = new Map(spec.foreignKeys.map((f) => [fkKey(f), f]))
  const addedFks = spec.foreignKeys.filter((f) => !origFk.has(fkKey(f)))
  const droppedFks = original.foreignKeys.filter((f) => !specFk.has(fkKey(f)))

  return { adds, drops, mods, pkChanged, addedIndexes, droppedIndexes, addedFks, droppedFks }
}

function buildAlterPgMysql(
  engine: Engine,
  original: TableSpec,
  spec: TableSpec,
  diff: Diff
): { statements: string[]; destructiveReasons: string[]; notes: string[] } {
  const q = (s: string): string => quote(engine, s)
  const t = qualified(engine, spec.schema, spec.name)
  const statements: string[] = []
  const destructiveReasons: string[] = []
  const notes: string[] = []

  // Renames first (so later ops reference new names).
  for (const m of diff.mods) {
    if (m.renamed) {
      if (engine === 'postgres') {
        statements.push(`ALTER TABLE ${t} RENAME COLUMN ${q(m.orig.name)} TO ${q(m.next.name)}`)
      }
      // MySQL: rename handled by CHANGE below (needs full definition).
    }
  }

  for (const c of diff.adds) {
    statements.push(`ALTER TABLE ${t} ADD COLUMN ${columnDef(engine, c, spec)}`)
  }

  for (const m of diff.mods) {
    if (engine === 'postgres') {
      if (m.typeChanged)
        statements.push(
          `ALTER TABLE ${t} ALTER COLUMN ${q(m.next.name)} TYPE ${renderType(engine, m.next)}`
        )
      if (m.orig.nullable !== m.next.nullable) {
        statements.push(
          `ALTER TABLE ${t} ALTER COLUMN ${q(m.next.name)} ${
            m.next.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'
          }`
        )
      }
      if ((m.orig.default ?? '') !== (m.next.default ?? '')) {
        statements.push(
          m.next.default
            ? `ALTER TABLE ${t} ALTER COLUMN ${q(m.next.name)} SET DEFAULT ${m.next.default}`
            : `ALTER TABLE ${t} ALTER COLUMN ${q(m.next.name)} DROP DEFAULT`
        )
      }
    } else {
      // MySQL: CHANGE handles rename+type+null+default in one shot.
      const def = columnDef(engine, m.next, spec)
      // def begins with the (new) quoted name; CHANGE needs old name then def.
      statements.push(`ALTER TABLE ${t} CHANGE COLUMN ${q(m.orig.name)} ${def}`)
    }
    if (m.typeChanged) destructiveReasons.push(`type change on column "${m.next.name}" may lose data`)
    if (m.nowNotNull)
      destructiveReasons.push(`setting NOT NULL on "${m.next.name}" fails if existing rows are null`)
  }

  for (const c of diff.drops) {
    statements.push(`ALTER TABLE ${t} DROP COLUMN ${q(c.name)}`)
    destructiveReasons.push(`drops column "${c.name}" (data in it is lost)`)
  }

  if (diff.pkChanged) {
    if (original.primaryKey.length > 0) {
      if (engine === 'postgres') {
        statements.push(`ALTER TABLE ${t} DROP CONSTRAINT ${q(spec.name + '_pkey')}`)
      } else {
        statements.push(`ALTER TABLE ${t} DROP PRIMARY KEY`)
      }
      destructiveReasons.push('drops the existing primary key')
    }
    if (spec.primaryKey.length > 0) {
      statements.push(`ALTER TABLE ${t} ADD PRIMARY KEY (${spec.primaryKey.map(q).join(', ')})`)
    }
  }

  for (const fk of diff.droppedFks) {
    if (fk.name) {
      statements.push(
        engine === 'postgres'
          ? `ALTER TABLE ${t} DROP CONSTRAINT ${q(fk.name)}`
          : `ALTER TABLE ${t} DROP FOREIGN KEY ${q(fk.name)}`
      )
      destructiveReasons.push(`drops foreign key "${fk.name}"`)
    } else {
      notes.push('A removed foreign key had no name and could not be dropped automatically.')
    }
  }
  for (const fk of diff.addedFks) {
    const named = fk.name ? `CONSTRAINT ${q(fk.name)} ` : ''
    statements.push(`ALTER TABLE ${t} ADD ${named}${fkClause(engine, fk)}`)
  }

  for (const idx of diff.droppedIndexes) {
    const name = indexName(original, idx)
    statements.push(
      engine === 'postgres'
        ? `DROP INDEX ${q(name)}`
        : `ALTER TABLE ${t} DROP INDEX ${q(name)}`
    )
  }
  for (const idx of diff.addedIndexes) statements.push(createIndexStmt(engine, spec, idx))

  if (engine === 'mysql') notes.push('MySQL DDL is not transactional; statements apply one by one.')
  return { statements, destructiveReasons, notes }
}

/** SQLite: use direct ALTER for simple changes, else the 12-step rebuild. */
function buildAlterSqlite(
  original: TableSpec,
  spec: TableSpec,
  diff: Diff
): { statements: string[]; destructiveReasons: string[]; notes: string[] } {
  const q = (s: string): string => quote('sqlite', s)
  const t = q(spec.name)
  const needsRebuild =
    diff.mods.some((m) => m.typeChanged || m.orig.nullable !== m.next.nullable) ||
    diff.pkChanged ||
    diff.droppedFks.length > 0 ||
    diff.addedFks.length > 0

  if (!needsRebuild) {
    // Simple path: ADD/RENAME/DROP COLUMN + index create/drop (SQLite 3.25+/3.35+).
    const statements: string[] = []
    const destructiveReasons: string[] = []
    for (const m of diff.mods) {
      if (m.renamed) statements.push(`ALTER TABLE ${t} RENAME COLUMN ${q(m.orig.name)} TO ${q(m.next.name)}`)
      // default-only change is not supported by ALTER; ignore silently (rare).
    }
    for (const c of diff.adds) statements.push(`ALTER TABLE ${t} ADD COLUMN ${columnDef('sqlite', c, spec)}`)
    for (const c of diff.drops) {
      statements.push(`ALTER TABLE ${t} DROP COLUMN ${q(c.name)}`)
      destructiveReasons.push(`drops column "${c.name}" (data in it is lost)`)
    }
    for (const idx of diff.droppedIndexes) statements.push(`DROP INDEX ${q(indexName(original, idx))}`)
    for (const idx of diff.addedIndexes) statements.push(createIndexStmt('sqlite', spec, idx))
    return { statements, destructiveReasons, notes: [] }
  }

  // Rebuild path (12-step). Copy overlapping columns old->new (by mapping
  // renamed columns via originalName), swap tables, recreate indexes.
  const tmp = `_new_${spec.name}`
  const created = buildCreateTable('sqlite', { ...spec, name: tmp })
  const statements: string[] = []
  statements.push(...created.statements.filter((s) => s.startsWith('CREATE TABLE')))

  // Column mapping: for each NEW column that existed before, copy from old name.
  const selectPairs: { from: string; to: string }[] = []
  for (const c of spec.columns) {
    const origName = c.originalName ?? c.name
    if (original.columns.some((o) => o.name === origName)) {
      selectPairs.push({ from: origName, to: c.name })
    }
  }
  const insertCols = selectPairs.map((p) => q(p.to)).join(', ')
  const selectCols = selectPairs.map((p) => q(p.from)).join(', ')
  statements.push(
    `INSERT INTO ${q(tmp)} (${insertCols}) SELECT ${selectCols} FROM ${t}`
  )
  statements.push(`DROP TABLE ${t}`)
  statements.push(`ALTER TABLE ${q(tmp)} RENAME TO ${q(spec.name)}`)
  // Recreate all indexes from the new spec.
  for (const idx of spec.indexes) statements.push(createIndexStmt('sqlite', spec, idx))

  const destructiveReasons: string[] = []
  for (const c of diff.drops) destructiveReasons.push(`drops column "${c.name}" (data in it is lost)`)
  for (const m of diff.mods) {
    if (m.typeChanged) destructiveReasons.push(`type change on "${m.next.name}" may lose data`)
    if (m.nowNotNull) destructiveReasons.push(`setting NOT NULL on "${m.next.name}" fails if rows are null`)
  }
  const notes = [
    'SQLite cannot ALTER this in place, so the table is rebuilt: a new table is ' +
      'created, data is copied over, the old table is dropped, and the new one is ' +
      'renamed into place — all inside a transaction with foreign keys disabled.'
  ]
  return { statements, destructiveReasons, notes }
}

/** Oracle ALTER TABLE: ADD (col…), MODIFY (col…), DROP COLUMN, PK/FK/index. */
function buildAlterOracle(
  original: TableSpec,
  spec: TableSpec,
  diff: Diff
): { statements: string[]; destructiveReasons: string[]; notes: string[] } {
  const q = (s: string): string => quote('oracle', s)
  const t = qualified('oracle', spec.schema, spec.name)
  const statements: string[] = []
  const destructiveReasons: string[] = []
  const notes: string[] = []

  // Renames first, so later ops reference the new names.
  for (const m of diff.mods) {
    if (m.renamed) statements.push(`ALTER TABLE ${t} RENAME COLUMN ${q(m.orig.name)} TO ${q(m.next.name)}`)
  }

  for (const c of diff.adds) statements.push(`ALTER TABLE ${t} ADD (${columnDef('oracle', c, spec)})`)

  for (const m of diff.mods) {
    // MODIFY only the aspects that changed (re-asserting NOT NULL/NULL that is
    // already set is an Oracle error).
    const clauses: string[] = []
    if (m.typeChanged) clauses.push(renderType('oracle', m.next))
    if ((m.orig.default ?? '') !== (m.next.default ?? '')) {
      clauses.push(m.next.default ? `DEFAULT ${m.next.default}` : 'DEFAULT NULL')
    }
    if (m.orig.nullable !== m.next.nullable) clauses.push(m.next.nullable ? 'NULL' : 'NOT NULL')
    if (clauses.length) statements.push(`ALTER TABLE ${t} MODIFY (${q(m.next.name)} ${clauses.join(' ')})`)
    if (m.typeChanged) destructiveReasons.push(`type change on column "${m.next.name}" may lose data`)
    if (m.nowNotNull) destructiveReasons.push(`setting NOT NULL on "${m.next.name}" fails if existing rows are null`)
  }

  for (const c of diff.drops) {
    statements.push(`ALTER TABLE ${t} DROP COLUMN ${q(c.name)}`)
    destructiveReasons.push(`drops column "${c.name}" (data in it is lost)`)
  }

  if (diff.pkChanged) {
    if (original.primaryKey.length > 0) {
      statements.push(`ALTER TABLE ${t} DROP PRIMARY KEY`)
      destructiveReasons.push('drops the existing primary key')
    }
    if (spec.primaryKey.length > 0) {
      statements.push(`ALTER TABLE ${t} ADD PRIMARY KEY (${spec.primaryKey.map(q).join(', ')})`)
    }
  }

  for (const fk of diff.droppedFks) {
    if (fk.name) {
      statements.push(`ALTER TABLE ${t} DROP CONSTRAINT ${q(fk.name)}`)
      destructiveReasons.push(`drops foreign key "${fk.name}"`)
    } else {
      notes.push('A removed foreign key had no name and could not be dropped automatically.')
    }
  }
  for (const fk of diff.addedFks) {
    const named = fk.name ? `CONSTRAINT ${q(fk.name)} ` : ''
    statements.push(`ALTER TABLE ${t} ADD ${named}${fkClause('oracle', fk)}`)
  }

  for (const idx of diff.droppedIndexes) statements.push(`DROP INDEX ${q(indexName(original, idx))}`)
  for (const idx of diff.addedIndexes) statements.push(createIndexStmt('oracle', spec, idx))

  return { statements, destructiveReasons, notes }
}

/** SQL Server ALTER: sp_rename column, ADD, ALTER COLUMN, DROP COLUMN, PK/FK/index. */
function buildAlterMssql(
  original: TableSpec,
  spec: TableSpec,
  diff: Diff
): { statements: string[]; destructiveReasons: string[]; notes: string[] } {
  const q = (s: string): string => quote('mssql', s)
  const t = qualified('mssql', spec.schema, spec.name)
  const statements: string[] = []
  const destructiveReasons: string[] = []
  const notes: string[] = []

  // Column renames via sp_rename 'schema.table.old', 'new', 'COLUMN'.
  for (const m of diff.mods) {
    if (m.renamed)
      statements.push(`EXEC sp_rename ${sqlString(`${spec.schema}.${spec.name}.${m.orig.name}`)}, ${sqlString(m.next.name)}, 'COLUMN'`)
  }

  for (const c of diff.adds) statements.push(`ALTER TABLE ${t} ADD ${columnDef('mssql', c, spec)}`)

  for (const m of diff.mods) {
    // ALTER COLUMN changes type/nullability (one column at a time). A DEFAULT
    // change is a named constraint on SQL Server — out of scope, so noted.
    if (m.typeChanged || m.orig.nullable !== m.next.nullable) {
      statements.push(`ALTER TABLE ${t} ALTER COLUMN ${q(m.next.name)} ${renderType('mssql', m.next)} ${m.next.nullable ? 'NULL' : 'NOT NULL'}`)
    }
    if ((m.orig.default ?? '') !== (m.next.default ?? ''))
      notes.push(`Default change on "${m.next.name}" needs a named DEFAULT constraint on SQL Server — not applied automatically.`)
    if (m.typeChanged) destructiveReasons.push(`type change on column "${m.next.name}" may lose data`)
    if (m.nowNotNull) destructiveReasons.push(`setting NOT NULL on "${m.next.name}" fails if existing rows are null`)
  }

  for (const c of diff.drops) {
    statements.push(`ALTER TABLE ${t} DROP COLUMN ${q(c.name)}`)
    destructiveReasons.push(`drops column "${c.name}" (data in it is lost)`)
  }

  if (diff.pkChanged) {
    if (original.primaryKey.length > 0) {
      // The PK constraint must be dropped by name.
      const pkName = original.name ? `PK_${original.name}` : null
      notes.push('Dropping a primary key on SQL Server needs its constraint name; verify the generated DROP CONSTRAINT.')
      if (pkName) statements.push(`ALTER TABLE ${t} DROP CONSTRAINT ${q(pkName)}`)
      destructiveReasons.push('drops the existing primary key')
    }
    if (spec.primaryKey.length > 0) {
      statements.push(`ALTER TABLE ${t} ADD PRIMARY KEY (${spec.primaryKey.map(q).join(', ')})`)
    }
  }

  for (const fk of diff.droppedFks) {
    if (fk.name) {
      statements.push(`ALTER TABLE ${t} DROP CONSTRAINT ${q(fk.name)}`)
      destructiveReasons.push(`drops foreign key "${fk.name}"`)
    } else {
      notes.push('A removed foreign key had no name and could not be dropped automatically.')
    }
  }
  for (const fk of diff.addedFks) {
    const named = fk.name ? `CONSTRAINT ${q(fk.name)} ` : ''
    statements.push(`ALTER TABLE ${t} ADD ${named}${fkClause('mssql', fk)}`)
  }

  // DROP INDEX name ON schema.table (SQL Server form, like MySQL — not Oracle).
  for (const idx of diff.droppedIndexes) statements.push(`DROP INDEX ${q(indexName(original, idx))} ON ${t}`)
  for (const idx of diff.addedIndexes) statements.push(createIndexStmt('mssql', spec, idx))

  return { statements, destructiveReasons, notes }
}

// --- public API ---------------------------------------------------------------

export function buildTableDdl(
  engine: Engine,
  mode: 'create' | 'alter',
  spec: TableSpec,
  original?: TableSpec | null
): DdlPreview {
  engine = sqlDialect(engine)
  let statements: string[] = []
  let destructiveReasons: string[] = []
  let notes: string[] = []

  if (mode === 'create') {
    const r = buildCreateTable(engine, spec)
    statements = r.statements
    notes = r.notes
  } else {
    if (!original) throw new Error('ALTER requires the original table structure')
    const diff = diffTable(engine, original, spec)
    // Table rename (all engines support RENAME TABLE / ALTER ... RENAME TO).
    if (original.name !== spec.name) {
      if (engine === 'mysql') {
        statements.push(
          `RENAME TABLE ${qualified(engine, original.schema, original.name)} TO ${qualified(
            engine,
            spec.schema,
            spec.name
          )}`
        )
      } else if (engine === 'postgres' || engine === 'oracle') {
        // Both take a bare (unqualified) new name after RENAME TO.
        statements.push(
          `ALTER TABLE ${qualified(engine, original.schema, original.name)} RENAME TO ${quote(
            engine,
            spec.name
          )}`
        )
      } else if (engine === 'mssql') {
        // SQL Server renames via sp_rename; the new name is bare (no schema).
        statements.push(`EXEC sp_rename ${sqlString(`${original.schema}.${original.name}`)}, ${sqlString(spec.name)}`)
      }
      // SQLite rename handled within its builder / rebuild.
    }
    const r =
      engine === 'sqlite'
        ? buildAlterSqlite(original, spec, diff)
        : engine === 'oracle'
          ? buildAlterOracle(original, spec, diff)
          : engine === 'mssql'
            ? buildAlterMssql(original, spec, diff)
            : buildAlterPgMysql(engine, original, spec, diff)
    statements.push(...r.statements)
    destructiveReasons = r.destructiveReasons
    notes = r.notes
    if (statements.length === 0) notes.push('No changes detected.')
  }

  return {
    sql: statements.join(';\n\n') + (statements.length ? ';' : ''),
    statements,
    destructive: destructiveReasons.length > 0,
    destructiveReasons,
    notes
  }
}

// --- transfer helpers (used by the cross-engine data-transfer feature) --------

/**
 * The column type a given column would get on `engine` — the exact string the
 * transfer planner shows and CREATE TABLE emits. Reuses the per-engine type
 * translation (oracle/mssql specials + the shared type catalog).
 */
export function targetColumnType(engine: Engine, col: ColumnSpec): string {
  return renderType(sqlDialect(engine), col)
}

/**
 * ALTER TABLE ADD [CONSTRAINT] FOREIGN KEY … for each FK in `spec`. A transfer
 * creates tables WITHOUT foreign keys, loads all data, then adds the FKs last,
 * so referential integrity is validated once every row is present.
 */
export function buildAddForeignKeys(engine: Engine, spec: TableSpec): string[] {
  engine = sqlDialect(engine)
  const q = (s: string): string => quote(engine, s)
  const t = qualified(engine, spec.schema, spec.name)
  return spec.foreignKeys.map((fk) => {
    const named = fk.name ? `CONSTRAINT ${q(fk.name)} ` : ''
    return `ALTER TABLE ${t} ADD ${named}${fkClause(engine, fk)}`
  })
}

/** CREATE INDEX statements for a spec (run separately so a name clash doesn't abort the table). */
export function buildCreateIndexes(engine: Engine, spec: TableSpec): string[] {
  engine = sqlDialect(engine)
  return spec.indexes.map((idx) => createIndexStmt(engine, spec, idx))
}

export function buildObjectOp(engine: Engine, op: ObjectOp): DdlPreview {
  engine = sqlDialect(engine)
  const q = (s: string): string => quote(engine, s)
  const statements: string[] = []
  const destructiveReasons: string[] = []
  const notes: string[] = []

  switch (op.kind) {
    case 'createSchema':
      if (engine === 'postgres' || engine === 'mssql') statements.push(`CREATE SCHEMA ${q(op.name)}`)
      else if (engine === 'mysql') statements.push(`CREATE DATABASE ${q(op.name)}`)
      else notes.push('SQLite databases are files — create one by adding a SQLite connection with a new file path.')
      break
    case 'dropSchema':
      if (engine === 'postgres') statements.push(`DROP SCHEMA ${q(op.name)} CASCADE`)
      else if (engine === 'mysql') statements.push(`DROP DATABASE ${q(op.name)}`)
      else if (engine === 'mssql') {
        statements.push(`DROP SCHEMA ${q(op.name)}`)
        notes.push('SQL Server drops a schema only when it is empty (no CASCADE).')
      } else notes.push('SQLite databases are files — delete the file to drop the database.')
      destructiveReasons.push(`drops ${engine === 'mysql' ? 'database' : 'schema'} "${op.name}" and everything in it`)
      break
    case 'renameSchema':
      if (engine === 'postgres') statements.push(`ALTER SCHEMA ${q(op.name)} RENAME TO ${q(op.newName)}`)
      else notes.push('Renaming a database is not supported on this engine.')
      break
    case 'dropTable':
      if (engine === 'oracle') {
        // CASCADE CONSTRAINTS drops FKs that reference this table; PURGE skips
        // the recycle bin (the table cannot be FLASHBACK-restored afterwards).
        statements.push(`DROP TABLE ${qualified(engine, op.schema, op.table)} CASCADE CONSTRAINTS PURGE`)
        notes.push('Oracle: CASCADE CONSTRAINTS drops referencing foreign keys; PURGE bypasses the recycle bin (no FLASHBACK restore).')
      } else {
        statements.push(`DROP TABLE ${qualified(engine, op.schema, op.table)}`)
      }
      destructiveReasons.push(`drops table "${op.table}" and all its rows`)
      break
    case 'truncateTable':
      if (engine === 'sqlite') statements.push(`DELETE FROM ${q(op.table)}`)
      else statements.push(`TRUNCATE TABLE ${qualified(engine, op.schema, op.table)}`)
      destructiveReasons.push(`removes ALL rows from "${op.table}"`)
      break
    case 'renameTable':
      if (engine === 'mysql')
        statements.push(
          `RENAME TABLE ${qualified(engine, op.schema, op.table)} TO ${qualified(engine, op.schema, op.newName)}`
        )
      else if (engine === 'mssql')
        statements.push(`EXEC sp_rename ${sqlString(`${op.schema}.${op.table}`)}, ${sqlString(op.newName)}`)
      else
        statements.push(
          `ALTER TABLE ${qualified(engine, op.schema, op.table)} RENAME TO ${quote(engine, op.newName)}`
        )
      break
    case 'dropView':
      statements.push(`DROP VIEW ${qualified(engine, op.schema, op.name)}`)
      destructiveReasons.push(`drops view "${op.name}"`)
      break
    case 'dropRoutine': {
      const kw = op.routineKind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
      // PostgreSQL can overload by signature, so include it to target the right one.
      const sig = engine === 'postgres' ? (op.signature ?? '()') : ''
      statements.push(`DROP ${kw} ${qualified(engine, op.schema, op.name)}${sig}`)
      destructiveReasons.push(`drops ${op.routineKind} "${op.name}${sig}"`)
      break
    }
    case 'dropPackage':
      // Dropping a package drops both its spec and body (Oracle).
      statements.push(`DROP PACKAGE ${qualified(engine, op.schema, op.name)}`)
      destructiveReasons.push(`drops package "${op.name}" (spec + body)`)
      break
    case 'dropPackageBody':
      statements.push(`DROP PACKAGE BODY ${qualified(engine, op.schema, op.name)}`)
      destructiveReasons.push(`drops the body of package "${op.name}" (spec kept)`)
      break
    case 'dropSequence':
      statements.push(`DROP SEQUENCE ${qualified(engine, op.schema, op.name)}`)
      destructiveReasons.push(`drops sequence "${op.name}" permanently`)
      notes.push('If this sequence is OWNED BY a column (e.g. a SERIAL), dropping it may break that column’s default.')
      break
    case 'dropTrigger':
      // DROP TRIGGER syntax differs by engine (PG needs ON table; MySQL is
      // db-qualified; SQLite is bare).
      if (engine === 'postgres') {
        statements.push(`DROP TRIGGER ${q(op.name)} ON ${qualified(engine, op.schema, op.table)}`)
      } else if (engine === 'mysql') {
        statements.push(`DROP TRIGGER ${q(op.schema)}.${q(op.name)}`)
      } else if (engine === 'oracle') {
        // Oracle triggers are schema-scoped objects, not qualified by their table.
        statements.push(`DROP TRIGGER ${qualified(engine, op.schema, op.name)}`)
      } else if (engine === 'mssql') {
        // SQL Server DML triggers are schema-scoped (by the table's schema).
        statements.push(`DROP TRIGGER ${q(op.schema)}.${q(op.name)}`)
      } else {
        statements.push(`DROP TRIGGER ${q(op.name)}`)
      }
      destructiveReasons.push(`drops trigger "${op.name}" on "${op.table}"`)
      break
    case 'dropIndex':
      // DROP INDEX form differs: MySQL + SQL Server need ON table; PG/Oracle are
      // schema-scoped.
      if (engine === 'mysql' || engine === 'mssql') {
        statements.push(`DROP INDEX ${q(op.name)} ON ${qualified(engine, op.schema, op.table)}`)
      } else {
        statements.push(`DROP INDEX ${qualified(engine, op.schema, op.name)}`)
      }
      destructiveReasons.push(`drops index "${op.name}" on "${op.table}"`)
      break

    // --- PostgreSQL advanced objects (TASK 67) ---
    case 'dropMatView':
      statements.push(`DROP MATERIALIZED VIEW ${qualified(engine, op.schema, op.name)}`)
      destructiveReasons.push(`drops materialized view "${op.name}" and its stored data`)
      break
    case 'refreshMatView':
      statements.push(`REFRESH MATERIALIZED VIEW ${op.concurrently ? 'CONCURRENTLY ' : ''}${qualified(engine, op.schema, op.name)}`)
      if (op.concurrently) notes.push('CONCURRENTLY requires a UNIQUE index on the materialized view; PostgreSQL errors otherwise.')
      break
    case 'dropType':
      statements.push(`DROP TYPE ${qualified(engine, op.schema, op.name)}${op.cascade ? ' CASCADE' : ''}`)
      destructiveReasons.push(`drops type "${op.name}"${op.cascade ? ' and every column/object that depends on it (CASCADE)' : ''}`)
      if (!op.cascade) notes.push('If the type is used by a column, PostgreSQL blocks the drop — re-run with CASCADE to force it.')
      break
    case 'createExtension': {
      const parts = [`CREATE EXTENSION IF NOT EXISTS ${q(op.name)}`]
      if (op.schema) parts.push(`SCHEMA ${q(op.schema)}`)
      if (op.version) parts.push(`VERSION ${sqlString(op.version)}`)
      statements.push(parts.join(' '))
      notes.push('Some extensions require superuser privileges; the server will report an error if not permitted.')
      break
    }
    case 'updateExtension':
      statements.push(`ALTER EXTENSION ${q(op.name)} UPDATE${op.version ? ` TO ${sqlString(op.version)}` : ''}`)
      break
    case 'dropExtension':
      statements.push(`DROP EXTENSION ${q(op.name)}${op.cascade ? ' CASCADE' : ''}`)
      destructiveReasons.push(`drops extension "${op.name}"${op.cascade ? ' and every dependent object (CASCADE)' : ''}`)
      if (!op.cascade) notes.push('If other objects depend on the extension, PostgreSQL blocks the drop — re-run with CASCADE to force it.')
      break
  }

  return {
    sql: statements.join(';\n\n') + (statements.length ? ';' : ''),
    statements,
    destructive: destructiveReasons.length > 0,
    destructiveReasons,
    notes
  }
}
