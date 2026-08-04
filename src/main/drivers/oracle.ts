// Oracle driver (MAIN process only). Uses node-oracledb.
//
// TWO modes (user-selectable in the connection form):
//   - THIN  (default): pure JS, no external libraries, Oracle 12.1+.
//   - THICK (optional): needs Oracle Instant Client. We DETECT it via
//     oracledb.initOracleClient() and, if missing, return a CLEAR message —
//     we never bundle or auto-install the client.
//
// This is the BASICS stage: connect, list tables/views, paginated browse,
// schema-aware catalog, parameterized grid CRUD by PK, and the filter modes
// producing valid Oracle SQL (`:n` binds, OFFSET/FETCH, "UPPERCASE" ids).
// Advanced object management (DDL/designer/sequences/triggers/indexes/dump) is
// a LATER Oracle stage — those methods return empty/clear-not-supported here.
import oracledb from 'oracledb'
import type {
  ColumnDef,
  ColumnFilter,
  ConnectionConfig,
  DdlApplyResult,
  FilterGroup,
  IndexInfo,
  ObjectDefRequest,
  QueryResult,
  RoutineRef,
  RowChangeRequest,
  RowChangeResult,
  SchemaCatalog,
  CatalogTable,
  SequenceInfo,
  SequenceRef,
  SortSpec,
  TableRef,
  TableSpec,
  TestConnectionResult,
  TriggerDetails,
  TriggerRef,
  ViewRef
} from '@shared/types'
import { coerceForWrite, orderByClause, type DbDriver } from '../driver'
import { compileFilter } from '@shared/filterCompiler'

// Return query rows as plain objects; large types as string/buffer for clean IPC.
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT
oracledb.fetchAsString = [oracledb.CLOB]
oracledb.fetchAsBuffer = [oracledb.BLOB]

const THICK_HELP =
  'https://node-oracledb.readthedocs.io/en/latest/user_guide/installation.html#oracle-instant-client'

// initOracleClient() is process-global and one-shot; remember the outcome.
let thickTried = false
let thickOk = false
function ensureThick(): { ok: boolean; message?: string } {
  if (thickTried) {
    return thickOk
      ? { ok: true }
      : { ok: false, message: `Thick mode requires Oracle Instant Client (not found). Install it (${THICK_HELP}) or switch to Thin mode.` }
  }
  thickTried = true
  try {
    oracledb.initOracleClient()
    thickOk = true
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      message: `Thick mode requires Oracle Instant Client, which was not found: ${(err as Error).message}. Install Instant Client (${THICK_HELP}) or switch this connection to Thin mode.`
    }
  }
}

/** Double-quote an Oracle identifier (catalog names are already UPPERCASE). */
function qid(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"'
}

/**
 * Parse the owner/name/type out of a `CREATE [OR REPLACE] TRIGGER|PROCEDURE|…`
 * statement, so ALL_ERRORS can be checked for the object it created. Quoted
 * identifiers keep their case; unquoted ones fold to UPPER (Oracle's rule).
 */
function parsePlsqlObject(
  sql: string,
  defaultOwner: string
): { owner: string; name: string; type: string } | null {
  // Note "PACKAGE BODY"/"TYPE BODY" must be tried before the bare forms, and
  // GET_DDL emits an optional [NON]EDITIONABLE keyword we skip.
  const m = sql.match(
    /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(PACKAGE\s+BODY|TYPE\s+BODY|TRIGGER|PROCEDURE|FUNCTION|PACKAGE|TYPE)\s+(?:("?)([\w$#]+)\2\s*\.\s*)?("?)([\w$#]+)\4/i
  )
  if (!m) return null
  const type = m[1].toUpperCase().replace(/\s+/g, ' ')
  const owner = m[3] ? (m[2] === '"' ? m[3] : m[3].toUpperCase()) : defaultOwner
  const name = m[4] === '"' ? m[5] : m[5].toUpperCase()
  return { owner, name, type }
}

/** Build a human-readable Oracle type label from ALL_TAB_COLUMNS metadata. */
function typeStr(dataType: string, len: unknown, prec: unknown, scale: unknown): string {
  const t = String(dataType).toUpperCase()
  if (t === 'NUMBER') {
    if (prec != null) return scale != null && Number(scale) !== 0 ? `NUMBER(${prec},${scale})` : `NUMBER(${prec})`
    return 'NUMBER'
  }
  if (/^(VARCHAR2|NVARCHAR2|CHAR|NCHAR|RAW)$/.test(t) && len != null) return `${t}(${len})`
  return t
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

/**
 * Coerce a value for binding into Oracle. Like coerceForWrite, but also converts
 * an ISO date STRING (as produced by CSV/JSON import or by normalize()) into a
 * JS Date for DATE/TIMESTAMP columns — node-oracledb binds a Date natively,
 * whereas a bare 'YYYY-MM-DDT…' string raises ORA-01861. Fixes date/time import
 * and grid-editing of date columns.
 */
function oracleBind(value: unknown, sqlType: string | undefined): unknown {
  const v = coerceForWrite(value, sqlType)
  if (v == null || typeof v !== 'string') return v
  const t = (sqlType ?? '').toUpperCase()
  if (/^(DATE|TIMESTAMP)/.test(t)) {
    const dt = new Date(v)
    if (!Number.isNaN(dt.getTime())) return dt
  }
  return v
}

export class OracleDriver implements DbDriver {
  readonly config: ConnectionConfig
  private pool: oracledb.Pool | null = null
  private schemaOwner = '' // the connected user == its schema, UPPERCASE
  private versionNum = 0 // server version * 100 + release (e.g. 21c → 2100), for feature detection

  constructor(config: ConnectionConfig) {
    this.config = config
  }

  /** Oracle Easy Connect / descriptor string from the config. */
  private connectString(): string {
    const host = this.config.host || 'localhost'
    const port = this.config.port || 1521
    if (this.config.serviceName && this.config.serviceName.trim()) {
      return `${host}:${port}/${this.config.serviceName.trim()}`
    }
    if (this.config.sid && this.config.sid.trim()) {
      // SID needs the full descriptor form (Easy Connect after `/` is a service).
      return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SID=${this.config.sid.trim()})))`
    }
    return `${host}:${port}`
  }

  private ensure(): oracledb.Pool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  async connect(): Promise<void> {
    if (this.pool) return
    if (this.config.driverMode === 'thick') {
      const t = ensureThick()
      if (!t.ok) throw new Error(t.message)
    }
    this.pool = await oracledb.createPool({
      user: this.config.user,
      password: this.config.password,
      connectString: this.connectString(),
      poolMin: 0,
      poolMax: 4,
      poolTimeout: 60
    })
    // Cache the current user == schema (Oracle stores it UPPERCASE) + server
    // version (for ALTER SEQUENCE … RESTART support, added in 12.2).
    const conn = await this.pool.getConnection()
    try {
      const r = await conn.execute<{ U: string }>('SELECT USER AS U FROM DUAL')
      this.schemaOwner = String(r.rows?.[0]?.U ?? this.config.user ?? '').toUpperCase()
      try {
        const v = await conn.execute<{ V: string }>(
          `SELECT version AS v FROM product_component_version WHERE product LIKE 'Oracle%' AND ROWNUM = 1`
        )
        const m = String(v.rows?.[0]?.V ?? '').match(/^(\d+)\.(\d+)/)
        if (m) this.versionNum = Number(m[1]) * 100 + Number(m[2])
      } catch {
        this.versionNum = 0
      }
    } finally {
      await conn.close()
    }
  }

  /** ALTER SEQUENCE … RESTART is available on Oracle 12.2+ (else DROP+CREATE). */
  private restartSupported(): boolean {
    return this.versionNum === 0 || this.versionNum >= 1202
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close(0)
      this.pool = null
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    if (this.config.driverMode === 'thick') {
      const t = ensureThick()
      if (!t.ok) return { ok: false, message: t.message }
    }
    let conn: oracledb.Connection | null = null
    try {
      conn = await oracledb.getConnection({
        user: this.config.user,
        password: this.config.password,
        connectString: this.connectString()
      })
      await conn.execute('SELECT 1 FROM DUAL')
      return { ok: true, message: `Connection successful (${this.config.driverMode === 'thick' ? 'Thick' : 'Thin'} mode)` }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    } finally {
      if (conn) await conn.close().catch(() => undefined)
    }
  }

  /** The owner to browse — the given schema (UPPERCASE), else the current user. */
  private owner(schema?: string): string {
    return (schema && schema.trim() ? schema.trim() : this.schemaOwner).toUpperCase()
  }

  async listDatabases(): Promise<string[]> {
    return []
  }

  async listSchemas(): Promise<string[]> {
    // In Oracle every user is a schema. List all schemas that own at least one
    // table, view, or other object the connected user can see, with the current
    // user's own schema always first.
    const res = await this.runQuery(
      `SELECT DISTINCT owner FROM all_objects
       WHERE object_type IN ('TABLE','VIEW','PROCEDURE','FUNCTION','PACKAGE','SEQUENCE','TRIGGER','SYNONYM')
       ORDER BY owner`
    )
    const schemas = res.rows.map((r) => String((r as Record<string, unknown>).OWNER))
    // Ensure the connected user's schema is first.
    if (this.schemaOwner && !schemas.includes(this.schemaOwner)) {
      schemas.unshift(this.schemaOwner)
    } else if (this.schemaOwner) {
      const idx = schemas.indexOf(this.schemaOwner)
      if (idx > 0) {
        schemas.splice(idx, 1)
        schemas.unshift(this.schemaOwner)
      }
    }
    return schemas
  }

  async listTables(schema: string): Promise<TableRef[]> {
    const owner = this.owner(schema)
    const res = await this.runQuery(
      `SELECT table_name AS name FROM all_tables WHERE owner = :1 ORDER BY table_name`,
      [owner]
    )
    return res.rows
      .map((r) => ({ schema: owner, name: String(r.NAME), type: 'table' as const }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }

  async listViews(schema: string): Promise<ViewRef[]> {
    const owner = this.owner(schema)
    const res = await this.runQuery(
      `SELECT view_name AS name FROM all_views WHERE owner = :1 ORDER BY view_name`,
      [owner]
    )
    return res.rows
      .map((r) => ({ schema: owner, name: String(r.NAME) }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }

  async getTableStructure(schema: string, table: string): Promise<ColumnDef[]> {
    const owner = this.owner(schema)
    const cols = await this.runQuery(
      `SELECT column_name, data_type, data_length, data_precision, data_scale, nullable, data_default
       FROM all_tab_columns WHERE owner = :1 AND table_name = :2 ORDER BY column_id`,
      [owner, table]
    )
    const pks = await this.runQuery(
      `SELECT cc.column_name AS col
       FROM all_constraints c
       JOIN all_cons_columns cc ON c.owner = cc.owner AND c.constraint_name = cc.constraint_name
       WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'P'`,
      [owner, table]
    )
    const pkSet = new Set(pks.rows.map((r) => String(r.COL)))
    return cols.rows.map((r) => ({
      name: String(r.COLUMN_NAME),
      dataType: typeStr(String(r.DATA_TYPE), r.DATA_LENGTH, r.DATA_PRECISION, r.DATA_SCALE),
      nullable: String(r.NULLABLE) === 'Y',
      isPrimaryKey: pkSet.has(String(r.COLUMN_NAME)),
      defaultValue: r.DATA_DEFAULT == null ? null : String(r.DATA_DEFAULT).trim()
    }))
  }

  async getSchemaCatalog(): Promise<SchemaCatalog> {
    const owner = this.owner()
    const res = await this.runQuery(
      `SELECT table_name, column_name, data_type, data_length, data_precision, data_scale
       FROM all_tab_columns WHERE owner = :1 ORDER BY table_name, column_id`,
      [owner]
    )
    const byTable = new Map<string, CatalogTable>()
    for (const r of res.rows) {
      const name = String(r.TABLE_NAME)
      const key = `${owner}.${name}`
      let t = byTable.get(key)
      if (!t) {
        t = { schema: owner, name, columns: [] }
        byTable.set(key, t)
      }
      t.columns.push({
        name: String(r.COLUMN_NAME),
        type: typeStr(String(r.DATA_TYPE), r.DATA_LENGTH, r.DATA_PRECISION, r.DATA_SCALE)
      })
    }
    return { tables: Array.from(byTable.values()) }
  }

  async runQuery(sql: string, params?: unknown[]): Promise<QueryResult> {
    const start = Date.now()
    const conn = await this.ensure().getConnection()
    try {
      const result = await conn.execute(sql, (params ?? []) as oracledb.BindParameters, { autoCommit: true })
      const durationMs = Date.now() - start
      const hasResultSet = Array.isArray(result.metaData) && result.metaData.length > 0
      if (!hasResultSet) {
        return { columns: [], rows: [], rowCount: result.rowsAffected ?? 0, durationMs, hasResultSet: false }
      }
      const columns = (result.metaData ?? []).map((m) => ({ name: m.name, dataType: '' }))
      const rows = ((result.rows ?? []) as Record<string, unknown>[]).map((row) => {
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(row)) out[k] = normalize(row[k])
        return out
      })
      return { columns, rows, rowCount: rows.length, durationMs, hasResultSet: true }
    } finally {
      await conn.close()
    }
  }

  private qtable(schema: string, table: string): string {
    return `${qid(this.owner(schema))}.${qid(table)}`
  }

  async getTableRows(schema: string, table: string, limit: number): Promise<QueryResult> {
    const n = Math.max(1, Math.min(5000, Math.floor(limit)))
    return this.runQuery(`SELECT * FROM ${this.qtable(schema, table)} FETCH FIRST ${n} ROWS ONLY`)
  }

  async getTablePage(
    schema: string,
    table: string,
    pageSize: number,
    page: number,
    sort?: SortSpec | null,
    filters?: ColumnFilter[] | null,
    tree?: FilterGroup | null,
    customWhere?: string | null
  ): Promise<QueryResult> {
    const struct = await this.getTableStructure(schema, table)
    const valid = new Set(struct.map((c) => c.name))
    const where = compileFilter('oracle', filters ?? [], tree ?? null, valid, qid, customWhere)
    const orderBy = orderByClause(struct, sort, qid)
    const size = Math.max(1, Math.min(5000, Math.floor(pageSize)))
    const offset = Math.max(0, (Math.max(1, Math.floor(page)) - 1) * size)
    const sql = `SELECT * FROM ${this.qtable(schema, table)} ${where.sql} ORDER BY ${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${size} ROWS ONLY`
    return this.runQuery(sql, where.params)
  }

  async getTableRowCount(
    schema: string,
    table: string,
    filters?: ColumnFilter[] | null,
    tree?: FilterGroup | null,
    customWhere?: string | null
  ): Promise<number> {
    const struct = await this.getTableStructure(schema, table)
    const valid = new Set(struct.map((c) => c.name))
    const where = compileFilter('oracle', filters ?? [], tree ?? null, valid, qid, customWhere)
    const res = await this.runQuery(`SELECT COUNT(*) AS N FROM ${this.qtable(schema, table)} ${where.sql}`, where.params)
    return Number(res.rows[0]?.N ?? 0)
  }

  async updateCell(
    schema: string,
    table: string,
    column: string,
    value: unknown,
    primaryKey: Record<string, unknown>
  ): Promise<number> {
    const pkCols = Object.keys(primaryKey)
    const set = `${qid(column)} = :1`
    const where = pkCols.map((c, i) => `${qid(c)} = :${i + 2}`).join(' AND ')
    const params = [value, ...pkCols.map((c) => primaryKey[c])]
    const conn = await this.ensure().getConnection()
    try {
      const r = await conn.execute(`UPDATE ${this.qtable(schema, table)} SET ${set} WHERE ${where}`, params as oracledb.BindParameters, { autoCommit: true })
      return r.rowsAffected ?? 0
    } finally {
      await conn.close()
    }
  }

  async applyRowChanges(req: RowChangeRequest): Promise<RowChangeResult> {
    const t = this.qtable(req.schema, req.table)
    const ct = req.columnTypes
    const conn = await this.ensure().getConnection()
    const out: RowChangeResult = { ok: true, inserted: 0, updated: 0, deleted: 0, insertedRows: [] }
    let phase: 'insert' | 'update' | 'delete' = 'delete'
    let index = 0
    try {
      phase = 'delete'
      for (index = 0; index < req.deletes.length; index++) {
        const d = req.deletes[index]
        const cols = Object.keys(d)
        const where = cols.map((c, i) => `${qid(c)} = :${i + 1}`).join(' AND ')
        const r = await conn.execute(`DELETE FROM ${t} WHERE ${where}`, cols.map((c) => oracleBind(d[c], ct[c])) as oracledb.BindParameters, { autoCommit: false })
        out.deleted += r.rowsAffected ?? 0
      }

      phase = 'update'
      for (index = 0; index < req.updates.length; index++) {
        const u = req.updates[index]
        const setCols = Object.keys(u.changes)
        if (setCols.length === 0) continue
        const pkCols = Object.keys(u.primaryKey)
        const setSql = setCols.map((c, i) => `${qid(c)} = :${i + 1}`).join(', ')
        const whereSql = pkCols.map((c, i) => `${qid(c)} = :${setCols.length + i + 1}`).join(' AND ')
        const params = [
          ...setCols.map((c) => oracleBind(u.changes[c], ct[c])),
          ...pkCols.map((c) => oracleBind(u.primaryKey[c], ct[c]))
        ]
        const r = await conn.execute(`UPDATE ${t} SET ${setSql} WHERE ${whereSql}`, params as oracledb.BindParameters, { autoCommit: false })
        out.updated += r.rowsAffected ?? 0
      }

      phase = 'insert'
      const singlePk = req.primaryKey.length === 1 ? req.primaryKey[0] : null
      for (index = 0; index < req.inserts.length; index++) {
        const ins = req.inserts[index]
        const cols = Object.keys(ins)
        if (cols.length === 0) throw new Error('Oracle: insert with no columns is not supported in this stage')
        const values = cols.map((c) => oracleBind(ins[c], ct[c]))
        const ph = cols.map((_, i) => `:${i + 1}`).join(', ')
        // RETURNING the generated PK when the PK column wasn't supplied.
        const returnPk = singlePk && !cols.includes(singlePk)
        let insertedId: unknown = null
        if (returnPk) {
          const r = await conn.execute(
            `INSERT INTO ${t} (${cols.map(qid).join(', ')}) VALUES (${ph}) RETURNING ${qid(singlePk)} INTO :${cols.length + 1}`,
            [...values, { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }] as oracledb.BindParameters,
            { autoCommit: false }
          )
          out.inserted += r.rowsAffected ?? 0
          // Positional out-binds contain only the OUT binds; the single
          // RETURNING value is at index 0 as a one-element array: [[id]].
          const ob = r.outBinds as Array<unknown[]> | undefined
          insertedId = ob?.[0]?.[0] ?? null
        } else {
          const r = await conn.execute(`INSERT INTO ${t} (${cols.map(qid).join(', ')}) VALUES (${ph})`, values as oracledb.BindParameters, { autoCommit: false })
          out.inserted += r.rowsAffected ?? 0
        }
        if (singlePk && insertedId != null) {
          const sel = await conn.execute(`SELECT * FROM ${t} WHERE ${qid(singlePk)} = :1`, [insertedId] as oracledb.BindParameters)
          const arr = (sel.rows ?? []) as Record<string, unknown>[]
          if (arr[0]) {
            const row: Record<string, unknown> = {}
            for (const k of Object.keys(arr[0])) row[k] = normalize(arr[0][k])
            out.insertedRows.push(row)
          } else out.insertedRows.push({ ...ins })
        } else {
          out.insertedRows.push({ ...ins })
        }
      }

      await conn.commit()
      return out
    } catch (err) {
      await conn.rollback().catch(() => undefined)
      return { ok: false, inserted: 0, updated: 0, deleted: 0, insertedRows: [], failure: { phase, index, message: (err as Error).message } }
    } finally {
      await conn.close()
    }
  }

  async execStatements(statements: string[]): Promise<DdlApplyResult> {
    const conn = await this.ensure().getConnection()
    let executed = 0
    try {
      for (let i = 0; i < statements.length; i++) {
        const s = statements[i].trim().replace(/;\s*$/, '')
        if (!s) continue
        try {
          await conn.execute(s, [], { autoCommit: true })
          executed++
        } catch (err) {
          return { ok: false, executed, failedAt: i, message: (err as Error).message }
        }
      }
      return { ok: true, executed }
    } finally {
      await conn.close()
    }
  }

  async transferInsert(
    schema: string,
    table: string,
    columns: string[],
    rows: unknown[][],
    columnTypes: Record<string, string>,
    _identityCols: string[]
  ): Promise<number> {
    if (rows.length === 0) return 0
    const t = this.qtable(schema, table)
    const colList = columns.map(qid).join(', ')
    const ph = columns.map((_, i) => `:${i + 1}`).join(', ')
    const stmt = `INSERT INTO ${t} (${colList}) VALUES (${ph})`
    const conn = await this.ensure().getConnection()
    try {
      // Oracle: single-row binds (no multi-row VALUES). oracleBind turns ISO date
      // strings into JS Date for DATE/TIMESTAMP columns (avoids ORA-01861) and
      // maps '' → NULL for non-text columns.
      for (const row of rows) {
        const values = row.map((v, c) => oracleBind(v, columnTypes[columns[c]]))
        await conn.execute(stmt, values as oracledb.BindParameters, { autoCommit: false })
      }
      await conn.commit()
      return rows.length
    } catch (err) {
      await conn.rollback().catch(() => undefined)
      throw err
    } finally {
      await conn.close()
    }
  }

  /**
   * Apply programmable-object DDL. Unlike execStatements, this keeps the trailing
   * ';' on PL/SQL-bearing statements (CREATE … TRIGGER/PROCEDURE/FUNCTION whose
   * body legitimately ends in "END;") and — crucially — because Oracle CREATES a
   * trigger even when its PL/SQL fails to compile (leaving it INVALID) — checks
   * ALL_ERRORS after each such statement and reports any compile errors instead
   * of a false success.
   */
  async applyObjectSql(statements: string[]): Promise<DdlApplyResult> {
    const plsql = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(TRIGGER|PROCEDURE|FUNCTION|PACKAGE|TYPE)\b/i
    const conn = await this.ensure().getConnection()
    let executed = 0
    try {
      for (let i = 0; i < statements.length; i++) {
        const raw = statements[i].trim()
        if (!raw) continue
        const isPlsql = plsql.test(raw)
        // PL/SQL keeps its internal terminators (END;); strip only a trailing
        // sqlplus '/'. Plain SQL: strip the trailing ';'.
        const s = isPlsql ? raw.replace(/\s*\/\s*$/, '') : raw.replace(/;\s*$/, '')
        try {
          await conn.execute(s, [], { autoCommit: true })
        } catch (err) {
          return { ok: false, executed, failedAt: i, message: (err as Error).message }
        }
        if (isPlsql) {
          const obj = parsePlsqlObject(raw, this.schemaOwner)
          if (obj) {
            const compileErr = await this.fetchCompileErrors(conn, obj.owner, obj.name, obj.type)
            if (compileErr) return { ok: false, executed, failedAt: i, message: compileErr }
          }
        }
        executed++
      }
      return { ok: true, executed }
    } finally {
      await conn.close()
    }
  }

  /** Read ALL_ERRORS for a just-compiled PL/SQL object; format line/pos/text. */
  private async fetchCompileErrors(
    conn: oracledb.Connection,
    owner: string,
    name: string,
    type: string
  ): Promise<string | null> {
    const res = await conn.execute<{ LINE: number; POSITION: number; TEXT: string }>(
      `SELECT line, position, text FROM all_errors
       WHERE owner = :1 AND name = :2 AND type = :3 ORDER BY sequence`,
      [owner, name, type],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    )
    const rows = res.rows ?? []
    if (rows.length === 0) return null
    const lines = rows.map((r) => `  line ${r.LINE}, col ${r.POSITION}: ${String(r.TEXT).trim()}`)
    return `${type} "${name}" compiled with errors (INVALID):\n${lines.join('\n')}`
  }

  async getObjectDefinition(req: ObjectDefRequest): Promise<string> {
    const owner = this.owner(req.schema)
    if (req.kind === 'view') {
      const res = await this.runQuery(
        `SELECT text AS t FROM all_views WHERE owner = :1 AND view_name = :2`,
        [owner, req.name]
      )
      return String(res.rows[0]?.T ?? '')
    }
    // function / procedure / package spec / package body: prefer GET_DDL; fall
    // back to reconstructing from ALL_SOURCE (needs no METADATA privilege).
    const metaType =
      req.kind === 'function' ? 'FUNCTION'
      : req.kind === 'procedure' ? 'PROCEDURE'
      : req.kind === 'packageSpec' ? 'PACKAGE'
      : 'PACKAGE_BODY'
    const sourceType =
      req.kind === 'function' ? 'FUNCTION'
      : req.kind === 'procedure' ? 'PROCEDURE'
      : req.kind === 'packageSpec' ? 'PACKAGE'
      : 'PACKAGE BODY'
    try {
      const ddl = await this.runQuery(`SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) AS d FROM dual`, [metaType, req.name, owner])
      const d = String((ddl.rows[0] as Record<string, unknown>)?.D ?? '').trim()
      if (d) return d
    } catch {
      // fall through to ALL_SOURCE
    }
    const src = await this.runQuery(
      `SELECT text FROM all_source WHERE owner = :1 AND name = :2 AND type = :3 ORDER BY line`,
      [owner, req.name, sourceType]
    )
    const lines = (src.rows as Record<string, unknown>[]).map((r) => String(r.TEXT ?? ''))
    if (lines.length === 0) return ''
    // ALL_SOURCE line 1 starts at "FUNCTION name…"/"PACKAGE name…" (no CREATE).
    return `CREATE OR REPLACE ${lines.join('').replace(/\s+$/, '')}`
  }

  /**
   * Columns (base type + length/scale, so the designer dropdown round-trips
   * cleanly) + primary key. FK/index editing is a later Oracle stage → empty.
   */
  async getTableSpec(schema: string, table: string): Promise<TableSpec> {
    const owner = this.owner(schema)
    const cols = await this.runQuery(
      `SELECT column_name, data_type, data_length, data_precision, data_scale, nullable, identity_column
       FROM all_tab_columns WHERE owner = :1 AND table_name = :2 ORDER BY column_id`,
      [owner, table]
    )
    const pks = await this.runQuery(
      `SELECT cc.column_name AS col, cc.position AS pos
       FROM all_constraints c
       JOIN all_cons_columns cc ON c.owner = cc.owner AND c.constraint_name = cc.constraint_name
       WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'P'
       ORDER BY cc.position`,
      [owner, table]
    )
    const baseType = (dt: string): string => {
      if (dt.startsWith('TIMESTAMP')) {
        if (dt.includes('WITH LOCAL')) return 'TIMESTAMP WITH LOCAL TIME ZONE'
        if (dt.includes('WITH TIME ZONE')) return 'TIMESTAMP WITH TIME ZONE'
        return 'TIMESTAMP'
      }
      return dt
    }
    const columns = cols.rows.map((r) => {
      const type = baseType(String(r.DATA_TYPE).toUpperCase())
      const c: import('@shared/types').ColumnSpec = {
        name: String(r.COLUMN_NAME),
        type,
        nullable: String(r.NULLABLE) === 'Y',
        originalName: null
      }
      if (/^(VARCHAR2|NVARCHAR2|CHAR|NCHAR|RAW)$/.test(type)) c.length = Number(r.DATA_LENGTH) || null
      if (type === 'NUMBER' && r.DATA_PRECISION != null) {
        c.length = Number(r.DATA_PRECISION)
        if (r.DATA_SCALE != null && Number(r.DATA_SCALE) !== 0) c.scale = Number(r.DATA_SCALE)
      }
      if (String(r.IDENTITY_COLUMN) === 'YES') c.autoIncrement = true
      return c
    })
    return {
      schema: owner,
      name: table,
      columns,
      primaryKey: pks.rows.map((r) => String(r.COL)),
      foreignKeys: await this.foreignKeysOf(owner, table),
      indexes: []
    }
  }

  /**
   * Foreign keys on a table (ALL_CONSTRAINTS type 'R'), resolving the referenced
   * table/columns via R_CONSTRAINT_NAME → the parent PK/UNIQUE constraint. Oracle
   * has no ON UPDATE rule, so `onUpdate` is always null.
   */
  private async foreignKeysOf(owner: string, table: string): Promise<import('@shared/types').ForeignKeySpec[]> {
    const res = await this.runQuery(
      `SELECT c.constraint_name AS fk_name, cc.column_name AS col, cc.position AS pos,
              rc.owner AS ref_owner, rc.table_name AS ref_table, rcc.column_name AS ref_col,
              c.delete_rule AS del_rule
       FROM all_constraints c
       JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
       JOIN all_constraints rc ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name
       JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position
       WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'R'
       ORDER BY c.constraint_name, cc.position`,
      [owner, table]
    )
    const action = (rule: unknown): import('@shared/types').FkAction | null => {
      const r = String(rule ?? '').toUpperCase()
      if (r === 'CASCADE') return 'CASCADE'
      if (r === 'SET NULL') return 'SET NULL'
      return 'NO ACTION'
    }
    const byName = new Map<string, import('@shared/types').ForeignKeySpec>()
    for (const row of res.rows as Record<string, unknown>[]) {
      const name = String(row.FK_NAME)
      let fk = byName.get(name)
      if (!fk) {
        fk = {
          name, columns: [], refSchema: String(row.REF_OWNER), refTable: String(row.REF_TABLE), refColumns: [],
          onDelete: action(row.DEL_RULE), onUpdate: null
        }
        byName.set(name, fk)
      }
      fk.columns.push(String(row.COL))
      fk.refColumns.push(String(row.REF_COL))
    }
    return [...byName.values()]
  }

  /**
   * Standalone FUNCTIONs and PROCEDUREs (not packaged) with VALID/INVALID
   * status and a signature built from ALL_ARGUMENTS. Packaged routines live
   * inside their package (see listPackages), not here.
   */
  async listRoutines(schema: string): Promise<RoutineRef[]> {
    const owner = this.owner(schema)
    const objs = await this.runQuery(
      `SELECT object_name, object_type, status
       FROM all_objects
       WHERE owner = :1 AND object_type IN ('FUNCTION', 'PROCEDURE')
       ORDER BY object_name`,
      [owner]
    )
    // Top-level args only (data_level = 0); position 0 is a function's RETURN.
    const args = await this.runQuery(
      `SELECT object_name, argument_name, position, data_type, in_out
       FROM all_arguments
       WHERE owner = :1 AND package_name IS NULL AND data_level = 0
       ORDER BY object_name, position`,
      [owner]
    )
    const paramsByName = new Map<string, string[]>()
    const returnsByName = new Map<string, string>()
    for (const r of args.rows as Record<string, unknown>[]) {
      const name = String(r.OBJECT_NAME)
      const pos = Number(r.POSITION)
      const dt = String(r.DATA_TYPE ?? '')
      if (pos === 0) {
        returnsByName.set(name, dt) // function return type
      } else if (r.ARGUMENT_NAME != null) {
        if (!paramsByName.has(name)) paramsByName.set(name, [])
        paramsByName.get(name)!.push(`${String(r.ARGUMENT_NAME)} ${String(r.IN_OUT ?? 'IN')} ${dt}`)
      }
    }
    return (objs.rows as Record<string, unknown>[]).map((r) => {
      const name = String(r.OBJECT_NAME)
      return {
        schema: owner,
        name,
        kind: String(r.OBJECT_TYPE) === 'PROCEDURE' ? 'procedure' : 'function',
        signature: `(${(paramsByName.get(name) ?? []).join(', ')})`,
        returns: returnsByName.get(name) ?? null,
        status: String(r.STATUS ?? '')
      }
    })
  }

  /**
   * PL/SQL packages: a PACKAGE spec and its optional PACKAGE BODY. Each object
   * has its own VALID/INVALID status in ALL_OBJECTS.
   */
  async listPackages(schema: string): Promise<import('@shared/types').PackageRef[]> {
    const owner = this.owner(schema)
    const res = await this.runQuery(
      `SELECT object_name, object_type, status
       FROM all_objects
       WHERE owner = :1 AND object_type IN ('PACKAGE', 'PACKAGE BODY')
       ORDER BY object_name`,
      [owner]
    )
    const byName = new Map<string, { status?: string; bodyStatus?: string }>()
    for (const r of res.rows as Record<string, unknown>[]) {
      const name = String(r.OBJECT_NAME)
      const entry = byName.get(name) ?? {}
      if (String(r.OBJECT_TYPE) === 'PACKAGE BODY') entry.bodyStatus = String(r.STATUS ?? '')
      else entry.status = String(r.STATUS ?? '')
      byName.set(name, entry)
    }
    return [...byName.entries()].map(([name, e]) => ({
      schema: owner,
      name,
      hasBody: e.bodyStatus != null,
      status: e.status,
      bodyStatus: e.bodyStatus
    }))
  }
  /**
   * Oracle sequences from ALL_SEQUENCES. IDENTITY columns (12c+) create internal
   * system sequences named `ISEQ$$_…` — flag those `system: true` so the UI
   * shows them read-only and never offers drop/alter.
   */
  async listSequences(schema: string): Promise<SequenceRef[]> {
    const owner = this.owner(schema)
    const res = await this.runQuery(
      `SELECT sequence_name AS name FROM all_sequences WHERE sequence_owner = :1 ORDER BY sequence_name`,
      [owner]
    )
    return (res.rows as Record<string, unknown>[])
      .map((r) => {
        const name = String(r.NAME)
        return { schema: owner, name, system: /^ISEQ\$\$/.test(name) }
      })
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }

  async getSequenceDetails(schema: string, name: string): Promise<SequenceInfo> {
    const owner = this.owner(schema)
    const res = await this.runQuery(
      `SELECT min_value, max_value, increment_by, cycle_flag, order_flag, cache_size, last_number
       FROM all_sequences WHERE sequence_owner = :1 AND sequence_name = :2`,
      [owner, name]
    )
    const r = res.rows[0] as Record<string, unknown> | undefined
    if (!r) throw new Error(`Sequence ${owner}.${name} not found`)
    const s = (v: unknown): string => (v == null ? '' : String(v))
    return {
      schema: owner,
      name,
      dataType: 'bigint', // Oracle sequences are NUMBER; no AS-type in DDL
      // Oracle doesn't store START WITH; LAST_NUMBER is the current/next-ish value.
      start: s(r.LAST_NUMBER),
      increment: s(r.INCREMENT_BY),
      minValue: s(r.MIN_VALUE),
      maxValue: s(r.MAX_VALUE),
      cache: s(r.CACHE_SIZE),
      cycle: String(r.CYCLE_FLAG) === 'Y',
      ownedBy: null,
      lastValue: r.LAST_NUMBER == null ? null : String(r.LAST_NUMBER),
      system: /^ISEQ\$\$/.test(name),
      restartSupported: this.restartSupported(),
      ordered: String(r.ORDER_FLAG) === 'Y'
    }
  }
  /**
   * Triggers on a table (ALL_TRIGGERS joined with ALL_OBJECTS for the VALID/
   * INVALID compile state). ALL_TRIGGERS.STATUS is ENABLED/DISABLED; the object
   * status is VALID/INVALID — both are surfaced in the tree.
   */
  async listTriggers(schema: string, table: string): Promise<TriggerRef[]> {
    const owner = this.owner(schema)
    const res = await this.runQuery(
      `SELECT t.trigger_name, t.trigger_type, t.triggering_event, t.status AS enabled_status, o.status AS valid_status
       FROM all_triggers t
       LEFT JOIN all_objects o
         ON o.owner = t.owner AND o.object_name = t.trigger_name AND o.object_type = 'TRIGGER'
       WHERE t.table_owner = :1 AND t.table_name = :2
       ORDER BY t.trigger_name`,
      [owner, table]
    )
    return (res.rows as Record<string, unknown>[]).map((r) => {
      const type = String(r.TRIGGER_TYPE ?? '').toUpperCase() // e.g. "BEFORE EACH ROW"
      const timing = /INSTEAD\s+OF/.test(type) ? 'INSTEAD OF' : /^AFTER/.test(type) ? 'AFTER' : 'BEFORE'
      return {
        schema: owner,
        table,
        name: String(r.TRIGGER_NAME),
        timing,
        event: String(r.TRIGGERING_EVENT ?? '').trim(),
        status: String(r.ENABLED_STATUS ?? '').trim(),
        valid: String(r.VALID_STATUS ?? '').trim()
      }
    })
  }

  async getTriggerDetails(schema: string, table: string, name: string): Promise<TriggerDetails> {
    const owner = this.owner(schema)
    // ALL_TRIGGERS gives the clean structured pieces (TRIGGER_BODY is the PL/SQL
    // block after the header). TRIGGER_BODY is a LONG — node-oracledb returns it
    // as a string.
    const res = await this.runQuery(
      `SELECT trigger_type, triggering_event, when_clause, trigger_body
       FROM all_triggers WHERE owner = :1 AND trigger_name = :2`,
      [owner, name]
    )
    const r = (res.rows as Record<string, unknown>[])[0]
    if (!r) throw new Error(`Trigger ${name} not found in ${owner}`)
    const type = String(r.TRIGGER_TYPE ?? '').toUpperCase()
    const timing = /INSTEAD\s+OF/.test(type) ? 'INSTEAD OF' : /^AFTER/.test(type) ? 'AFTER' : 'BEFORE'
    const level = /EACH\s+ROW/.test(type) ? 'ROW' : 'STATEMENT'
    // triggering_event may be a combo ("INSERT OR UPDATE"); the single-event form
    // uses the first token (combos are preserved in the tree label / definition).
    const eventRaw = String(r.TRIGGERING_EVENT ?? 'INSERT').trim()
    const event = (eventRaw.match(/INSERT|UPDATE|DELETE/i)?.[0] ?? 'INSERT').toUpperCase()
    const whenClause = String(r.WHEN_CLAUSE ?? '').trim() || null
    const body = String(r.TRIGGER_BODY ?? '').trim()

    // Full DDL (for reference) — prefer DBMS_METADATA.GET_DDL; fall back to a
    // reconstruction if it's unavailable (privileges) or errors.
    let definition = ''
    try {
      const ddl = await this.runQuery(
        `SELECT DBMS_METADATA.GET_DDL('TRIGGER', :1, :2) AS d FROM dual`,
        [name, owner]
      )
      definition = String((ddl.rows[0] as Record<string, unknown>)?.D ?? '').trim()
    } catch {
      definition = ''
    }
    if (!definition) {
      const forEach = level === 'ROW' ? '\n  FOR EACH ROW' : ''
      const when = whenClause ? `\n  WHEN (${whenClause})` : ''
      definition = `CREATE OR REPLACE TRIGGER ${qid(owner)}.${qid(name)}\n  ${timing} ${eventRaw} ON ${qid(owner)}.${qid(table)}${forEach}${when}\n${body}`
    }

    return {
      schema: owner,
      table,
      name,
      timing,
      event,
      level,
      body,
      functionName: null,
      functionBody: null,
      whenClause,
      definition
    }
  }
  /**
   * Indexes on a table (ALL_INDEXES + ordered ALL_IND_COLUMNS). PK/UNIQUE
   * constraint-backing indexes and system/non-NORMAL ones (SYS_*, bitmap,
   * function-based, LOB/IOT) are flagged `constraintBacked` → read-only in the UI.
   */
  async listIndexes(schema: string, table: string): Promise<IndexInfo[]> {
    const owner = this.owner(schema)
    const idx = await this.runQuery(
      `SELECT index_name, uniqueness, status, index_type
       FROM all_indexes WHERE table_owner = :1 AND table_name = :2 ORDER BY index_name`,
      [owner, table]
    )
    const cols = await this.runQuery(
      `SELECT index_name, column_name, column_position
       FROM all_ind_columns WHERE index_owner = :1 AND table_name = :2 ORDER BY index_name, column_position`,
      [owner, table]
    )
    const cons = await this.runQuery(
      `SELECT index_name FROM all_constraints
       WHERE owner = :1 AND table_name = :2 AND constraint_type IN ('P','U') AND index_name IS NOT NULL`,
      [owner, table]
    )
    const colsByIdx = new Map<string, string[]>()
    for (const r of cols.rows as Record<string, unknown>[]) {
      const n = String(r.INDEX_NAME)
      if (!colsByIdx.has(n)) colsByIdx.set(n, [])
      colsByIdx.get(n)!.push(String(r.COLUMN_NAME))
    }
    const conSet = new Set((cons.rows as Record<string, unknown>[]).map((r) => String(r.INDEX_NAME)))
    return (idx.rows as Record<string, unknown>[])
      .map((r) => {
        const name = String(r.INDEX_NAME)
        const indexType = String(r.INDEX_TYPE ?? 'NORMAL')
        // System/advanced (SYS_, bitmap, function-based, LOB/IOT) → read-only too.
        const system = /^SYS_/i.test(name) || indexType !== 'NORMAL'
        return {
          schema: owner,
          table,
          name,
          columns: colsByIdx.get(name) ?? [],
          unique: String(r.UNIQUENESS) === 'UNIQUE',
          constraintBacked: conSet.has(name) || system,
          status: String(r.STATUS ?? '')
        }
      })
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }
}
