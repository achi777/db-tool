// Data export (CSV / JSON / Excel / SQL) — runs in MAIN. Rows are streamed from
// the driver in batches (LIMIT/OFFSET, honoring the active filter) and written
// incrementally so memory stays bounded (Excel is the exception — SheetJS builds
// in memory). SQL literals are escaped per engine; the file is generated text,
// so escaping (not parameterization) is what keeps it safe.
import { createWriteStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { DbDriver } from './driver'
import { buildTableDdl } from './ddl'
import type { ColumnSpec, Engine, ExportRequest, ExportResult, ResultColumn, TableSpec } from '@shared/types'
import { sqlDialect } from '@shared/types'

// SheetJS is CommonJS — load via createRequire so it resolves in the ESM main bundle.
const XLSX = createRequire(import.meta.url)('xlsx') as typeof import('xlsx')

const BATCH = 1000

type Row = Record<string, unknown>

/** Which columns to export (requested subset, else all in table order). */
function pickColumns(all: ResultColumn[], requested: string[]): ResultColumn[] {
  if (!requested.length) return all
  const byName = new Map(all.map((c) => [c.name, c]))
  return requested.map((n) => byName.get(n)).filter((c): c is ResultColumn => !!c)
}

/** Stream all rows matching the request in batches. Calls back per batch. */
async function streamRows(
  driver: DbDriver,
  req: ExportRequest,
  onBatch: (rows: Row[], columns: ResultColumn[]) => Promise<void> | void,
  onProgress?: (done: number) => void
): Promise<{ total: number; columns: ResultColumn[] }> {
  const useFilter = req.scope === 'filter'
  const filters = useFilter ? req.filters ?? [] : []
  const tree = useFilter ? req.tree ?? null : null
  const customWhere = useFilter ? req.customWhere ?? null : null

  let page = 1
  let columns: ResultColumn[] = []
  let done = 0
  for (;;) {
    const res = await driver.getTablePage(req.schema, req.table, BATCH, page, null, filters, tree, customWhere)
    if (page === 1) columns = pickColumns(res.columns, req.columns)
    if (res.rows.length > 0) await onBatch(res.rows as Row[], columns)
    done += res.rows.length
    onProgress?.(done)
    if (res.rows.length < BATCH) break
    page++
  }
  return { total: done, columns }
}

// --- value formatting --------------------------------------------------------

function isNumericType(t: string): boolean {
  return /\b(int|integer|bigint|smallint|serial|numeric|decimal|real|double|float|money)\b/i.test(t)
}

/** Coerce a driver value for JSON/Excel: numbers as numbers where safe, else as-is. */
function typedValue(v: unknown, col: ResultColumn): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'string' && isNumericType(col.dataType) && /^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v)
    // Keep bigints that exceed JS safe range as strings to avoid precision loss.
    if (Number.isSafeInteger(n) || !/^-?\d+$/.test(v)) return n
  }
  return v
}

function csvField(v: unknown, delimiter: string, nullRepr: string): string {
  if (v === null || v === undefined) return nullRepr
  let s: string
  if (v instanceof Date) s = v.toISOString()
  else if (typeof v === 'object') s = JSON.stringify(v)
  else s = String(v)
  const needsQuote = s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')
  return needsQuote ? '"' + s.replace(/"/g, '""') + '"' : s
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

export function sqlLiteral(v: unknown, engine: Engine): string {
  engine = sqlDialect(engine)
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return engine === 'postgres' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0'
  if (v instanceof Date && engine === 'oracle') {
    // Oracle can't implicitly parse an ISO string into DATE/TIMESTAMP — an
    // unqualified 'YYYY-MM-DDT…' literal raises ORA-01858 on import. Emit an
    // explicit TO_TIMESTAMP. Local components reconstruct the wall-clock that
    // node-oracledb decoded from the DB value (works for DATE and TIMESTAMP).
    const s = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}.${pad(v.getMilliseconds(), 3)}`
    return `TO_TIMESTAMP('${s}', 'YYYY-MM-DD HH24:MI:SS.FF3')`
  }
  let s: string
  if (v instanceof Date) {
    // SQL Server: a space-separated 'YYYY-MM-DD HH:MM:SS.mmm' literal loads
    // cleanly into DATE/DATETIME2 (the ISO 'T'/'Z' form can be fussy).
    s =
      engine === 'mssql'
        ? `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}.${pad(v.getUTCMilliseconds(), 3)}`
        : v.toISOString()
  } else if (typeof v === 'object') s = JSON.stringify(v)
  else s = String(v)
  // SQL Server: N'…' preserves NVARCHAR unicode (Georgian etc.).
  const prefix = engine === 'mssql' ? 'N' : ''
  return prefix + "'" + s.replace(/'/g, "''") + "'"
}

export function qid(engine: Engine, id: string): string {
  const d = sqlDialect(engine)
  if (d === 'mysql') return '`' + id.replace(/`/g, '``') + '`'
  if (d === 'mssql') return '[' + id.replace(/]/g, ']]') + ']'
  return '"' + id.replace(/"/g, '""') + '"'
}

export function qtable(engine: Engine, schema: string, table: string): string {
  return sqlDialect(engine) === 'sqlite' ? qid(engine, table) : `${qid(engine, schema)}.${qid(engine, table)}`
}

// --- per-format exporters ----------------------------------------------------

async function exportCsv(driver: DbDriver, req: ExportRequest, path: string, onProgress?: (n: number) => void): Promise<number> {
  const delim = req.options.csvDelimiter || ','
  const nullRepr = req.options.csvNull === 'slashN' ? '\\N' : ''
  const stream = createWriteStream(path, { encoding: 'utf-8' })
  if (req.options.csvBom) stream.write('﻿')
  const write = (s: string): Promise<void> =>
    new Promise((resolve, reject) => stream.write(s, (e) => (e ? reject(e) : resolve())))

  let headerWritten = false
  const { total } = await streamRows(
    driver,
    req,
    async (rows, columns) => {
      if (!headerWritten) {
        await write(columns.map((c) => csvField(c.name, delim, '')).join(delim) + '\r\n')
        headerWritten = true
      }
      for (const row of rows) {
        await write(columns.map((c) => csvField(row[c.name], delim, nullRepr)).join(delim) + '\r\n')
      }
    },
    onProgress
  )
  await new Promise<void>((resolve, reject) => stream.end((e?: Error) => (e ? reject(e) : resolve())))
  return total
}

async function exportJson(driver: DbDriver, req: ExportRequest, path: string, onProgress?: (n: number) => void): Promise<number> {
  const pretty = !!req.options.jsonPretty
  const stream = createWriteStream(path, { encoding: 'utf-8' })
  const write = (s: string): Promise<void> =>
    new Promise((resolve, reject) => stream.write(s, (e) => (e ? reject(e) : resolve())))
  await write('[')
  let first = true
  const { total } = await streamRows(
    driver,
    req,
    async (rows, columns) => {
      for (const row of rows) {
        const obj: Record<string, unknown> = {}
        for (const c of columns) obj[c.name] = typedValue(row[c.name], c)
        const json = pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)
        await write((first ? (pretty ? '\n' : '') : ',' + (pretty ? '\n' : '')) + (pretty ? '  ' + json.replace(/\n/g, '\n  ') : json))
        first = false
      }
    },
    onProgress
  )
  await write(pretty ? '\n]\n' : ']\n')
  await new Promise<void>((resolve, reject) => stream.end((e?: Error) => (e ? reject(e) : resolve())))
  return total
}

/**
 * CREATE TABLE for the exported columns, using the REAL source types via the
 * shared table-designer generator (TASK 46) — so each engine gets its own valid
 * type syntax (Oracle NUMBER/VARCHAR2/…, never "text"), plus PK / NOT NULL /
 * IDENTITY. When a column subset is exported, PK/FK/indexes referencing excluded
 * columns are dropped. Returns null if there is no usable spec (→ caller falls
 * back to generic result-column types).
 */
function createTableFromSpec(engine: Engine, req: ExportRequest, spec: TableSpec | null): string | null {
  if (!spec || !spec.columns.length) return null
  const requested = req.columns ?? []
  const exported = requested.length ? requested : spec.columns.map((c) => c.name)
  const exportedSet = new Set(exported)
  const byName = new Map(spec.columns.map((c) => [c.name, c]))
  const cols = exported.map((n) => byName.get(n)).filter((c): c is ColumnSpec => !!c)
  if (cols.length !== exported.length) return null // an exported column isn't in the spec
  const filtered: TableSpec = {
    ...spec,
    columns: cols,
    primaryKey: spec.primaryKey.filter((n) => exportedSet.has(n)),
    foreignKeys: spec.foreignKeys.filter((fk) => fk.columns.every((c) => exportedSet.has(c))),
    indexes: spec.indexes.filter((ix) => ix.columns.every((c) => exportedSet.has(c)))
  }
  const ddl = buildTableDdl(engine, 'create', filtered)
  return ddl.statements.map((s) => s + ';').join('\n') + '\n\n'
}

/** DATE/TIMESTAMP column names in a spec — for the Oracle TO_TIMESTAMP path. */
export function dateColumnSet(spec: TableSpec | null): Set<string> {
  const s = new Set<string>()
  // Matches DATE / DATETIME / DATETIME2 / SMALLDATETIME / TIMESTAMP.
  if (spec) for (const c of spec.columns) if (/^(DATE|DATETIME|SMALLDATETIME|TIMESTAMP)/i.test(c.type)) s.add(c.name)
  return s
}

/**
 * A SQL value literal, aware of whether the column is an Oracle date. The Oracle
 * driver normalizes DATE/TIMESTAMP values to ISO strings; a bare 'YYYY-MM-DDT…'
 * string raises ORA-01858 on import, so date columns are wrapped in TO_TIMESTAMP.
 */
export function sqlValueLiteral(v: unknown, engine: Engine, isDateCol: boolean): string {
  const d = sqlDialect(engine)
  if (d === 'oracle' && isDateCol && typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(v)
    if (m) {
      const frac = (m[7] ?? '').padEnd(3, '0').slice(0, 3)
      return `TO_TIMESTAMP('${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}.${frac}', 'YYYY-MM-DD HH24:MI:SS.FF3')`
    }
  }
  if (d === 'mssql' && isDateCol && typeof v === 'string') {
    // The driver normalizes DATETIME2 to an ISO 'T…Z' string; reshape to a
    // space-separated literal SQL Server parses into DATE/DATETIME2 cleanly.
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(v)
    if (m) {
      const frac = (m[7] ?? '').padEnd(3, '0').slice(0, 3)
      return `N'${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}.${frac}'`
    }
  }
  return sqlLiteral(v, engine)
}

async function exportSql(
  driver: DbDriver,
  req: ExportRequest,
  path: string,
  engine: Engine,
  onProgress?: (n: number) => void
): Promise<number> {
  const stream = createWriteStream(path, { encoding: 'utf-8' })
  const write = (s: string): Promise<void> =>
    new Promise((resolve, reject) => stream.write(s, (e) => (e ? reject(e) : resolve())))
  const t = qtable(engine, req.schema, req.table)
  // Oracle has no multi-row VALUES list; SQL Server caps a VALUES list at 1000
  // row constructors. Other engines keep multi-row batching when the option is on.
  const multi = !!req.options.sqlMultiRow && engine !== 'oracle'
  const MSSQL_VALUES_CHUNK = 1000

  // The real table spec drives correct CREATE TABLE types AND the set of date
  // columns that need reshaped literals (Oracle TO_TIMESTAMP / MSSQL space-form).
  let spec: TableSpec | null = null
  try {
    spec = await driver.getTableSpec(req.schema, req.table)
  } catch {
    spec = null
  }
  const dateCols = engine === 'oracle' || engine === 'mssql' ? dateColumnSet(spec) : new Set<string>()
  // SQL Server: if an IDENTITY column is exported, wrap the inserts in
  // SET IDENTITY_INSERT … ON/OFF so explicit id values can be inserted.
  const identityCol = engine === 'mssql' ? spec?.columns.find((c) => c.autoIncrement)?.name : undefined

  // CREATE TABLE is written UPFRONT (so it appears even for empty tables), using
  // the real source column types. `specWritten` records whether that succeeded;
  // if not, we fall back to generic result-column types once rows arrive.
  let specWritten = false
  if (req.options.sqlCreateTable) {
    const specDdl = createTableFromSpec(engine, req, spec)
    if (specDdl) {
      await write(specDdl)
      specWritten = true
    }
  }

  const lit = (v: unknown, name: string): string => sqlValueLiteral(v, engine, dateCols.has(name))
  let colList = ''
  let identityOn = false
  const { total } = await streamRows(
    driver,
    req,
    async (rows, columns) => {
      if (!colList) {
        colList = columns.map((c) => qid(engine, c.name)).join(', ')
        // Fallback CREATE TABLE (generic types) only if the spec path produced
        // nothing — e.g. the source has no readable table spec.
        if (req.options.sqlCreateTable && !specWritten) {
          const cols = columns.map((c) => `  ${qid(engine, c.name)} ${c.dataType || 'text'}`).join(',\n')
          await write(`CREATE TABLE ${t} (\n${cols}\n);\n\n`)
          specWritten = true
        }
      }
      // Turn IDENTITY_INSERT on lazily (only when a column matches an exported one).
      if (identityCol && !identityOn && columns.some((c) => c.name === identityCol)) {
        await write(`SET IDENTITY_INSERT ${t} ON;\n`)
        identityOn = true
      }
      if (multi) {
        const values = rows.map((row) => '(' + columns.map((c) => lit(row[c.name], c.name)).join(', ') + ')')
        // SQL Server: emit ≤1000 row constructors per INSERT statement.
        const chunk = engine === 'mssql' ? MSSQL_VALUES_CHUNK : values.length
        for (let i = 0; i < values.length; i += chunk) {
          await write(`INSERT INTO ${t} (${colList}) VALUES\n${values.slice(i, i + chunk).join(',\n')};\n`)
        }
      } else {
        for (const row of rows) {
          const vals = columns.map((c) => lit(row[c.name], c.name)).join(', ')
          await write(`INSERT INTO ${t} (${colList}) VALUES (${vals});\n`)
        }
      }
    },
    onProgress
  )
  if (identityOn) await write(`SET IDENTITY_INSERT ${t} OFF;\n`)
  await new Promise<void>((resolve, reject) => stream.end((e?: Error) => (e ? reject(e) : resolve())))
  return total
}

async function exportXlsx(driver: DbDriver, req: ExportRequest, path: string, onProgress?: (n: number) => void): Promise<number> {
  const aoa: unknown[][] = []
  let cols: ResultColumn[] = []
  const { total, columns } = await streamRows(
    driver,
    req,
    (rows, columns) => {
      if (aoa.length === 0) {
        cols = columns
        aoa.push(columns.map((c) => c.name))
      }
      for (const row of rows) aoa.push(columns.map((c) => typedValue(row[c.name], c)))
    },
    onProgress
  )
  if (aoa.length === 0) aoa.push(columns.map((c) => c.name)) // header-only for empty
  void cols
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  const sheetName = req.table.slice(0, 31).replace(/[\\/?*[\]:]/g, '_') || 'Sheet1'
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  await writeFile(path, buf)
  return total
}

/** Export according to `req`, writing to `path`. Returns the row count. */
export async function runExport(
  driver: DbDriver,
  engine: Engine,
  req: ExportRequest,
  path: string,
  onProgress?: (done: number) => void
): Promise<ExportResult> {
  engine = sqlDialect(engine)
  try {
    let rows = 0
    if (req.format === 'csv') rows = await exportCsv(driver, req, path, onProgress)
    else if (req.format === 'json') rows = await exportJson(driver, req, path, onProgress)
    else if (req.format === 'sql') rows = await exportSql(driver, req, path, engine, onProgress)
    else rows = await exportXlsx(driver, req, path, onProgress)
    return { ok: true, path, rows }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
