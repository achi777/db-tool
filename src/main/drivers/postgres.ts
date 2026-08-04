// PostgreSQL driver (MAIN process only). Uses `pg` (pure JS).
import pg from 'pg'
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
  IndexInfo,
  IndexSpec,
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
  ColumnSpec,
  TestConnectionResult
} from '@shared/types'
import { coerceForWrite, orderByClause, type DbDriver } from '../driver'
import { compileFilter } from '@shared/filterCompiler'
import { findType } from '@shared/typeCatalog'
import { parseEvent, parseFunctionBody, parseLevel, parseTiming } from '@shared/triggerDdl'

const { Pool } = pg

// pg parses NUMERIC/BIGINT as strings by default (to avoid precision loss).
// That's fine for display; we keep them as-is. Timestamps come back as JS
// Date objects — normalize to ISO strings so IPC (structured clone) is clean
// and the grid shows something readable.
function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`
  if (value !== null && typeof value === 'object') {
    // JSONB/arrays already come back as JS objects/arrays; stringify for grid.
    return JSON.stringify(value)
  }
  return value
}

/** Double-quote a Postgres identifier safely. */
function qid(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"'
}

/** The first top-level parenthesised key list from a `pg_get_indexdef` string. */
function extractIndexKeyList(def: string): string | null {
  const usingAt = def.search(/\bUSING\b/i)
  const from = usingAt >= 0 ? usingAt : 0
  const open = def.indexOf('(', from)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < def.length; i++) {
    if (def[i] === '(') depth++
    else if (def[i] === ')') {
      depth--
      if (depth === 0) return def.slice(open + 1, i).trim()
    }
  }
  return null
}

/** Split a key list on commas that are NOT inside parentheses. */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Strip surrounding double quotes from a plain quoted identifier ("Foo" → Foo). */
function stripIdentQuotes(s: string): string {
  const m = /^"((?:[^"]|"")*)"$/.exec(s)
  return m ? m[1].replace(/""/g, '"') : s
}

export class PostgresDriver implements DbDriver {
  readonly config: ConnectionConfig
  private pool: pg.Pool | null = null

  constructor(config: ConnectionConfig) {
    this.config = config
  }

  private poolConfig(): pg.PoolConfig {
    return {
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      max: 4,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000
    }
  }

  async connect(): Promise<void> {
    if (this.pool) return
    this.pool = new Pool(this.poolConfig())
    // Fail fast if credentials/host are wrong.
    const client = await this.pool.connect()
    client.release()
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end()
      this.pool = null
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    const probe = new Pool({ ...this.poolConfig(), max: 1 })
    try {
      const client = await probe.connect()
      client.release()
      return { ok: true, message: 'Connection successful' }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    } finally {
      await probe.end().catch(() => undefined)
    }
  }

  private ensure(): pg.Pool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.ensure().query(
      'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname'
    )
    return res.rows.map((r) => r.datname as string)
  }

  async listSchemas(): Promise<string[]> {
    const res = await this.ensure().query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog','information_schema')
         AND schema_name NOT LIKE 'pg_toast%'
         AND schema_name NOT LIKE 'pg_temp%'
       ORDER BY schema_name`
    )
    return res.rows.map((r) => r.schema_name as string)
  }

  async listTables(schema: string): Promise<TableRef[]> {
    // Base tables ONLY — views live under their own node (see listViews).
    const res = await this.ensure().query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY lower(table_name)`,
      [schema]
    )
    return res.rows.map((r) => ({ schema, name: r.table_name as string, type: 'table' as const }))
  }

  async getTableStructure(schema: string, table: string): Promise<ColumnDef[]> {
    const cols = await this.ensure().query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, table]
    )
    const pk = await this.ensure().query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, table]
    )
    const pkCols = new Set(pk.rows.map((r) => r.column_name as string))
    return cols.rows.map((r) => ({
      name: r.column_name as string,
      dataType: r.data_type as string,
      nullable: r.is_nullable === 'YES',
      isPrimaryKey: pkCols.has(r.column_name as string),
      defaultValue: (r.column_default as string | null) ?? null
    }))
  }

  async getSchemaCatalog(): Promise<SchemaCatalog> {
    const res = await this.ensure().query(
      `SELECT table_schema, table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog','information_schema')
         AND table_schema NOT LIKE 'pg_toast%'
       ORDER BY table_schema, table_name, ordinal_position`
    )
    const byTable = new Map<string, CatalogTable>()
    for (const r of res.rows) {
      const schema = r.table_schema as string
      const name = r.table_name as string
      const key = `${schema}.${name}`
      let t = byTable.get(key)
      if (!t) {
        t = { schema, name, columns: [] }
        byTable.set(key, t)
      }
      t.columns.push({ name: r.column_name as string, type: r.data_type as string })
    }
    return { tables: Array.from(byTable.values()) }
  }

  async getTableSpec(schema: string, table: string): Promise<TableSpec> {
    const pool = this.ensure()
    const colsRes = await pool.query(
      `SELECT column_name, data_type, udt_name, character_maximum_length,
              numeric_precision, numeric_scale, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, table]
    )
    const pkRes = await pool.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
       ORDER BY kcu.ordinal_position`,
      [schema, table]
    )
    const primaryKey = pkRes.rows.map((r) => r.column_name as string)

    const pgName = (s: string): string => findType('postgres', s)?.name ?? s.toUpperCase()

    const columns: ColumnSpec[] = colsRes.rows.map((r) => {
      const def = (r.column_default as string | null) ?? null
      const isSerial = !!def && /nextval\(/i.test(def)
      const dataType = String(r.data_type)
      const udt = String(r.udt_name)
      let type: string
      let length: number | null = null
      let scale: number | null = null
      let withTimeZone = false
      let isArray = false

      if (dataType === 'ARRAY') {
        // udt_name is the element type with a leading underscore, e.g. '_int4'.
        isArray = true
        type = pgName(udt.replace(/^_/, ''))
      } else if (/with time zone/i.test(dataType)) {
        withTimeZone = true
        type = /^timestamp/i.test(dataType) ? 'TIMESTAMP' : 'TIME'
      } else if (/without time zone/i.test(dataType)) {
        type = /^timestamp/i.test(dataType) ? 'TIMESTAMP' : 'TIME'
      } else {
        type = pgName(dataType)
      }

      if (!isArray) {
        if (r.character_maximum_length != null) {
          length = Number(r.character_maximum_length)
        } else if (/^(NUMERIC|DECIMAL)$/.test(type) && r.numeric_precision != null) {
          length = Number(r.numeric_precision)
          scale = r.numeric_scale != null ? Number(r.numeric_scale) : null
        }
      }

      return {
        name: r.column_name as string,
        originalName: r.column_name as string,
        type,
        length,
        scale,
        withTimeZone,
        isArray,
        nullable: r.is_nullable === 'YES',
        default: isSerial ? null : def,
        autoIncrement: isSerial,
        comment: null
      }
    })

    const fkRes = await pool.query(
      `SELECT con.conname AS name,
              att.attname AS column_name,
              cl2.relname AS ref_table,
              ns2.nspname AS ref_schema,
              att2.attname AS ref_column,
              con.confdeltype, con.confupdtype,
              ord.n AS ord
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       JOIN pg_class cl2 ON cl2.oid = con.confrelid
       JOIN pg_namespace ns2 ON ns2.oid = cl2.relnamespace
       JOIN LATERAL generate_subscripts(con.conkey, 1) AS ord(n) ON true
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[ord.n]
       JOIN pg_attribute att2 ON att2.attrelid = con.confrelid AND att2.attnum = con.confkey[ord.n]
       WHERE con.contype = 'f' AND ns.nspname = $1 AND cl.relname = $2
       ORDER BY con.conname, ord.n`,
      [schema, table]
    )
    const fkMap = new Map<string, ForeignKeySpec>()
    const actionMap: Record<string, ForeignKeySpec['onDelete']> = {
      a: 'NO ACTION',
      r: 'RESTRICT',
      c: 'CASCADE',
      n: 'SET NULL',
      d: 'SET DEFAULT'
    }
    for (const r of fkRes.rows) {
      const name = r.name as string
      let fk = fkMap.get(name)
      if (!fk) {
        fk = {
          name,
          columns: [],
          refSchema: r.ref_schema as string,
          refTable: r.ref_table as string,
          refColumns: [],
          onDelete: actionMap[r.confdeltype as string] ?? 'NO ACTION',
          onUpdate: actionMap[r.confupdtype as string] ?? 'NO ACTION'
        }
        fkMap.set(name, fk)
      }
      fk.columns.push(r.column_name as string)
      fk.refColumns.push(r.ref_column as string)
    }

    const idxRes = await pool.query(
      `SELECT i.relname AS name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
              a.attname AS column_name, k.n AS ord
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace ns ON ns.oid = t.relnamespace
       JOIN LATERAL generate_subscripts(ix.indkey, 1) AS k(n) ON true
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ix.indkey[k.n]
       WHERE ns.nspname = $1 AND t.relname = $2
       ORDER BY i.relname, k.n`,
      [schema, table]
    )
    const idxMap = new Map<string, IndexSpec & { primary: boolean }>()
    for (const r of idxRes.rows) {
      const name = r.name as string
      let idx = idxMap.get(name)
      if (!idx) {
        idx = { name, columns: [], unique: r.is_unique as boolean, primary: r.is_primary as boolean }
        idxMap.set(name, idx)
      }
      idx.columns.push(r.column_name as string)
    }
    // Exclude the implicit PK index from the editable index list.
    const indexes: IndexSpec[] = Array.from(idxMap.values())
      .filter((i) => !i.primary)
      .map(({ name, columns, unique }) => ({ name, columns, unique }))

    return {
      schema,
      name: table,
      originalName: table,
      columns,
      primaryKey,
      foreignKeys: Array.from(fkMap.values()),
      indexes,
      comment: null
    }
  }

  async applyRowChanges(req: RowChangeRequest): Promise<RowChangeResult> {
    const pool = this.ensure()
    const t = `${qid(req.schema)}.${qid(req.table)}`
    const ct = req.columnTypes
    const client = await pool.connect()
    const out: RowChangeResult = { ok: true, inserted: 0, updated: 0, deleted: 0, insertedRows: [] }
    let phase: 'insert' | 'update' | 'delete' = 'delete'
    let index = 0
    try {
      await client.query('BEGIN')

      phase = 'delete'
      for (index = 0; index < req.deletes.length; index++) {
        const d = req.deletes[index]
        const cols = Object.keys(d)
        const where = cols.map((c, k) => `${qid(c)} = $${k + 1}`).join(' AND ')
        const params = cols.map((c) => coerceForWrite(d[c], ct[c]))
        const r = await client.query(`DELETE FROM ${t} WHERE ${where}`, params)
        out.deleted += r.rowCount ?? 0
      }

      phase = 'update'
      for (index = 0; index < req.updates.length; index++) {
        const u = req.updates[index]
        const setCols = Object.keys(u.changes)
        if (setCols.length === 0) continue
        const setSql = setCols.map((c, k) => `${qid(c)} = $${k + 1}`).join(', ')
        const pkCols = Object.keys(u.primaryKey)
        const whereSql = pkCols.map((c, k) => `${qid(c)} = $${setCols.length + k + 1}`).join(' AND ')
        const params = [
          ...setCols.map((c) => coerceForWrite(u.changes[c], ct[c])),
          ...pkCols.map((c) => coerceForWrite(u.primaryKey[c], ct[c]))
        ]
        const r = await client.query(`UPDATE ${t} SET ${setSql} WHERE ${whereSql}`, params)
        out.updated += r.rowCount ?? 0
      }

      phase = 'insert'
      for (index = 0; index < req.inserts.length; index++) {
        const ins = req.inserts[index]
        const cols = Object.keys(ins)
        let r: pg.QueryResult
        if (cols.length === 0) {
          r = await client.query(`INSERT INTO ${t} DEFAULT VALUES RETURNING *`)
        } else {
          const params = cols.map((c) => coerceForWrite(ins[c], ct[c]))
          const ph = cols.map((_, k) => `$${k + 1}`).join(', ')
          r = await client.query(
            `INSERT INTO ${t} (${cols.map(qid).join(', ')}) VALUES (${ph}) RETURNING *`,
            params
          )
        }
        out.inserted += r.rowCount ?? 0
        if (r.rows?.[0]) {
          const row: Record<string, unknown> = {}
          for (const key of Object.keys(r.rows[0])) row[key] = normalize(r.rows[0][key])
          out.insertedRows.push(row)
        }
      }

      await client.query('COMMIT')
      return out
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      return {
        ok: false,
        inserted: 0,
        updated: 0,
        deleted: 0,
        insertedRows: [],
        failure: { phase, index, message: (err as Error).message }
      }
    } finally {
      client.release()
    }
  }

  async execStatements(statements: string[]): Promise<DdlApplyResult> {
    const pool = this.ensure()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < statements.length; i++) {
        try {
          await client.query(statements[i])
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined)
          return {
            ok: false,
            executed: i,
            failedAt: i,
            message: (err as Error).message
          }
        }
      }
      await client.query('COMMIT')
      return { ok: true, executed: statements.length }
    } finally {
      client.release()
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
    const pool = this.ensure()
    const client = await pool.connect()
    const t = `${qid(schema)}.${qid(table)}`
    const colList = columns.map(qid).join(', ')
    // Keep parameter count well under Postgres' 65535 bind limit.
    const perChunk = Math.max(1, Math.floor(60000 / columns.length))
    try {
      await client.query('BEGIN')
      for (let i = 0; i < rows.length; i += perChunk) {
        const chunk = rows.slice(i, i + perChunk)
        const params: unknown[] = []
        const tuples = chunk.map(
          (row) =>
            '(' +
            row.map((v, c) => { params.push(coerceForWrite(v, columnTypes[columns[c]])); return `$${params.length}` }).join(', ') +
            ')'
        )
        await client.query(`INSERT INTO ${t} (${colList}) VALUES ${tuples.join(', ')}`, params)
      }
      await client.query('COMMIT')
      return rows.length
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  applyObjectSql(statements: string[]): Promise<DdlApplyResult> {
    return this.execStatements(statements)
  }

  async listSequences(schema: string): Promise<SequenceRef[]> {
    const res = await this.ensure().query(
      `SELECT c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'S' AND n.nspname = $1
       ORDER BY lower(c.relname)`,
      [schema]
    )
    return res.rows.map((r) => ({ schema, name: r.name as string }))
  }

  async getSequenceDetails(schema: string, name: string): Promise<SequenceInfo> {
    const pool = this.ensure()
    // pg_sequences (PG 10+) exposes every property incl. last_value + cache.
    const res = await pool.query(
      `SELECT data_type::text AS data_type, start_value, min_value, max_value,
              increment_by, cache_size, cycle, last_value
       FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`,
      [schema, name]
    )
    const r = res.rows[0]
    if (!r) throw new Error(`Sequence ${schema}.${name} not found`)

    // Owned-by column (SERIAL / IDENTITY dependency), if any.
    const dep = await pool.query(
      `SELECT format('%I.%I.%I', tn.nspname, t.relname, a.attname) AS owned_by
       FROM pg_depend d
       JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
       JOIN pg_namespace sn ON sn.oid = s.relnamespace
       JOIN pg_class t ON t.oid = d.refobjid
       JOIN pg_namespace tn ON tn.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
       WHERE d.deptype = 'a' AND sn.nspname = $1 AND s.relname = $2
       LIMIT 1`,
      [schema, name]
    )
    const s = (v: unknown): string => (v == null ? '' : String(v))
    return {
      schema,
      name,
      dataType: s(r.data_type),
      start: s(r.start_value),
      increment: s(r.increment_by),
      minValue: s(r.min_value),
      maxValue: s(r.max_value),
      cache: s(r.cache_size),
      cycle: r.cycle === true,
      ownedBy: (dep.rows[0]?.owned_by as string | undefined) ?? null,
      lastValue: r.last_value == null ? null : String(r.last_value)
    }
  }

  async listTriggers(schema: string, table: string): Promise<TriggerRef[]> {
    const res = await this.ensure().query(
      `SELECT t.tgname AS name, pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT t.tgisinternal AND n.nspname = $1 AND c.relname = $2
       ORDER BY t.tgname`,
      [schema, table]
    )
    return res.rows.map((r) => {
      const def = String(r.def ?? '')
      return { schema, table, name: r.name as string, timing: parseTiming(def), event: parseEvent(def) }
    })
  }

  async getTriggerDetails(schema: string, table: string, name: string): Promise<TriggerDetails> {
    const res = await this.ensure().query(
      `SELECT pg_get_triggerdef(t.oid) AS def, p.proname AS fn_name, pg_get_functiondef(p.oid) AS fn_def
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND n.nspname = $1 AND c.relname = $2 AND t.tgname = $3`,
      [schema, table, name]
    )
    const r = res.rows[0]
    if (!r) throw new Error(`Trigger ${name} on ${schema}.${table} not found`)
    const def = String(r.def ?? '')
    return {
      schema,
      table,
      name,
      timing: parseTiming(def),
      event: parseEvent(def),
      level: parseLevel(def),
      body: '',
      functionName: (r.fn_name as string | null) ?? null,
      functionBody: parseFunctionBody(String(r.fn_def ?? '')),
      definition: def
    }
  }

  async listIndexes(schema: string, table: string): Promise<IndexInfo[]> {
    // One row per index (not per column): parse the key list from pg_get_indexdef
    // so EXPRESSION indexes (whose indkey is 0) are not dropped, and read the
    // access method + partial predicate for the advanced-index editor.
    const res = await this.ensure().query(
      `SELECT i.relname AS name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
              am.amname AS method,
              pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
              pg_get_indexdef(ix.indexrelid) AS def,
              EXISTS (
                SELECT 1 FROM pg_constraint con
                WHERE con.conindid = ix.indexrelid AND con.conrelid = t.oid AND con.contype IN ('p', 'u')
              ) AS con_backed
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_am am ON am.oid = i.relam
       WHERE n.nspname = $1 AND t.relname = $2
       ORDER BY i.relname`,
      [schema, table]
    )
    return res.rows.map((r) => {
      const def = String(r.def ?? '')
      // The key list is the FIRST top-level parenthesised group after USING method.
      const keyExpr = extractIndexKeyList(def)
      const parts = keyExpr ? splitTopLevelCommas(keyExpr) : []
      // A part is a plain column when it's a (optionally quoted) identifier with no
      // parens/space modifiers — those prefill the column multi-select on edit.
      const columns = parts.map((p) => stripIdentQuotes(p.trim()))
      return {
        schema,
        table,
        name: r.name as string,
        columns,
        unique: r.is_unique === true,
        constraintBacked: r.is_primary === true || r.con_backed === true,
        method: (r.method as string) ?? 'btree',
        predicate: (r.predicate as string | null) ?? null,
        keyExpr
      } satisfies IndexInfo
    })
  }

  async listMatViews(schema: string): Promise<import('@shared/types').MatViewRef[]> {
    const res = await this.ensure().query(
      `SELECT matviewname AS name, ispopulated AS populated
       FROM pg_matviews WHERE schemaname = $1 ORDER BY lower(matviewname)`,
      [schema]
    )
    return res.rows.map((r) => ({ schema, name: r.name as string, populated: r.populated === true }))
  }

  async listTypes(schema: string): Promise<import('@shared/types').TypeRef[]> {
    const pool = this.ensure()
    // User-defined enum ('e') + composite ('c') types; exclude table row-types
    // (a composite has typrelid pointing at a relkind='c' pg_class, or 0 for enums).
    const res = await pool.query(
      `SELECT t.typname AS name, t.typtype AS kind, t.oid,
              (SELECT string_agg(e.enumlabel, E'\\n' ORDER BY e.enumsortorder)
                 FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typtype IN ('e', 'c')
         AND (t.typrelid = 0 OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))
       ORDER BY t.typname`,
      [schema]
    )
    const out: import('@shared/types').TypeRef[] = []
    for (const r of res.rows) {
      const kind = r.kind === 'e' ? 'enum' : r.kind === 'c' ? 'composite' : 'other'
      let fields: { name: string; type: string }[] | undefined
      if (kind === 'composite') {
        const fr = await pool.query(
          `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_type t JOIN pg_class c ON c.oid = t.typrelid
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           WHERE t.oid = $1 ORDER BY a.attnum`,
          [r.oid]
        )
        fields = fr.rows.map((f) => ({ name: f.name as string, type: f.type as string }))
      }
      out.push({
        schema,
        name: r.name as string,
        kind,
        labels: kind === 'enum' && r.labels ? String(r.labels).split('\n') : undefined,
        fields
      })
    }
    return out
  }

  async listExtensions(): Promise<{ installed: import('@shared/types').ExtensionRef[]; available: import('@shared/types').ExtensionRef[] }> {
    const res = await this.ensure().query(
      `SELECT a.name, a.default_version, a.installed_version, a.comment
       FROM pg_available_extensions a ORDER BY a.name`
    )
    const map = (r: Record<string, unknown>): import('@shared/types').ExtensionRef => ({
      name: r.name as string,
      installedVersion: (r.installed_version as string | null) ?? null,
      defaultVersion: (r.default_version as string | null) ?? null,
      comment: (r.comment as string | null) ?? null
    })
    const all = res.rows.map(map)
    return { installed: all.filter((e) => e.installedVersion != null), available: all }
  }

  async listViews(schema: string): Promise<ViewRef[]> {
    const res = await this.ensure().query(
      `SELECT table_name FROM information_schema.views WHERE table_schema = $1 ORDER BY lower(table_name)`,
      [schema]
    )
    return res.rows.map((r) => ({ schema, name: r.table_name as string }))
  }

  async listRoutines(schema: string): Promise<RoutineRef[]> {
    const res = await this.ensure().query(
      `SELECT p.proname AS name, p.prokind AS kind,
              pg_get_function_identity_arguments(p.oid) AS args,
              pg_get_function_result(p.oid) AS returns
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.prokind IN ('f','p')
       ORDER BY p.proname`,
      [schema]
    )
    return res.rows.map((r) => ({
      schema,
      name: r.name as string,
      kind: (r.kind as string) === 'p' ? 'procedure' : 'function',
      signature: `(${(r.args as string) ?? ''})`,
      returns: (r.returns as string | null) ?? null
    }))
  }

  async getObjectDefinition(req: ObjectDefRequest): Promise<string> {
    const pool = this.ensure()
    // pg_get_viewdef returns the SELECT body for both views and materialized views.
    if (req.kind === 'view' || req.kind === 'matview') {
      const res = await pool.query(`SELECT pg_get_viewdef(format('%I.%I', $1::text, $2::text)::regclass, true) AS def`, [
        req.schema,
        req.name
      ])
      return String(res.rows[0]?.def ?? '')
    }
    // function / procedure: full CREATE OR REPLACE from pg_get_functiondef.
    const args = (req.signature ?? '').replace(/^\(|\)$/g, '')
    const res = await pool.query(
      `SELECT pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = $2
         AND ($3 = '' OR pg_get_function_identity_arguments(p.oid) = $3)
       LIMIT 1`,
      [req.schema, req.name, args]
    )
    return String(res.rows[0]?.def ?? '')
  }

  async runQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const started = performance.now()
    const res = await this.ensure().query({ text: sql, values: params as unknown[] })
    const durationMs = Math.round((performance.now() - started) * 100) / 100
    const columns: ResultColumn[] = (res.fields ?? []).map((f) => ({
      name: f.name,
      dataType: pgTypeName(f.dataTypeID)
    }))
    const rows = (res.rows ?? []).map((row: Record<string, unknown>) => {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(row)) out[key] = normalize(row[key])
      return out
    })
    const hasResultSet = (res.fields ?? []).length > 0
    return {
      columns,
      rows,
      rowCount: hasResultSet ? rows.length : (res.rowCount ?? 0),
      durationMs,
      hasResultSet
    }
  }

  async getTableRows(schema: string, table: string, limit: number): Promise<QueryResult> {
    const sql = `SELECT * FROM ${qid(schema)}.${qid(table)} LIMIT ${Number(limit) | 0}`
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
    const where = compileFilter('postgres', filters ?? [], tree ?? null, valid, qid, customWhere)
    const orderBy = orderByClause(struct, sort, qid)
    const size = Math.max(1, Math.min(5000, Math.floor(pageSize)))
    const offset = Math.max(0, (Math.max(1, Math.floor(page)) - 1) * size)
    const sql = `SELECT * FROM ${qid(schema)}.${qid(table)} ${where.sql} ORDER BY ${orderBy} LIMIT ${size} OFFSET ${offset}`
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
    const where = compileFilter('postgres', filters ?? [], tree ?? null, valid, qid, customWhere)
    const res = await this.ensure().query(
      `SELECT COUNT(*)::bigint AS c FROM ${qid(schema)}.${qid(table)} ${where.sql}`,
      where.params
    )
    return Number(res.rows[0]?.c ?? 0)
  }

  async updateCell(
    schema: string,
    table: string,
    column: string,
    value: unknown,
    primaryKey: Record<string, unknown>
  ): Promise<number> {
    const pkCols = Object.keys(primaryKey)
    if (pkCols.length === 0) throw new Error('No primary key available for update')
    const params: unknown[] = [value]
    const whereParts = pkCols.map((col, i) => `${qid(col)} = $${i + 2}`)
    for (const col of pkCols) params.push(primaryKey[col])
    const sql = `UPDATE ${qid(schema)}.${qid(table)} SET ${qid(column)} = $1 WHERE ${whereParts.join(
      ' AND '
    )}`
    const res = await this.ensure().query({ text: sql, values: params })
    return res.rowCount ?? 0
  }
}

// A tiny subset of pg OID -> readable name mapping for grid headers. Unknown
// OIDs fall back to the numeric id, which is still informative enough here.
function pgTypeName(oid: number): string {
  const map: Record<number, string> = {
    16: 'bool',
    20: 'int8',
    21: 'int2',
    23: 'int4',
    25: 'text',
    114: 'json',
    3802: 'jsonb',
    1043: 'varchar',
    1700: 'numeric',
    1082: 'date',
    1114: 'timestamp',
    1184: 'timestamptz',
    1009: 'text[]',
    1007: 'int4[]'
  }
  return map[oid] ?? `oid:${oid}`
}
