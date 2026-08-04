// Cross-engine data transfer (MAIN). Copies tables from ANY connection to ANY
// other, across all six engines. The SOURCE IS READ-ONLY — this module only
// ever SELECTs from it; every write lands on the target. Structure is recreated
// on the target by reusing the table designer's DDL generator (which already
// knows each engine's type rules), data is copied via the drivers' parameterized
// `transferInsert`, and foreign keys are added AFTER the load so referential
// integrity is validated once every row is present.
import { buildTableDdl, buildObjectOp, targetColumnType, buildAddForeignKeys, buildCreateIndexes } from './ddl'
import type { DbDriver } from './driver'
import type {
  ColumnSpec,
  Engine,
  TableSpec,
  TransferColumnPlan,
  TransferPlan,
  TransferPlanRequest,
  TransferRequest,
  TransferResult,
  TransferTablePlan,
  TransferTableResult,
  TransferColumnOverride
} from '@shared/types'
import { sqlDialect } from '@shared/types'

const BATCH = 1000

// --- helpers -----------------------------------------------------------------

/** A compact source type label (e.g. VARCHAR(255), NUMBER(10,2), TIMESTAMP[]). */
function sourceTypeLabel(c: ColumnSpec): string {
  let t = c.type
  if (c.length != null && c.scale != null) t += `(${c.length},${c.scale})`
  else if (c.length != null && c.length !== 0) t += `(${c.length})`
  if (c.withTimeZone) t += ' WITH TIME ZONE'
  if (c.isArray) t += '[]'
  return t
}

/**
 * Normalize an engine-specific type NAME to a canonical generic the type
 * renderers all understand (VARCHAR2/NUMBER/CLOB from Oracle, NVARCHAR/DATETIME2/
 * BIT from SQL Server, etc.) so a cross-engine CREATE never emits foreign syntax.
 * Length/scale/tz live on the ColumnSpec and are preserved separately.
 */
function normalizeSourceType(type: string): string {
  const t = (type || '').trim().toLowerCase().replace(/\(.*\)/, '').trim()
  if (/^(varchar2|nvarchar2|nvarchar|character varying|varchar|string)$/.test(t)) return 'varchar'
  if (/^(nchar|bpchar|character|char)$/.test(t)) return 'char'
  if (/^(clob|nclob|ntext|longtext|mediumtext|tinytext|text)$/.test(t)) return 'text'
  if (/^(bigint|int8|bigserial|serial8)$/.test(t)) return 'bigint'
  if (/^(smallint|int2|tinyint)$/.test(t)) return 'smallint'
  if (/^(int|integer|int4|mediumint|serial|serial4)$/.test(t)) return 'integer'
  if (/^(number|numeric|decimal|dec|money|smallmoney)$/.test(t)) return 'numeric'
  if (/^(binary_double|double precision|double|float8)$/.test(t)) return 'double'
  if (/^(binary_float|real|float4)$/.test(t)) return 'real'
  if (/^float$/.test(t)) return 'float'
  if (/^(bit|bool|boolean)$/.test(t)) return 'boolean'
  if (/^(timestamptz|timestamp with time zone|timestamp with local time zone|datetimeoffset)$/.test(t)) return 'timestamp'
  if (/^(timestamp|datetime2|datetime|smalldatetime)$/.test(t)) return 'timestamp'
  if (/^date$/.test(t)) return 'date'
  if (/^time$/.test(t)) return 'time'
  if (/^(blob|bytea|varbinary|binary|image|longblob|mediumblob|raw)$/.test(t)) return 'blob'
  if (/^(json|jsonb)$/.test(t)) return 'json'
  if (/^(uuid|uniqueidentifier)$/.test(t)) return 'uuid'
  if (/^xml$/.test(t)) return 'text'
  return t // unrecognized — passed through (flagged needsReview in the plan)
}

/**
 * Adapt a source column for the target engine: normalize the type name, remap the
 * handful of cases whose naive translation would silently lose data, honour a user
 * override, and drop source-specific defaults (which reference the wrong dialect).
 */
function adaptColumn(
  sourceEngine: Engine,
  targetEngine: Engine,
  c: ColumnSpec,
  override?: TransferColumnOverride
): ColumnSpec {
  const src = sqlDialect(sourceEngine)
  const tgt = sqlDialect(targetEngine)
  const origLower = (c.type || '').toLowerCase()
  let type = override?.targetType ?? normalizeSourceType(c.type)
  let length = c.length
  let isArray = c.isArray ?? false
  let withTimeZone = c.withTimeZone ?? false

  if (!override?.targetType) {
    // SQL Server MAX columns (NVARCHAR(MAX)/VARBINARY(MAX)) report length -1 —
    // that's an unbounded LOB, so map to text/blob with no length.
    if (length === -1) {
      type = /bin|blob|bytea|raw|image/.test(type) ? 'blob' : 'text'
      length = null
    }
    // Auto-increment columns are always an integer type (source may report NUMBER,
    // SERIAL, etc.) so every target renders a valid IDENTITY/SERIAL/AUTO_INCREMENT.
    if (c.autoIncrement) type = /big|int8|serial8/.test(origLower) ? 'bigint' : 'integer'
    // Oracle DATE carries a TIME component; a plain "date" on other engines is
    // date-only and would drop the time. Map it to a timestamp/datetime type.
    if (src === 'oracle' && origLower === 'date' && tgt !== 'oracle') type = 'timestamp'
    // Arrays only exist on Postgres — flatten to text (values become JSON) elsewhere.
    if (isArray && tgt !== 'postgres') {
      isArray = false
      type = 'text'
    }
    // A tz-aware timestamp: preserve the offset on engines that HAVE a tz type
    // (SQL Server DATETIMEOFFSET, Oracle TIMESTAMP WITH TIME ZONE, Postgres
    // timestamptz); drop it (with a warning) only on MySQL/SQLite which have none.
    const isTzTs = withTimeZone || /timestamptz|timestamp with time zone|timestamp with local time zone|datetimeoffset/.test(origLower)
    if (isTzTs) {
      if (tgt === 'mssql') { type = 'datetimeoffset'; withTimeZone = true }
      else if (tgt === 'oracle') { type = 'timestamptz'; withTimeZone = true }
      else if (tgt === 'postgres') { type = 'timestamp'; withTimeZone = true }
      else { type = 'timestamp'; withTimeZone = false }
    }
  }

  return {
    ...c,
    type,
    length,
    isArray,
    withTimeZone,
    default: null, // never carry a source-dialect default expression across
    comment: null,
    originalName: null
  }
}

/** Lossy/approximate-mapping warnings for one column (task §3). */
function columnWarnings(sourceEngine: Engine, targetEngine: Engine, c: ColumnSpec, targetType: string): { warnings: string[]; needsReview: boolean } {
  const src = sqlDialect(sourceEngine)
  const tgt = sqlDialect(targetEngine)
  const st = (c.type || '').toLowerCase()
  const warnings: string[] = []

  if (c.isArray && tgt !== 'postgres') {
    warnings.push(`array type flattened to ${targetType} (values stored as JSON text)`)
  }
  if (c.withTimeZone && (tgt === 'mysql' || tgt === 'sqlite')) {
    warnings.push('time-zone offset is dropped (target has no tz-aware type)')
  }
  if (src === 'oracle' && st === 'date' && tgt !== 'oracle') {
    warnings.push(`Oracle DATE carries a time component → mapped to ${targetType} to keep it`)
  }
  if (/^(number|numeric|decimal)$/.test(st) && (c.length == null || c.length === 0) && tgt !== 'oracle') {
    warnings.push(`unconstrained ${c.type} → ${targetType}; precision/scale may be approximated`)
  }
  if (/^(json|jsonb)$/.test(st) && tgt !== 'postgres' && tgt !== 'mysql') {
    warnings.push(`no native JSON on target → stored as ${targetType}`)
  }
  if (/^(bool|boolean|bit)$/.test(st) || /^tinyint$/.test(st)) {
    warnings.push(`boolean represented as ${targetType} on the target`)
  }
  if (tgt === 'oracle' && /char|text|clob|varchar|string/.test(st)) {
    warnings.push("empty string '' becomes NULL on Oracle")
  }
  if (c.autoIncrement) {
    const kw = tgt === 'postgres' ? 'SERIAL' : tgt === 'mysql' ? 'AUTO_INCREMENT' : tgt === 'mssql' ? 'IDENTITY(1,1)' : tgt === 'oracle' ? 'IDENTITY' : 'AUTOINCREMENT'
    warnings.push(`auto-increment → ${kw}; source values preserved on copy`)
  }

  // Well-known base types every engine's mapper recognizes. When the source type
  // is NOT one of these and the target mapper simply echoed it back verbatim, the
  // mapping is a guess the user should review (or override / skip the column).
  const known =
    /^(var)?char|^character|^n?varchar|^n?char|^text|^clob|^nclob|^string|^tiny|^medium|^long|^int|^integer|^smallint|^bigint|^serial|^dec|^numeric|^number|^float|^double|^real|^money|^bool|^bit|^date|^time|^timestamp|^datetime|^year|^json|^uuid|^uniqueidentifier|^blob|^bytea|^binary|^raw|^xml|^enum|^set/i
  const needsReview = !c.isArray && !known.test((c.type || '').trim()) && targetType.toUpperCase() === (c.type || '').toUpperCase()
  return { warnings, needsReview }
}

/** Build the target TableSpec (no FKs — added after the load) + column/identity lists. */
function adaptSpec(
  sourceEngine: Engine,
  targetEngine: Engine,
  targetSchema: string,
  spec: TableSpec,
  overrides?: Record<string, TransferColumnOverride>
): { spec: TableSpec; columns: string[]; identityCols: string[]; columnTypes: Record<string, string> } {
  const kept = spec.columns.filter((c) => !overrides?.[c.name]?.skip)
  const adapted = kept.map((c) => adaptColumn(sourceEngine, targetEngine, c, overrides?.[c.name]))
  const columns = adapted.map((c) => c.name)
  const keptSet = new Set(columns)
  const columnTypes: Record<string, string> = {}
  for (const c of adapted) columnTypes[c.name] = targetColumnType(targetEngine, c)
  const identityCols = adapted.filter((c) => c.autoIncrement).map((c) => c.name)
  const targetSpec: TableSpec = {
    schema: targetSchema,
    name: spec.name,
    columns: adapted,
    primaryKey: spec.primaryKey.filter((p) => keptSet.has(p)),
    foreignKeys: [], // added after data load
    indexes: spec.indexes.filter((i) => i.columns.every((col) => keptSet.has(col))),
    comment: null
  }
  return { spec: targetSpec, columns, identityCols, columnTypes }
}

/** Order tables so a referenced (parent) table precedes its children (FK order). */
function orderTables(specs: Map<string, TableSpec>, names: string[]): string[] {
  const present = new Set(names)
  const visited = new Set<string>()
  const out: string[] = []
  const visit = (name: string, stack: Set<string>): void => {
    if (visited.has(name) || stack.has(name)) return
    stack.add(name)
    for (const fk of specs.get(name)?.foreignKeys ?? []) {
      if (present.has(fk.refTable) && fk.refTable !== name) visit(fk.refTable, stack)
    }
    stack.delete(name)
    visited.add(name)
    out.push(name)
  }
  for (const n of names) visit(n, new Set())
  return out
}

/**
 * Cross-engine value coercion applied before binding. The drivers already do
 * ''→NULL / date-string→Date; this converts JS types that no target can bind
 * directly: booleans → 0/1 (except native-boolean Postgres), objects/arrays →
 * JSON text, and Dates → ISO strings for SQLite (which has no date type).
 */
function coerceValue(value: unknown, targetEngine: Engine, targetType: string): unknown {
  if (value === null || value === undefined) return null
  const tgt = sqlDialect(targetEngine)
  const t = (targetType || '').toLowerCase()
  const pgBool = tgt === 'postgres' && /^bool/.test(t)

  if (typeof value === 'boolean') return pgBool ? value : value ? 1 : 0
  if (Buffer.isBuffer(value)) return value
  // Binary columns: the source drivers normalize a Buffer to a hex string (pg
  // `\x…`, others `0x…`) for IPC/display. For a binary TARGET column, decode it
  // back to a Buffer so the bytes round-trip instead of landing as text.
  if (/blob|bytea|binary|varbinary|\braw\b|image/.test(t) && typeof value === 'string') {
    const m = /^(?:\\x|0x)([0-9a-fA-F]*)$/.exec(value)
    if (m) return Buffer.from(m[1], 'hex')
  }
  // MySQL/MariaDB DATETIME reject ISO 'T'/'Z' formatting — hand them a Date or a
  // plain 'YYYY-MM-DD HH:MM:SS' string (sources may return either Date or ISO).
  if (tgt === 'mysql') {
    if (value instanceof Date) return value
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value)) {
      return value.replace('T', ' ').replace(/\.\d+/, '').replace(/(Z|[+-]\d\d:?\d\d)$/, '')
    }
  }
  if (value instanceof Date) return tgt === 'sqlite' ? value.toISOString() : value
  if (typeof value === 'object') return JSON.stringify(value) // arrays / JSON objects
  if (pgBool && typeof value === 'number') return value !== 0
  if (pgBool && typeof value === 'string') {
    if (/^(t|true|1|y|yes)$/i.test(value)) return true
    if (/^(f|false|0|n|no)$/i.test(value)) return false
  }
  return value
}

// --- plan --------------------------------------------------------------------

/** Build the type-translation plan + lossy-mapping warnings shown before running. */
export async function buildTransferPlan(
  source: DbDriver,
  target: DbDriver,
  req: TransferPlanRequest
): Promise<TransferPlan> {
  const sourceEngine = source.config.engine
  const targetEngine = target.config.engine
  const existing = new Set((await target.listTables(req.targetSchema)).map((r) => r.name))
  const selected = new Set(req.tables)

  const tables: TransferTablePlan[] = []
  for (const name of req.tables) {
    const spec = await source.getTableSpec(req.sourceSchema, name)
    const columns: TransferColumnPlan[] = spec.columns.map((c) => {
      const adapted = adaptColumn(sourceEngine, targetEngine, c)
      const targetType = targetColumnType(targetEngine, adapted)
      const { warnings, needsReview } = columnWarnings(sourceEngine, targetEngine, c, targetType)
      return {
        name: c.name,
        sourceType: sourceTypeLabel(c),
        targetType,
        autoIncrement: !!c.autoIncrement,
        warnings,
        needsReview
      }
    })
    const skippedForeignKeys = spec.foreignKeys
      .filter((fk) => !selected.has(fk.refTable))
      .map((fk) => `${(fk.columns || []).join(',')} → ${fk.refTable} (not in transfer set)`)
    let rowCountEstimate: number | null = null
    try {
      rowCountEstimate = await source.getTableRowCount(req.sourceSchema, name, [], null, null)
    } catch {
      rowCountEstimate = null
    }
    tables.push({
      table: name,
      columns,
      primaryKey: spec.primaryKey,
      existsInTarget: existing.has(name),
      foreignKeys: spec.foreignKeys.filter((fk) => selected.has(fk.refTable)).length,
      skippedForeignKeys,
      rowCountEstimate
    })
  }

  const notes: string[] = []
  if (targetEngine === 'mssql' && tables.some((t) => t.columns.some((c) => c.autoIncrement))) {
    notes.push('SQL Server identity columns are loaded with SET IDENTITY_INSERT so the source values are preserved.')
  }
  if (targetEngine === 'oracle') {
    notes.push('Oracle stores an empty string as NULL — empty text values become NULL on the target.')
  }
  notes.push('The source is read-only: nothing is deleted or modified there.')
  return { sourceEngine, targetEngine, tables, notes }
}

// --- run ---------------------------------------------------------------------

/** Execute a transfer. Source untouched; tables created + loaded on the target. */
export async function runTransfer(
  source: DbDriver,
  target: DbDriver,
  req: TransferRequest,
  onProgress?: (done: number, total: number) => void
): Promise<TransferResult> {
  const sourceEngine = source.config.engine
  const targetEngine = target.config.engine

  // SAFETY: never let a "transfer" write back into the source. Copying a table
  // onto itself (same connection + schema + name) would modify the source.
  if (req.sourceConnectionId === req.targetConnectionId && req.sourceSchema === req.targetSchema) {
    return {
      ok: false,
      tables: [],
      totalRows: 0,
      fkWarnings: [],
      sourceUnchanged: true,
      error: 'Source and target are the same connection + schema. Choose a different target schema/connection so the source is never written to.'
    }
  }

  const results: TransferTableResult[] = []
  const fkWarnings: string[] = []
  let totalRows = 0

  try {
    // Load every selected source spec up front (read-only) + order for the load.
    const specs = new Map<string, TableSpec>()
    for (const name of req.tables) specs.set(name, await source.getTableSpec(req.sourceSchema, name))
    const order = orderTables(specs, req.tables)
    const existing = new Set((await target.listTables(req.targetSchema)).map((r) => r.name))

    // Track which tables actually ended up present on the target (for FK add).
    const present = new Set<string>()
    const created = new Set<string>()

    // --- Phase 1: create tables (no FKs, indexes added separately) -----------
    for (const name of order) {
      const spec = specs.get(name)!
      const adapted = adaptSpec(sourceEngine, targetEngine, req.targetSchema, spec, req.overrides?.[name])
      const exists = existing.has(name)
      const res: TransferTableResult = { table: name, status: 'created', rows: 0, warnings: [] }

      if (exists && req.ifExists === 'skip') {
        res.status = 'skipped'
        res.warnings.push('target table already exists — skipped')
        results.push(res)
        continue
      }
      if (exists && req.ifExists === 'append') {
        res.status = 'appended'
        present.add(name)
        results.push(res)
        continue // load into the existing structure
      }
      if (exists && req.ifExists === 'drop') {
        const drop = buildObjectOp(targetEngine, { kind: 'dropTable', schema: req.targetSchema, table: name })
        const dr = await target.execStatements(drop.statements)
        if (!dr.ok) {
          res.status = 'failed'
          res.error = `drop existing table failed: ${dr.message}`
          results.push(res)
          continue
        }
      }

      const create = buildTableDdl(targetEngine, 'create', { ...adapted.spec, foreignKeys: [], indexes: [] })
      const cr = await target.execStatements(create.statements)
      if (!cr.ok) {
        res.status = 'failed'
        res.error = `create table failed: ${cr.message}`
        results.push(res)
        continue
      }
      // Indexes: separate + non-fatal (names can clash across schemas/engines).
      for (const idxStmt of buildCreateIndexes(targetEngine, adapted.spec)) {
        const ir = await target.execStatements([idxStmt])
        if (!ir.ok) res.warnings.push(`index not created: ${ir.message}`)
      }
      created.add(name)
      present.add(name)
      results.push(res)
    }

    const byName = new Map(results.map((r) => [r.table, r]))

    // --- Phase 2: copy data (page the source, insert into the target) --------
    for (const name of order) {
      const res = byName.get(name)!
      if (res.status === 'skipped' || res.status === 'failed') continue
      const spec = specs.get(name)!
      const adapted = adaptSpec(sourceEngine, targetEngine, req.targetSchema, spec, req.overrides?.[name])
      const cols = adapted.columns
      try {
        let page = 1
        for (;;) {
          const pageRes = await source.getTablePage(req.sourceSchema, name, BATCH, page, null, [], null, null)
          if (pageRes.rows.length > 0) {
            const rows = pageRes.rows.map((row) =>
              cols.map((col) => coerceValue((row as Record<string, unknown>)[col], targetEngine, adapted.columnTypes[col]))
            )
            const n = await target.transferInsert(req.targetSchema, name, cols, rows, adapted.columnTypes, adapted.identityCols)
            res.rows += n
            totalRows += n
            onProgress?.(totalRows, totalRows)
          }
          if (pageRes.rows.length < BATCH) break
          page++
        }
      } catch (err) {
        res.status = 'failed'
        res.error = `data load failed after ${res.rows} row(s): ${(err as Error).message}`
      }
    }

    // --- Phase 3: add foreign keys (both endpoints must be present) ----------
    for (const name of order) {
      const res = byName.get(name)!
      if (res.status !== 'created') continue // only freshly-created tables get FKs
      const spec = specs.get(name)!
      const fks = spec.foreignKeys.filter((fk) => present.has(fk.refTable))
      if (fks.length === 0) continue
      const fkSpec: TableSpec = {
        ...spec,
        schema: req.targetSchema,
        // point every FK at the target schema
        foreignKeys: fks.map((fk) => ({ ...fk, refSchema: req.targetSchema }))
      }
      for (const stmt of buildAddForeignKeys(targetEngine, fkSpec)) {
        const r = await target.execStatements([stmt])
        if (!r.ok) fkWarnings.push(`${name}: ${r.message}`)
      }
    }

    const anyFailed = results.some((r) => r.status === 'failed')
    return { ok: !anyFailed, tables: results, totalRows, fkWarnings, sourceUnchanged: true }
  } catch (err) {
    return { ok: false, tables: results, totalRows, fkWarnings, sourceUnchanged: true, error: (err as Error).message }
  }
}
