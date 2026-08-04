// SQLite driver (MAIN process only). Uses `better-sqlite3` (synchronous,
// native). SQLite is file-based; the "connection" is just an open file.
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
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
import { parseEvent, parseLevel, parseTiming, parseTriggerBody } from '@shared/triggerDdl'

function normalize(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`
  return value
}

/** Double-quote a SQLite identifier safely. */
function qid(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"'
}

export class SqliteDriver implements DbDriver {
  readonly config: ConnectionConfig
  private db: Database.Database | null = null

  constructor(config: ConnectionConfig) {
    this.config = config
  }

  private path(): string {
    if (!this.config.filePath) throw new Error('SQLite requires a file path')
    return this.config.filePath
  }

  async connect(): Promise<void> {
    if (this.db) return
    this.db = new Database(this.path())
    this.db.pragma('foreign_keys = ON')
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const p = this.path()
      // Opening with fileMustExist=false would create the file; for a "test"
      // we only assert we can open it. If it doesn't exist yet, that's still a
      // valid target the app will create on connect — report that clearly.
      const exists = existsSync(p)
      const probe = new Database(p)
      probe.prepare('SELECT 1').get()
      probe.close()
      return {
        ok: true,
        message: exists ? 'Opened SQLite file' : 'SQLite file created / openable'
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }

  private ensure(): Database.Database {
    if (!this.db) throw new Error('Not connected')
    return this.db
  }

  async listDatabases(): Promise<string[]> {
    // SQLite has a single database per file; expose attached DB names.
    const rows = this.ensure().pragma('database_list') as Array<{ name: string }>
    return rows.map((r) => r.name)
  }

  async listSchemas(): Promise<string[]> {
    return ['main']
  }

  async listTables(_schema: string): Promise<TableRef[]> {
    // Base tables ONLY — views live under their own node (see listViews).
    const rows = this.ensure()
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name COLLATE NOCASE`
      )
      .all() as Array<{ name: string }>
    return rows.map((r) => ({ schema: 'main', name: r.name, type: 'table' as const }))
  }

  async getTableStructure(_schema: string, table: string): Promise<ColumnDef[]> {
    const rows = this.ensure().pragma(`table_info(${qid(table)})`) as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>
    return rows.map((r) => ({
      name: r.name,
      dataType: r.type || 'BLOB',
      nullable: r.notnull === 0,
      isPrimaryKey: r.pk > 0,
      defaultValue: r.dflt_value
    }))
  }

  async getSchemaCatalog(): Promise<SchemaCatalog> {
    const db = this.ensure()
    const tableRows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all() as Array<{ name: string }>
    const tables: CatalogTable[] = []
    for (const { name } of tableRows) {
      const info = db.pragma(`table_info(${qid(name)})`) as Array<{
        name: string
        type: string
      }>
      tables.push({
        schema: 'main',
        name,
        columns: info.map((c) => ({ name: c.name, type: c.type || 'BLOB' }))
      })
    }
    return { tables }
  }

  async getTableSpec(_schema: string, table: string): Promise<TableSpec> {
    const db = this.ensure()
    const createSql = (
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
        .get(table) as { sql?: string } | undefined
    )?.sql
    const hasAutoInc = !!createSql && /AUTOINCREMENT/i.test(createSql)

    const info = db.pragma(`table_info(${qid(table)})`) as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>
    const pkCols = info
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)
    const columns: ColumnSpec[] = info.map((c) => {
      const isIntPk = pkCols.length === 1 && pkCols[0] === c.name && /INT/i.test(c.type)
      // Parse declared type (e.g. 'VARCHAR(50)', 'DECIMAL(10,2)') into type + params.
      const parsed = parseTypeString(c.type || 'TEXT')
      return {
        name: c.name,
        originalName: c.name,
        type: parsed.type ?? (c.type || 'TEXT'),
        length: parsed.length ?? null,
        scale: parsed.scale ?? null,
        nullable: c.notnull === 0,
        default: c.dflt_value,
        autoIncrement: isIntPk && hasAutoInc,
        comment: null
      }
    })

    const fkList = db.pragma(`foreign_key_list(${qid(table)})`) as Array<{
      id: number
      seq: number
      table: string
      from: string
      to: string
      on_update: string
      on_delete: string
    }>
    const fkMap = new Map<number, ForeignKeySpec>()
    for (const r of fkList) {
      let fk = fkMap.get(r.id)
      if (!fk) {
        fk = {
          name: null,
          columns: [],
          refSchema: null,
          refTable: r.table,
          refColumns: [],
          onDelete: (r.on_delete as ForeignKeySpec['onDelete']) ?? 'NO ACTION',
          onUpdate: (r.on_update as ForeignKeySpec['onUpdate']) ?? 'NO ACTION'
        }
        fkMap.set(r.id, fk)
      }
      fk.columns.push(r.from)
      fk.refColumns.push(r.to)
    }

    const idxList = db.pragma(`index_list(${qid(table)})`) as Array<{
      name: string
      unique: number
      origin: string
    }>
    const indexes: IndexSpec[] = []
    for (const ix of idxList) {
      // origin 'c' = created by an explicit CREATE INDEX (user-editable).
      if (ix.origin !== 'c') continue
      const cols = db.pragma(`index_info(${qid(ix.name)})`) as Array<{ name: string }>
      indexes.push({ name: ix.name, columns: cols.map((c) => c.name), unique: ix.unique === 1 })
    }

    return {
      schema: 'main',
      name: table,
      originalName: table,
      columns,
      primaryKey: pkCols,
      foreignKeys: Array.from(fkMap.values()),
      indexes,
      comment: null
    }
  }

  async applyRowChanges(req: RowChangeRequest): Promise<RowChangeResult> {
    const db = this.ensure()
    const t = qid(req.table)
    const ct = req.columnTypes
    const out: RowChangeResult = { ok: true, inserted: 0, updated: 0, deleted: 0, insertedRows: [] }
    let phase: 'insert' | 'update' | 'delete' = 'delete'
    let index = 0
    try {
      const run = db.transaction(() => {
        phase = 'delete'
        for (index = 0; index < req.deletes.length; index++) {
          const d = req.deletes[index]
          const cols = Object.keys(d)
          const where = cols.map((c) => `${qid(c)} = ?`).join(' AND ')
          const info = db.prepare(`DELETE FROM ${t} WHERE ${where}`).run(...cols.map((c) => coerceForWrite(d[c], ct[c])))
          out.deleted += info.changes
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
          out.updated += db.prepare(`UPDATE ${t} SET ${setSql} WHERE ${whereSql}`).run(...params).changes
        }

        phase = 'insert'
        for (index = 0; index < req.inserts.length; index++) {
          const ins = req.inserts[index]
          const cols = Object.keys(ins)
          let info: import('better-sqlite3').RunResult
          if (cols.length === 0) {
            info = db.prepare(`INSERT INTO ${t} DEFAULT VALUES`).run()
          } else {
            const ph = cols.map(() => '?').join(', ')
            info = db
              .prepare(`INSERT INTO ${t} (${cols.map(qid).join(', ')}) VALUES (${ph})`)
              .run(...cols.map((c) => coerceForWrite(ins[c], ct[c])))
          }
          out.inserted += info.changes
          if (req.primaryKey.length === 1) {
            const pk = req.primaryKey[0]
            const row = db
              .prepare(`SELECT * FROM ${t} WHERE ${qid(pk)} = ?`)
              .get(info.lastInsertRowid) as Record<string, unknown> | undefined
            if (row) {
              const norm: Record<string, unknown> = {}
              for (const key of Object.keys(row)) norm[key] = normalize(row[key])
              out.insertedRows.push(norm)
            }
          } else {
            out.insertedRows.push({ ...ins })
          }
        }
      })
      run()
      return out
    } catch (err) {
      // better-sqlite3 auto-rolls-back a throwing transaction.
      return {
        ok: false,
        inserted: 0,
        updated: 0,
        deleted: 0,
        insertedRows: [],
        failure: { phase, index, message: (err as Error).message }
      }
    }
  }

  async execStatements(statements: string[]): Promise<DdlApplyResult> {
    const db = this.ensure()
    // FK enforcement must be off around a rebuild; setting it here (outside the
    // transaction) is the documented approach. Restored in finally.
    db.pragma('foreign_keys = OFF')
    try {
      let failedAt = -1
      let failMsg = ''
      const run = db.transaction((stmts: string[]) => {
        for (let i = 0; i < stmts.length; i++) {
          try {
            db.exec(stmts[i])
          } catch (err) {
            failedAt = i
            failMsg = (err as Error).message
            throw err // triggers rollback
          }
        }
      })
      try {
        run(statements)
      } catch {
        return { ok: false, executed: Math.max(0, failedAt), failedAt, message: failMsg }
      }
      return { ok: true, executed: statements.length }
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }

  applyObjectSql(statements: string[]): Promise<DdlApplyResult> {
    return this.execStatements(statements)
  }

  async transferInsert(
    _schema: string,
    table: string,
    columns: string[],
    rows: unknown[][],
    columnTypes: Record<string, string>,
    _identityCols: string[]
  ): Promise<number> {
    if (rows.length === 0) return 0
    const db = this.ensure()
    const t = qid(table)
    const colList = columns.map(qid).join(', ')
    const rowPh = '(' + columns.map(() => '?').join(', ') + ')'
    // Stay under SQLite's default SQLITE_MAX_VARIABLE_NUMBER (999 on older builds).
    const perChunk = Math.max(1, Math.floor(900 / columns.length))
    const chunks: unknown[][][] = []
    for (let i = 0; i < rows.length; i += perChunk) chunks.push(rows.slice(i, i + perChunk))
    const bind = (row: unknown[]): unknown[] => row.map((v, c) => coerceForWrite(v, columnTypes[columns[c]]))
    const run = db.transaction((cs: unknown[][][]) => {
      for (const chunk of cs) {
        const placeholders = chunk.map(() => rowPh).join(', ')
        db.prepare(`INSERT INTO ${t} (${colList}) VALUES ${placeholders}`).run(...chunk.flatMap(bind))
      }
    })
    run(chunks) // better-sqlite3 auto-rolls-back on throw
    return rows.length
  }

  async listViews(_schema: string): Promise<ViewRef[]> {
    const rows = this.ensure()
      .prepare(`SELECT name FROM sqlite_master WHERE type='view' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE`)
      .all() as Array<{ name: string }>
    return rows.map((r) => ({ schema: 'main', name: r.name }))
  }

  async listRoutines(_schema: string): Promise<RoutineRef[]> {
    // SQLite has no stored functions/procedures.
    return []
  }

  async listSequences(_schema: string): Promise<SequenceRef[]> {
    // SQLite has no standalone sequences (rowid / AUTOINCREMENT).
    return []
  }

  async getSequenceDetails(_schema: string, _name: string): Promise<SequenceInfo> {
    throw new Error('SQLite has no standalone sequences.')
  }

  async listTriggers(_schema: string, table: string): Promise<TriggerRef[]> {
    const rows = this.ensure()
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ? ORDER BY name COLLATE NOCASE`)
      .all(table) as Array<{ name: string; sql: string }>
    return rows.map((r) => ({
      schema: 'main',
      table,
      name: r.name,
      timing: parseTiming(r.sql ?? ''),
      event: parseEvent(r.sql ?? '')
    }))
  }

  async listIndexes(_schema: string, table: string): Promise<IndexInfo[]> {
    const db = this.ensure()
    const list = db.pragma(`index_list(${qid(table)})`) as Array<{
      name: string
      unique: number
      origin: string
    }>
    const out: IndexInfo[] = []
    for (const ix of list) {
      const cols = db.pragma(`index_info(${qid(ix.name)})`) as Array<{ name: string | null }>
      out.push({
        schema: 'main',
        table,
        name: ix.name,
        columns: cols.map((c) => c.name).filter((n): n is string => n != null),
        unique: ix.unique === 1,
        // origin 'c' = CREATE INDEX (user); 'u'/'pk' = auto (constraint) → read-only.
        constraintBacked: ix.origin !== 'c'
      })
    }
    return out
  }

  async getTriggerDetails(_schema: string, table: string, name: string): Promise<TriggerDetails> {
    const row = this.ensure()
      .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?`)
      .get(name) as { sql?: string } | undefined
    const def = row?.sql ?? ''
    if (!def) throw new Error(`Trigger ${name} not found`)
    return {
      schema: 'main',
      table,
      name,
      timing: parseTiming(def),
      event: parseEvent(def),
      level: parseLevel(def),
      body: parseTriggerBody(def),
      functionName: null,
      functionBody: null,
      definition: def
    }
  }

  async getObjectDefinition(req: ObjectDefRequest): Promise<string> {
    if (req.kind !== 'view') return ''
    const row = this.ensure()
      .prepare(`SELECT sql FROM sqlite_master WHERE type='view' AND name = ?`)
      .get(req.name) as { sql?: string } | undefined
    const sql = row?.sql ?? ''
    // Return just the SELECT body (strip the `CREATE VIEW name AS` prefix).
    return sql.replace(/^\s*CREATE\s+VIEW\s+[\s\S]*?\bAS\b\s*/i, '')
  }

  async runQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const db = this.ensure()
    const started = performance.now()
    const stmt = db.prepare(sql)
    // `reader` is the authoritative signal for whether the statement returns
    // rows — correct even for `WITH ... INSERT` (a CTE that ends in DML).
    if (stmt.reader) {
      const rows = stmt.all(...(params as unknown[])) as Record<string, unknown>[]
      const durationMs = Math.round((performance.now() - started) * 100) / 100
      let columns: ResultColumn[]
      try {
        columns = stmt.columns().map((c) => ({ name: c.name, dataType: c.type ?? 'TEXT' }))
      } catch {
        const keys = rows.length ? Object.keys(rows[0]) : []
        columns = keys.map((k) => ({ name: k, dataType: 'TEXT' }))
      }
      const outRows = rows.map((row) => {
        const out: Record<string, unknown> = {}
        for (const key of Object.keys(row)) out[key] = normalize(row[key])
        return out
      })
      return { columns, rows: outRows, rowCount: outRows.length, durationMs, hasResultSet: true }
    } else {
      const info = stmt.run(...(params as unknown[]))
      const durationMs = Math.round((performance.now() - started) * 100) / 100
      return { columns: [], rows: [], rowCount: info.changes ?? 0, durationMs, hasResultSet: false }
    }
  }

  async getTableRows(_schema: string, table: string, limit: number): Promise<QueryResult> {
    const sql = `SELECT * FROM ${qid(table)} LIMIT ${Number(limit) | 0}`
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
    const struct = await this.getTableStructure(schema, table)
    const valid = new Set(struct.map((c) => c.name))
    const where = compileFilter('sqlite', filters ?? [], tree ?? null, valid, qid, customWhere)
    const orderBy = orderByClause(struct, sort, qid)
    const size = Math.max(1, Math.min(5000, Math.floor(pageSize)))
    const offset = Math.max(0, (Math.max(1, Math.floor(page)) - 1) * size)
    const sql = `SELECT * FROM ${qid(table)} ${where.sql} ORDER BY ${orderBy} LIMIT ${size} OFFSET ${offset}`
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
    const where = compileFilter('sqlite', filters ?? [], tree ?? null, valid, qid, customWhere)
    const res = await this.runQuery(`SELECT COUNT(*) AS c FROM ${qid(table)} ${where.sql}`, where.params)
    return Number(res.rows[0]?.c ?? 0)
  }

  async updateCell(
    _schema: string,
    table: string,
    column: string,
    value: unknown,
    primaryKey: Record<string, unknown>
  ): Promise<number> {
    const pkCols = Object.keys(primaryKey)
    if (pkCols.length === 0) throw new Error('No primary key available for update')
    const params: unknown[] = [value, ...pkCols.map((c) => primaryKey[c])]
    const whereParts = pkCols.map((c) => `${qid(c)} = ?`)
    const sql = `UPDATE ${qid(table)} SET ${qid(column)} = ? WHERE ${whereParts.join(' AND ')}`
    const info = this.ensure()
      .prepare(sql)
      .run(...params)
    return info.changes ?? 0
  }
}
