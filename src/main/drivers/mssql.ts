// Microsoft SQL Server driver (MAIN process only). Uses node-mssql (tedious
// backend) — pure JS, no native build.
//
// AUTHENTICATION (user-selectable in the connection form):
//   - SQL SERVER AUTH (default): user + password. Works everywhere.
//   - WINDOWS AUTH (Integrated): needs the NATIVE, Windows-only `msnodesqlv8`
//     module. We DETECT it at connect time and, if missing, return a CLEAR
//     message — mirroring how Oracle Thick mode handles a missing Instant
//     Client. We never bundle or auto-install it.
//
// This is the BASICS stage (TASK 58, stage 1): connect, list databases/schemas/
// tables/views, paginated browse, schema-aware catalog, parameterized grid CRUD
// by PK with IDENTITY handling, and the filter modes producing valid MSSQL SQL
// (`@p` binds, OFFSET/FETCH, [bracket] identifiers). Advanced object management
// (designer/DDL, indexes, triggers, routines, sequences, dump) is a LATER stage
// and those methods return empty / clear-not-supported here.
import sql from 'mssql'
import { createRequire } from 'node:module'
import type {
  ColumnDef,
  ConnectionConfig,
  DdlApplyResult,
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
import type { ColumnFilter, FilterGroup } from '@shared/types'
import { coerceForWrite, orderByClause, type DbDriver } from '../driver'
import { compileFilter } from '@shared/filterCompiler'

const requireCjs = createRequire(import.meta.url)

/** Bracket-quote a SQL Server identifier ( ] is escaped by doubling ). */
function qid(id: string): string {
  return '[' + id.replace(/]/g, ']]') + ']'
}

/** A readable type label from INFORMATION_SCHEMA metadata (for grid headers). */
function typeStr(dataType: string, len: unknown, prec: unknown, scale: unknown): string {
  const t = String(dataType).toLowerCase()
  if (/char|binary/.test(t) && len != null) {
    return Number(len) === -1 ? `${t}(max)` : `${t}(${Number(len)})`
  }
  if (/^(decimal|numeric)$/.test(t) && prec != null) {
    return scale != null && Number(scale) !== 0 ? `${t}(${Number(prec)},${Number(scale)})` : `${t}(${Number(prec)})`
  }
  return t
}

/** Normalize a driver value for clean IPC (Dates → ISO, Buffers → 0xhex). */
function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

// System schemas hidden from the tree (fixed database roles + sys/INFORMATION_SCHEMA).
const SYS_SCHEMAS = new Set([
  'sys', 'INFORMATION_SCHEMA', 'guest', 'db_owner', 'db_accessadmin', 'db_securityadmin',
  'db_ddladmin', 'db_backupoperator', 'db_datareader', 'db_datawriter',
  'db_denydatareader', 'db_denydatawriter'
])

export class MssqlDriver implements DbDriver {
  readonly config: ConnectionConfig
  private pool: sql.ConnectionPool | null = null
  private defaultSchema = 'dbo'
  private majorVersion = 0 // SQL Server major version; 13+ (2016 SP1) has CREATE OR ALTER

  constructor(config: ConnectionConfig) {
    this.config = config
  }

  private poolConfig(): sql.config {
    return {
      server: this.config.host || 'localhost',
      port: this.config.instanceName ? undefined : this.config.port || 1433,
      database: this.config.database || undefined,
      user: this.config.user,
      password: this.config.password,
      options: {
        // Newer drivers default encrypt:true; against a local Docker MSSQL the
        // cert is self-signed, so trustServerCertificate must be on by default.
        encrypt: this.config.encrypt ?? true,
        trustServerCertificate: this.config.trustServerCertificate ?? true,
        instanceName: this.config.instanceName || undefined,
        enableArithAbort: true
      },
      pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
      connectionTimeout: 15000,
      requestTimeout: 60000
    }
  }

  /** Windows Auth needs a native Windows-only module we never bundle. Detect it. */
  private windowsAuthError(): string | null {
    if (this.config.authType !== 'windows') return null
    try {
      requireCjs.resolve('msnodesqlv8')
      // Even when present, this stage does not wire the msnodesqlv8 path.
      return 'Windows Authentication is not enabled in this build. Use SQL Server Authentication instead.'
    } catch {
      return 'Windows Authentication requires the native msnodesqlv8 driver (Windows-only), which is not installed. Use SQL Server Authentication instead.'
    }
  }

  async connect(): Promise<void> {
    if (this.pool) return
    const winErr = this.windowsAuthError()
    if (winErr) throw new Error(winErr)
    this.pool = await new sql.ConnectionPool(this.poolConfig()).connect()
    // Cache the default schema (usually dbo) + major version (CREATE OR ALTER
    // needs 2016 SP1 = major 13+).
    try {
      const r = await this.pool.request().query<{ s: string; v: number }>(
        `SELECT SCHEMA_NAME() AS s, CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) AS v`
      )
      this.defaultSchema = String(r.recordset?.[0]?.s ?? 'dbo')
      this.majorVersion = Number(r.recordset?.[0]?.v ?? 0)
    } catch {
      this.defaultSchema = 'dbo'
    }
  }

  private ensure(): sql.ConnectionPool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close()
      this.pool = null
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    const winErr = this.windowsAuthError()
    if (winErr) return { ok: false, message: winErr }
    let pool: sql.ConnectionPool | null = null
    try {
      pool = await new sql.ConnectionPool(this.poolConfig()).connect()
      await pool.request().query('SELECT 1')
      return { ok: true, message: 'Connection successful (SQL Server Authentication)' }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    } finally {
      if (pool) await pool.close().catch(() => undefined)
    }
  }

  private schemaOr(schema?: string): string {
    return schema && schema.trim() ? schema.trim() : this.defaultSchema
  }

  private qtable(schema: string, table: string): string {
    return `${qid(this.schemaOr(schema))}.${qid(table)}`
  }

  /**
   * Run SQL with POSITIONAL params (bound as @p1..@pN). The filter compiler and
   * the driver's own CRUD emit `@pN` placeholders, so they line up 1:1.
   */
  async runQuery(sqlText: string, params?: unknown[]): Promise<QueryResult> {
    const start = Date.now()
    const req = this.ensure().request()
    ;(params ?? []).forEach((v, i) => req.input(`p${i + 1}`, v as never))
    const result = await req.query(sqlText)
    const durationMs = Date.now() - start
    const rs = result.recordset
    if (!rs) {
      const affected = Array.isArray(result.rowsAffected) ? result.rowsAffected.reduce((a, b) => a + b, 0) : 0
      return { columns: [], rows: [], rowCount: affected, durationMs, hasResultSet: false }
    }
    const meta = rs.columns
      ? Object.values(rs.columns as Record<string, { index: number; name: string; type?: { declaration?: string } }>)
          .sort((a, b) => a.index - b.index)
      : []
    let columns = meta.map((m) => ({ name: m.name, dataType: String(m.type?.declaration ?? '') }))
    const rows = (rs as Record<string, unknown>[]).map((row) => {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(row)) out[k] = normalize(row[k])
      return out
    })
    if (columns.length === 0 && rows.length > 0) columns = Object.keys(rows[0]).map((name) => ({ name, dataType: '' }))
    return { columns, rows, rowCount: rows.length, durationMs, hasResultSet: true }
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.runQuery(
      `SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0 ORDER BY name`
    )
    return res.rows.map((r) => String(r.name))
  }

  async listSchemas(): Promise<string[]> {
    const res = await this.runQuery(
      `SELECT s.name AS name FROM sys.schemas s
       WHERE s.schema_id < 16384 ORDER BY s.name`
    )
    return res.rows
      .map((r) => String(r.name))
      .filter((n) => !SYS_SCHEMAS.has(n))
  }

  async listTables(schema: string): Promise<TableRef[]> {
    const res = await this.runQuery(
      `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = @p1 AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [this.schemaOr(schema)]
    )
    return res.rows
      .map((r) => ({ schema: this.schemaOr(schema), name: String(r.name), type: 'table' as const }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }

  async listViews(schema: string): Promise<ViewRef[]> {
    const res = await this.runQuery(
      `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.VIEWS
       WHERE TABLE_SCHEMA = @p1 ORDER BY TABLE_NAME`,
      [this.schemaOr(schema)]
    )
    return res.rows
      .map((r) => ({ schema: this.schemaOr(schema), name: String(r.name) }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }

  private async primaryKeyCols(schema: string, table: string): Promise<Set<string>> {
    const res = await this.runQuery(
      `SELECT kcu.COLUMN_NAME AS col
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
       WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = @p1 AND tc.TABLE_NAME = @p2
       ORDER BY kcu.ORDINAL_POSITION`,
      [this.schemaOr(schema), table]
    )
    return new Set(res.rows.map((r) => String(r.col)))
  }

  async getTableStructure(schema: string, table: string): Promise<ColumnDef[]> {
    const sch = this.schemaOr(schema)
    const cols = await this.runQuery(
      `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE, COLUMN_DEFAULT
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @p1 AND TABLE_NAME = @p2 ORDER BY ORDINAL_POSITION`,
      [sch, table]
    )
    const pk = await this.primaryKeyCols(sch, table)
    return cols.rows.map((r) => ({
      name: String(r.COLUMN_NAME),
      dataType: typeStr(String(r.DATA_TYPE), r.CHARACTER_MAXIMUM_LENGTH, r.NUMERIC_PRECISION, r.NUMERIC_SCALE),
      nullable: String(r.IS_NULLABLE) === 'YES',
      isPrimaryKey: pk.has(String(r.COLUMN_NAME)),
      defaultValue: r.COLUMN_DEFAULT == null ? null : String(r.COLUMN_DEFAULT)
    }))
  }

  async getSchemaCatalog(): Promise<SchemaCatalog> {
    const res = await this.runQuery(
      `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA NOT IN ('sys','INFORMATION_SCHEMA')
       ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`
    )
    const byTable = new Map<string, CatalogTable>()
    for (const r of res.rows) {
      const sch = String(r.TABLE_SCHEMA)
      if (SYS_SCHEMAS.has(sch)) continue
      const name = String(r.TABLE_NAME)
      const key = `${sch}.${name}`
      let t = byTable.get(key)
      if (!t) {
        t = { schema: sch, name, columns: [] }
        byTable.set(key, t)
      }
      t.columns.push({
        name: String(r.COLUMN_NAME),
        type: typeStr(String(r.DATA_TYPE), r.CHARACTER_MAXIMUM_LENGTH, r.NUMERIC_PRECISION, r.NUMERIC_SCALE)
      })
    }
    return { tables: Array.from(byTable.values()) }
  }

  async getTableRows(schema: string, table: string, limit: number): Promise<QueryResult> {
    const n = Math.max(1, Math.min(5000, Math.floor(limit)))
    return this.runQuery(`SELECT TOP (${n}) * FROM ${this.qtable(schema, table)}`)
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
    const where = compileFilter('mssql', filters ?? [], tree ?? null, valid, qid, customWhere)
    const orderBy = orderByClause(struct, sort, qid)
    const size = Math.max(1, Math.min(5000, Math.floor(pageSize)))
    const offset = Math.max(0, (Math.max(1, Math.floor(page)) - 1) * size)
    const sqlText = `SELECT * FROM ${this.qtable(schema, table)} ${where.sql} ORDER BY ${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${size} ROWS ONLY`
    return this.runQuery(sqlText, where.params)
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
    const where = compileFilter('mssql', filters ?? [], tree ?? null, valid, qid, customWhere)
    const res = await this.runQuery(`SELECT COUNT(*) AS n FROM ${this.qtable(schema, table)} ${where.sql}`, where.params)
    return Number((res.rows[0] as Record<string, unknown>)?.n ?? 0)
  }

  async updateCell(
    schema: string,
    table: string,
    column: string,
    value: unknown,
    primaryKey: Record<string, unknown>
  ): Promise<number> {
    const pkCols = Object.keys(primaryKey)
    const where = pkCols.map((c, i) => `${qid(c)} = @p${i + 2}`).join(' AND ')
    const res = await this.runQuery(
      `UPDATE ${this.qtable(schema, table)} SET ${qid(column)} = @p1 WHERE ${where}`,
      [value, ...pkCols.map((c) => primaryKey[c])]
    )
    return res.rowCount
  }

  async getTableSpec(schema: string, table: string): Promise<TableSpec> {
    const sch = this.schemaOr(schema)
    const cols = await this.runQuery(
      `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE,
              c.IS_NULLABLE, c.COLUMN_DEFAULT,
              COLUMNPROPERTY(OBJECT_ID(QUOTENAME(@p1) + '.' + QUOTENAME(@p2)), c.COLUMN_NAME, 'IsIdentity') AS is_identity
       FROM INFORMATION_SCHEMA.COLUMNS c
       WHERE c.TABLE_SCHEMA = @p1 AND c.TABLE_NAME = @p2 ORDER BY c.ORDINAL_POSITION`,
      [sch, table]
    )
    const pk = await this.primaryKeyCols(sch, table)
    const columns = cols.rows.map((r) => {
      const type = String(r.DATA_TYPE).toUpperCase()
      const c: import('@shared/types').ColumnSpec = {
        name: String(r.COLUMN_NAME),
        type,
        nullable: String(r.IS_NULLABLE) === 'YES',
        originalName: null
      }
      const len = r.CHARACTER_MAXIMUM_LENGTH
      // -1 = MAX (NVARCHAR(MAX) etc.); the DDL/type renderer emits (MAX).
      if (/^(VARCHAR|NVARCHAR|CHAR|NCHAR|VARBINARY|BINARY)$/.test(type) && len != null) c.length = Number(len)
      if (/^(DECIMAL|NUMERIC)$/.test(type) && r.NUMERIC_PRECISION != null) {
        c.length = Number(r.NUMERIC_PRECISION)
        if (r.NUMERIC_SCALE != null && Number(r.NUMERIC_SCALE) !== 0) c.scale = Number(r.NUMERIC_SCALE)
      }
      if (Number(r.is_identity) === 1) c.autoIncrement = true
      if (r.COLUMN_DEFAULT != null) c.default = String(r.COLUMN_DEFAULT)
      return c
    })
    return { schema: sch, name: table, columns, primaryKey: [...pk], foreignKeys: await this.foreignKeysOf(sch, table), indexes: [] }
  }

  private async foreignKeysOf(schema: string, table: string): Promise<import('@shared/types').ForeignKeySpec[]> {
    const res = await this.runQuery(
      `SELECT fk.name AS fk_name, pc.name AS col, rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_col,
              fk.delete_referential_action AS del_action, fk.update_referential_action AS upd_action
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
       JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
       JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
       WHERE fk.parent_object_id = OBJECT_ID(QUOTENAME(@p1) + '.' + QUOTENAME(@p2))
       ORDER BY fk.name, fkc.constraint_column_id`,
      [schema, table]
    )
    const action = (n: unknown): import('@shared/types').FkAction | null => {
      switch (Number(n)) {
        case 1: return 'CASCADE'
        case 2: return 'SET NULL'
        case 3: return 'SET DEFAULT'
        default: return 'NO ACTION'
      }
    }
    const byName = new Map<string, import('@shared/types').ForeignKeySpec>()
    for (const r of res.rows as Record<string, unknown>[]) {
      const name = String(r.fk_name)
      let fk = byName.get(name)
      if (!fk) {
        fk = {
          name, columns: [], refSchema: String(r.ref_schema), refTable: String(r.ref_table), refColumns: [],
          onDelete: action(r.del_action), onUpdate: action(r.upd_action)
        }
        byName.set(name, fk)
      }
      fk.columns.push(String(r.col))
      fk.refColumns.push(String(r.ref_col))
    }
    return [...byName.values()]
  }

  async applyRowChanges(req: RowChangeRequest): Promise<RowChangeResult> {
    const t = this.qtable(req.schema, req.table)
    const ct = req.columnTypes
    const tx = new sql.Transaction(this.ensure())
    const out: RowChangeResult = { ok: true, inserted: 0, updated: 0, deleted: 0, insertedRows: [] }
    let phase: 'insert' | 'update' | 'delete' = 'delete'
    let index = 0
    await tx.begin()
    try {
      phase = 'delete'
      for (index = 0; index < req.deletes.length; index++) {
        const d = req.deletes[index]
        const cols = Object.keys(d)
        const where = cols.map((c, i) => `${qid(c)} = @p${i + 1}`).join(' AND ')
        const r = new sql.Request(tx)
        cols.forEach((c, i) => r.input(`p${i + 1}`, coerceForWrite(d[c], ct[c]) as never))
        const res = await r.query(`DELETE FROM ${t} WHERE ${where}`)
        out.deleted += res.rowsAffected[0] ?? 0
      }

      phase = 'update'
      for (index = 0; index < req.updates.length; index++) {
        const u = req.updates[index]
        const setCols = Object.keys(u.changes)
        if (setCols.length === 0) continue
        const pkCols = Object.keys(u.primaryKey)
        const setSql = setCols.map((c, i) => `${qid(c)} = @p${i + 1}`).join(', ')
        const whereSql = pkCols.map((c, i) => `${qid(c)} = @p${setCols.length + i + 1}`).join(' AND ')
        const r = new sql.Request(tx)
        setCols.forEach((c, i) => r.input(`p${i + 1}`, coerceForWrite(u.changes[c], ct[c]) as never))
        pkCols.forEach((c, i) => r.input(`p${setCols.length + i + 1}`, coerceForWrite(u.primaryKey[c], ct[c]) as never))
        const res = await r.query(`UPDATE ${t} SET ${setSql} WHERE ${whereSql}`)
        out.updated += res.rowsAffected[0] ?? 0
      }

      phase = 'insert'
      for (index = 0; index < req.inserts.length; index++) {
        const ins = req.inserts[index]
        const cols = Object.keys(ins)
        const r = new sql.Request(tx)
        // OUTPUT INSERTED.* returns the full new row (incl. IDENTITY) directly.
        let insertSql: string
        if (cols.length === 0) {
          insertSql = `INSERT INTO ${t} OUTPUT INSERTED.* DEFAULT VALUES`
        } else {
          cols.forEach((c, i) => r.input(`p${i + 1}`, coerceForWrite(ins[c], ct[c]) as never))
          const ph = cols.map((_, i) => `@p${i + 1}`).join(', ')
          insertSql = `INSERT INTO ${t} (${cols.map(qid).join(', ')}) OUTPUT INSERTED.* VALUES (${ph})`
        }
        const res = await r.query(insertSql)
        out.inserted += res.rowsAffected[0] ?? 0
        const newRow = (res.recordset ?? [])[0] as Record<string, unknown> | undefined
        if (newRow) {
          const row: Record<string, unknown> = {}
          for (const k of Object.keys(newRow)) row[k] = normalize(newRow[k])
          out.insertedRows.push(row)
        } else {
          out.insertedRows.push({ ...ins })
        }
      }

      await tx.commit()
      return out
    } catch (err) {
      await tx.rollback().catch(() => undefined)
      return { ok: false, inserted: 0, updated: 0, deleted: 0, insertedRows: [], failure: { phase, index, message: (err as Error).message } }
    }
  }

  async execStatements(statements: string[]): Promise<DdlApplyResult> {
    let executed = 0
    for (let i = 0; i < statements.length; i++) {
      const s = statements[i].trim().replace(/;\s*$/, '')
      if (!s) continue
      try {
        await this.ensure().request().batch(s)
        executed++
      } catch (err) {
        return { ok: false, executed, failedAt: i, message: (err as Error).message }
      }
    }
    return { ok: true, executed }
  }

  async transferInsert(
    schema: string,
    table: string,
    columns: string[],
    rows: unknown[][],
    columnTypes: Record<string, string>,
    identityCols: string[]
  ): Promise<number> {
    if (rows.length === 0) return 0
    const t = this.qtable(schema, table)
    const colList = columns.map(qid).join(', ')
    // SQL Server caps a statement at 2100 parameters; keep chunks ≤ 1000 rows and
    // under that param budget.
    const perChunk = Math.max(1, Math.min(1000, Math.floor(2000 / columns.length)))
    const identity = identityCols.length > 0
    const tx = new sql.Transaction(this.ensure())
    await tx.begin()
    try {
      // IDENTITY_INSERT is session-scoped; ON only inside this one transaction so
      // the source's explicit identity values are preserved (never touches source).
      // Use batch() (a direct T-SQL batch): request.query() runs via sp_executesql,
      // whose SET is scoped to that dynamic-SQL call and would revert before INSERT.
      if (identity) await new sql.Request(tx).batch(`SET IDENTITY_INSERT ${t} ON`)
      for (let i = 0; i < rows.length; i += perChunk) {
        const chunk = rows.slice(i, i + perChunk)
        const r = new sql.Request(tx)
        let p = 0
        const tuples = chunk.map(
          (row) =>
            '(' +
            row
              .map((v, c) => {
                p++
                const val = coerceForWrite(v, columnTypes[columns[c]])
                // Binary columns need an EXPLICIT VarBinary type: node-mssql infers
                // a NULL (and sometimes a Buffer) as NVarChar, which SQL Server
                // refuses to implicitly convert to varbinary.
                if (/varbinary|\bbinary\b|blob|image|\braw\b/i.test(columnTypes[columns[c]] || '')) {
                  r.input(`p${p}`, sql.VarBinary(sql.MAX), val as never)
                } else {
                  r.input(`p${p}`, val as never)
                }
                return `@p${p}`
              })
              .join(', ') +
            ')'
        )
        await r.query(`INSERT INTO ${t} (${colList}) VALUES ${tuples.join(', ')}`)
      }
      if (identity) await new sql.Request(tx).batch(`SET IDENTITY_INSERT ${t} OFF`)
      await tx.commit()
      return rows.length
    } catch (err) {
      await tx.rollback().catch(() => undefined)
      throw err
    }
  }

  async applyObjectSql(statements: string[]): Promise<DdlApplyResult> {
    return this.execStatements(statements)
  }

  async getObjectDefinition(req: ObjectDefRequest): Promise<string> {
    // Views + routines: the module text from sys.sql_modules / OBJECT_DEFINITION.
    const res = await this.runQuery(
      `SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@p1) + '.' + QUOTENAME(@p2))) AS def`,
      [this.schemaOr(req.schema), req.name]
    )
    return String((res.rows[0] as Record<string, unknown>)?.def ?? '')
  }

  /** True when the server supports CREATE OR ALTER (2016 SP1+, major 13+). */
  supportsCreateOrAlter(): boolean {
    return this.majorVersion === 0 || this.majorVersion >= 13
  }

  /**
   * Standalone functions (scalar FN / inline-TVF IF / multi-statement-TVF TF)
   * and procedures (P), with a @param signature from sys.parameters.
   */
  async listRoutines(schema: string): Promise<RoutineRef[]> {
    const sch = this.schemaOr(schema)
    const objs = await this.runQuery(
      `SELECT o.name, o.type FROM sys.objects o
       WHERE o.schema_id = SCHEMA_ID(@p1) AND o.type IN ('FN','IF','TF','P') ORDER BY o.name`,
      [sch]
    )
    const params = await this.runQuery(
      `SELECT o.name AS obj, p.name AS par, p.parameter_id AS pid, TYPE_NAME(p.user_type_id) AS typ, p.is_output AS is_out
       FROM sys.objects o JOIN sys.parameters p ON p.object_id = o.object_id
       WHERE o.schema_id = SCHEMA_ID(@p1) AND o.type IN ('FN','IF','TF','P') ORDER BY o.name, p.parameter_id`,
      [sch]
    )
    const argsByObj = new Map<string, string[]>()
    const returnsByObj = new Map<string, string>()
    for (const r of params.rows as Record<string, unknown>[]) {
      const obj = String(r.obj)
      if (Number(r.pid) === 0) {
        returnsByObj.set(obj, String(r.typ)) // scalar function RETURN type
      } else {
        if (!argsByObj.has(obj)) argsByObj.set(obj, [])
        argsByObj.get(obj)!.push(`${String(r.par)} ${String(r.typ)}${Number(r.is_out) === 1 ? ' OUTPUT' : ''}`)
      }
    }
    return (objs.rows as Record<string, unknown>[]).map((r) => {
      const name = String(r.name)
      const type = String(r.type).trim()
      return {
        schema: sch,
        name,
        kind: type === 'P' ? 'procedure' : 'function',
        signature: `(${(argsByObj.get(name) ?? []).join(', ')})`,
        returns: returnsByObj.get(name) ?? (type === 'IF' || type === 'TF' ? 'TABLE' : null)
      }
    })
  }

  // SQL Server HAS sequences (2012+), but they are a later stage here.
  async listSequences(): Promise<SequenceRef[]> {
    return []
  }
  async getSequenceDetails(): Promise<SequenceInfo> {
    throw new Error('SQL Server sequence management is a later stage.')
  }

  /**
   * Triggers on a table (sys.triggers). timing = AFTER / INSTEAD OF; the event
   * set (INSERT/UPDATE/DELETE) comes from OBJECTPROPERTY; is_disabled → status.
   */
  async listTriggers(schema: string, table: string): Promise<TriggerRef[]> {
    const sch = this.schemaOr(schema)
    const res = await this.runQuery(
      `SELECT t.name, t.is_disabled AS disabled,
              OBJECTPROPERTY(t.object_id,'ExecIsInsteadOfTrigger') AS instead_of,
              OBJECTPROPERTY(t.object_id,'ExecIsInsertTrigger') AS is_ins,
              OBJECTPROPERTY(t.object_id,'ExecIsUpdateTrigger') AS is_upd,
              OBJECTPROPERTY(t.object_id,'ExecIsDeleteTrigger') AS is_del
       FROM sys.triggers t WHERE t.parent_id = OBJECT_ID(QUOTENAME(@p1) + '.' + QUOTENAME(@p2)) ORDER BY t.name`,
      [sch, table]
    )
    return (res.rows as Record<string, unknown>[]).map((r) => {
      const events: string[] = []
      if (Number(r.is_ins) === 1) events.push('INSERT')
      if (Number(r.is_upd) === 1) events.push('UPDATE')
      if (Number(r.is_del) === 1) events.push('DELETE')
      return {
        schema: sch,
        table,
        name: String(r.name),
        timing: Number(r.instead_of) === 1 ? 'INSTEAD OF' : 'AFTER',
        event: events.join(' OR ') || 'INSERT',
        status: Number(r.disabled) === 1 ? 'DISABLED' : 'ENABLED'
      }
    })
  }

  async getTriggerDetails(schema: string, table: string, name: string): Promise<TriggerDetails> {
    const sch = this.schemaOr(schema)
    const res = await this.runQuery(
      `SELECT OBJECT_DEFINITION(t.object_id) AS def,
              OBJECTPROPERTY(t.object_id,'ExecIsInsteadOfTrigger') AS instead_of,
              OBJECTPROPERTY(t.object_id,'ExecIsInsertTrigger') AS is_ins,
              OBJECTPROPERTY(t.object_id,'ExecIsUpdateTrigger') AS is_upd,
              OBJECTPROPERTY(t.object_id,'ExecIsDeleteTrigger') AS is_del
       FROM sys.triggers t
       WHERE t.parent_id = OBJECT_ID(QUOTENAME(@p1) + '.' + QUOTENAME(@p2)) AND t.name = @p3`,
      [sch, table, name]
    )
    const r = (res.rows as Record<string, unknown>[])[0]
    if (!r) throw new Error(`Trigger ${name} not found on ${sch}.${table}`)
    const definition = String(r.def ?? '')
    const timing = Number(r.instead_of) === 1 ? 'INSTEAD OF' : 'AFTER'
    const event = Number(r.is_ins) === 1 ? 'INSERT' : Number(r.is_upd) === 1 ? 'UPDATE' : 'DELETE'
    // The trigger body is everything after the header's standalone AS.
    const m = definition.match(/\bAS\b\s+([\s\S]*)$/i)
    const body = m ? m[1].trim() : definition
    return {
      schema: sch, table, name, timing, event, level: 'STATEMENT',
      body, functionName: null, functionBody: null, definition
    }
  }

  /**
   * Indexes on a table (sys.indexes + sys.index_columns). PK / UNIQUE-constraint
   * backing indexes are flagged read-only (drop the constraint instead).
   */
  async listIndexes(schema: string, table: string): Promise<IndexInfo[]> {
    const sch = this.schemaOr(schema)
    const res = await this.runQuery(
      `SELECT i.name AS ix, i.is_unique AS uniq, i.is_primary_key AS is_pk, i.is_unique_constraint AS is_uc,
              i.type_desc AS type_desc, c.name AS col
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
       JOIN sys.columns c ON c.object_id = i.object_id AND c.column_id = ic.column_id
       WHERE i.object_id = OBJECT_ID(QUOTENAME(@p1) + '.' + QUOTENAME(@p2)) AND i.type > 0 AND i.name IS NOT NULL
       ORDER BY i.name, ic.key_ordinal`,
      [sch, table]
    )
    const byName = new Map<string, IndexInfo>()
    for (const r of res.rows as Record<string, unknown>[]) {
      const name = String(r.ix)
      let ix = byName.get(name)
      if (!ix) {
        ix = {
          schema: sch, table, name, columns: [],
          unique: Number(r.uniq) === 1,
          constraintBacked: Number(r.is_pk) === 1 || Number(r.is_uc) === 1,
          status: String(r.type_desc ?? '')
        }
        byName.set(name, ix)
      }
      ix.columns.push(String(r.col))
    }
    return [...byName.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }
}
