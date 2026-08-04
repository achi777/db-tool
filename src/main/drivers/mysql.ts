// MySQL driver (MAIN process only). Uses `mysql2` (pure JS).
import mysql from 'mysql2/promise'
import type {
  ColumnDef,
  ConnectionConfig,
  DdlApplyResult,
  QueryResult,
  ResultColumn,
  RowChangeRequest,
  RowChangeResult,
  SchemaCatalog,
  CatalogTable,
  ColumnFilter,
  FilterGroup,
  ForeignKeySpec,
  IndexSpec,
  ColumnSpec,
  IndexInfo,
  ObjectDefRequest,
  RoutineRef,
  SequenceInfo,
  SequenceRef,
  SortSpec,
  TriggerDetails,
  TriggerRef,
  ViewRef,
  TableRef,
  TableSpec,
  TestConnectionResult
} from '@shared/types'
import { coerceForWrite, orderByClause, type DbDriver } from '../driver'
import { compileFilter } from '@shared/filterCompiler'
import { parseTypeString } from '@shared/typeCatalog'

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`
  if (value !== null && typeof value === 'object') {
    // mysql2 returns JSON columns already parsed into JS objects.
    return JSON.stringify(value)
  }
  return value
}

/** Backtick-quote a MySQL identifier safely. */
function qid(id: string): string {
  return '`' + id.replace(/`/g, '``') + '`'
}

export class MysqlDriver implements DbDriver {
  readonly config: ConnectionConfig
  private pool: mysql.Pool | null = null

  constructor(config: ConnectionConfig) {
    this.config = config
  }

  private poolOptions(): mysql.PoolOptions {
    return {
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      connectionLimit: 4,
      connectTimeout: 8000,
      // Keep large numbers precise and dates as strings for clean IPC.
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true
    }
  }

  async connect(): Promise<void> {
    if (this.pool) return
    this.pool = mysql.createPool(this.poolOptions())
    const conn = await this.pool.getConnection()
    conn.release()
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end()
      this.pool = null
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    let conn: mysql.Connection | null = null
    try {
      conn = await mysql.createConnection({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        connectTimeout: 8000
      })
      await conn.query('SELECT 1')
      return { ok: true, message: 'Connection successful' }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    } finally {
      if (conn) await conn.end().catch(() => undefined)
    }
  }

  // protected so the MariaDB driver (which extends this class) can reuse them.
  protected ensure(): mysql.Pool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  /** In MySQL/MariaDB, a "schema" is a database. */
  protected schemaName(schema?: string): string {
    return schema || this.config.database || 'mysql'
  }

  async listDatabases(): Promise<string[]> {
    const [rows] = await this.ensure().query('SHOW DATABASES')
    return (rows as Record<string, unknown>[]).map((r) => String(Object.values(r)[0]))
  }

  async listSchemas(): Promise<string[]> {
    const [rows] = await this.ensure().query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys')
       ORDER BY schema_name`
    )
    return (rows as Record<string, unknown>[]).map((r) => String(r.schema_name ?? r.SCHEMA_NAME))
  }

  async listTables(schema: string): Promise<TableRef[]> {
    const db = this.schemaName(schema)
    // Base tables ONLY — views live under their own node (see listViews).
    // NOTE: sort in JS (locale-aware), NOT via SQL `ORDER BY LOWER(name)`.
    // The server collation of information_schema differs across versions
    // (MySQL 5.7 orders `_` after letters, so `orders` sorts before
    // `order_items`; 8.0 does the opposite), which made the tree order
    // version-dependent. JS localeCompare gives one stable order everywhere.
    const [rows] = await this.ensure().query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
      [db]
    )
    return (rows as Record<string, unknown>[])
      .map((r) => ({
        schema: db,
        name: String(r.table_name ?? r.TABLE_NAME),
        type: 'table' as const
      }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }

  async getTableStructure(schema: string, table: string): Promise<ColumnDef[]> {
    const db = this.schemaName(schema)
    const [rows] = await this.ensure().query(
      `SELECT column_name, column_type, is_nullable, column_default, column_key
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?
       ORDER BY ordinal_position`,
      [db, table]
    )
    return (rows as Record<string, unknown>[]).map((r) => ({
      name: String(r.column_name ?? r.COLUMN_NAME),
      dataType: String(r.column_type ?? r.COLUMN_TYPE),
      nullable: String(r.is_nullable ?? r.IS_NULLABLE) === 'YES',
      isPrimaryKey: String(r.column_key ?? r.COLUMN_KEY) === 'PRI',
      defaultValue: (r.column_default ?? r.COLUMN_DEFAULT ?? null) as string | null
    }))
  }

  async getSchemaCatalog(): Promise<SchemaCatalog> {
    const db = this.schemaName()
    const [rows] = await this.ensure().query(
      `SELECT table_schema, table_name, column_name, column_type
       FROM information_schema.columns
       WHERE table_schema = ?
       ORDER BY table_name, ordinal_position`,
      [db]
    )
    const byTable = new Map<string, CatalogTable>()
    for (const r of rows as Record<string, unknown>[]) {
      const schema = String(r.table_schema ?? r.TABLE_SCHEMA)
      const name = String(r.table_name ?? r.TABLE_NAME)
      const key = `${schema}.${name}`
      let t = byTable.get(key)
      if (!t) {
        t = { schema, name, columns: [] }
        byTable.set(key, t)
      }
      t.columns.push({
        name: String(r.column_name ?? r.COLUMN_NAME),
        type: String(r.column_type ?? r.COLUMN_TYPE)
      })
    }
    return { tables: Array.from(byTable.values()) }
  }

  async getTableSpec(schema: string, table: string): Promise<TableSpec> {
    const db = this.schemaName(schema)
    const pool = this.ensure()

    const [colRows] = await pool.query(
      `SELECT column_name, column_type, is_nullable, column_default, extra
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?
       ORDER BY ordinal_position`,
      [db, table]
    )
    const columns: ColumnSpec[] = (colRows as Record<string, unknown>[]).map((r) => {
      const extra = String(r.extra ?? r.EXTRA ?? '')
      // Parse the full column_type (e.g. 'varchar(255)', 'int unsigned',
      // 'decimal(10,2)', "enum('a','b')") back into type + params.
      const parsed = parseTypeString(String(r.column_type ?? r.COLUMN_TYPE))
      return {
        name: String(r.column_name ?? r.COLUMN_NAME),
        originalName: String(r.column_name ?? r.COLUMN_NAME),
        type: parsed.type ?? String(r.column_type ?? r.COLUMN_TYPE).toUpperCase(),
        length: parsed.length ?? null,
        scale: parsed.scale ?? null,
        enumValues: parsed.enumValues ?? null,
        unsigned: parsed.unsigned ?? false,
        zerofill: parsed.zerofill ?? false,
        nullable: String(r.is_nullable ?? r.IS_NULLABLE) === 'YES',
        default: (r.column_default ?? r.COLUMN_DEFAULT ?? null) as string | null,
        autoIncrement: /auto_increment/i.test(extra),
        comment: null
      }
    })

    const [pkRows] = await pool.query(
      `SELECT column_name FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = ? AND index_name = 'PRIMARY'
       ORDER BY seq_in_index`,
      [db, table]
    )
    const primaryKey = (pkRows as Record<string, unknown>[]).map((r) =>
      String(r.column_name ?? r.COLUMN_NAME)
    )

    const [fkRows] = await pool.query(
      `SELECT k.constraint_name, k.column_name, k.referenced_table_schema,
              k.referenced_table_name, k.referenced_column_name,
              r.delete_rule, r.update_rule
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_name = k.constraint_name AND r.constraint_schema = k.constraint_schema
       WHERE k.table_schema = ? AND k.table_name = ? AND k.referenced_table_name IS NOT NULL
       ORDER BY k.constraint_name, k.ordinal_position`,
      [db, table]
    )
    const fkMap = new Map<string, ForeignKeySpec>()
    for (const r of fkRows as Record<string, unknown>[]) {
      const name = String(r.constraint_name ?? r.CONSTRAINT_NAME)
      let fk = fkMap.get(name)
      if (!fk) {
        fk = {
          name,
          columns: [],
          refSchema: String(r.referenced_table_schema ?? r.REFERENCED_TABLE_SCHEMA),
          refTable: String(r.referenced_table_name ?? r.REFERENCED_TABLE_NAME),
          refColumns: [],
          onDelete: (String(r.delete_rule ?? r.DELETE_RULE) as ForeignKeySpec['onDelete']) ?? 'NO ACTION',
          onUpdate: (String(r.update_rule ?? r.UPDATE_RULE) as ForeignKeySpec['onUpdate']) ?? 'NO ACTION'
        }
        fkMap.set(name, fk)
      }
      fk.columns.push(String(r.column_name ?? r.COLUMN_NAME))
      fk.refColumns.push(String(r.referenced_column_name ?? r.REFERENCED_COLUMN_NAME))
    }

    const [idxRows] = await pool.query(
      `SELECT index_name, non_unique, column_name
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = ? AND index_name <> 'PRIMARY'
       ORDER BY index_name, seq_in_index`,
      [db, table]
    )
    const idxMap = new Map<string, IndexSpec>()
    for (const r of idxRows as Record<string, unknown>[]) {
      const name = String(r.index_name ?? r.INDEX_NAME)
      let idx = idxMap.get(name)
      if (!idx) {
        idx = { name, columns: [], unique: Number(r.non_unique ?? r.NON_UNIQUE) === 0 }
        idxMap.set(name, idx)
      }
      idx.columns.push(String(r.column_name ?? r.COLUMN_NAME))
    }

    return {
      schema: db,
      name: table,
      originalName: table,
      columns,
      primaryKey,
      foreignKeys: Array.from(fkMap.values()),
      indexes: Array.from(idxMap.values()),
      comment: null
    }
  }

  async applyRowChanges(req: RowChangeRequest): Promise<RowChangeResult> {
    const db = this.schemaName(req.schema)
    const t = `${qid(db)}.${qid(req.table)}`
    const ct = req.columnTypes
    const conn = await this.ensure().getConnection()
    const out: RowChangeResult = { ok: true, inserted: 0, updated: 0, deleted: 0, insertedRows: [] }
    let phase: 'insert' | 'update' | 'delete' = 'delete'
    let index = 0
    try {
      await conn.beginTransaction() // InnoDB DML is transactional

      phase = 'delete'
      for (index = 0; index < req.deletes.length; index++) {
        const d = req.deletes[index]
        const cols = Object.keys(d)
        const where = cols.map((c) => `${qid(c)} = ?`).join(' AND ')
        const [r] = await conn.query(
          `DELETE FROM ${t} WHERE ${where}`,
          cols.map((c) => coerceForWrite(d[c], ct[c]))
        )
        out.deleted += (r as mysql.ResultSetHeader).affectedRows ?? 0
      }

      phase = 'update'
      for (index = 0; index < req.updates.length; index++) {
        const u = req.updates[index]
        const setCols = Object.keys(u.changes)
        if (setCols.length === 0) continue
        const pkCols = Object.keys(u.primaryKey)
        const setSql = setCols.map((c) => `${qid(c)} = ?`).join(', ')
        const whereSql = pkCols.map((c) => `${qid(c)} = ?`).join(' AND ')
        const params = [
          ...setCols.map((c) => coerceForWrite(u.changes[c], ct[c])),
          ...pkCols.map((c) => coerceForWrite(u.primaryKey[c], ct[c]))
        ]
        const [r] = await conn.query(`UPDATE ${t} SET ${setSql} WHERE ${whereSql}`, params)
        out.updated += (r as mysql.ResultSetHeader).affectedRows ?? 0
      }

      phase = 'insert'
      for (index = 0; index < req.inserts.length; index++) {
        const ins = req.inserts[index]
        const cols = Object.keys(ins)
        let insertId = 0
        if (cols.length === 0) {
          const [r] = await conn.query(`INSERT INTO ${t} () VALUES ()`)
          const h = r as mysql.ResultSetHeader
          out.inserted += h.affectedRows ?? 0
          insertId = h.insertId
        } else {
          const ph = cols.map(() => '?').join(', ')
          const [r] = await conn.query(
            `INSERT INTO ${t} (${cols.map(qid).join(', ')}) VALUES (${ph})`,
            cols.map((c) => coerceForWrite(ins[c], ct[c]))
          )
          const h = r as mysql.ResultSetHeader
          out.inserted += h.affectedRows ?? 0
          insertId = h.insertId
        }
        // Return the freshly inserted row when there is a single PK we can key on.
        if (req.primaryKey.length === 1 && insertId) {
          const pk = req.primaryKey[0]
          const [rows] = await conn.query(`SELECT * FROM ${t} WHERE ${qid(pk)} = ?`, [insertId])
          const arr = rows as Record<string, unknown>[]
          if (arr[0]) {
            const row: Record<string, unknown> = {}
            for (const key of Object.keys(arr[0])) row[key] = normalize(arr[0][key])
            out.insertedRows.push(row)
          }
        } else {
          out.insertedRows.push({ ...ins })
        }
      }

      await conn.commit()
      return out
    } catch (err) {
      await conn.rollback().catch(() => undefined)
      return {
        ok: false,
        inserted: 0,
        updated: 0,
        deleted: 0,
        insertedRows: [],
        failure: { phase, index, message: (err as Error).message }
      }
    } finally {
      conn.release()
    }
  }

  async execStatements(statements: string[]): Promise<DdlApplyResult> {
    // MySQL DDL is (mostly) non-transactional — apply one statement at a time
    // and report exactly which one failed.
    const pool = this.ensure()
    for (let i = 0; i < statements.length; i++) {
      try {
        await pool.query(statements[i])
      } catch (err) {
        return { ok: false, executed: i, failedAt: i, message: (err as Error).message }
      }
    }
    return { ok: true, executed: statements.length }
  }

  // Inherited unchanged by MariaDB (same wire protocol + AUTO_INCREMENT rules).
  async transferInsert(
    schema: string,
    table: string,
    columns: string[],
    rows: unknown[][],
    columnTypes: Record<string, string>,
    _identityCols: string[]
  ): Promise<number> {
    if (rows.length === 0) return 0
    const t = `${qid(this.schemaName(schema))}.${qid(table)}`
    const colList = columns.map(qid).join(', ')
    const rowPh = '(' + columns.map(() => '?').join(', ') + ')'
    const perChunk = Math.max(1, Math.floor(60000 / columns.length))
    const conn = await this.ensure().getConnection()
    try {
      await conn.beginTransaction()
      for (let i = 0; i < rows.length; i += perChunk) {
        const chunk = rows.slice(i, i + perChunk)
        const placeholders = chunk.map(() => rowPh).join(', ')
        const params = chunk.flatMap((row) => row.map((v, c) => coerceForWrite(v, columnTypes[columns[c]])))
        await conn.query(`INSERT INTO ${t} (${colList}) VALUES ${placeholders}`, params)
      }
      await conn.commit()
      return rows.length
    } catch (err) {
      await conn.rollback().catch(() => undefined)
      throw err
    } finally {
      conn.release()
    }
  }

  applyObjectSql(statements: string[]): Promise<DdlApplyResult> {
    return this.execStatements(statements)
  }

  async listViews(schema: string): Promise<ViewRef[]> {
    const db = this.schemaName(schema)
    const [rows] = await this.ensure().query(
      `SELECT table_name FROM information_schema.views WHERE table_schema = ?`,
      [db]
    )
    // Locale-aware JS sort (see listTables) — stable across MySQL versions.
    return (rows as Record<string, unknown>[])
      .map((r) => ({
        schema: db,
        name: String(r.table_name ?? r.TABLE_NAME)
      }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }

  async listRoutines(schema: string): Promise<RoutineRef[]> {
    const db = this.schemaName(schema)
    const [rows] = await this.ensure().query(
      `SELECT routine_name AS name, routine_type AS type, dtd_identifier AS returns
       FROM information_schema.routines WHERE routine_schema = ? ORDER BY routine_name`,
      [db]
    )
    return (rows as Record<string, unknown>[]).map((r) => ({
      schema: db,
      name: String(r.name ?? r.ROUTINE_NAME),
      kind: String(r.type ?? r.ROUTINE_TYPE).toUpperCase() === 'PROCEDURE' ? 'procedure' : 'function',
      signature: null,
      returns: (r.returns ?? r.DTD_IDENTIFIER ?? null) as string | null
    }))
  }

  async listSequences(_schema: string): Promise<SequenceRef[]> {
    // MySQL uses AUTO_INCREMENT; it has no standalone sequences.
    return []
  }

  async getSequenceDetails(_schema: string, _name: string): Promise<SequenceInfo> {
    throw new Error('MySQL has no standalone sequences.')
  }

  async listTriggers(schema: string, table: string): Promise<TriggerRef[]> {
    const db = this.schemaName(schema)
    const [rows] = await this.ensure().query(
      `SELECT trigger_name AS name, action_timing AS timing, event_manipulation AS event
       FROM information_schema.triggers
       WHERE trigger_schema = ? AND event_object_table = ? ORDER BY trigger_name`,
      [db, table]
    )
    return (rows as Record<string, unknown>[]).map((r) => ({
      schema: db,
      table,
      name: String(r.name ?? r.TRIGGER_NAME),
      timing: String(r.timing ?? r.ACTION_TIMING ?? ''),
      event: String(r.event ?? r.EVENT_MANIPULATION ?? '')
    }))
  }

  async getTriggerDetails(schema: string, table: string, name: string): Promise<TriggerDetails> {
    const db = this.schemaName(schema)
    const [rows] = await this.ensure().query(
      `SELECT action_timing AS timing, event_manipulation AS event,
              action_statement AS body, action_orientation AS level
       FROM information_schema.triggers
       WHERE trigger_schema = ? AND event_object_table = ? AND trigger_name = ?`,
      [db, table, name]
    )
    const r = (rows as Record<string, unknown>[])[0]
    if (!r) throw new Error(`Trigger ${name} on ${db}.${table} not found`)
    const timing = String(r.timing ?? r.ACTION_TIMING ?? 'BEFORE')
    const event = String(r.event ?? r.EVENT_MANIPULATION ?? 'INSERT')
    const body = String(r.body ?? r.ACTION_STATEMENT ?? '')
    return {
      schema: db,
      table,
      name,
      timing,
      event,
      level: String(r.level ?? r.ACTION_ORIENTATION ?? 'ROW').toUpperCase(),
      body,
      functionName: null,
      functionBody: null,
      definition: `CREATE TRIGGER \`${db}\`.\`${name}\` ${timing} ${event} ON \`${db}\`.\`${table}\`\nFOR EACH ROW ${body}`
    }
  }

  async listIndexes(schema: string, table: string): Promise<IndexInfo[]> {
    const db = this.schemaName(schema)
    const [rows] = await this.ensure().query(
      `SELECT index_name AS name, non_unique, seq_in_index, column_name
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = ?
       ORDER BY index_name, seq_in_index`,
      [db, table]
    )
    const map = new Map<string, IndexInfo>()
    for (const r of rows as Record<string, unknown>[]) {
      const name = String(r.name ?? r.INDEX_NAME)
      const unique = Number(r.non_unique ?? r.NON_UNIQUE) === 0
      let idx = map.get(name)
      if (!idx) {
        // PRIMARY and any unique index back a constraint in MySQL — read-only here.
        idx = { schema: db, table, name, columns: [], unique, constraintBacked: name === 'PRIMARY' || unique }
        map.set(name, idx)
      }
      idx.columns.push(String(r.column_name ?? r.COLUMN_NAME))
    }
    return Array.from(map.values())
  }

  async getObjectDefinition(req: ObjectDefRequest): Promise<string> {
    const db = this.schemaName(req.schema)
    const pool = this.ensure()
    if (req.kind === 'view') {
      // view_definition is just the SELECT body.
      const [rows] = await pool.query(
        `SELECT view_definition FROM information_schema.views WHERE table_schema = ? AND table_name = ?`,
        [db, req.name]
      )
      const arr = rows as Record<string, unknown>[]
      return String(arr[0]?.view_definition ?? arr[0]?.VIEW_DEFINITION ?? '')
    }
    // function / procedure: SHOW CREATE gives the full statement.
    const kw = req.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
    const [rows] = await pool.query(`SHOW CREATE ${kw} ${qid(db)}.${qid(req.name)}`)
    const row = (rows as Record<string, unknown>[])[0] ?? {}
    const key = Object.keys(row).find((k) => /^Create /i.test(k))
    return key ? String(row[key] ?? '') : ''
  }

  async runQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const started = performance.now()
    let [rows, fields] = await this.ensure().query(sql, params)
    const durationMs = Math.round((performance.now() - started) * 100) / 100

    // A CALL (or multi-statement) returns an ARRAY OF RESULT SETS — rows is an
    // array whose elements are themselves row-arrays, with a trailing OK packet,
    // and `fields` is an array of field-arrays (the last often undefined). Pick
    // the first real result set so `fields.map(f => f.name)` doesn't crash.
    if (Array.isArray(rows) && rows.some((r) => Array.isArray(r))) {
      const idx = (rows as unknown[]).findIndex((r) => Array.isArray(r))
      const fArr = fields as unknown as mysql.FieldPacket[][]
      rows = (rows as unknown[])[idx] as typeof rows
      fields = (Array.isArray(fArr) ? fArr[idx] : fields) as typeof fields
    }

    // Non-SELECT statements return an OkPacket (not an array).
    if (!Array.isArray(rows)) {
      const ok = rows as mysql.ResultSetHeader
      return {
        columns: [],
        rows: [],
        rowCount: ok.affectedRows ?? 0,
        durationMs,
        hasResultSet: false
      }
    }

    const fieldArr = ((fields as mysql.FieldPacket[]) ?? []).filter((f) => f && typeof (f as { name?: unknown }).name === 'string')
    const columns: ResultColumn[] = fieldArr.map((f) => ({
      name: f.name,
      dataType: mysqlTypeName(f.type)
    }))
    const outRows = (rows as Record<string, unknown>[]).map((row) => {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(row)) out[key] = normalize(row[key])
      return out
    })
    return {
      columns,
      rows: outRows,
      rowCount: outRows.length,
      durationMs,
      hasResultSet: true
    }
  }

  async getTableRows(schema: string, table: string, limit: number): Promise<QueryResult> {
    const db = this.schemaName(schema)
    const sql = `SELECT * FROM ${qid(db)}.${qid(table)} LIMIT ${Number(limit) | 0}`
    return this.runQuery(sql)
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
    const db = this.schemaName(schema)
    const struct = await this.getTableStructure(schema, table)
    const valid = new Set(struct.map((c) => c.name))
    const where = compileFilter('mysql', filters ?? [], tree ?? null, valid, qid, customWhere)
    const orderBy = orderByClause(struct, sort, qid)
    const size = Math.max(1, Math.min(5000, Math.floor(pageSize)))
    const offset = Math.max(0, (Math.max(1, Math.floor(page)) - 1) * size)
    const sql = `SELECT * FROM ${qid(db)}.${qid(table)} ${where.sql} ORDER BY ${orderBy} LIMIT ${size} OFFSET ${offset}`
    return this.runQuery(sql, where.params)
  }

  async getTableRowCount(
    schema: string,
    table: string,
    filters?: ColumnFilter[] | null,
    tree?: FilterGroup | null,
    customWhere?: string | null
  ): Promise<number> {
    const db = this.schemaName(schema)
    const struct = await this.getTableStructure(schema, table)
    const valid = new Set(struct.map((c) => c.name))
    const where = compileFilter('mysql', filters ?? [], tree ?? null, valid, qid, customWhere)
    const [rows] = await this.ensure().query(
      `SELECT COUNT(*) AS c FROM ${qid(db)}.${qid(table)} ${where.sql}`,
      where.params
    )
    const arr = rows as Record<string, unknown>[]
    return Number(arr[0]?.c ?? 0)
  }

  async updateCell(
    schema: string,
    table: string,
    column: string,
    value: unknown,
    primaryKey: Record<string, unknown>
  ): Promise<number> {
    const db = this.schemaName(schema)
    const pkCols = Object.keys(primaryKey)
    if (pkCols.length === 0) throw new Error('No primary key available for update')
    const params: unknown[] = [value, ...pkCols.map((c) => primaryKey[c])]
    const whereParts = pkCols.map((c) => `${qid(c)} = ?`)
    const sql = `UPDATE ${qid(db)}.${qid(table)} SET ${qid(column)} = ? WHERE ${whereParts.join(
      ' AND '
    )}`
    const [res] = await this.ensure().query(sql, params)
    return (res as mysql.ResultSetHeader).affectedRows ?? 0
  }
}

// Minimal mysql2 field-type code -> readable name for grid headers.
function mysqlTypeName(code: number | undefined): string {
  const map: Record<number, string> = {
    0: 'decimal',
    1: 'tinyint',
    2: 'smallint',
    3: 'int',
    4: 'float',
    5: 'double',
    7: 'timestamp',
    8: 'bigint',
    10: 'date',
    12: 'datetime',
    15: 'varchar',
    245: 'json',
    246: 'decimal',
    252: 'text',
    253: 'varchar',
    254: 'char'
  }
  return code != null && map[code] ? map[code] : `type:${code}`
}
