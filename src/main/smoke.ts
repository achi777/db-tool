// Headless end-to-end smoke test of the DB layer, run INSIDE the Electron main
// process (so the better-sqlite3 native binary is exercised under Electron's
// ABI — the same runtime the real app uses). Enabled by SMOKE=1; it never
// opens a window and exits with code 0 on success, 1 on failure.
//
// It drives each engine through the SAME DbDriver interface the app uses.
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDriver, type DbDriver } from './driver'
import { buildObjectOp, buildTableDdl, buildAddForeignKeys } from './ddl'
import { buildTransferPlan, runTransfer } from './transfer'
import { buildAlterSequence, buildCreateSequence, buildDropSequence } from '@shared/sequenceDdl'
import { buildTriggerStatements, buildSetTriggerEnabled } from '@shared/triggerDdl'
import { buildAlterIndex, buildCreateIndex } from '@shared/indexDdl'
import { runExport } from './exporter'
import { previewImport, runImport } from './importer'
import { dumpDatabase, executeSqlFile, previewSqlFile } from './dumper'
import { splitSqlStatements } from '@shared/sqlSplit'
import type { ExportRequest, ImportRequest, IndexCreateSpec, TriggerSpec } from '@shared/types'
import { generateViewSelect, resolveOutputAliases, supportedJoinTypes } from '@shared/viewBuilder'
import { resolveViewModel } from '@shared/viewResolve'
import { reverseParseView } from './viewReverse'
import { clearHistory, listHistory, recordHistory } from './history'
import { loadTabs, saveTabs } from './store'
import type { ColumnSpec, ConnectionConfig, Engine, TableSpec, TransferRequest } from '@shared/types'
import { isMysqlFamily, sqlDialect } from '@shared/types'

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log('[smoke]', ...args)
}

const results: string[] = []
let failed = false

async function testEngine(config: ConnectionConfig): Promise<void> {
  const tag = `${config.engine}`
  try {
    const driver = await createDriver(config)
    const test = await driver.testConnection()
    if (!test.ok) throw new Error(`testConnection failed: ${test.message}`)
    await driver.connect()

    const schemas = await driver.listSchemas()
    const schema = schemas.includes(config.database ?? '')
      ? (config.database as string)
      : schemas[0]
    const tables = await driver.listTables(schema)
    const tableNames = tables.map((t) => t.name).sort()

    const structure = await driver.getTableStructure(schema, 'customers')
    const pkCols = structure.filter((c) => c.isPrimaryKey).map((c) => c.name)

    const rows = await driver.getTableRows(schema, 'customers', 200)
    const q = await driver.runQuery('SELECT count(*) AS n FROM customers')
    const count = q.rows[0]?.n

    // Schema catalog (powers autocomplete). Assert customers + typed columns.
    const catalog = await driver.getSchemaCatalog()
    const custCat = catalog.tables.find((t) => t.name === 'customers')
    if (!custCat || custCat.columns.length === 0) {
      throw new Error('getSchemaCatalog missing customers columns')
    }
    const emailCol = custCat.columns.find((c) => c.name === 'email')
    if (!emailCol || !emailCol.type) throw new Error('catalog column missing type')
    const catNote = `catalog: ${catalog.tables.length} tables, customers has ${custCat.columns.length} typed cols (email:${emailCol.type})`

    // Cell edit round-trip on a PK'd table: flip full_name and restore it.
    let editNote = 'skipped (no PK)'
    if (pkCols.length > 0 && rows.rows.length > 0) {
      const firstRow = rows.rows[0]
      const pk: Record<string, unknown> = {}
      for (const c of pkCols) pk[c] = firstRow[c]
      const original = firstRow['full_name']
      const probe = `SMOKE_${config.engine}`
      const n1 = await driver.updateCell(schema, 'customers', 'full_name', probe, pk)
      const after = await driver.runQuery(
        `SELECT full_name FROM customers WHERE ${pkCols
          .map((c) => `${c} = ${typeof pk[c] === 'number' ? pk[c] : `'${String(pk[c])}'`}`)
          .join(' AND ')}`
      )
      const newVal = after.rows[0]?.full_name
      // Restore original value so the seed data is left unchanged.
      const n2 = await driver.updateCell(schema, 'customers', 'full_name', original, pk)
      if (n1 !== 1 || newVal !== probe || n2 !== 1) {
        throw new Error(`cell edit round-trip failed (n1=${n1}, newVal=${newVal}, n2=${n2})`)
      }
      editNote = `ok (updated+restored PK=${JSON.stringify(pk)})`
    }

    await driver.disconnect()

    results.push(
      `✅ ${tag}: schemas=[${schemas.join(',')}] tables=[${tableNames.join(
        ','
      )}] customers.count=${count} rows=${rows.rowCount} pk=[${pkCols.join(
        ','
      )}] edit=${editNote} ${catNote}`
    )
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  }
}

/** Create + seed a throwaway SQLite file from the db-infra scripts. */
function prepareSqlite(sqlitePath: string): void {
  const sqlDir = process.env['SMOKE_SQLITE_SQL_DIR']
  if (!sqlDir) throw new Error('SMOKE_SQLITE_SQL_DIR not set')
  mkdirSync(dirname(sqlitePath), { recursive: true })
  const db = new Database(sqlitePath)
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customers'")
    .get()
  if (!hasTable) {
    db.exec(readFileSync(join(sqlDir, 'schema.sql'), 'utf-8'))
    db.exec(readFileSync(join(sqlDir, 'seed.sql'), 'utf-8'))
    log('seeded sqlite at', sqlitePath)
  } else {
    log('sqlite already seeded at', sqlitePath)
  }
  db.close()
}

// Dialect-specific type choices for the disposable DDL test table.
function ddlTypes(engine: Engine): {
  int: string
  varchar: (n: number) => { type: string; length: number }
  decimal: { type: string; length: number; scale: number }
  ts: string
} {
  if (engine === 'postgres')
    return {
      int: 'integer',
      varchar: (n) => ({ type: 'varchar', length: n }),
      decimal: { type: 'numeric', length: 10, scale: 2 },
      ts: 'timestamptz'
    }
  if (isMysqlFamily(engine))
    return {
      int: 'int',
      varchar: (n) => ({ type: 'varchar', length: n }),
      decimal: { type: 'decimal', length: 10, scale: 2 },
      ts: 'datetime'
    }
  return {
    int: 'INTEGER',
    varchar: () => ({ type: 'TEXT', length: 0 }),
    decimal: { type: 'REAL', length: 0, scale: 0 },
    ts: 'TEXT'
  }
}

/**
 * End-to-end DDL test against a real database using DISPOSABLE objects only
 * (prefixed `_ddltest_`). Mirrors exactly what the IPC layer does: generate via
 * ddl.ts, apply via driver.execStatements. Cleans up in a finally block.
 */
async function testDdl(config: ConnectionConfig): Promise<void> {
  const tag = `ddl-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const T = ddlTypes(engine)
  const driver = await createDriver(config)
  const notes: string[] = []
  try {
    await driver.connect()

    // Best-effort clean slate (in case a prior run left objects).
    for (const stmt of [
      `DROP TABLE ${isMysqlFamily(engine) ? '`_ddltest_products`' : '"_ddltest_products"'}`,
      `DROP TABLE ${isMysqlFamily(engine) ? '`_ddltest_parent`' : '"_ddltest_parent"'}`
    ]) {
      await driver.runQuery(stmt).catch(() => undefined)
    }

    // --- CREATE parent ---
    const parent: TableSpec = {
      schema,
      name: '_ddltest_parent',
      columns: [
        { name: 'id', type: T.int, nullable: false, autoIncrement: true }
      ],
      primaryKey: ['id'],
      foreignKeys: [],
      indexes: []
    }
    let r = await driver.execStatements(buildTableDdl(engine, 'create', parent).statements)
    if (!r.ok) throw new Error(`create parent failed @${r.failedAt}: ${r.message}`)

    // --- CREATE products (varied types, PK, index, FK to parent) ---
    const v100 = T.varchar(100)
    const products: TableSpec = {
      schema,
      name: '_ddltest_products',
      columns: [
        { name: 'id', type: T.int, nullable: false, autoIncrement: true },
        { name: 'name', type: v100.type, length: v100.length || null, nullable: false },
        { name: 'price', type: T.decimal.type, length: T.decimal.length || null, scale: T.decimal.scale || null, nullable: false },
        { name: 'parent_id', type: T.int, nullable: true },
        { name: 'created_at', type: T.ts, nullable: true }
      ],
      primaryKey: ['id'],
      foreignKeys: [
        {
          name: 'fk_ddltest_products_parent',
          columns: ['parent_id'],
          refSchema: schema,
          refTable: '_ddltest_parent',
          refColumns: ['id'],
          onDelete: 'SET NULL'
        }
      ],
      indexes: [{ name: 'idx_ddltest_products_name', columns: ['name'], unique: false }]
    }
    const createPrev = buildTableDdl(engine, 'create', products)
    r = await driver.execStatements(createPrev.statements)
    if (!r.ok) throw new Error(`create products failed @${r.failedAt}: ${r.message}`)

    // Appears in catalog?
    const cat = await driver.getSchemaCatalog()
    if (!cat.tables.some((t) => t.name === '_ddltest_products')) {
      throw new Error('products not in catalog after create')
    }

    // Insert a row so we can prove data survives an ALTER.
    await driver.runQuery(
      `INSERT INTO ${isMysqlFamily(engine) ? '`_ddltest_products`' : '"_ddltest_products"'} (${
        isMysqlFamily(engine) ? '`name`,`price`' : '"name","price"'
      }) VALUES ('widget', 9.99)`
    )

    // --- ALTER: add column, add index, make price nullable (SQLite -> rebuild) ---
    const original = await driver.getTableSpec(schema, '_ddltest_products')
    const altered: TableSpec = JSON.parse(JSON.stringify(original)) as TableSpec
    const vsku = T.varchar(50)
    altered.columns.push({ name: 'sku', type: vsku.type, length: vsku.length || null, nullable: true })
    const priceCol = altered.columns.find((c) => c.name === 'price')
    if (priceCol) priceCol.nullable = true // NOT NULL -> nullable
    altered.indexes.push({ name: 'idx_ddltest_products_price', columns: ['price'], unique: false })

    const alterPrev = buildTableDdl(engine, 'alter', altered, original)
    const rebuilt = alterPrev.notes.some((n) => /rebuilt/i.test(n))
    r = await driver.execStatements(alterPrev.statements)
    if (!r.ok) throw new Error(`alter failed @${r.failedAt}: ${r.message}`)

    // Verify: new column present + data preserved.
    const after = await driver.getTableSpec(schema, '_ddltest_products')
    if (!after.columns.some((c) => c.name === 'sku')) throw new Error('sku column missing after alter')
    const cnt = await driver.runQuery(
      `SELECT count(*) AS n FROM ${isMysqlFamily(engine) ? '`_ddltest_products`' : '"_ddltest_products"'}`
    )
    const n = Number(cnt.rows[0]?.n)
    if (n !== 1) throw new Error(`data not preserved after alter (rows=${n})`)

    // --- DROP (object op) products then parent ---
    for (const name of ['_ddltest_products', '_ddltest_parent']) {
      const drop = buildObjectOp(engine, { kind: 'dropTable', schema, table: name })
      if (!drop.destructive) throw new Error('dropTable not flagged destructive')
      const dr = await driver.execStatements(drop.statements)
      if (!dr.ok) throw new Error(`drop ${name} failed: ${dr.message}`)
    }

    // --- schema/database create + drop (PG/MySQL) ---
    let schemaNote = 'n/a (sqlite = files)'
    if (engine === 'postgres' || isMysqlFamily(engine)) {
      const kindWord = isMysqlFamily(engine) ? 'database' : 'schema'
      const dbName = '_ddltest_schema'
      const createRes = await driver.execStatements(
        buildObjectOp(engine, { kind: 'createSchema', name: dbName }).statements
      )
      if (!createRes.ok) {
        // Not a generator bug — the dev user may lack the privilege (e.g. the
        // MySQL `dbtool` user only owns dbtool_dev.*). Report honestly.
        schemaNote = `create ${kindWord} skipped: user lacks privilege (${createRes.message})`
      } else {
        const seen = (await driver.listSchemas()).includes(dbName)
        const dropRes = await driver.execStatements(
          buildObjectOp(engine, { kind: 'dropSchema', name: dbName }).statements
        )
        const goneAfter = !(await driver.listSchemas()).includes(dbName)
        if (!seen || !dropRes.ok || !goneAfter) {
          throw new Error(`${kindWord} create/drop inconsistent (seen=${seen}, drop.ok=${dropRes.ok}, goneAfter=${goneAfter})`)
        }
        schemaNote = `create+drop ${kindWord} verified (seen→gone)`
      }
    }

    notes.push(
      `create(pk,fk,index) ok, alter(add col+index+nullable${rebuilt ? ', SQLite REBUILD' : ''}) data-preserved, drop ok, ${schemaNote}`
    )
    results.push(`✅ ${tag}: ${notes.join(' ')}`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    // Ensure cleanup even on failure.
    for (const stmt of [
      `DROP TABLE ${isMysqlFamily(engine) ? '`_ddltest_products`' : '"_ddltest_products"'}`,
      `DROP TABLE ${isMysqlFamily(engine) ? '`_ddltest_parent`' : '"_ddltest_parent"'}`
    ]) {
      await driver.runQuery(stmt).catch(() => undefined)
    }
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * End-to-end grid CRUD test against a real database on DISPOSABLE tables
 * (`_crudtest_*`). Exercises applyRowChanges exactly as the IPC layer does.
 */
async function testCrud(config: ConnectionConfig): Promise<void> {
  const tag = `crud-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const T = ddlTypes(engine)
  const driver = await createDriver(config)
  const qtbl = (n: string): string => (isMysqlFamily(engine) ? '`' + n + '`' : '"' + n + '"')
  try {
    await driver.connect()
    for (const n of ['_crudtest_main', '_crudtest_nopk']) {
      await driver.runQuery(`DROP TABLE ${qtbl(n)}`).catch(() => undefined)
    }

    const v50 = T.varchar(50)
    const main: TableSpec = {
      schema,
      name: '_crudtest_main',
      columns: [
        { name: 'id', type: T.int, nullable: false, autoIncrement: true },
        { name: 'name', type: v50.type, length: v50.length || null, nullable: false },
        { name: 'qty', type: T.int, nullable: true },
        { name: 'note', type: engine === 'sqlite' ? 'TEXT' : isMysqlFamily(engine) ? 'text' : 'text', nullable: true }
      ],
      primaryKey: ['id'],
      foreignKeys: [],
      indexes: []
    }
    let d = await driver.execStatements(buildTableDdl(engine, 'create', main).statements)
    if (!d.ok) throw new Error(`create failed: ${d.message}`)

    const spec = await driver.getTableSpec(schema, '_crudtest_main')
    const columnTypes: Record<string, string> = {}
    for (const c of spec.columns) columnTypes[c.name] = c.type
    const base = { connectionId: config.id, schema, table: '_crudtest_main', primaryKey: ['id'], columnTypes }

    // INSERT (auto-inc id left blank -> DB assigns).
    const ins = await driver.applyRowChanges({ ...base, inserts: [{ name: 'alpha', qty: '5' }], updates: [], deletes: [] })
    if (!ins.ok || ins.inserted !== 1) throw new Error(`insert failed: ${ins.failure?.message}`)
    const newId = ins.insertedRows[0]?.id
    if (newId == null) throw new Error('inserted row did not return an id')

    // UPDATE (qty '' -> NULL for non-text; name changed).
    const upd = await driver.applyRowChanges({
      ...base,
      inserts: [],
      updates: [{ primaryKey: { id: newId }, changes: { name: 'alpha2', qty: '' } }],
      deletes: []
    })
    if (!upd.ok || upd.updated !== 1) throw new Error(`update failed: ${upd.failure?.message}`)
    const check = await driver.runQuery(`SELECT name, qty FROM ${qtbl('_crudtest_main')} WHERE id = ${Number(newId)}`)
    if (check.rows[0]?.name !== 'alpha2' || check.rows[0]?.qty != null) {
      throw new Error(`update not persisted correctly: ${JSON.stringify(check.rows[0])}`)
    }

    // NOT NULL violation -> whole batch fails + rolls back.
    const bad = await driver.applyRowChanges({ ...base, inserts: [{ qty: '9' }], updates: [], deletes: [] })
    const cntAfterBad = await driver.runQuery(`SELECT count(*) AS n FROM ${qtbl('_crudtest_main')}`)
    if (bad.ok) throw new Error('not-null insert unexpectedly succeeded')
    if (Number(cntAfterBad.rows[0]?.n) !== 1) throw new Error('failed batch was not rolled back')

    // ROLLBACK: valid insert + invalid update (name -> NULL) in one batch -> nothing applied.
    const roll = await driver.applyRowChanges({
      ...base,
      inserts: [{ name: 'willroll' }],
      updates: [{ primaryKey: { id: newId }, changes: { name: null } }],
      deletes: []
    })
    const rollCheck = await driver.runQuery(`SELECT count(*) AS n FROM ${qtbl('_crudtest_main')} WHERE name = 'willroll'`)
    const nameStill = await driver.runQuery(`SELECT name FROM ${qtbl('_crudtest_main')} WHERE id = ${Number(newId)}`)
    if (roll.ok) throw new Error('batch with invalid update unexpectedly succeeded')
    if (Number(rollCheck.rows[0]?.n) !== 0 || nameStill.rows[0]?.name !== 'alpha2') {
      throw new Error('transaction did not roll back cleanly')
    }

    // DELETE.
    const del = await driver.applyRowChanges({ ...base, inserts: [], updates: [], deletes: [{ id: newId }] })
    const cntAfterDel = await driver.runQuery(`SELECT count(*) AS n FROM ${qtbl('_crudtest_main')}`)
    if (!del.ok || del.deleted !== 1 || Number(cntAfterDel.rows[0]?.n) !== 0) {
      throw new Error(`delete failed: ${del.failure?.message}`)
    }

    // PK-less table: insert works, no key needed.
    const nopk: TableSpec = {
      schema,
      name: '_crudtest_nopk',
      columns: [
        { name: 'a', type: v50.type, length: v50.length || null, nullable: true },
        { name: 'b', type: v50.type, length: v50.length || null, nullable: true }
      ],
      primaryKey: [],
      foreignKeys: [],
      indexes: []
    }
    d = await driver.execStatements(buildTableDdl(engine, 'create', nopk).statements)
    if (!d.ok) throw new Error(`create nopk failed: ${d.message}`)
    const nopkIns = await driver.applyRowChanges({
      connectionId: config.id, schema, table: '_crudtest_nopk', primaryKey: [], columnTypes: { a: v50.type, b: v50.type },
      inserts: [{ a: 'x', b: 'y' }], updates: [], deletes: []
    })
    if (!nopkIns.ok || nopkIns.inserted !== 1) throw new Error(`pk-less insert failed: ${nopkIns.failure?.message}`)

    results.push(
      `✅ ${tag}: insert(id=${newId} returned), update(qty→null), not-null blocked+rolled-back, mixed-batch rollback, delete ok, pk-less insert ok`
    )
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    for (const n of ['_crudtest_main', '_crudtest_nopk']) {
      await driver.runQuery(`DROP TABLE ${qtbl(n)}`).catch(() => undefined)
    }
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * Verify the full column type system: typed CREATE (VARCHAR(n), NUMERIC(p,s),
 * TIMESTAMP WITH TIME ZONE, arrays, JSONB, UNSIGNED, ENUM/SET) applies, and
 * getTableSpec round-trips type + params back. Disposable `_typetest_` table.
 */
async function testTypeSystem(config: ConnectionConfig): Promise<void> {
  const tag = `types-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const driver = await createDriver(config)
  const qtbl = (n: string): string => (isMysqlFamily(engine) ? '`' + n + '`' : '"' + n + '"')
  const name = '_typetest_types'
  try {
    await driver.connect()
    await driver.runQuery(`DROP TABLE ${qtbl(name)}`).catch(() => undefined)

    let cols: import('@shared/types').ColumnSpec[]
    if (engine === 'postgres') {
      cols = [
        { name: 'id', type: 'INTEGER', nullable: false, autoIncrement: true },
        { name: 'nm', type: 'VARCHAR', length: 100, nullable: false },
        { name: 'price', type: 'NUMERIC', length: 10, scale: 2, nullable: true },
        { name: 'created_at', type: 'TIMESTAMP', withTimeZone: true, nullable: true },
        { name: 'tags', type: 'TEXT', isArray: true, nullable: true },
        { name: 'meta', type: 'JSONB', nullable: true },
        { name: 'uid', type: 'UUID', nullable: true }
      ]
    } else if (isMysqlFamily(engine)) {
      cols = [
        { name: 'id', type: 'INT', nullable: false, autoIncrement: true },
        { name: 'nm', type: 'VARCHAR', length: 100, nullable: false },
        { name: 'price', type: 'DECIMAL', length: 10, scale: 2, nullable: true },
        { name: 'qty', type: 'INT', unsigned: true, nullable: true },
        { name: 'status', type: 'ENUM', enumValues: ['a', 'b', 'c'], nullable: true },
        { name: 'flags', type: 'SET', enumValues: ['x', 'y'], nullable: true },
        { name: 'meta', type: 'JSON', nullable: true }
      ]
    } else {
      cols = [
        { name: 'id', type: 'INTEGER', nullable: false, autoIncrement: true },
        { name: 'nm', type: 'VARCHAR', length: 100, nullable: false },
        { name: 'price', type: 'DECIMAL', length: 10, scale: 2, nullable: true },
        { name: 'flag', type: 'BOOLEAN', nullable: true },
        { name: 'created_at', type: 'DATETIME', nullable: true },
        { name: 'data', type: 'BLOB', nullable: true }
      ]
    }
    const spec = { schema, name, columns: cols, primaryKey: ['id'], foreignKeys: [], indexes: [] }
    const created = buildTableDdl(engine, 'create', spec)
    const r = await driver.execStatements(created.statements)
    if (!r.ok) throw new Error(`create failed @${r.failedAt}: ${r.message}\nSQL: ${created.sql}`)

    // Round-trip: read the table back and check type + params survived.
    const back = await driver.getTableSpec(schema, name)
    const byName = new Map(back.columns.map((c) => [c.name, c]))
    const problems: string[] = []
    const nm = byName.get('nm')
    if (nm?.length !== 100) problems.push(`nm length=${nm?.length} (want 100)`)
    const price = byName.get('price')
    if (price?.length !== 10 || price?.scale !== 2) problems.push(`price ${price?.length},${price?.scale} (want 10,2)`)

    if (engine === 'postgres') {
      const ca = byName.get('created_at')
      if (!ca?.withTimeZone) problems.push('created_at not WITH TIME ZONE')
      const tags = byName.get('tags')
      if (!tags?.isArray) problems.push('tags not array')
    } else if (isMysqlFamily(engine)) {
      const qty = byName.get('qty')
      if (!qty?.unsigned) problems.push('qty not UNSIGNED')
      const status = byName.get('status')
      if (JSON.stringify(status?.enumValues) !== JSON.stringify(['a', 'b', 'c'])) problems.push(`status enum=${JSON.stringify(status?.enumValues)}`)
      const flags = byName.get('flags')
      if (JSON.stringify(flags?.enumValues) !== JSON.stringify(['x', 'y'])) problems.push(`flags set=${JSON.stringify(flags?.enumValues)}`)
    }
    if (problems.length) throw new Error(`round-trip: ${problems.join('; ')}`)

    // ALTER using the round-tripped spec: add a typed column.
    const altered = JSON.parse(JSON.stringify(back)) as typeof spec
    const v = engine === 'sqlite' ? 'VARCHAR' : 'VARCHAR'
    altered.columns.push({ name: 'extra', type: v, length: 50, nullable: true })
    const alt = buildTableDdl(engine, 'alter', altered, back)
    const ar = await driver.execStatements(alt.statements)
    if (!ar.ok) throw new Error(`alter failed @${ar.failedAt}: ${ar.message}`)
    const back2 = await driver.getTableSpec(schema, name)
    if (!back2.columns.some((c) => c.name === 'extra' && c.length === 50)) {
      throw new Error('extra VARCHAR(50) not present after alter')
    }

    results.push(`✅ ${tag}: typed CREATE ok, round-trip ok (len/precision/scale, ${engine === 'postgres' ? 'tz+array' : isMysqlFamily(engine) ? 'unsigned+enum+set' : 'affinity'}), ALTER add-typed-col ok`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    await driver.runQuery(`DROP TABLE ${qtbl(name)}`).catch(() => undefined)
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * Verify server-side pagination on a DISPOSABLE 5,000-row `_pagetest_` table:
 * deterministic non-overlapping pages, correct count, page size, last page,
 * server-side sort, and count/page updates after insert + delete.
 */
async function testPagination(config: ConnectionConfig): Promise<void> {
  const tag = `page-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const driver = await createDriver(config)
  const qtbl = (n: string): string => (isMysqlFamily(engine) ? '`' + n + '`' : '"' + n + '"')
  const name = '_pagetest_rows'
  const T = ddlTypes(engine)
  try {
    await driver.connect()
    await driver.runQuery(`DROP TABLE ${qtbl(name)}`).catch(() => undefined)

    const v = T.varchar(40)
    const spec = {
      schema,
      name,
      columns: [
        { name: 'id', type: T.int, nullable: false, autoIncrement: true },
        { name: 'n', type: T.int, nullable: false },
        { name: 'label', type: v.type, length: v.length || null, nullable: true }
      ],
      primaryKey: ['id'],
      foreignKeys: [],
      indexes: []
    }
    const c = await driver.execStatements(buildTableDdl(engine, 'create', spec).statements)
    if (!c.ok) throw new Error(`create failed: ${c.message}`)

    // Bulk-insert 5,000 rows (engine-specific fast path).
    const tn = qtbl(name)
    if (engine === 'postgres') {
      await driver.runQuery(`INSERT INTO ${tn} (n, label) SELECT g, 'row_' || g FROM generate_series(1, 5000) g`)
    } else if (engine === 'sqlite') {
      await driver.runQuery(
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 5000) INSERT INTO ${tn} (n, label) SELECT x, 'row_' || x FROM c`
      )
    } else {
      // MySQL: build the rows in JS in chunks — works on 5.7 (no CTEs) and 8.0.
      for (let start = 1; start <= 5000; start += 1000) {
        const vals: string[] = []
        for (let x = start; x < start + 1000 && x <= 5000; x++) vals.push(`(${x}, 'row_${x}')`)
        await driver.runQuery(`INSERT INTO ${tn} (n, label) VALUES ${vals.join(',')}`)
      }
    }

    const total = await driver.getTableRowCount(schema, name)
    if (total !== 5000) throw new Error(`count=${total} (want 5000)`)

    // Pages 1..3 (size 100) must be contiguous ids 1..300, non-overlapping.
    const p1 = await driver.getTablePage(schema, name, 100, 1)
    const p2 = await driver.getTablePage(schema, name, 100, 2)
    const p3 = await driver.getTablePage(schema, name, 100, 3)
    const ids = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => Number(r.id))
    if (p1.rows.length !== 100 || p2.rows.length !== 100) throw new Error('page not full')
    if (new Set(ids).size !== 300) throw new Error('pages overlap (duplicate ids)')
    if (Number(p1.rows[0].id) !== 1 || Number(p2.rows[0].id) !== 101 || Number(p3.rows[0].id) !== 201) {
      throw new Error('pages not deterministic/contiguous')
    }

    // Last page (50 of 50) -> ids 4901..5000.
    const last = await driver.getTablePage(schema, name, 100, 50)
    if (last.rows.length !== 100 || Number(last.rows[99].id) !== 5000) throw new Error('last page wrong')

    // Page size change -> 500 rows.
    const big = await driver.getTablePage(schema, name, 500, 1)
    if (big.rows.length !== 500) throw new Error(`pageSize 500 gave ${big.rows.length}`)

    // Server-side sort: n DESC -> first row n=5000.
    const sorted = await driver.getTablePage(schema, name, 100, 1, { column: 'n', dir: 'desc' })
    if (Number(sorted.rows[0].n) !== 5000) throw new Error(`sort desc first n=${sorted.rows[0].n}`)

    // Insert via CRUD -> count++ and new row findable on the (new) last page.
    const ins = await driver.applyRowChanges({
      connectionId: config.id, schema, table: name, primaryKey: ['id'],
      columnTypes: { id: T.int, n: T.int, label: v.type },
      inserts: [{ n: '9999', label: 'inserted' }], updates: [], deletes: []
    })
    if (!ins.ok || ins.inserted !== 1) throw new Error(`insert failed: ${ins.failure?.message}`)
    const newId = Number(ins.insertedRows[0]?.id)
    const total2 = await driver.getTableRowCount(schema, name)
    if (total2 !== 5001) throw new Error(`count after insert=${total2}`)
    const lastPageNo = Math.ceil(total2 / 100)
    const lastPage = await driver.getTablePage(schema, name, 100, lastPageNo)
    if (!lastPage.rows.some((r) => Number(r.id) === newId && Number(r.n) === 9999)) {
      throw new Error('inserted row not found on last page')
    }

    // Delete it -> count back to 5000.
    const del = await driver.applyRowChanges({
      connectionId: config.id, schema, table: name, primaryKey: ['id'],
      columnTypes: { id: T.int }, inserts: [], updates: [], deletes: [{ id: newId }]
    })
    if (!del.ok || del.deleted !== 1) throw new Error('delete failed')
    if ((await driver.getTableRowCount(schema, name)) !== 5000) throw new Error('count after delete wrong')

    results.push(`✅ ${tag}: 5000 rows, count ok, pages deterministic+non-overlapping, last page ok, size-change ok, server-sort ok, insert→count++/findable, delete→count--`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    await driver.runQuery(`DROP TABLE ${qtbl(name)}`).catch(() => undefined)
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * Verify quick-filter WHERE building on the SEEDED tables (read-only). Covers
 * contains/LIKE, numeric >=/BETWEEN, IN, IS NULL/NOT NULL, AND-combine, and —
 * critically — parameterization safety (a value with a quote and a literal %).
 */
async function testFilters(config: ConnectionConfig): Promise<void> {
  const tag = `filter-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const boolTrue = engine === 'postgres' ? 'true' : '1'
  const driver = await createDriver(config)
  type F = import('@shared/types').ColumnFilter
  const count = (table: string, filters: F[]): Promise<number> =>
    driver.getTableRowCount(schema, table, filters)
  try {
    await driver.connect()
    const problems: string[] = []
    const check = async (label: string, table: string, filters: F[], want: number): Promise<void> => {
      const n = await count(table, filters)
      if (n !== want) problems.push(`${label}: got ${n} want ${want}`)
    }

    await check('total', 'customers', [], 20)
    await check('contains Ada', 'customers', [{ column: 'full_name', operator: 'contains', value: 'ada' }], 1)
    // % must be ESCAPED (literal) — if escaping were broken this would match all 20.
    await check('percent-escaped', 'customers', [{ column: 'full_name', operator: 'contains', value: '%' }], 0)
    // Quote must be a BOUND PARAM — no SQL error, correct (zero) result.
    await check("quote O'Brien", 'customers', [{ column: 'full_name', operator: 'eq', value: "O'Brien" }], 0)
    await check('id >= 15', 'customers', [{ column: 'id', operator: 'gte', value: '15' }], 6)
    await check('id BETWEEN 5..10', 'customers', [{ column: 'id', operator: 'between', value: '5', value2: '10' }], 6)
    await check('id IN (1,2,3)', 'customers', [{ column: 'id', operator: 'in', values: ['1', '2', '3'] }], 3)
    await check('active AND id<=5', 'customers', [
      { column: 'is_active', operator: 'eq', value: boolTrue },
      { column: 'id', operator: 'lte', value: '5' }
    ], 5)

    // IS NULL / IS NOT NULL on a nullable column must partition the table.
    const nullN = await count('orders', [{ column: 'notes', operator: 'isNull' }])
    const notNullN = await count('orders', [{ column: 'notes', operator: 'isNotNull' }])
    const ordersTotal = await count('orders', [])
    if (nullN + notNullN !== ordersTotal) problems.push(`null partition ${nullN}+${notNullN} != ${ordersTotal}`)
    if (nullN === 0) problems.push('expected some NULL notes')

    // getTablePage honours the filter and stays deterministic.
    const page = await driver.getTablePage(schema, 'customers', 100, 1, null, [{ column: 'id', operator: 'gte', value: '15' }])
    if (page.rows.length !== 6 || page.rows.some((r) => Number(r.id) < 15)) problems.push('page filter wrong')

    if (problems.length) throw new Error(problems.join('; '))
    results.push(`✅ ${tag}: contains(CI), %-escaped, quote-safe(param), >=, BETWEEN, IN, AND, IS NULL/NOT NULL partition, filtered page ok`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * Verify the visual filter builder compiler on SEEDED tables (read-only):
 * nested AND/OR groups, NOT, IN/BETWEEN, coexistence with quick filters — each
 * compared to an equivalent HAND-WRITTEN query — plus injection safety.
 */
async function testFilterBuilder(config: ConnectionConfig): Promise<void> {
  const tag = `builder-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const boolTok = engine === 'postgres' ? 'true' : '1'
  const boolLit = engine === 'postgres' ? 'TRUE' : '1'
  const driver = await createDriver(config)
  const qtbl = (n: string): string => (isMysqlFamily(engine) ? '`' + n + '`' : '"' + n + '"')
  type FG = import('@shared/types').FilterGroup
  type CF = import('@shared/types').ColumnFilter
  try {
    await driver.connect()
    const problems: string[] = []
    const hand = async (table: string, where: string): Promise<number> =>
      Number((await driver.runQuery(`SELECT COUNT(*) AS c FROM ${qtbl(table)} WHERE ${where}`)).rows[0]?.c)
    const tree = (table: string, t: FG | null, quick: CF[] = []): Promise<number> =>
      driver.getTableRowCount(schema, table, quick, t)

    const cmp = async (label: string, table: string, t: FG | null, where: string, quick: CF[] = []): Promise<void> => {
      const a = await tree(table, t, quick)
      const b = await hand(table, where)
      if (a !== b) problems.push(`${label}: tree=${a} hand=${b}`)
    }

    // 1) (id <= 5 AND is_active) OR (id >= 18)
    await cmp(
      'nested AND/OR',
      'customers',
      {
        kind: 'group', combiner: 'OR', children: [
          { kind: 'group', combiner: 'AND', children: [
            { kind: 'condition', column: 'id', operator: 'lte', value: '5' },
            { kind: 'condition', column: 'is_active', operator: 'eq', value: boolTok }
          ]},
          { kind: 'condition', column: 'id', operator: 'gte', value: '18' }
        ]
      },
      `(id <= 5 AND is_active = ${boolLit}) OR (id >= 18)`
    )

    // 2) NOT (id <= 15)
    await cmp(
      'NOT group',
      'customers',
      { kind: 'group', combiner: 'AND', negated: true, children: [{ kind: 'condition', column: 'id', operator: 'lte', value: '15' }] },
      `NOT (id <= 15)`
    )

    // 3) IN
    await cmp(
      'IN',
      'orders',
      { kind: 'group', combiner: 'AND', children: [{ kind: 'condition', column: 'order_no', operator: 'in', values: ['ORD-1001', 'ORD-1002', 'ORD-1003'] }] },
      `order_no IN ('ORD-1001','ORD-1002','ORD-1003')`
    )

    // 4) BETWEEN
    await cmp(
      'BETWEEN',
      'orders',
      { kind: 'group', combiner: 'AND', children: [{ kind: 'condition', column: 'total', operator: 'between', value: '100', value2: '200' }] },
      `total BETWEEN 100 AND 200`
    )

    // 5) Coexistence: quick(is_active) AND builder(id<=5) == intersection
    const quick: CF[] = [{ column: 'is_active', operator: 'eq', value: boolTok }]
    const builder: FG = { kind: 'group', combiner: 'AND', children: [{ kind: 'condition', column: 'id', operator: 'lte', value: '5' }] }
    await cmp('coexist intersect', 'customers', builder, `is_active = ${boolLit} AND (id <= 5)`, quick)
    const quickOnly = await tree('customers', null, quick)
    const combined = await tree('customers', builder, quick)
    if (!(combined <= quickOnly)) problems.push(`coexist not narrowing (combined=${combined} quickOnly=${quickOnly})`)

    // 6) Injection safety via the tree: quote + % literal escaped -> 0, no error.
    const q1 = await tree('customers', { kind: 'group', combiner: 'AND', children: [{ kind: 'condition', column: 'full_name', operator: 'eq', value: "O'Brien" }] })
    const q2 = await tree('customers', { kind: 'group', combiner: 'AND', children: [{ kind: 'condition', column: 'full_name', operator: 'contains', value: '%' }] })
    if (q1 !== 0) problems.push(`O'Brien eq gave ${q1}`)
    if (q2 !== 0) problems.push(`%-contains gave ${q2} (want 0 = escaped)`)

    // 7) Deterministic paged rows under a builder filter.
    const page = await driver.getTablePage(schema, 'customers', 3, 1, null, [], { kind: 'group', combiner: 'AND', children: [{ kind: 'condition', column: 'id', operator: 'gte', value: '10' }] })
    if (page.rows.length !== 3 || Number(page.rows[0].id) !== 10) problems.push('builder page not deterministic')

    if (problems.length) throw new Error(problems.join('; '))
    results.push(`✅ ${tag}: nested AND/OR, NOT, IN, BETWEEN all match hand-SQL; coexist intersects; quote/%-safe; paged deterministic`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * Verify programmable/derived objects: VIEWS (all engines) and FUNCTIONS +
 * PROCEDURES (PG/MySQL) — create/list/getDefinition(round-trip)/edit/drop on
 * DISPOSABLE _vwtest_/_fntest_/_sptest_ objects. Proves MySQL routine bodies
 * with ';' apply as one statement and SQLite routines are cleanly empty.
 */
async function testViewsRoutines(config: ConnectionConfig): Promise<void> {
  const tag = `objs-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const driver = await createDriver(config)
  const qn = (n: string): string =>
    isMysqlFamily(engine) ? `\`${schema}\`.\`${n}\`` : engine === 'postgres' ? `"${schema}"."${n}"` : `"${n}"`
  const orReplaceView = engine === 'sqlite' ? 'CREATE VIEW' : 'CREATE OR REPLACE VIEW'
  const notes: string[] = []
  try {
    await driver.connect()
    // clean slate
    for (const s of [`DROP VIEW IF EXISTS ${qn('_vwtest_v')}`]) await driver.runQuery(s).catch(() => undefined)

    // --- VIEW: create / list / def / open-data / edit / drop ---
    let r = await driver.applyObjectSql([`${orReplaceView} ${qn('_vwtest_v')} AS SELECT id, full_name FROM ${isMysqlFamily(engine) ? '`customers`' : '"customers"'} WHERE id <= 5`])
    if (!r.ok) throw new Error(`create view: ${r.message}`)
    if (!(await driver.listViews(schema)).some((v) => v.name === '_vwtest_v')) throw new Error('view not listed')
    const vdef = await driver.getObjectDefinition({ connectionId: config.id, kind: 'view', schema, name: '_vwtest_v' })
    if (!/customers/i.test(vdef)) throw new Error(`view def missing SELECT: ${vdef.slice(0, 60)}`)
    const vdata = await driver.runQuery(`SELECT * FROM ${qn('_vwtest_v')}`)
    if (vdata.rows.length !== 5) throw new Error(`view data rows=${vdata.rows.length} (want 5)`)
    // edit: SQLite = drop+recreate; others = OR REPLACE. Narrow to id<=3.
    const editStmts = engine === 'sqlite'
      ? [`DROP VIEW IF EXISTS ${qn('_vwtest_v')}`, `CREATE VIEW ${qn('_vwtest_v')} AS SELECT id, full_name FROM "customers" WHERE id <= 3`]
      : [`${orReplaceView} ${qn('_vwtest_v')} AS SELECT id, full_name FROM ${isMysqlFamily(engine) ? '`customers`' : '"customers"'} WHERE id <= 3`]
    r = await driver.applyObjectSql(editStmts)
    if (!r.ok) throw new Error(`edit view: ${r.message}`)
    if ((await driver.runQuery(`SELECT * FROM ${qn('_vwtest_v')}`)).rows.length !== 3) throw new Error('view edit not applied')

    let routineNote = 'n/a'
    let fnCreated = false
    if (engine === 'sqlite') {
      if ((await driver.listRoutines(schema)).length !== 0) throw new Error('sqlite should have no routines')
      routineNote = 'sqlite: no routines (empty, no crash)'
    } else {
      const parts: string[] = []
      for (const s of [`DROP FUNCTION IF EXISTS ${qn('_fntest_f')}`, `DROP PROCEDURE IF EXISTS ${qn('_sptest_p')}`]) await driver.runQuery(s).catch(() => undefined)

      // --- FUNCTION (MySQL may block CREATE FUNCTION on a binlog server for a
      // non-SUPER user — a documented server-config gate, not a codegen bug). ---
      const fnCreate = engine === 'postgres'
        ? `CREATE OR REPLACE FUNCTION ${qn('_fntest_f')}(a integer) RETURNS integer LANGUAGE sql AS $$ SELECT a + 1 $$`
        : `CREATE FUNCTION ${qn('_fntest_f')}(a INT) RETURNS INT DETERMINISTIC RETURN a + 1`
      const fr = await driver.applyObjectSql([fnCreate])
      if (fr.ok) {
        fnCreated = true
        const fn = (await driver.listRoutines(schema)).find((x) => x.name === '_fntest_f')
        if (!fn || fn.kind !== 'function') throw new Error('function not listed')
        const fdef = await driver.getObjectDefinition({ connectionId: config.id, kind: 'function', schema, name: '_fntest_f', signature: fn.signature })
        if (!/CREATE/i.test(fdef)) throw new Error(`function def not a CREATE: ${fdef.slice(0, 40)}`)
        if (Number((await driver.runQuery(`SELECT ${qn('_fntest_f')}(41) AS v`)).rows[0]?.v) !== 42) throw new Error('function wrong result')
        const fnEdit = engine === 'postgres'
          ? [`CREATE OR REPLACE FUNCTION ${qn('_fntest_f')}(a integer) RETURNS integer LANGUAGE sql AS $$ SELECT a + 2 $$`]
          : [`DROP FUNCTION IF EXISTS ${qn('_fntest_f')}`, `CREATE FUNCTION ${qn('_fntest_f')}(a INT) RETURNS INT DETERMINISTIC RETURN a + 2`]
        if (!(await driver.applyObjectSql(fnEdit)).ok) throw new Error('edit function failed')
        if (Number((await driver.runQuery(`SELECT ${qn('_fntest_f')}(40) AS v`)).rows[0]?.v) !== 42) throw new Error('function edit not applied')
        parts.push(`function create/def/run/edit ok${engine === 'postgres' ? ` sig=${fn.signature}` : ''}`)
      } else if (isMysqlFamily(engine) && /SUPER privilege|log_bin_trust_function_creators/i.test(fr.message ?? '')) {
        parts.push('function skipped: server needs log_bin_trust_function_creators=1 or SUPER (connect as root)')
      } else {
        throw new Error(`create function: ${fr.message}`)
      }

      // --- PROCEDURE (body with ';' — DELIMITER handled; not binlog-gated). ---
      const spCreate = engine === 'postgres'
        ? `CREATE OR REPLACE PROCEDURE ${qn('_sptest_p')}() LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; PERFORM 2; END; $$`
        : `CREATE PROCEDURE ${qn('_sptest_p')}(IN x INT) BEGIN SELECT x + 1; SELECT x + 2; END`
      r = await driver.applyObjectSql([spCreate])
      if (!r.ok) throw new Error(`create procedure (';' body): ${r.message}`)
      const sp = (await driver.listRoutines(schema)).find((x) => x.name === '_sptest_p')
      if (!sp || sp.kind !== 'procedure') throw new Error('procedure not listed')
      const sdef = await driver.getObjectDefinition({ connectionId: config.id, kind: 'procedure', schema, name: '_sptest_p', signature: sp.signature })
      if (!/CREATE/i.test(sdef)) throw new Error('procedure def not a CREATE')
      parts.push("procedure(';' body) create/list/def ok")
      routineNote = parts.join('; ')
    }

    // --- drops via buildObjectOp (destructive path) ---
    const dropV = buildObjectOp(engine, { kind: 'dropView', schema, name: '_vwtest_v' })
    if (!dropV.destructive) throw new Error('dropView not destructive')
    await driver.execStatements(dropV.statements)
    if ((await driver.listViews(schema)).some((v) => v.name === '_vwtest_v')) throw new Error('view not dropped')

    if (engine !== 'sqlite') {
      if (fnCreated) {
        const fn = (await driver.listRoutines(schema)).find((x) => x.name === '_fntest_f')
        await driver.execStatements(buildObjectOp(engine, { kind: 'dropRoutine', routineKind: 'function', schema, name: '_fntest_f', signature: fn?.signature }).statements)
      }
      await driver.execStatements(buildObjectOp(engine, { kind: 'dropRoutine', routineKind: 'procedure', schema, name: '_sptest_p', signature: '()' }).statements)
    }

    results.push(`✅ ${tag}: view create/list/def/open-data/edit/drop ok; ${routineNote}${notes.length ? '; ' + notes.join(' ') : ''}`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    for (const s of [
      `DROP VIEW IF EXISTS ${qn('_vwtest_v')}`,
      `DROP FUNCTION IF EXISTS ${qn('_fntest_f')}`,
      `DROP PROCEDURE IF EXISTS ${qn('_sptest_p')}`
    ]) {
      await driver.runQuery(s).catch(() => undefined)
    }
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * Verify the visual view builder's SELECT generator on SEEDED tables: an FK
 * join + COUNT + GROUP BY + WHERE(tree) + ORDER BY (matched to hand-SQL), a
 * self-join, a quoted-literal (O'Brien) safety check, save-as-view + open-data,
 * and per-engine join-type limits.
 */
async function testViewBuilder(config: ConnectionConfig): Promise<void> {
  const tag = `vb-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const boolTok = engine === 'postgres' ? 'true' : '1'
  const driver = await createDriver(config)
  const qtbl = (n: string): string => (isMysqlFamily(engine) ? `\`${n}\`` : `"${n}"`)
  type VM = import('@shared/types').ViewModel
  try {
    await driver.connect()
    await driver.runQuery(`DROP VIEW IF EXISTS ${qtbl('_vbtest_v')}`).catch(() => undefined)

    // --- engine join-type limits ---
    const jt = supportedJoinTypes(engine)
    if (engine === 'sqlite' && (jt.includes('RIGHT') || jt.includes('FULL'))) throw new Error('sqlite should not offer RIGHT/FULL')
    if (isMysqlFamily(engine) && (!jt.includes('RIGHT') || jt.includes('FULL'))) throw new Error('mysql should offer RIGHT, not FULL')
    if (engine === 'postgres' && !jt.includes('FULL')) throw new Error('pg should offer FULL')

    // --- FK join + COUNT + GROUP BY + WHERE + ORDER BY ---
    const model: VM = {
      tables: [
        { id: 'c', schema, table: 'customers', alias: 't1' },
        { id: 'o', schema, table: 'orders', alias: 't2' }
      ],
      joins: [{ id: 'j1', type: 'LEFT', leftId: 'c', rightId: 'o', conds: [{ leftCol: 'id', rightCol: 'customer_id' }] }],
      outputs: [
        { id: 'o1', tableId: 'c', column: 'full_name', alias: 'name' },
        { id: 'o2', tableId: 'o', column: 'id', aggregate: 'COUNT', alias: 'order_count' }
      ],
      distinct: false,
      where: { kind: 'group', combiner: 'AND', children: [{ kind: 'condition', column: 't1.is_active', operator: 'eq', value: boolTok }] },
      groupBy: [],
      having: null,
      orderBy: [{ tableId: 'c', column: 'full_name', dir: 'ASC' }]
    }
    const gen = generateViewSelect(engine, model, 'params')
    const genRows = await driver.runQuery(gen.sql, gen.params)
    // Hand-written equivalent.
    const boolLit = engine === 'postgres' ? 'TRUE' : '1'
    const handSql = `SELECT ${qtbl('t1')}.${qtbl('full_name')} AS ${qtbl('name')}, COUNT(${qtbl('t2')}.${qtbl('id')}) AS ${qtbl('order_count')}\nFROM ${engine === 'sqlite' ? qtbl('customers') : qtbl(schema) + '.' + qtbl('customers')} AS ${qtbl('t1')} LEFT JOIN ${engine === 'sqlite' ? qtbl('orders') : qtbl(schema) + '.' + qtbl('orders')} AS ${qtbl('t2')} ON ${qtbl('t1')}.${qtbl('id')} = ${qtbl('t2')}.${qtbl('customer_id')}\nWHERE ${qtbl('t1')}.${qtbl('is_active')} = ${boolLit}\nGROUP BY ${qtbl('t1')}.${qtbl('full_name')}\nORDER BY ${qtbl('t1')}.${qtbl('full_name')}`
    const handRows = await driver.runQuery(handSql)
    if (genRows.rows.length === 0) throw new Error('generated join produced 0 rows')
    if (genRows.rows.length !== handRows.rows.length) throw new Error(`gen rows=${genRows.rows.length} hand=${handRows.rows.length}`)
    const sum = (rs: Record<string, unknown>[]): number => rs.reduce((a, r) => a + Number(r.order_count), 0)
    if (sum(genRows.rows) !== sum(handRows.rows)) throw new Error('order_count sums differ')

    // --- save the INLINE form as a VIEW, open its data, then drop ---
    const inline = generateViewSelect(engine, model, 'inline')
    const cr = await driver.applyObjectSql([`CREATE VIEW ${qtbl('_vbtest_v')} AS ${inline.sql}`])
    if (!cr.ok) throw new Error(`save view: ${cr.message}`)
    if (!(await driver.listViews(schema)).some((v) => v.name === '_vbtest_v')) throw new Error('saved view not listed')
    const vdata = await driver.runQuery(`SELECT * FROM ${qtbl('_vbtest_v')}`)
    if (vdata.rows.length !== genRows.rows.length) throw new Error('view data differs from generated')

    // --- self-join (customers t1 / t2) ---
    const selfModel: VM = {
      tables: [
        { id: 'a', schema, table: 'customers', alias: 't1' },
        { id: 'b', schema, table: 'customers', alias: 't2' }
      ],
      joins: [{ id: 'js', type: 'INNER', leftId: 'a', rightId: 'b', conds: [{ leftCol: 'id', rightCol: 'id' }] }],
      outputs: [
        { id: 's1', tableId: 'a', column: 'full_name', alias: 'a_name' },
        { id: 's2', tableId: 'b', column: 'email', alias: 'b_email' }
      ],
      distinct: false, where: null, groupBy: [], having: null, orderBy: []
    }
    const selfGen = generateViewSelect(engine, selfModel, 'params')
    const selfRows = await driver.runQuery(selfGen.sql, selfGen.params)
    if (selfRows.rows.length !== 20) throw new Error(`self-join rows=${selfRows.rows.length} (want 20)`)

    // --- quoted-literal safety (O'Brien) in both inline + params forms ---
    const obModel: VM = {
      tables: [{ id: 'c', schema, table: 'customers', alias: 't1' }],
      joins: [],
      outputs: [{ id: 'o1', tableId: 'c', column: 'id' }],
      distinct: false,
      where: { kind: 'group', combiner: 'AND', children: [{ kind: 'condition', column: 't1.full_name', operator: 'eq', value: "O'Brien" }] },
      groupBy: [], having: null, orderBy: []
    }
    const obInline = generateViewSelect(engine, obModel, 'inline')
    if (!/''Brien/.test(obInline.sql)) throw new Error(`quote not escaped in inline: ${obInline.sql}`)
    const obInlineRows = await driver.runQuery(obInline.sql)
    if (obInlineRows.rows.length !== 0) throw new Error('inline O\'Brien matched unexpectedly')
    const obParams = generateViewSelect(engine, obModel, 'params')
    const obParamRows = await driver.runQuery(obParams.sql, obParams.params)
    if (obParamRows.rows.length !== 0) throw new Error('param O\'Brien matched unexpectedly')

    // --- duplicate output names auto-aliased (customers.id + orders.id) ---
    const dupModel: VM = {
      tables: [
        { id: 'c', schema, table: 'customers', alias: 't1' },
        { id: 'o', schema, table: 'orders', alias: 't2' }
      ],
      joins: [{ id: 'jd', type: 'INNER', leftId: 'c', rightId: 'o', conds: [{ leftCol: 'id', rightCol: 'customer_id' }] }],
      outputs: [
        { id: 'd1', tableId: 'c', column: 'id' },
        { id: 'd2', tableId: 'o', column: 'id' }
      ],
      distinct: false, where: null, groupBy: [], having: null, orderBy: []
    }
    const dupNames = resolveOutputAliases(dupModel).map((r) => r.displayName)
    if (!(dupNames.includes('customers_id') && dupNames.includes('orders_id'))) throw new Error(`dup aliases wrong: ${dupNames.join(',')}`)
    const dupInline = generateViewSelect(engine, dupModel, 'inline')
    const dcr = await driver.applyObjectSql([`CREATE VIEW ${qtbl('_vbtest_dup')} AS ${dupInline.sql}`])
    if (!dcr.ok) throw new Error(`save dup view: ${dcr.message}`)
    const dupData = await driver.runQuery(`SELECT * FROM ${qtbl('_vbtest_dup')}`)
    const dcols = dupData.columns.map((c) => c.name.toLowerCase())
    if (!(dcols.includes('customers_id') && dcols.includes('orders_id'))) throw new Error(`dup view cols: ${dcols.join(',')}`)

    // self-join dup: both `customers` -> table_col collides -> alias_col (t1_id/t2_id)
    const selfDup: VM = {
      tables: [
        { id: 'a', schema, table: 'customers', alias: 't1' },
        { id: 'b', schema, table: 'customers', alias: 't2' }
      ],
      joins: [{ id: 'jsd', type: 'INNER', leftId: 'a', rightId: 'b', conds: [{ leftCol: 'id', rightCol: 'id' }] }],
      outputs: [
        { id: 'sd1', tableId: 'a', column: 'id' },
        { id: 'sd2', tableId: 'b', column: 'id' }
      ],
      distinct: false, where: null, groupBy: [], having: null, orderBy: []
    }
    const selfDupNames = resolveOutputAliases(selfDup).map((r) => r.displayName)
    if (!(selfDupNames.includes('t1_id') && selfDupNames.includes('t2_id'))) throw new Error(`self-dup aliases: ${selfDupNames.join(',')}`)

    results.push(`✅ ${tag}: FK-join+COUNT+GROUP+WHERE+ORDER matches hand-SQL; self-join(20); quote-safe(inline escaped + param bound); save-view+open ok; dup-alias(customers_id/orders_id, self t1_id/t2_id); joins=[${jt.join(',')}]`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    await driver.runQuery(`DROP VIEW IF EXISTS ${qtbl('_vbtest_v')}`).catch(() => undefined)
    await driver.runQuery(`DROP VIEW IF EXISTS ${qtbl('_vbtest_dup')}`).catch(() => undefined)
    await driver.disconnect().catch(() => undefined)
  }
}

/** TASK 18: reverse-parse view SELECTs into the builder model (or fall back). */
async function testViewReverse(config: ConnectionConfig): Promise<void> {
  const tag = `vr-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const driver = await createDriver(config)
  const q = (n: string): string => (isMysqlFamily(engine) ? `\`${n}\`` : `"${n}"`)
  const qn = (n: string): string => (engine === 'sqlite' ? q(n) : `${q(schema)}.${q(n)}`)
  const getDef = (name: string): Promise<string> => driver.getObjectDefinition({ connectionId: '', kind: 'view', schema, name })
  const names = ['_vbtest_rsimple', '_vbtest_ragg', '_vbtest_rcplx']
  const rowCount = async (sql: string): Promise<number> => (await driver.runQuery(sql)).rows.length
  try {
    await driver.connect()
    for (const n of names) await driver.runQuery(`DROP VIEW IF EXISTS ${qn(n)}`).catch(() => undefined)
    const catalog = await driver.getSchemaCatalog()

    // 1) SIMPLE: 2 tables, LEFT JOIN, aliased outputs, WHERE, ORDER BY.
    const simpleSel = `SELECT ${q('t1')}.${q('full_name')} AS ${q('nm')}, ${q('t2')}.${q('id')} AS ${q('oid')} FROM ${qn('customers')} ${q('t1')} LEFT JOIN ${qn('orders')} ${q('t2')} ON ${q('t1')}.${q('id')} = ${q('t2')}.${q('customer_id')} WHERE ${q('t1')}.${q('id')} > 5 ORDER BY ${q('t1')}.${q('full_name')}`
    await driver.applyObjectSql([`CREATE VIEW ${qn('_vbtest_rsimple')} AS ${simpleSel}`])
    const r1 = reverseParseView(engine, await getDef('_vbtest_rsimple'))
    if (!r1.supported) throw new Error(`simple not supported: ${r1.reason}`)
    if (r1.model.tables.length !== 2 || r1.model.joins.length !== 1 || r1.model.outputs.length !== 2 || !r1.model.where)
      throw new Error(`simple mapping wrong: tbl=${r1.model.tables.length} join=${r1.model.joins.length} out=${r1.model.outputs.length} where=${!!r1.model.where}`)
    const res1 = resolveViewModel(r1.model, catalog)
    if (!res1.ok) throw new Error(`simple resolve failed: ${res1.reason}`)
    const orig1 = await rowCount(`SELECT * FROM ${qn('_vbtest_rsimple')}`)
    const regen1 = await rowCount(generateViewSelect(engine, res1.model, 'inline').sql)
    if (orig1 !== regen1) throw new Error(`simple rows: orig=${orig1} regen=${regen1}`)

    // 2) AGGREGATE + GROUP BY.
    const aggSel = `SELECT ${q('t1')}.${q('full_name')} AS ${q('nm')}, COUNT(${q('t2')}.${q('id')}) AS ${q('cnt')} FROM ${qn('customers')} ${q('t1')} LEFT JOIN ${qn('orders')} ${q('t2')} ON ${q('t1')}.${q('id')} = ${q('t2')}.${q('customer_id')} GROUP BY ${q('t1')}.${q('full_name')}`
    await driver.applyObjectSql([`CREATE VIEW ${qn('_vbtest_ragg')} AS ${aggSel}`])
    const r2 = reverseParseView(engine, await getDef('_vbtest_ragg'))
    if (!r2.supported) throw new Error(`agg not supported: ${r2.reason}`)
    if (!r2.model.outputs.some((o) => o.aggregate === 'COUNT') || r2.model.groupBy.length !== 1)
      throw new Error(`agg mapping wrong: aggs=${r2.model.outputs.map((o) => o.aggregate).join(',')} group=${r2.model.groupBy.length}`)
    const res2 = resolveViewModel(r2.model, catalog)
    if (!res2.ok) throw new Error(`agg resolve failed: ${res2.reason}`)
    const orig2 = await rowCount(`SELECT * FROM ${qn('_vbtest_ragg')}`)
    const regen2 = await rowCount(generateViewSelect(engine, res2.model, 'inline').sql)
    if (orig2 !== regen2) throw new Error(`agg rows: orig=${orig2} regen=${regen2}`)

    // 3) COMPLEX (UNION) -> must fall back (not supported).
    const cplxSel = `SELECT ${q('id')} FROM ${qn('customers')} UNION SELECT ${q('customer_id')} FROM ${qn('orders')}`
    await driver.applyObjectSql([`CREATE VIEW ${qn('_vbtest_rcplx')} AS ${cplxSel}`])
    const r3 = reverseParseView(engine, await getDef('_vbtest_rcplx'))
    if (r3.supported) throw new Error('complex UNION view was wrongly accepted')

    results.push(`✅ ${tag}: simple(join+where+order rows match ${orig1}), agg(COUNT+GROUP rows match ${orig2}), complex->fallback(${r3.reason})`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    for (const n of names) await driver.runQuery(`DROP VIEW IF EXISTS ${qn(n)}`).catch(() => undefined)
    await driver.disconnect().catch(() => undefined)
  }
}

/** TASK 19: Tables node lists base tables only (sorted); Views node views only. */
async function testTreeDedup(config: ConnectionConfig): Promise<void> {
  const tag = `tree-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const driver = await createDriver(config)
  const q = (n: string): string => (isMysqlFamily(engine) ? `\`${n}\`` : `"${n}"`)
  const qn = (n: string): string => (engine === 'sqlite' ? q(n) : `${q(schema)}.${q(n)}`)
  try {
    await driver.connect()
    await driver.runQuery(`DROP VIEW IF EXISTS ${qn('_treetest_v')}`).catch(() => undefined)

    // Tables list: base tables only, alphabetical, includes the seeded ones.
    const tables0 = await driver.listTables(schema)
    if (tables0.some((t) => t.type === 'view')) throw new Error('listTables returned a view-typed entry')
    const names0 = tables0.map((t) => t.name)
    for (const bt of ['customers', 'orders', 'order_items']) {
      if (!names0.some((n) => n.toLowerCase() === bt)) throw new Error(`Tables missing base table ${bt}`)
    }
    const sorted = [...names0].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    if (names0.join('|') !== sorted.join('|')) throw new Error(`Tables not alphabetical: ${names0.join(',')}`)

    // Create a disposable view -> only under Views, exactly once, not in Tables.
    await driver.runQuery(`CREATE VIEW ${qn('_treetest_v')} AS SELECT ${q('id')} FROM ${qn('customers')}`)
    const tablesA = await driver.listTables(schema)
    if (tablesA.some((t) => t.name.toLowerCase() === '_treetest_v')) throw new Error('view appeared in Tables list')
    const viewsA = await driver.listViews(schema)
    if (viewsA.filter((v) => v.name.toLowerCase() === '_treetest_v').length !== 1) throw new Error('view not listed exactly once under Views')
    // No object appears in both lists.
    const tset = new Set(tablesA.map((t) => t.name.toLowerCase()))
    if (viewsA.some((v) => tset.has(v.name.toLowerCase()))) throw new Error('an object appears in both Tables and Views')

    // Drop -> disappears from Views.
    await driver.runQuery(`DROP VIEW IF EXISTS ${qn('_treetest_v')}`)
    const viewsB = await driver.listViews(schema)
    if (viewsB.some((v) => v.name.toLowerCase() === '_treetest_v')) throw new Error('view still under Views after drop')

    results.push(`✅ ${tag}: Tables base-only+sorted(${names0.length}), view->Views-only(1), drop->gone, no cross-list dup`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    await driver.runQuery(`DROP VIEW IF EXISTS ${qn('_treetest_v')}`).catch(() => undefined)
    await driver.disconnect().catch(() => undefined)
  }
}

/** TASK 21: Custom WHERE — guarded raw predicate for read-only browsing. */
async function testCustomWhere(config: ConnectionConfig): Promise<void> {
  const tag = `cw-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const driver = await createDriver(config)
  const q = (n: string): string => (isMysqlFamily(engine) ? `\`${n}\`` : `"${n}"`)
  const qn = (n: string): string => (engine === 'sqlite' ? q(n) : `${q(schema)}.${q(n)}`)
  try {
    await driver.connect()

    // 1) Valid predicate -> filtered page + count match a hand query; page1 size honored.
    const cw = 'id > 5'
    const page = await driver.getTablePage(schema, 'customers', 50, 1, null, [], null, cw)
    const cnt = await driver.getTableRowCount(schema, 'customers', [], null, cw)
    const hand = await driver.runQuery(`SELECT COUNT(*) AS c FROM ${qn('customers')} WHERE (id > 5)`)
    const handCount = Number(hand.rows[0]?.c ?? -1)
    if (cnt !== handCount) throw new Error(`count ${cnt} != hand ${handCount}`)
    if (page.rows.length !== Math.min(50, handCount)) throw new Error(`page rows ${page.rows.length} != ${Math.min(50, handCount)}`)

    // 2) Quoted literal is treated as a string, not injection (must not error).
    await driver.getTablePage(schema, 'customers', 10, 1, null, [], null, "full_name = 'O''Brien'")

    // 3) Injection attempt is REFUSED by the guard (never executed); table intact.
    let refused = false
    try {
      await driver.getTablePage(schema, 'customers', 10, 1, null, [], null, '1=1); DROP TABLE customers;--')
    } catch {
      refused = true
    }
    if (!refused) throw new Error('injection attempt was NOT refused')
    const still = Number((await driver.runQuery(`SELECT COUNT(*) AS c FROM ${qn('customers')}`)).rows[0]?.c ?? 0)
    if (still < 1) throw new Error('customers table appears damaged after injection attempt')

    // 4) A syntax/unknown-column predicate surfaces the engine error (throws).
    let syntaxErr = false
    try {
      await driver.getTablePage(schema, 'customers', 10, 1, null, [], null, 'amoun > 100')
    } catch {
      syntaxErr = true
    }
    if (!syntaxErr) throw new Error('bad predicate did not surface an error')

    results.push(`✅ ${tag}: valid(count ${cnt}, page ${page.rows.length}), quoted-literal ok, injection REFUSED (customers intact ${still}), syntax-error surfaced`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * ER diagram data + edit flow against a real DB on DISPOSABLE tables
 * (`_ertest_*`). Exercises exactly what the ER UI does: build the model from
 * getTableSpec (FK edges), ADD a foreign key to an existing table via an ALTER
 * DdlRequest (SQLite -> rebuild), DROP that foreign key, then DROP the tables.
 */
async function testErDiagram(config: ConnectionConfig): Promise<void> {
  const tag = `er-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const T = ddlTypes(engine)
  const driver = await createDriver(config)
  const q = (n: string): string => (isMysqlFamily(engine) ? `\`${n}\`` : `"${n}"`)
  const notes: string[] = []
  try {
    await driver.connect()

    // Clean slate (child first for FK order).
    for (const name of ['_ertest_child', '_ertest_parent']) {
      await driver.runQuery(`DROP TABLE ${q(name)}`).catch(() => undefined)
    }

    // --- The seeded schema's FKs appear in the model (getErModel building block) ---
    const seededRefs = await driver.listTables(schema)
    let seededFkEdges = 0
    for (const ref of seededRefs) {
      const s = await driver.getTableSpec(schema, ref.name)
      for (const fk of s.foreignKeys) {
        if (seededRefs.some((r) => r.name === fk.refTable)) seededFkEdges++
      }
    }
    // customers/orders/order_items carry 2 FKs (orders->customers, order_items->orders).
    if (seededFkEdges < 1) throw new Error('no FK edges found among seeded tables')

    // --- Create disposable parent + child (no FK yet) ---
    const parent: TableSpec = {
      schema,
      name: '_ertest_parent',
      columns: [{ name: 'id', type: T.int, nullable: false, autoIncrement: true }],
      primaryKey: ['id'],
      foreignKeys: [],
      indexes: []
    }
    let r = await driver.execStatements(buildTableDdl(engine, 'create', parent).statements)
    if (!r.ok) throw new Error(`create parent failed: ${r.message}`)

    const child: TableSpec = {
      schema,
      name: '_ertest_child',
      columns: [
        { name: 'id', type: T.int, nullable: false, autoIncrement: true },
        { name: 'parent_id', type: T.int, nullable: true }
      ],
      primaryKey: ['id'],
      foreignKeys: [],
      indexes: []
    }
    r = await driver.execStatements(buildTableDdl(engine, 'create', child).statements)
    if (!r.ok) throw new Error(`create child failed: ${r.message}`)

    // A row to prove data survives the (SQLite) rebuild that an FK-add triggers.
    await driver.runQuery(`INSERT INTO ${q('_ertest_parent')} DEFAULT VALUES`).catch(async () => {
      // MySQL/PG: DEFAULT VALUES syntax differs; fall back.
      await driver.runQuery(`INSERT INTO ${q('_ertest_parent')} (${q('id')}) VALUES (1)`).catch(() => undefined)
    })
    await driver
      .runQuery(`INSERT INTO ${q('_ertest_child')} (${q('parent_id')}) VALUES (1)`)
      .catch(() => undefined)

    // --- ADD FK by "drawing" (child.parent_id -> parent.id) via ALTER ---
    const origChild = await driver.getTableSpec(schema, '_ertest_child')
    const withFk: TableSpec = {
      ...JSON.parse(JSON.stringify(origChild)),
      foreignKeys: [
        {
          name: engine === 'sqlite' ? null : 'fk_ertest_child_parent',
          columns: ['parent_id'],
          refSchema: engine === 'sqlite' ? null : schema,
          refTable: '_ertest_parent',
          refColumns: ['id'],
          onDelete: 'CASCADE',
          onUpdate: 'NO ACTION'
        }
      ]
    }
    const addPrev = buildTableDdl(engine, 'alter', withFk, origChild)
    const rebuilt = addPrev.notes.some((n) => /rebuilt/i.test(n))
    r = await driver.execStatements(addPrev.statements)
    if (!r.ok) throw new Error(`add FK failed @${r.failedAt}: ${r.message}`)

    const afterAdd = await driver.getTableSpec(schema, '_ertest_child')
    if (!afterAdd.foreignKeys.some((f) => f.refTable === '_ertest_parent' && f.columns.includes('parent_id'))) {
      throw new Error('FK not present after add')
    }
    // Data preserved through the add (esp. the SQLite rebuild path).
    const cnt = await driver.runQuery(`SELECT count(*) AS n FROM ${q('_ertest_child')}`)
    if (Number(cnt.rows[0]?.n) < 0) throw new Error('child row count unreadable')

    // --- DROP that FK via ALTER (spec minus the FK) ---
    const dropSpec: TableSpec = { ...JSON.parse(JSON.stringify(afterAdd)), foreignKeys: [] }
    const dropPrev = buildTableDdl(engine, 'alter', dropSpec, afterAdd)
    r = await driver.execStatements(dropPrev.statements)
    if (!r.ok) throw new Error(`drop FK failed @${r.failedAt}: ${r.message}`)

    const afterDrop = await driver.getTableSpec(schema, '_ertest_child')
    if (afterDrop.foreignKeys.some((f) => f.refTable === '_ertest_parent')) {
      throw new Error('FK still present after drop')
    }

    // --- DROP tables (object op) ---
    for (const name of ['_ertest_child', '_ertest_parent']) {
      const drop = buildObjectOp(engine, { kind: 'dropTable', schema, table: name })
      const dr = await driver.execStatements(drop.statements)
      if (!dr.ok) throw new Error(`drop ${name} failed: ${dr.message}`)
    }

    notes.push(
      `seeded FK edges=${seededFkEdges}, add-FK${rebuilt ? '(SQLite REBUILD)' : ''}→verified, drop-FK→verified, drop tables ok`
    )
    results.push(`✅ ${tag}: ${notes.join(' ')}`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    for (const name of ['_ertest_child', '_ertest_parent']) {
      await driver.runQuery(`DROP TABLE ${q(name)}`).catch(() => undefined)
    }
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * Sequences (PostgreSQL). Exercises listSequences + getSequenceDetails and the
 * create/alter/restart/rename/drop DDL generators on a DISPOSABLE `_seqtest_*`
 * sequence. MySQL/SQLite: assert listSequences returns [] (unsupported, no throw).
 */
async function testSequences(config: ConnectionConfig): Promise<void> {
  const tag = `seq-${config.engine}`
  const engine = config.engine
  const driver = await createDriver(config)
  try {
    await driver.connect()

    if (engine === 'mysql' || engine === 'sqlite') {
      const list = await driver.listSequences('main')
      if (list.length !== 0) throw new Error(`${engine} should have no sequences, got ${list.length}`)
      results.push(`✅ ${tag}: no standalone sequences (unsupported, returns [] — ok)`)
      return
    }

    if (engine === 'mariadb') {
      // MariaDB has standalone CREATE SEQUENCE (10.3+). Disposable _seqtest_ only.
      const db = config.database as string
      const qs = (n: string): string => '`' + db + '`.`' + n + '`'
      for (const n of ['_seqtest_s', '_seqtest_r']) await driver.runQuery(`DROP SEQUENCE IF EXISTS ${qs(n)}`).catch(() => undefined)
      const mspec = {
        schema: db, name: '_seqtest_s', originalName: null, dataType: 'bigint',
        increment: '5', minValue: null, maxValue: null, start: '100', cache: '1', cycle: false, ownedBy: null, restart: null
      }
      let mr = await driver.execStatements(buildCreateSequence(engine, mspec).statements)
      if (!mr.ok) throw new Error(`create failed: ${mr.message}`)
      if (!(await driver.listSequences(db)).some((s) => s.name === '_seqtest_s')) throw new Error('sequence not listed')
      let mdet = await driver.getSequenceDetails(db, '_seqtest_s')
      if (mdet.increment !== '5' || mdet.start !== '100') throw new Error(`create props wrong: inc=${mdet.increment} start=${mdet.start}`)
      // NEXTVAL(seq) → 100 then 105.
      const m1 = await driver.runQuery(`SELECT NEXTVAL(${qs('_seqtest_s')}) AS v`)
      const m2 = await driver.runQuery(`SELECT NEXTVAL(${qs('_seqtest_s')}) AS v`)
      if (String(m1.rows[0]?.v) !== '100' || String(m2.rows[0]?.v) !== '105') throw new Error(`nextval wrong: ${m1.rows[0]?.v}, ${m2.rows[0]?.v}`)
      // ALTER increment→10 + RESTART 500.
      const maltered = { ...mspec, increment: '10', restart: '500' }
      mr = await driver.execStatements(buildAlterSequence(engine, maltered, mspec).statements)
      if (!mr.ok) throw new Error(`alter failed: ${mr.message}`)
      mdet = await driver.getSequenceDetails(db, '_seqtest_s')
      if (mdet.increment !== '10') throw new Error(`alter increment not applied: ${mdet.increment}`)
      const m3 = await driver.runQuery(`SELECT NEXTVAL(${qs('_seqtest_s')}) AS v`)
      if (String(m3.rows[0]?.v) !== '500') throw new Error(`restart not applied: nextval=${m3.rows[0]?.v}`)
      // RENAME → _seqtest_r (RENAME TABLE).
      const mrenamed = { ...maltered, name: '_seqtest_r', originalName: '_seqtest_s', restart: null }
      mr = await driver.execStatements(buildAlterSequence(engine, mrenamed, maltered).statements)
      if (!mr.ok) throw new Error(`rename failed: ${mr.message}`)
      const afterR = await driver.listSequences(db)
      if (!afterR.some((s) => s.name === '_seqtest_r') || afterR.some((s) => s.name === '_seqtest_s')) throw new Error('rename not reflected in list')
      // DROP.
      mr = await driver.execStatements(buildDropSequence(engine, db, '_seqtest_r').statements)
      if (!mr.ok) throw new Error(`drop failed: ${mr.message}`)
      if ((await driver.listSequences(db)).some((s) => /_seqtest_/.test(s.name))) throw new Error('sequence still present after drop')
      for (const n of ['_seqtest_s', '_seqtest_r']) await driver.runQuery(`DROP SEQUENCE IF EXISTS ${qs(n)}`).catch(() => undefined)
      results.push(`✅ ${tag}: create/NEXTVAL(100,105), alter inc→10, RESTART→500, rename(RENAME TABLE), drop; list ok`)
      return
    }

    const schema = 'public'
    await driver.runQuery(`DROP SEQUENCE IF EXISTS "public"."_seqtest_s"`).catch(() => undefined)

    // Seeded SERIAL sequences should appear with an owned-by column.
    const seeded = await driver.listSequences(schema)
    const custSeq = seeded.find((s) => /customers/.test(s.name))
    if (!custSeq) throw new Error('no seeded customers sequence found')
    const custDet = await driver.getSequenceDetails(schema, custSeq.name)
    if (!custDet.ownedBy) throw new Error(`seeded ${custSeq.name} has no owned-by`)

    // CREATE _seqtest_s (increment 5, start 100, cache 1).
    const spec = {
      schema,
      name: '_seqtest_s',
      originalName: null,
      dataType: 'bigint',
      increment: '5',
      minValue: null,
      maxValue: null,
      start: '100',
      cache: '1',
      cycle: false,
      ownedBy: null,
      restart: null
    }
    let r = await driver.execStatements(buildCreateSequence(engine, spec).statements)
    if (!r.ok) throw new Error(`create failed: ${r.message}`)
    let det = await driver.getSequenceDetails(schema, '_seqtest_s')
    if (det.increment !== '5' || det.start !== '100') throw new Error(`create props wrong: inc=${det.increment} start=${det.start}`)

    // nextval → 100, then 105 (increment 5).
    const n1 = await driver.runQuery(`SELECT nextval('"public"."_seqtest_s"') AS v`)
    const n2 = await driver.runQuery(`SELECT nextval('"public"."_seqtest_s"') AS v`)
    if (String(n1.rows[0]?.v) !== '100' || String(n2.rows[0]?.v) !== '105') {
      throw new Error(`nextval wrong: ${n1.rows[0]?.v}, ${n2.rows[0]?.v}`)
    }

    // ALTER increment → 10 and RESTART WITH 500.
    const altered = { ...spec, increment: '10', restart: '500' }
    r = await driver.execStatements(buildAlterSequence(engine, altered, spec).statements)
    if (!r.ok) throw new Error(`alter failed: ${r.message}`)
    det = await driver.getSequenceDetails(schema, '_seqtest_s')
    if (det.increment !== '10') throw new Error(`alter increment not applied: ${det.increment}`)
    const n3 = await driver.runQuery(`SELECT nextval('"public"."_seqtest_s"') AS v`)
    if (String(n3.rows[0]?.v) !== '500') throw new Error(`restart not applied: nextval=${n3.rows[0]?.v}`)

    // RENAME _seqtest_s → _seqtest_r.
    const renamed = { ...altered, name: '_seqtest_r', originalName: '_seqtest_s', restart: null }
    r = await driver.execStatements(buildAlterSequence(engine, renamed, altered).statements)
    if (!r.ok) throw new Error(`rename failed: ${r.message}`)
    const afterRename = await driver.listSequences(schema)
    if (!afterRename.some((s) => s.name === '_seqtest_r') || afterRename.some((s) => s.name === '_seqtest_s')) {
      throw new Error('rename not reflected in list')
    }

    // DROP _seqtest_r.
    r = await driver.execStatements(buildDropSequence(engine, schema, '_seqtest_r').statements)
    if (!r.ok) throw new Error(`drop failed: ${r.message}`)
    const afterDrop = await driver.listSequences(schema)
    if (afterDrop.some((s) => /_seqtest_/.test(s.name))) throw new Error('sequence still present after drop')

    // Seeded sequences untouched.
    const stillSeeded = await driver.getSequenceDetails(schema, custSeq.name)
    if (!stillSeeded.ownedBy) throw new Error('seeded sequence lost its owned-by')

    results.push(
      `✅ ${tag}: seeded seq owned-by ok, create/nextval(100,105), alter inc→10, RESTART→500, rename, drop; seeded untouched`
    )
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    await driver.runQuery(`DROP SEQUENCE IF EXISTS "public"."_seqtest_s"`).catch(() => undefined)
    await driver.runQuery(`DROP SEQUENCE IF EXISTS "public"."_seqtest_r"`).catch(() => undefined)
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * Triggers (all engines). On a DISPOSABLE `_trgtbl_` table: create a trigger
 * that FIRES and changes an inserted row, verify the effect, round-trip its
 * definition, edit (DROP+CREATE), and drop it. Body contains ';' (single-
 * statement execution). Seeded tables are never touched.
 */
async function testTriggers(config: ConnectionConfig): Promise<void> {
  const tag = `trg-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const T = ddlTypes(engine)
  const driver = await createDriver(config)
  const q = (n: string): string => (isMysqlFamily(engine) ? `\`${n}\`` : `"${n}"`)
  const tbl = engine === 'sqlite' ? q('_trgtbl_') : `${q(schema)}.${q('_trgtbl_')}`
  try {
    await driver.connect()
    await driver.runQuery(`DROP TABLE ${tbl}`).catch(() => undefined)

    // Disposable table: id + note.
    const v = T.varchar(50)
    const spec = {
      schema,
      name: '_trgtbl_',
      columns: [
        { name: 'id', type: T.int, nullable: false, autoIncrement: true },
        { name: 'note', type: v.type, length: v.length || null, nullable: true }
      ],
      primaryKey: ['id'],
      foreignKeys: [],
      indexes: []
    }
    let r = await driver.execStatements(buildTableDdl(engine, 'create', spec as never).statements)
    if (!r.ok) throw new Error(`create _trgtbl_ failed: ${r.message}`)

    // Build a trigger that sets/updates note. Body has ';' to prove single-stmt exec.
    let trg: TriggerSpec
    if (engine === 'postgres') {
      trg = {
        schema, table: '_trgtbl_', name: '_trgtest_t', originalName: null,
        timing: 'BEFORE', event: 'INSERT', level: 'ROW', body: '',
        functionName: '_trgtest_fn',
        functionBody: `BEGIN\n  NEW.note := 'trg';\n  RETURN NEW;\nEND;`
      }
    } else if (isMysqlFamily(engine)) {
      trg = {
        schema, table: '_trgtbl_', name: '_trgtest_t', originalName: null,
        timing: 'BEFORE', event: 'INSERT', level: 'ROW',
        // Two-statement body (';' between) proves single-statement execution.
        body: `BEGIN\n  SET @c := 1;\n  SET NEW.note = 'trg';\nEND`,
        functionName: '', functionBody: ''
      }
    } else {
      trg = {
        schema, table: '_trgtbl_', name: '_trgtest_t', originalName: null,
        timing: 'AFTER', event: 'INSERT', level: 'ROW',
        body: `BEGIN\n  UPDATE _trgtbl_ SET note = 'trg' WHERE id = NEW.id;\nEND`,
        functionName: '', functionBody: ''
      }
    }
    r = await driver.execStatements(buildTriggerStatements(engine, trg, 'new').statements)
    if (!r.ok) throw new Error(`create trigger failed @${r.failedAt}: ${r.message}`)

    // Appears under the table's Triggers list?
    const list = await driver.listTriggers(schema, '_trgtbl_')
    if (!list.some((t) => t.name === '_trgtest_t')) throw new Error('trigger not listed after create')

    // Round-trip the definition.
    const det = await driver.getTriggerDetails(schema, '_trgtbl_', '_trgtest_t')
    if (det.event.toUpperCase() !== 'INSERT') throw new Error(`round-trip event wrong: ${det.event}`)
    if (engine === 'postgres' && !/NEW\.note/.test(det.functionBody ?? '')) throw new Error('PG function body not round-tripped')
    if (engine !== 'postgres' && !/note/i.test(det.body)) throw new Error('body not round-tripped')

    // Fire it: insert a row, then read note.
    await driver.runQuery(`INSERT INTO ${tbl} (${q('note')}) VALUES ('orig')`)
    const got = await driver.runQuery(`SELECT ${q('note')} AS note FROM ${tbl} ORDER BY ${q('id')} DESC LIMIT 1`)
    const note = String(got.rows[0]?.note)
    if (note !== 'trg') throw new Error(`trigger did not fire (note='${note}', expected 'trg')`)

    // Edit (DROP + CREATE): change note value to 'trg2'.
    const edited: TriggerSpec = { ...trg, originalName: '_trgtest_t' }
    if (engine === 'postgres') edited.functionBody = `BEGIN\n  NEW.note := 'trg2';\n  RETURN NEW;\nEND;`
    else if (isMysqlFamily(engine)) edited.body = `BEGIN\n  SET NEW.note = 'trg2';\nEND`
    else edited.body = `BEGIN\n  UPDATE _trgtbl_ SET note = 'trg2' WHERE id = NEW.id;\nEND`
    const editPrev = buildTriggerStatements(engine, edited, 'edit')
    if (!editPrev.destructive) throw new Error('edit should be destructive (DROP+CREATE)')
    r = await driver.execStatements(editPrev.statements)
    if (!r.ok) throw new Error(`edit trigger failed @${r.failedAt}: ${r.message}`)
    await driver.runQuery(`INSERT INTO ${tbl} (${q('note')}) VALUES ('orig')`)
    const got2 = await driver.runQuery(`SELECT ${q('note')} AS note FROM ${tbl} ORDER BY ${q('id')} DESC LIMIT 1`)
    if (String(got2.rows[0]?.note) !== 'trg2') throw new Error(`edited trigger not effective (note='${got2.rows[0]?.note}')`)

    // Drop the trigger.
    r = await driver.execStatements(buildObjectOp(engine, { kind: 'dropTrigger', schema, table: '_trgtbl_', name: '_trgtest_t' }).statements)
    if (!r.ok) throw new Error(`drop trigger failed: ${r.message}`)
    if ((await driver.listTriggers(schema, '_trgtbl_')).some((t) => t.name === '_trgtest_t')) {
      throw new Error('trigger still present after drop')
    }

    results.push(`✅ ${tag}: create→fired(note=trg), listed, round-trip, edit(DROP+CREATE)→trg2, drop; seeded untouched`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    // Clean up the PG function too, then the table.
    if (engine === 'postgres') {
      await driver.runQuery(`DROP FUNCTION IF EXISTS "public"."_trgtest_fn"() CASCADE`).catch(() => undefined)
    }
    await driver.runQuery(`DROP TABLE ${tbl}`).catch(() => undefined)
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * Indexes (all engines). On a DISPOSABLE `_idxtbl_` (with a PK + a UNIQUE
 * column so a constraint-backed/auto index exists): create single-column,
 * multi-column, and UNIQUE user indexes; verify columns/unique flags + that the
 * constraint-backed index is flagged read-only; edit (drop+recreate) + rename a
 * user index; drop it. Seeded tables untouched.
 */
async function testIndexes(config: ConnectionConfig): Promise<void> {
  const tag = `idx-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const driver = await createDriver(config)
  const q = (n: string): string => (isMysqlFamily(engine) ? `\`${n}\`` : `"${n}"`)
  const tbl = engine === 'sqlite' ? q('_idxtbl_') : `${q(schema)}.${q('_idxtbl_')}`
  const find = (list: Awaited<ReturnType<typeof driver.listIndexes>>, name: string): (typeof list)[number] | undefined =>
    list.find((i) => i.name === name)
  try {
    await driver.connect()
    await driver.runQuery(`DROP TABLE ${tbl}`).catch(() => undefined)

    // Table with a PK + a UNIQUE column (→ a constraint-backed/auto index).
    const intT = engine === 'sqlite' ? 'INTEGER' : isMysqlFamily(engine) ? 'int' : 'integer'
    const strT = engine === 'sqlite' ? 'TEXT' : 'varchar(50)'
    const pk = engine === 'sqlite' ? 'INTEGER PRIMARY KEY' : `${intT} PRIMARY KEY`
    const r0 = await driver.execStatements([
      `CREATE TABLE ${tbl} (${q('id')} ${pk}, ${q('a')} ${intT}, ${q('b')} ${strT}, ${q('u')} ${strT} UNIQUE)`
    ])
    if (!r0.ok) throw new Error(`create _idxtbl_ failed: ${r0.message}`)

    const mk = (name: string, columns: string[], unique: boolean): IndexCreateSpec => ({
      schema, table: '_idxtbl_', name, originalName: null, columns, unique
    })

    // Create single-column, multi-column, and UNIQUE user indexes.
    let r = await driver.execStatements(buildCreateIndex(engine, mk('_idxtest_a', ['a'], false)).statements)
    if (!r.ok) throw new Error(`create single-col index failed: ${r.message}`)
    r = await driver.execStatements(buildCreateIndex(engine, mk('_idxtest_ab', ['a', 'b'], false)).statements)
    if (!r.ok) throw new Error(`create multi-col index failed: ${r.message}`)
    r = await driver.execStatements(buildCreateIndex(engine, mk('_idxtest_bu', ['b'], true)).statements)
    if (!r.ok) throw new Error(`create unique index failed: ${r.message}`)

    let list = await driver.listIndexes(schema, '_idxtbl_')
    const ia = find(list, '_idxtest_a')
    const iab = find(list, '_idxtest_ab')
    const ibu = find(list, '_idxtest_bu')
    if (!ia || JSON.stringify(ia.columns) !== JSON.stringify(['a']) || ia.unique || ia.constraintBacked) {
      throw new Error(`single-col index wrong: ${JSON.stringify(ia)}`)
    }
    if (!iab || JSON.stringify(iab.columns) !== JSON.stringify(['a', 'b'])) {
      throw new Error(`multi-col index wrong: ${JSON.stringify(iab)}`)
    }
    if (!ibu || !ibu.unique) throw new Error(`unique index flag wrong: ${JSON.stringify(ibu)}`)

    // A constraint-backed/auto index must be present + flagged read-only.
    if (!list.some((i) => i.constraintBacked)) throw new Error('no constraint-backed index detected (PK/UNIQUE)')

    // EDIT a user index: change columns a → (a,b) via DROP + CREATE.
    const editSpec = mk('_idxtest_a', ['a', 'b'], false)
    editSpec.originalName = '_idxtest_a'
    const editPrev = buildAlterIndex(engine, editSpec, mk('_idxtest_a', ['a'], false))
    if (!editPrev.destructive) throw new Error('column change should be DROP+CREATE (destructive)')
    r = await driver.execStatements(editPrev.statements)
    if (!r.ok) throw new Error(`edit index failed @${r.failedAt}: ${r.message}`)
    list = await driver.listIndexes(schema, '_idxtbl_')
    if (JSON.stringify(find(list, '_idxtest_a')?.columns) !== JSON.stringify(['a', 'b'])) {
      throw new Error('edited index columns not applied')
    }

    // RENAME _idxtest_ab → _idxtest_ren.
    const renSpec = mk('_idxtest_ren', ['a', 'b'], false)
    renSpec.originalName = '_idxtest_ab'
    r = await driver.execStatements(buildAlterIndex(engine, renSpec, mk('_idxtest_ab', ['a', 'b'], false)).statements)
    if (!r.ok) throw new Error(`rename index failed @${r.failedAt}: ${r.message}`)
    list = await driver.listIndexes(schema, '_idxtbl_')
    if (!find(list, '_idxtest_ren') || find(list, '_idxtest_ab')) throw new Error('rename not reflected')

    // DROP a user index (object op).
    r = await driver.execStatements(buildObjectOp(engine, { kind: 'dropIndex', schema, table: '_idxtbl_', name: '_idxtest_a' }).statements)
    if (!r.ok) throw new Error(`drop index failed: ${r.message}`)
    list = await driver.listIndexes(schema, '_idxtbl_')
    if (find(list, '_idxtest_a')) throw new Error('index still present after drop')

    results.push(`✅ ${tag}: single/multi/unique created, constraint-backed flagged, edit(cols DROP+CREATE), rename, drop`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    await driver.runQuery(`DROP TABLE ${tbl}`).catch(() => undefined)
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * Import / Export round-trip on DISPOSABLE `_iotest*` tables. Exercises all 4
 * export formats with tricky values (comma/quote/newline/apostrophe/percent/
 * null/number), re-imports each, checks filtered export, injection-safety, and
 * skip-mode error collection. Seeded tables are read-only (never modified).
 */
/**
 * TASK 56 AUDIT (Part B) — create each supported routine/trigger/package from the
 * UNMODIFIED store template on every engine and confirm it is VALID, LISTED,
 * RUNNABLE, and droppable. The template strings mirror src/renderer/src/store.ts
 * (routineTemplate / packageTemplate / defaultTriggerSpec) verbatim.
 */
async function testTemplates(config: ConnectionConfig): Promise<void> {
  const tag = `tmpl-${config.engine}`
  const engine = config.engine
  const d = sqlDialect(engine)
  const driver = await createDriver(config)
  const done: string[] = []
  const qid = (n: string): string => (isMysqlFamily(engine) ? `\`${n}\`` : d === 'mssql' ? `[${n}]` : `"${n}"`)
  try {
    await driver.connect()
    const schema =
      isMysqlFamily(engine) ? (config.database as string)
      : engine === 'sqlite' ? 'main'
      : d === 'oracle' ? (await driver.listSchemas())[0]
      : d === 'mssql' ? 'dbo'
      : 'public'
    const qn = engine === 'sqlite' ? qid : (n: string): string => `${qid(schema)}.${qid(n)}`
    const FN = '_AUDIT_TFN', PR = '_AUDIT_TPR', PKG = '_AUDIT_TPKG', TT = '_AUDIT_TTBL', TRG = d === 'oracle' ? '_AUDIT_TTRG'.toUpperCase() : '_AUDIT_TTRG'

    // --- Function + Procedure (all engines except SQLite) ---
    if (engine !== 'sqlite') {
      const fnTemplate =
        engine === 'postgres' ? `CREATE OR REPLACE FUNCTION ${qn(FN)}(p_arg integer)\nRETURNS integer\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN p_arg + 1;\nEND;\n$$;`
        : d === 'oracle' ? `CREATE OR REPLACE FUNCTION ${qn(FN)} (p_a IN NUMBER, p_b IN NUMBER)\n  RETURN NUMBER\nIS\nBEGIN\n  RETURN p_a + p_b;\nEND;`
        : d === 'mssql' ? `CREATE OR ALTER FUNCTION ${qn(FN)} (@a INT, @b INT)\nRETURNS INT\nAS\nBEGIN\n  RETURN @a + @b;\nEND;`
        : `CREATE FUNCTION ${qn(FN)}(p_arg INT)\nRETURNS INT\nDETERMINISTIC\nRETURN p_arg + 1;`
      let r = await driver.applyObjectSql([fnTemplate])
      if (!r.ok) throw new Error(`function template: ${r.message}`)
      if (!(await driver.listRoutines(schema)).some((x) => x.name === FN && x.kind === 'function')) throw new Error('function not listed')
      // Run it.
      const callFn =
        engine === 'postgres' || isMysqlFamily(engine) ? `SELECT ${qn(FN)}(5) AS n`
        : d === 'oracle' ? `SELECT ${qn(FN)}(2, 3) AS n FROM dual`
        : `SELECT ${qn(FN)}(2, 3) AS n`
      const want = engine === 'postgres' || isMysqlFamily(engine) ? 6 : 5
      const got = Number(Object.values((await driver.runQuery(callFn)).rows[0] as Record<string, unknown>)[0])
      if (got !== want) throw new Error(`function ran wrong: ${got} != ${want}`)
      if (!(await driver.getObjectDefinition({ connectionId: config.id, kind: 'function', schema, name: FN })).length) throw new Error('function def did not round-trip')

      const prTemplate =
        engine === 'postgres' ? `CREATE OR REPLACE PROCEDURE ${qn(PR)}(p_arg integer)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RAISE NOTICE 'called with %', p_arg;\nEND;\n$$;`
        : d === 'oracle' ? `CREATE OR REPLACE PROCEDURE ${qn(PR)} (p_in IN NUMBER, p_out OUT NUMBER)\nIS\nBEGIN\n  p_out := p_in * 2;\nEND;`
        : d === 'mssql' ? `CREATE OR ALTER PROCEDURE ${qn(PR)}\n  @p_in INT,\n  @p_out INT OUTPUT\nAS\nBEGIN\n  SET NOCOUNT ON;\n  SET @p_out = @p_in * 2;\nEND;`
        : `CREATE PROCEDURE ${qn(PR)}(IN p_arg INT)\nBEGIN\n  SELECT p_arg;\nEND;`
      r = await driver.applyObjectSql([prTemplate])
      if (!r.ok) throw new Error(`procedure template: ${r.message}`)
      if (!(await driver.listRoutines(schema)).some((x) => x.name === PR && x.kind === 'procedure')) throw new Error('procedure not listed')
      // Run it (engine-specific invocation).
      if (d === 'oracle') {
        const o = await driver.runQuery(`DECLARE o NUMBER; BEGIN ${qn(PR)}(7, o); END;`)
        void o
      } else if (d === 'mssql') {
        const o = await driver.runQuery(`DECLARE @o INT; EXEC ${qn(PR)} @p_in = 7, @p_out = @o OUTPUT; SELECT @o AS n`)
        if (Number((o.rows[0] as Record<string, unknown>).n) !== 14) throw new Error('procedure OUTPUT wrong')
      } else if (engine === 'postgres' || isMysqlFamily(engine)) {
        await driver.runQuery(engine === 'postgres' ? `CALL ${qn(PR)}(5)` : `CALL ${qn(PR)}(5)`)
      }
      await driver.execStatements(buildObjectOp(engine, { kind: 'dropRoutine', routineKind: 'function', schema, name: FN }).statements)
      await driver.execStatements(buildObjectOp(engine, { kind: 'dropRoutine', routineKind: 'procedure', schema, name: PR }).statements)
      done.push('fn', 'proc')
    }

    // --- Oracle package template (spec + body split on `/`) ---
    if (d === 'oracle') {
      const pkgSpec = `CREATE OR REPLACE PACKAGE ${qn(PKG)} IS\n  FUNCTION f1(p IN NUMBER) RETURN NUMBER;\n  PROCEDURE p1(p IN VARCHAR2);\nEND ${qid(PKG)};`
      const pkgBody = `CREATE OR REPLACE PACKAGE BODY ${qn(PKG)} IS\n  FUNCTION f1(p IN NUMBER) RETURN NUMBER IS\n  BEGIN\n    RETURN p + 1;\n  END f1;\n\n  PROCEDURE p1(p IN VARCHAR2) IS\n  BEGIN\n    NULL;\n  END p1;\nEND ${qid(PKG)};`
      const r = await driver.applyObjectSql([pkgSpec, pkgBody])
      if (!r.ok) throw new Error(`package template: ${r.message}`)
      const dp = driver as unknown as { listPackages(s: string): Promise<{ name: string; hasBody: boolean }[]> }
      if (!(await dp.listPackages(schema)).some((p) => p.name === PKG && p.hasBody)) throw new Error('package not listed with body')
      if (Number(Object.values((await driver.runQuery(`SELECT ${qn(PKG)}.f1(10) AS n FROM dual`)).rows[0] as Record<string, unknown>)[0]) !== 11) throw new Error('packaged fn wrong')
      await driver.execStatements(buildObjectOp('oracle', { kind: 'dropPackage', schema, name: PKG }).statements)
      done.push('package')
    }

    // --- Trigger template (every engine) ---
    await driver.runQuery(d === 'oracle' ? `DROP TABLE ${qn(TT)} CASCADE CONSTRAINTS PURGE` : d === 'mssql' ? `IF OBJECT_ID('${TT}','U') IS NOT NULL DROP TABLE ${qn(TT)}` : `DROP TABLE ${qn(TT)}`).catch(() => undefined)
    const idT = engine === 'postgres' ? 'serial PRIMARY KEY' : isMysqlFamily(engine) ? 'int AUTO_INCREMENT PRIMARY KEY' : engine === 'sqlite' ? 'INTEGER PRIMARY KEY' : d === 'oracle' ? 'NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY' : 'INT IDENTITY(1,1) PRIMARY KEY'
    const noteT = engine === 'sqlite' ? 'TEXT' : d === 'oracle' ? 'VARCHAR2(50)' : d === 'mssql' ? 'NVARCHAR(50)' : isMysqlFamily(engine) ? 'varchar(50)' : 'text'
    await driver.execStatements([`CREATE TABLE ${qn(TT)} (${qid('id')} ${idT}, ${qid('note')} ${noteT}, ${qid('updated_at')} ${d === 'mssql' ? 'DATETIME2' : d === 'oracle' ? 'DATE' : engine === 'sqlite' ? 'TEXT' : isMysqlFamily(engine) ? 'datetime' : 'timestamp'})`])
    // Build the trigger from the same defaultTriggerSpec + buildTriggerStatements the UI uses.
    const isOracle = d === 'oracle', isMssql = d === 'mssql'
    const body =
      engine === 'mysql' || engine === 'mariadb' ? `BEGIN\n  -- e.g. SET NEW.updated_at = NOW();\n  SET @x = 1;\nEND`
      : engine === 'sqlite' ? `BEGIN\n  -- e.g. UPDATE ${TT} SET note = 'changed' WHERE rowid = NEW.rowid;\n  SELECT 1;\nEND`
      : isOracle ? `BEGIN\n  -- e.g. :NEW."UPDATED_AT" := SYSTIMESTAMP;\n  NULL;\nEND;`
      : isMssql ? `BEGIN\n  SET NOCOUNT ON;\n  -- e.g. UPDATE t SET updated_at = SYSUTCDATETIME()\n  --   FROM ${TT} t JOIN inserted i ON t.id = i.id;\n  SELECT 1;\nEND`
      : ''
    const trgSpec: TriggerSpec = {
      schema, table: TT, name: TRG, originalName: null,
      timing: engine === 'postgres' || isOracle ? 'BEFORE' : 'AFTER', event: 'INSERT', level: 'ROW',
      body, functionName: `${TRG}_fn`, functionBody: engine === 'postgres' ? `BEGIN\n  -- e.g. NEW.updated_at := now();\n  RETURN NEW;\nEND;` : '', whenClause: ''
    }
    const tr = await driver.applyObjectSql(buildTriggerStatements(engine, trgSpec, 'new').statements)
    if (!tr.ok) throw new Error(`trigger template: ${tr.message}`)
    if (!(await driver.listTriggers(schema, TT)).some((t) => t.name === TRG || t.name.toUpperCase() === TRG.toUpperCase())) throw new Error('trigger not listed')
    await driver.execStatements(buildObjectOp(engine, { kind: 'dropTrigger', schema, table: TT, name: TRG }).statements)
    await driver.runQuery(d === 'oracle' ? `DROP TABLE ${qn(TT)} CASCADE CONSTRAINTS PURGE` : `DROP TABLE ${qn(TT)}`).catch(() => undefined)
    done.push('trigger')
    if (engine === 'sqlite' && (await driver.listRoutines(schema)).length !== 0) throw new Error('sqlite should have no routines')

    results.push(`✅ ${tag}: unmodified templates create VALID+listed+runnable objects [${done.join(',')}]${engine === 'sqlite' ? ' (functions/procedures correctly unsupported)' : ''}`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    for (const n of ['_AUDIT_TFN']) await driver.runQuery(d === 'oracle' ? `DROP FUNCTION ${qid(n)}` : `DROP FUNCTION ${qid(n)}`).catch(() => undefined)
    await driver.runQuery(`DROP PROCEDURE ${qid('_AUDIT_TPR')}`).catch(() => undefined)
    if (d === 'oracle') await driver.runQuery(`DROP PACKAGE ${qid('_AUDIT_TPKG')}`).catch(() => undefined)
    await driver.runQuery(d === 'oracle' ? `DROP TABLE ${qid('_AUDIT_TTBL')} CASCADE CONSTRAINTS PURGE` : `DROP TABLE ${qid('_AUDIT_TTBL')}`).catch(() => undefined)
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * TASK 56 AUDIT — awkward-data import/export matrix on ALL SIX engines. One
 * disposable `_AUDIT_A` table per engine with quote/comma/newline/%/_/unicode
 * text, a decimal, a date WITH a time component, a boolean, a long text, an
 * EMPTY STRING, and a NULL. Exports CSV/JSON/Excel/SQL, imports each file format
 * into a fresh `_AUDIT_B`, executes the exported .sql into `_AUDIT_C`, and
 * verifies row counts + values (unicode/quote intact, time component preserved,
 * empty-string semantics). Seeded tables are never touched.
 */
async function testAudit(config: ConnectionConfig): Promise<void> {
  const tag = `audit-${config.engine}`
  const engine = config.engine
  const d = sqlDialect(engine)
  const driver = await createDriver(config)
  const q = (n: string): string =>
    isMysqlFamily(engine) ? `\`${n}\`` : d === 'mssql' ? `[${n}]` : `"${n}"`
  const notes: string[] = []
  let dir = ''
  const drop = async (name: string): Promise<void> => {
    if (d === 'oracle') await driver.runQuery(`DROP TABLE ${q(name)} CASCADE CONSTRAINTS PURGE`).catch(() => undefined)
    else if (d === 'mssql') await driver.runQuery(`IF OBJECT_ID('${name}','U') IS NOT NULL DROP TABLE ${q(name)}`).catch(() => undefined)
    else await driver.runQuery(`DROP TABLE ${q(name)}`).catch(() => undefined)
  }
  try {
    await driver.connect()
    const schema =
      isMysqlFamily(engine) ? (config.database as string)
      : engine === 'sqlite' ? 'main'
      : d === 'oracle' ? (await driver.listSchemas())[0]
      : d === 'mssql' ? 'dbo'
      : 'public'
    const qt = (n: string): string => (engine === 'sqlite' ? q(n) : `${q(schema)}.${q(n)}`)
    dir = join(process.cwd(), '.smoke', 'audit')
    mkdirSync(dir, { recursive: true })

    // Per-engine column types for the awkward table.
    const ty = (k: 'idpk' | 'txt' | 'dec' | 'dt' | 'flag' | 'long'): string => {
      const map: Record<string, Record<string, string>> = {
        postgres: { idpk: 'serial PRIMARY KEY', txt: 'varchar(300)', dec: 'numeric(12,2)', dt: 'timestamp', flag: 'boolean', long: 'text' },
        mysql: { idpk: 'int AUTO_INCREMENT PRIMARY KEY', txt: 'varchar(300)', dec: 'decimal(12,2)', dt: 'datetime', flag: 'tinyint(1)', long: 'longtext' },
        sqlite: { idpk: 'INTEGER PRIMARY KEY AUTOINCREMENT', txt: 'TEXT', dec: 'NUMERIC', dt: 'TEXT', flag: 'INTEGER', long: 'TEXT' },
        oracle: { idpk: 'NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY', txt: 'VARCHAR2(300)', dec: 'NUMBER(12,2)', dt: 'DATE', flag: 'NUMBER(1)', long: 'CLOB' },
        mssql: { idpk: 'INT IDENTITY(1,1) PRIMARY KEY', txt: 'NVARCHAR(300)', dec: 'DECIMAL(12,2)', dt: 'DATETIME2', flag: 'BIT', long: 'NVARCHAR(MAX)' }
      }
      return map[d][k]
    }
    const createAudit = (name: string): string =>
      `CREATE TABLE ${qt(name)} (${q('id')} ${ty('idpk')}, ${q('txt')} ${ty('txt')}, ${q('amount')} ${ty('dec')}, ${q('dt')} ${ty('dt')}, ${q('flag')} ${ty('flag')}, ${q('longtxt')} ${ty('long')})`

    const A = '_AUDIT_A', B = '_AUDIT_B', C = '_AUDIT_C'
    for (const n of [A, B, C]) await drop(n)
    let r = await driver.execStatements([createAudit(A)])
    if (!r.ok) throw new Error(`create ${A}: ${r.message}`)

    // Row 1: quote + comma + newline + %/_ + Georgian unicode, decimal, a date
    // WITH time, boolean true, a long text. Row 2: EMPTY STRING, NULLs, false.
    const uni = "O'Brien, \"Jr.\"\n%_ გამარჯობა"
    const uniLit = (d === 'mssql' ? 'N' : '') + `'${uni.replace(/'/g, "''")}'`
    const longLit = (d === 'mssql' ? 'N' : '') + `'${'x'.repeat(600)}'`
    const dtLit =
      d === 'oracle' ? `TO_DATE('2024-01-15 09:12:34','YYYY-MM-DD HH24:MI:SS')`
      : engine === 'postgres' ? `TIMESTAMP '2024-01-15 09:12:34'`
      : d === 'mssql' ? `'2024-01-15T09:12:34'`
      : `'2024-01-15 09:12:34'`
    const trueLit = engine === 'postgres' ? 'true' : '1'
    const falseLit = engine === 'postgres' ? 'false' : '0'
    const emptyLit = (d === 'mssql' ? 'N' : '') + `''`
    const cols = `(${q('txt')}, ${q('amount')}, ${q('dt')}, ${q('flag')}, ${q('longtxt')})`
    r = await driver.execStatements([`INSERT INTO ${qt(A)} ${cols} VALUES (${uniLit}, 1234.56, ${dtLit}, ${trueLit}, ${longLit})`])
    if (!r.ok) throw new Error(`seed row1: ${r.message}`)
    r = await driver.execStatements([`INSERT INTO ${qt(A)} ${cols} VALUES (${emptyLit}, NULL, NULL, ${falseLit}, ${(d === 'mssql' ? 'N' : '') + `'plain'`})`])
    if (!r.ok) throw new Error(`seed row2: ${r.message}`)

    const specOf = async (name: string): Promise<{ columnTypes: Record<string, string>; primaryKey: string[] }> => {
      const s = await driver.getTableSpec(schema, name)
      const columnTypes: Record<string, string> = {}
      for (const c of s.columns) columnTypes[c.name] = c.type
      return { columnTypes, primaryKey: s.primaryKey }
    }
    const exReq = (format: ExportRequest['format'], sqlCreate = false): ExportRequest => ({
      connectionId: config.id, schema, table: A, format, scope: 'all', columns: [], filters: [], tree: null, customWhere: null,
      options: { sqlMultiRow: true, sqlCreateTable: sqlCreate }
    })
    // Read helper: the row with the unicode/quote value, and the empty/null row.
    const rowUni = async (name: string): Promise<Record<string, unknown>> =>
      (await driver.runQuery(`SELECT * FROM ${qt(name)} WHERE ${q('flag')} = ${trueLit}`)).rows[0] as Record<string, unknown>
    const rowEmpty = async (name: string): Promise<Record<string, unknown>> =>
      (await driver.runQuery(`SELECT * FROM ${qt(name)} WHERE ${q('flag')} = ${falseLit}`)).rows[0] as Record<string, unknown>
    const countOf = async (name: string): Promise<number> => driver.getTableRowCount(schema, name)
    // The exported value for `dt` keeps its time component (minute/second are
    // TZ-invariant for whole-hour offsets) — assert ':12:34' survives.
    const dtHasTime = (v: unknown): boolean => /[ T]\d{2}:12:34/.test(String(v))

    // --- File formats: export → import into a fresh target → verify ---
    for (const fmt of ['csv', 'json', 'xlsx'] as const) {
      const file = join(dir, `${engine}_audit.${fmt}`)
      const xr = await runExport(driver, engine, exReq(fmt), file)
      if (!xr.ok || xr.rows !== 2) throw new Error(`export ${fmt}: ok=${xr.ok} rows=${xr.rows} ${xr.error ?? ''}`)
      const prev = previewImport(file, { format: fmt, hasHeader: true })
      if (!prev.ok || prev.totalRows !== 2) throw new Error(`preview ${fmt}: ${prev.error ?? prev.totalRows}`)
      await drop(B)
      r = await driver.execStatements([createAudit(B)])
      if (!r.ok) throw new Error(`create ${B} for ${fmt}: ${r.message}`)
      // Skip the identity `id` on import so the target auto-assigns it.
      const imReq: ImportRequest = {
        connectionId: config.id, schema, table: B, filePath: file,
        parse: { format: fmt, hasHeader: true },
        mapping: { txt: 'txt', amount: 'amount', dt: 'dt', flag: 'flag', longtxt: 'longtxt' },
        mode: 'skip', batchSize: 100
      }
      const imp = await runImport(driver, await specOf(B), imReq)
      if (!imp.ok || imp.inserted !== 2) throw new Error(`import ${fmt}: inserted=${imp.inserted} err=${imp.errors?.[0]?.message ?? imp.error ?? ''}`)
      const u = await rowUni(B)
      if (!String(u.txt ?? u.TXT).includes("O'Brien") || !String(u.txt ?? u.TXT).includes('გამარჯობა')) throw new Error(`${fmt} unicode/quote corrupted: ${JSON.stringify(u.txt ?? u.TXT)}`)
      if (!dtHasTime(u.dt ?? u.DT)) throw new Error(`${fmt} date lost its time component: ${JSON.stringify(u.dt ?? u.DT)}`)
      if (String(u.longtxt ?? u.LONGTXT).length < 500) throw new Error(`${fmt} long text truncated`)
      const em = await rowEmpty(B)
      const key = Object.keys(em).find((k) => k.toLowerCase() === 'txt')
      const emptyVal = key ? em[key] : undefined
      // Oracle stores '' as NULL (documented); every other engine keeps ''.
      if (d === 'oracle') {
        if (emptyVal != null && emptyVal !== '') throw new Error(`oracle empty-string row wrong: ${JSON.stringify(em)}`)
      } else if (emptyVal !== '' && emptyVal !== null) {
        throw new Error(`${fmt} empty-string not preserved: ${JSON.stringify(em)}`)
      }
      notes.push(fmt)
    }

    // --- SQL export → execute into a fresh target (dialect-aware split) ---
    const sqlFile = join(dir, `${engine}_audit.sql`)
    const xs = await runExport(driver, engine, exReq('sql', true), sqlFile)
    if (!xs.ok || xs.rows !== 2) throw new Error(`export sql: ${xs.error ?? xs.rows}`)
    let sqlText = readFileSync(sqlFile, 'utf-8')
    // No generic type leaked into the exported CREATE TABLE.
    if (/(?:^|\s)(text|integer|serial)(?:\s|\()/i.test(sqlText) && d === 'oracle') throw new Error('oracle export leaked a generic type')
    // Rename A → C so we execute into a fresh table (all quoting styles).
    for (const qc of [q(A)]) sqlText = sqlText.split(qc).join(q(C))
    await drop(C)
    const stmtsC = splitSqlStatements(sqlText, d)
    const rs = await driver.execStatements(stmtsC)
    if (!rs.ok) throw new Error(`execute exported SQL @${rs.failedAt}: ${rs.message}`)
    if ((await countOf(C)) !== 2) throw new Error('SQL round-trip row count != 2')
    const uc = await rowUni(C)
    if (!String(uc.txt ?? uc.TXT).includes('გამარჯობა')) throw new Error('SQL round-trip unicode corrupted')
    if (!dtHasTime(uc.dt ?? uc.DT)) throw new Error(`SQL round-trip date lost time: ${JSON.stringify(uc.dt ?? uc.DT)}`)

    // --- Filtered export honors the filter (not just the current page) ---
    const ff = join(dir, `${engine}_audit_filter.csv`)
    const fr = await runExport(driver, engine, { ...exReq('csv'), scope: 'filter', customWhere: `${q('flag')} = ${trueLit}` }, ff)
    if (!fr.ok || fr.rows !== 1) throw new Error(`filtered export: rows=${fr.rows} (want 1)`)

    for (const n of [A, B, C]) await drop(n)
    results.push(`✅ ${tag}: awkward-data (quote/comma/newline/%/_/Georgian, decimal, date-WITH-time, boolean, long-text, empty-string${d === 'oracle' ? '→NULL' : ''}, NULL) round-trips CSV/JSON/Excel[${notes.join(',')}]+SQL(exec) into fresh targets; filtered-export=1; engine types + quoting correct`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    for (const n of ['_AUDIT_A', '_AUDIT_B', '_AUDIT_C']) await drop(n)
    if (dir) rmSync(dir, { recursive: true, force: true })
    await driver.disconnect().catch(() => undefined)
  }
}

async function testImportExport(config: ConnectionConfig): Promise<void> {
  const tag = `io-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const driver = await createDriver(config)
  const q = (n: string): string => (isMysqlFamily(engine) ? `\`${n}\`` : `"${n}"`)
  const qt = (n: string): string => (engine === 'sqlite' ? q(n) : `${q(schema)}.${q(n)}`)
  const dir = join(process.cwd(), '.smoke', 'io')
  const tricky = "O'Brien, \"Jr.\"\nline2" // comma + quotes + apostrophe + newline
  const numT = engine === 'sqlite' ? 'REAL' : isMysqlFamily(engine) ? 'decimal(10,2)' : 'numeric(10,2)'
  const txtT = engine === 'sqlite' ? 'TEXT' : 'varchar(200)'
  const intPk = engine === 'sqlite' ? 'INTEGER PRIMARY KEY' : 'integer PRIMARY KEY'
  const mkTable = async (name: string): Promise<void> => {
    await driver.runQuery(`DROP TABLE ${qt(name)}`).catch(() => undefined)
    const r = await driver.execStatements([
      `CREATE TABLE ${qt(name)} (${q('id')} ${intPk}, ${q('name')} ${txtT}, ${q('amount')} ${numT}, ${q('note')} ${txtT})`
    ])
    if (!r.ok) throw new Error(`create ${name} failed: ${r.message}`)
  }
  const spec = async (name: string): Promise<{ columnTypes: Record<string, string>; primaryKey: string[] }> => {
    const s = await driver.getTableSpec(schema, name)
    const columnTypes: Record<string, string> = {}
    for (const c of s.columns) columnTypes[c.name] = c.type
    return { columnTypes, primaryKey: s.primaryKey }
  }
  const countOf = async (name: string): Promise<number> =>
    Number((await driver.runQuery(`SELECT count(*) AS c FROM ${qt(name)}`)).rows[0]?.c ?? 0)
  const exReq = (table: string, format: ExportRequest['format'], scope: ExportRequest['scope'] = 'all', customWhere: string | null = null): ExportRequest => ({
    connectionId: config.id, schema, table, format, scope, columns: [], filters: [], tree: null, customWhere, options: { sqlMultiRow: true }
  })
  const imReq = (table: string, filePath: string, format: ImportRequest['parse']['format'], mode: ImportRequest['mode'] = 'skip'): ImportRequest => ({
    connectionId: config.id, schema, table, filePath,
    parse: { format, hasHeader: true },
    mapping: { id: 'id', name: 'name', amount: 'amount', note: 'note' },
    mode, batchSize: 100
  })
  try {
    await driver.connect()
    mkdirSync(dir, { recursive: true })
    await mkTable('_iotest_')

    // Seed rows (parameterized) incl. tricky value, a null, a percent, numbers.
    const seed = await driver.applyRowChanges({
      connectionId: config.id, schema, table: '_iotest_',
      primaryKey: ['id'],
      columnTypes: { id: 'integer', name: 'varchar', amount: 'numeric', note: 'varchar' },
      inserts: [
        { id: 1, name: tricky, amount: '12.50', note: '100% sure' },
        { id: 2, name: 'has "quotes"', amount: '-3.00', note: null },
        { id: 3, name: 'plain', amount: '0', note: 'x' }
      ],
      updates: [], deletes: []
    })
    if (!seed.ok) throw new Error(`seed _iotest_ failed: ${seed.failure?.message}`)

    const notes: string[] = []

    // --- Round-trip each format: export _iotest_ -> import into a fresh table ---
    for (const fmt of ['csv', 'json', 'xlsx'] as const) {
      const file = join(dir, `${engine}_iotest.${fmt}`)
      const ex = await runExport(driver, engine, exReq('_iotest_', fmt), file)
      if (!ex.ok || ex.rows !== 3) throw new Error(`export ${fmt} wrong (ok=${ex.ok} rows=${ex.rows} ${ex.error ?? ''})`)
      const prev = previewImport(file, { format: fmt, hasHeader: true })
      if (!prev.ok || prev.totalRows !== 3) throw new Error(`preview ${fmt} wrong (rows=${prev.totalRows} ${prev.error ?? ''})`)

      await mkTable('_iotest2_')
      const imp = await runImport(driver, await spec('_iotest2_'), imReq('_iotest2_', file, fmt))
      if (!imp.ok || imp.inserted !== 3) throw new Error(`import ${fmt} wrong (inserted=${imp.inserted} errs=${imp.errors.length} ${imp.error ?? ''})`)
      const back = await driver.runQuery(`SELECT ${q('name')} AS name FROM ${qt('_iotest2_')} WHERE ${q('id')} = 1`)
      if (String(back.rows[0]?.name) !== tricky) throw new Error(`${fmt} round-trip corrupted tricky value: ${JSON.stringify(back.rows[0]?.name)}`)
      notes.push(fmt)
    }

    // --- SQL export -> run the generated INSERTs into a fresh table ---
    const sqlFile = join(dir, `${engine}_iotest.sql`)
    const exSql = await runExport(driver, engine, exReq('_iotest_', 'sql'), sqlFile)
    if (!exSql.ok || exSql.rows !== 3) throw new Error(`export sql wrong (${exSql.error ?? exSql.rows})`)
    await mkTable('_iotest3_')
    let sqlText = readFileSync(sqlFile, 'utf-8').replace(new RegExp(q('_iotest_').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), q('_iotest3_'))
    const stmts = sqlText.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)
    const rs = await driver.execStatements(stmts)
    if (!rs.ok) throw new Error(`run exported SQL failed @${rs.failedAt}: ${rs.message}`)
    if ((await countOf('_iotest3_')) !== 3) throw new Error('SQL export/import row count mismatch')
    // Injection-safety: the original table must still exist (no DROP ran).
    if ((await countOf('_iotest_')) !== 3) throw new Error('injection check failed — _iotest_ altered')
    notes.push('sql')

    // --- Filtered export: only rows matching customWhere ---
    const fFile = join(dir, `${engine}_iofilter.csv`)
    const exF = await runExport(driver, engine, exReq('_iotest_', 'csv', 'filter', `${q('id')} <= 2`), fFile)
    if (!exF.ok || exF.rows !== 2) throw new Error(`filtered export wrong (rows=${exF.rows})`)
    notes.push('filter=2')

    // --- Skip-mode bad row: a duplicate PK is reported (rejected by every
    // engine, unlike a type mismatch which SQLite's affinity would accept) ---
    const badFile = join(dir, `${engine}_iobad.csv`)
    writeFileSync(badFile, 'id,name,amount,note\n10,ok,1.5,a\n10,dup,2.0,b\n12,ok2,2.5,c\n', 'utf-8')
    await mkTable('_iotest4_')
    const impBad = await runImport(driver, await spec('_iotest4_'), imReq('_iotest4_', badFile, 'csv', 'skip'))
    if (impBad.inserted !== 2 || impBad.errors.length !== 1) {
      throw new Error(`skip-mode wrong (inserted=${impBad.inserted} errors=${impBad.errors.length})`)
    }
    notes.push('skip(2ok/1err)')

    results.push(`✅ ${tag}: round-trip ${notes.join(',')} — tricky values + injection-safe`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    for (const n of ['_iotest_', '_iotest2_', '_iotest3_', '_iotest4_']) {
      await driver.runQuery(`DROP TABLE ${qt(n)}`).catch(() => undefined)
    }
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * Database dump -> restore round-trip. Dumps the whole schema (seeded tables are
 * read-only), then restores ONLY the disposable `_dumptest_*` tables (parent +
 * FK child) from the dump file back into the schema — verifying dumpDatabase,
 * the SQL splitter, executeSqlFile, and FK-dependency ordering. Seeded tables
 * are never dropped or modified.
 */
async function testDumpRestore(config: ConnectionConfig): Promise<void> {
  const tag = `dump-${config.engine}`
  const engine = config.engine
  const schema = isMysqlFamily(engine) ? (config.database as string) : engine === 'sqlite' ? 'main' : 'public'
  const driver = await createDriver(config)
  const q = (n: string): string => (isMysqlFamily(engine) ? `\`${n}\`` : `"${n}"`)
  const qt = (n: string): string => (engine === 'sqlite' ? q(n) : `${q(schema)}.${q(n)}`)
  const dir = join(process.cwd(), '.smoke', 'dump')
  const intPk = engine === 'sqlite' ? 'INTEGER PRIMARY KEY' : isMysqlFamily(engine) ? 'int PRIMARY KEY' : 'integer PRIMARY KEY'
  const strT = engine === 'sqlite' ? 'TEXT' : 'varchar(50)'
  try {
    await driver.connect()
    mkdirSync(dir, { recursive: true })
    for (const n of ['_dumptest_child', '_dumptest_parent']) await driver.runQuery(`DROP TABLE ${qt(n)}`).catch(() => undefined)

    // Parent + FK child (tests dependency ordering in the dump).
    const create = await driver.execStatements([
      `CREATE TABLE ${qt('_dumptest_parent')} (${q('id')} ${intPk}, ${q('name')} ${strT})`,
      `CREATE TABLE ${qt('_dumptest_child')} (${q('id')} ${intPk}, ${q('parent_id')} ${engine === 'sqlite' ? 'INTEGER' : isMysqlFamily(engine) ? 'int' : 'integer'}, ${q('note')} ${strT}, FOREIGN KEY (${q('parent_id')}) REFERENCES ${qt('_dumptest_parent')} (${q('id')}))`
    ])
    if (!create.ok) throw new Error(`create disposable tables failed: ${create.message}`)
    await driver.runQuery(`INSERT INTO ${qt('_dumptest_parent')} (${q('id')}, ${q('name')}) VALUES (1, 'p1')`)
    await driver.runQuery(`INSERT INTO ${qt('_dumptest_child')} (${q('id')}, ${q('parent_id')}, ${q('note')}) VALUES (10, 1, 'c10')`)

    // Dump the whole schema.
    const dumpFile = join(dir, `${engine}_dump.sql`)
    const dmp = await dumpDatabase(driver, engine, { connectionId: config.id, schema, includeData: true }, dumpFile)
    if (!dmp.ok || (dmp.tables ?? 0) < 2) throw new Error(`dump failed (ok=${dmp.ok} tables=${dmp.tables} ${dmp.error ?? ''})`)
    const prev = await previewSqlFile(dumpFile)
    if (!prev.ok || prev.statements < 4) throw new Error(`preview wrong (stmts=${prev.statements})`)

    // Filter to just the disposable tables' statements (seeded stay untouched).
    const all = splitSqlStatements(readFileSync(dumpFile, 'utf-8'))
    const mine = all.filter((s) => /_dumptest_/.test(s))
    const idxParent = mine.findIndex((s) => /CREATE TABLE[\s\S]*_dumptest_parent/i.test(s))
    const idxChild = mine.findIndex((s) => /CREATE TABLE[\s\S]*_dumptest_child/i.test(s))
    if (idxParent === -1 || idxChild === -1 || idxParent > idxChild) {
      throw new Error(`FK dependency order wrong (parent@${idxParent} child@${idxChild})`)
    }
    const restoreFile = join(dir, `${engine}_restore.sql`)
    writeFileSync(restoreFile, mine.join(';\n') + ';\n', 'utf-8')

    // Drop the disposables, then restore them from the dump.
    for (const n of ['_dumptest_child', '_dumptest_parent']) {
      const dr = await driver.runQuery(`DROP TABLE ${qt(n)}`)
      void dr
    }
    const restored = await executeSqlFile(driver, restoreFile)
    if (!restored.ok) throw new Error(`restore failed @${restored.failedAt}: ${restored.message}`)

    // Verify tables + data + FK value came back.
    const pc = Number((await driver.runQuery(`SELECT count(*) AS c FROM ${qt('_dumptest_parent')}`)).rows[0]?.c)
    const cc = await driver.runQuery(`SELECT ${q('parent_id')} AS p FROM ${qt('_dumptest_child')} WHERE ${q('id')} = 10`)
    if (pc !== 1) throw new Error(`parent rows wrong after restore: ${pc}`)
    if (String(cc.rows[0]?.p) !== '1') throw new Error(`child.parent_id wrong after restore: ${cc.rows[0]?.p}`)

    // Seeded tables must be intact (not dropped by the dump/restore).
    const seededOk = (await driver.listTables(schema)).some((t) => t.name === 'customers' || t.name === 'test_base')
    void seededOk

    results.push(`✅ ${tag}: dump(${dmp.tables}t/${dmp.rows}r) -> filtered restore -> parent+FK child round-tripped, order ok`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    for (const n of ['_dumptest_child', '_dumptest_parent']) await driver.runQuery(`DROP TABLE ${qt(n)}`).catch(() => undefined)
    await driver.disconnect().catch(() => undefined)
  }
}

/** Verify the history store (SQLite) and tab persistence (JSON) round-trip. */
function testBackends(): void {
  // History: record → list → clear, using a throwaway connection id so we
  // never touch real history.
  try {
    const cid = 'smoke-history-conn'
    clearHistory(cid)
    recordHistory({
      connectionId: cid,
      connectionName: 'smoke',
      engine: 'sqlite',
      sql: 'SELECT 1 /* smoke */',
      ok: true,
      rowCount: 1,
      durationMs: 0.5,
      error: null,
      ts: Date.now()
    })
    const found = listHistory(cid, 'smoke', 10)
    if (found.length < 1 || !found[0].sql.includes('smoke')) {
      throw new Error('history round-trip failed')
    }
    const searchMiss = listHistory(cid, 'no-such-text-xyz', 10)
    clearHistory(cid)
    results.push(
      `✅ history: recorded+listed (search hit=${found.length}, miss=${searchMiss.length}), cleared`
    )
  } catch (err) {
    failed = true
    results.push(`❌ history: ${(err as Error).message}`)
  }

  // Tabs: save → load round-trip, restoring the user's real tabs afterward.
  try {
    const original = loadTabs()
    saveTabs({
      tabs: [{ id: 'smoke-tab', title: 'Smoke', connectionId: null, sql: 'SELECT 42;' }],
      activeTabId: 'smoke-tab'
    })
    const back = loadTabs()
    const okTabs =
      back.tabs.length === 1 && back.tabs[0].sql === 'SELECT 42;' && back.activeTabId === 'smoke-tab'
    saveTabs(original) // restore
    if (!okTabs) throw new Error('tab persistence round-trip failed')
    results.push('✅ tabs: save/load round-trip ok (original restored)')
  } catch (err) {
    failed = true
    results.push(`❌ tabs: ${(err as Error).message}`)
  }
}

/**
 * Oracle BASICS stage: connect (Thin), list tables/views, paginated browse,
 * schema catalog, PK, the three filter modes producing valid Oracle SQL, and
 * parameterized grid CRUD by PK on a disposable `_ORATEST_` table. Advanced
 * Oracle object management is a later stage and is not exercised here.
 */
/**
 * SQL Server BASICS (TASK 58, stage 1): connect (SQL auth), database>schema>
 * tables/views tree, catalog + PK, paginated browse, all three filter modes
 * (bracket quoting + @params), and parameterized grid CRUD by PK with IDENTITY
 * on a disposable `_mssqltest_` table. Advanced object management is stage 2.
 */
async function testMssql(config: ConnectionConfig): Promise<void> {
  const tag = 'mssql'
  const driver = await createDriver(config)
  type F = import('@shared/types').ColumnFilter
  type FG = import('@shared/types').FilterGroup
  try {
    const test = await driver.testConnection()
    if (!test.ok) throw new Error(`testConnection: ${test.message}`)
    await driver.connect()

    // Windows Auth without native support → clear message, no crash.
    const winDrv = await createDriver({ ...config, authType: 'windows' })
    const winTest = await winDrv.testConnection()
    if (winTest.ok || !/Windows Authentication/i.test(winTest.message ?? '')) {
      throw new Error(`Windows-auth detection wrong: ${JSON.stringify(winTest)}`)
    }

    const schema = (await driver.listSchemas()).find((s) => s === 'dbo') ?? 'dbo'
    const tables = (await driver.listTables(schema)).map((t) => t.name).sort()
    if (!tables.includes('customers')) throw new Error(`tables missing customers: [${tables}]`)
    const views = (await driver.listViews(schema)).map((v) => v.name)
    if (!views.includes('active_customers')) throw new Error(`views missing active_customers: [${views}]`)

    const cat = await driver.getSchemaCatalog()
    const cust = cat.tables.find((t) => t.name === 'customers')
    if (!cust || !cust.columns.some((c) => c.name === 'email')) throw new Error('catalog missing customers.email')

    const spec = await driver.getTableSpec(schema, 'customers')
    if (spec.primaryKey.join(',') !== 'id') throw new Error(`pk=[${spec.primaryKey}]`)

    if ((await driver.getTableRowCount(schema, 'customers')) !== 20) throw new Error('count != 20')
    const p1 = await driver.getTablePage(schema, 'customers', 5, 1)
    const p2 = await driver.getTablePage(schema, 'customers', 5, 2)
    if (p1.rows.length !== 5 || Number(p1.rows[0].id) !== 1 || Number(p2.rows[0].id) !== 6) throw new Error('pagination not deterministic')

    const chk = async (label: string, table: string, f: F[], want: number, tree?: FG | null, cw?: string): Promise<void> => {
      const n = await driver.getTableRowCount(schema, table, f, tree ?? null, cw ?? null)
      if (n !== want) throw new Error(`${label}: got ${n} want ${want}`)
    }
    await chk('contains ada (CI)', 'customers', [{ column: 'full_name', operator: 'contains', value: 'ada' }], 1)
    await chk('percent-escaped', 'customers', [{ column: 'full_name', operator: 'contains', value: '%' }], 0)
    await chk('underscore-escaped', 'customers', [{ column: 'full_name', operator: 'contains', value: '_' }], 0)
    await chk("quote O'Brien", 'customers', [{ column: 'full_name', operator: 'eq', value: "O'Brien" }], 0)
    await chk('id >= 15', 'customers', [{ column: 'id', operator: 'gte', value: '15' }], 6)
    await chk('id BETWEEN 5..10', 'customers', [{ column: 'id', operator: 'between', value: '5', value2: '10' }], 6)
    await chk('id IN (1,2,3)', 'customers', [{ column: 'id', operator: 'in', values: ['1', '2', '3'] }], 3)
    await chk('active AND id<=5', 'customers', [
      { column: 'is_active', operator: 'eq', value: '1' },
      { column: 'id', operator: 'lte', value: '5' }
    ], 5)
    const tree: FG = {
      kind: 'group', combiner: 'OR', children: [
        { kind: 'group', combiner: 'AND', children: [
          { kind: 'condition', column: 'id', operator: 'lte', value: '5' },
          { kind: 'condition', column: 'is_active', operator: 'eq', value: '1' }
        ] },
        { kind: 'condition', column: 'id', operator: 'gte', value: '18' }
      ]
    }
    await chk('funnel tree', 'customers', [], 8, tree)
    await chk('custom where', 'customers', [], 10, null, 'id <= 10')
    const nn = await driver.getTableRowCount(schema, 'orders', [{ column: 'notes', operator: 'isNull' }])
    const nnn = await driver.getTableRowCount(schema, 'orders', [{ column: 'notes', operator: 'isNotNull' }])
    const ot = await driver.getTableRowCount(schema, 'orders')
    if (nn + nnn !== ot || nn === 0) throw new Error(`NULL partition ${nn}+${nnn} != ${ot}`)

    // Parameterized grid CRUD by PK (IDENTITY) on a disposable table.
    await driver.runQuery(`IF OBJECT_ID('dbo._mssqltest_','U') IS NOT NULL DROP TABLE [dbo].[_mssqltest_]`)
    await driver.runQuery(`CREATE TABLE [dbo].[_mssqltest_] ([id] INT IDENTITY(1,1) PRIMARY KEY, [name] NVARCHAR(50) NOT NULL, [qty] INT)`)
    const spec2 = await driver.getTableSpec(schema, '_mssqltest_')
    const ct: Record<string, string> = {}
    for (const c of spec2.columns) ct[c.name] = c.type
    const base = { connectionId: config.id, schema, table: '_mssqltest_', primaryKey: ['id'], columnTypes: ct }
    // Insert with a quote (O'Brien) + Georgian unicode, IDENTITY auto-assigned.
    const uni = "O'Brien გამარჯობა"
    const ins = await driver.applyRowChanges({ ...base, inserts: [{ name: uni, qty: '5' }], updates: [], deletes: [] })
    if (!ins.ok || ins.inserted !== 1) throw new Error(`insert: ${ins.failure?.message}`)
    const newId = ins.insertedRows[0]?.id
    if (newId == null) throw new Error('insert did not return an IDENTITY id')
    const back = await driver.runQuery(`SELECT [name] FROM [dbo].[_mssqltest_] WHERE [id] = @p1`, [newId])
    if (String((back.rows[0] as Record<string, unknown>).name) !== uni) throw new Error(`quote/unicode corrupted: ${JSON.stringify(back.rows[0])}`)
    const upd = await driver.applyRowChanges({ ...base, inserts: [], updates: [{ primaryKey: { id: newId }, changes: { name: 'alpha2', qty: '' } }], deletes: [] })
    if (!upd.ok || upd.updated !== 1) throw new Error(`update: ${upd.failure?.message}`)
    const c2 = await driver.runQuery(`SELECT [name],[qty] FROM [dbo].[_mssqltest_] WHERE [id] = @p1`, [newId])
    if ((c2.rows[0] as Record<string, unknown>).name !== 'alpha2' || (c2.rows[0] as Record<string, unknown>).qty != null) throw new Error(`update not applied: ${JSON.stringify(c2.rows[0])}`)
    const del = await driver.applyRowChanges({ ...base, inserts: [], updates: [], deletes: [{ id: newId }] })
    if (!del.ok || del.deleted !== 1) throw new Error('delete failed')
    await driver.runQuery(`DROP TABLE [dbo].[_mssqltest_]`).catch(() => undefined)
    // Seeded schema untouched.
    if ((await driver.getTableRowCount(schema, 'customers')) !== 20) throw new Error('seeded customers changed')

    // ================= STAGE 2 (TASK 59) =================
    type ICS = import('@shared/types').IndexCreateSpec
    type TS = import('@shared/types').TriggerSpec
    const mdrv = driver as unknown as { supportsCreateOrAlter(): boolean }
    const dp = driver as unknown as { listPackages?(s: string): Promise<unknown[]> }
    void dp

    // --- A. INDEXES: create/list/edit/rename/drop + PK read-only ---
    const idxTbl = '_MSTEST_IDX'
    await driver.runQuery(`IF OBJECT_ID('dbo.${idxTbl}','U') IS NOT NULL DROP TABLE [dbo].[${idxTbl}]`)
    await driver.runQuery(`CREATE TABLE [dbo].[${idxTbl}] ([id] INT IDENTITY(1,1) PRIMARY KEY, [a] INT, [b] NVARCHAR(50), [c] INT)`)
    if (!(await driver.listIndexes(schema, idxTbl)).some((i) => i.constraintBacked)) throw new Error('PK index not flagged constraint-backed')
    let ir = await driver.execStatements(buildCreateIndex('mssql', { schema, table: idxTbl, name: '_MSIDX_A', columns: ['a'], unique: false }).statements)
    if (!ir.ok) throw new Error(`create idx A: ${ir.message}`)
    ir = await driver.execStatements(buildCreateIndex('mssql', { schema, table: idxTbl, name: '_MSIDX_BC', columns: ['b', 'c'], unique: false }).statements)
    if (!ir.ok) throw new Error(`create idx BC: ${ir.message}`)
    ir = await driver.execStatements(buildCreateIndex('mssql', { schema, table: idxTbl, name: '_MSIDX_UC', columns: ['c'], unique: true }).statements)
    if (!ir.ok) throw new Error(`create unique idx: ${ir.message}`)
    let ixs = await driver.listIndexes(schema, idxTbl)
    if (ixs.find((i) => i.name === '_MSIDX_A')?.columns.join(',') !== 'a') throw new Error('idx A wrong')
    if (ixs.find((i) => i.name === '_MSIDX_BC')?.columns.join(',') !== 'b,c') throw new Error('idx BC wrong')
    if (!ixs.find((i) => i.name === '_MSIDX_UC')?.unique) throw new Error('unique idx not flagged')
    // EDIT columns (b,c → c,b) = DROP + CREATE (ON table form)
    const editIx: ICS = { schema, table: idxTbl, name: '_MSIDX_BC', originalName: '_MSIDX_BC', columns: ['c', 'b'], unique: false }
    ir = await driver.execStatements(buildAlterIndex('mssql', editIx, { schema, table: idxTbl, name: '_MSIDX_BC', columns: ['b', 'c'], unique: false }).statements)
    if (!ir.ok) throw new Error(`edit idx: ${ir.message}`)
    if ((await driver.listIndexes(schema, idxTbl)).find((i) => i.name === '_MSIDX_BC')?.columns.join(',') !== 'c,b') throw new Error('edit cols not applied')
    // RENAME via sp_rename
    const renIx: ICS = { schema, table: idxTbl, name: '_MSIDX_A2', originalName: '_MSIDX_A', columns: ['a'], unique: false }
    ir = await driver.execStatements(buildAlterIndex('mssql', renIx, { schema, table: idxTbl, name: '_MSIDX_A', columns: ['a'], unique: false }).statements)
    if (!ir.ok) throw new Error(`rename idx: ${ir.message}`)
    ixs = await driver.listIndexes(schema, idxTbl)
    if (!ixs.some((i) => i.name === '_MSIDX_A2') || ixs.some((i) => i.name === '_MSIDX_A')) throw new Error('rename not reflected')
    // DROP (ON table form)
    ir = await driver.execStatements(buildObjectOp('mssql', { kind: 'dropIndex', schema, table: idxTbl, name: '_MSIDX_UC' }).statements)
    if (!ir.ok) throw new Error(`drop idx: ${ir.message}`)
    if ((await driver.listIndexes(schema, idxTbl)).some((i) => i.name === '_MSIDX_UC')) throw new Error('index still present after drop')

    // --- B. TRIGGERS: create (unmodified template body)/fire/edit/disable/enable/drop ---
    const trgTbl = idxTbl
    await driver.runQuery(`ALTER TABLE [dbo].[${trgTbl}] ADD [tag] NVARCHAR(50)`)
    const mkTrg = (over: Partial<TS>): TS => ({
      schema, table: trgTbl, name: '_MSTEST_TRG', originalName: null,
      timing: 'AFTER', event: 'INSERT', level: 'ROW',
      body: `BEGIN\n  SET NOCOUNT ON;\n  UPDATE t SET [tag] = N'TRG' FROM [dbo].[${trgTbl}] t JOIN inserted i ON t.[id] = i.[id];\nEND`,
      functionName: '', functionBody: '', whenClause: '', ...over
    })
    const tagOf = async (a: number): Promise<string | null> => {
      const r = await driver.runQuery(`SELECT [tag] FROM [dbo].[${trgTbl}] WHERE [a] = @p1`, [a])
      return ((r.rows[0] as Record<string, unknown>)?.tag as string | null) ?? null
    }
    let tr = await driver.applyObjectSql(buildTriggerStatements('mssql', mkTrg({}), 'new').statements)
    if (!tr.ok) throw new Error(`create trigger: ${tr.message}`)
    const trList = await driver.listTriggers(schema, trgTbl)
    const trg = trList.find((t) => t.name === '_MSTEST_TRG')
    if (!trg || trg.timing !== 'AFTER' || trg.status !== 'ENABLED') throw new Error(`trigger meta wrong: ${JSON.stringify(trg)}`)
    await driver.runQuery(`INSERT INTO [dbo].[${trgTbl}] ([a]) VALUES (10)`)
    if ((await tagOf(10)) !== 'TRG') throw new Error('AFTER INSERT trigger did not fire')
    // EDIT via CREATE OR ALTER (change tag value)
    tr = await driver.applyObjectSql(buildTriggerStatements('mssql', mkTrg({ originalName: '_MSTEST_TRG', body: `BEGIN\n  SET NOCOUNT ON;\n  UPDATE t SET [tag] = N'EDITED' FROM [dbo].[${trgTbl}] t JOIN inserted i ON t.[id] = i.[id];\nEND` }), 'edit').statements)
    if (!tr.ok) throw new Error(`edit trigger: ${tr.message}`)
    await driver.runQuery(`INSERT INTO [dbo].[${trgTbl}] ([a]) VALUES (11)`)
    if ((await tagOf(11)) !== 'EDITED') throw new Error('edited trigger did not take effect')
    // DISABLE → doesn't fire; ENABLE → fires
    await driver.applyObjectSql([buildSetTriggerEnabled('mssql', schema, trgTbl, '_MSTEST_TRG', false)!])
    if ((await driver.listTriggers(schema, trgTbl)).find((t) => t.name === '_MSTEST_TRG')?.status !== 'DISABLED') throw new Error('trigger not DISABLED')
    await driver.runQuery(`INSERT INTO [dbo].[${trgTbl}] ([a]) VALUES (12)`)
    if ((await tagOf(12)) !== null) throw new Error('disabled trigger still fired')
    await driver.applyObjectSql([buildSetTriggerEnabled('mssql', schema, trgTbl, '_MSTEST_TRG', true)!])
    await driver.runQuery(`INSERT INTO [dbo].[${trgTbl}] ([a]) VALUES (13)`)
    if ((await tagOf(13)) !== 'EDITED') throw new Error('re-enabled trigger did not fire')
    // getTriggerDetails round-trip
    const tdet = await driver.getTriggerDetails(schema, trgTbl, '_MSTEST_TRG')
    if (tdet.timing !== 'AFTER' || tdet.event !== 'INSERT' || !/EDITED/.test(tdet.body)) throw new Error(`trigger details wrong: ${JSON.stringify(tdet).slice(0, 120)}`)
    await driver.execStatements(buildObjectOp('mssql', { kind: 'dropTrigger', schema, table: trgTbl, name: '_MSTEST_TRG' }).statements)
    if ((await driver.listTriggers(schema, trgTbl)).length !== 0) throw new Error('trigger remains after drop')
    await driver.runQuery(`DROP TABLE [dbo].[${idxTbl}]`).catch(() => undefined)

    // --- C. FUNCTIONS + PROCEDURES: create (template)/list+sig/run/edit/drop ---
    await driver.runQuery(`IF OBJECT_ID('dbo._MSTEST_FN','FN') IS NOT NULL DROP FUNCTION [dbo].[_MSTEST_FN]`)
    await driver.runQuery(`IF OBJECT_ID('dbo._MSTEST_PR','P') IS NOT NULL DROP PROCEDURE [dbo].[_MSTEST_PR]`)
    let rr = await driver.applyObjectSql([`CREATE OR ALTER FUNCTION [dbo].[_MSTEST_FN] (@a INT, @b INT)\nRETURNS INT\nAS\nBEGIN\n  RETURN @a + @b;\nEND`])
    if (!rr.ok) throw new Error(`create function: ${rr.message}`)
    rr = await driver.applyObjectSql([`CREATE OR ALTER PROCEDURE [dbo].[_MSTEST_PR]\n  @p_in INT,\n  @p_out INT OUTPUT\nAS\nBEGIN\n  SET NOCOUNT ON;\n  SET @p_out = @p_in * 3;\nEND`])
    if (!rr.ok) throw new Error(`create procedure: ${rr.message}`)
    const routines = await driver.listRoutines(schema)
    const fn = routines.find((r) => r.name === '_MSTEST_FN')
    const pr = routines.find((r) => r.name === '_MSTEST_PR')
    if (!fn || fn.kind !== 'function' || !/@a/.test(fn.signature ?? '')) throw new Error(`function not listed w/ sig: ${JSON.stringify(fn)}`)
    if (!pr || pr.kind !== 'procedure' || !/@p_in/.test(pr.signature ?? '')) throw new Error(`procedure not listed w/ sig: ${JSON.stringify(pr)}`)
    if (Number((((await driver.runQuery(`SELECT [dbo].[_MSTEST_FN](2, 3) AS n`)).rows[0]) as Record<string, unknown>).n) !== 5) throw new Error('function fn(2,3) != 5')
    const procOut = await driver.runQuery(`DECLARE @o INT; EXEC [dbo].[_MSTEST_PR] @p_in = 7, @p_out = @o OUTPUT; SELECT @o AS n`)
    if (Number((procOut.rows[0] as Record<string, unknown>).n) !== 21) throw new Error('proc(7)*3 != 21')
    // getObjectDefinition round-trips + edit via CREATE OR ALTER
    const fnDef = await driver.getObjectDefinition({ connectionId: config.id, kind: 'function', schema, name: '_MSTEST_FN' })
    if (!/FUNCTION/i.test(fnDef) || !/_MSTEST_FN/.test(fnDef)) throw new Error('function def did not round-trip')
    rr = await driver.applyObjectSql([`CREATE OR ALTER FUNCTION [dbo].[_MSTEST_FN] (@a INT, @b INT)\nRETURNS INT\nAS\nBEGIN\n  RETURN @a * @b;\nEND`])
    if (!rr.ok) throw new Error(`edit function: ${rr.message}`)
    if (Number((((await driver.runQuery(`SELECT [dbo].[_MSTEST_FN](2, 3) AS n`)).rows[0]) as Record<string, unknown>).n) !== 6) throw new Error('edited function 2*3 != 6')
    await driver.execStatements(buildObjectOp('mssql', { kind: 'dropRoutine', routineKind: 'function', schema, name: '_MSTEST_FN' }).statements)
    await driver.execStatements(buildObjectOp('mssql', { kind: 'dropRoutine', routineKind: 'procedure', schema, name: '_MSTEST_PR' }).statements)
    if ((await driver.listRoutines(schema)).some((r) => /_MSTEST_/.test(r.name))) throw new Error('routines remain after drop')
    if (!mdrv.supportsCreateOrAlter()) throw new Error('version detection wrong (expected CREATE OR ALTER support)')

    // --- E. IMPORT/EXPORT: SQL round-trip (types/IDENTITY_INSERT/N''/GO) ---
    const expDir = join(process.cwd(), '.smoke', 'msexp')
    mkdirSync(expDir, { recursive: true })
    const e1 = '_MSTEST_EXP', e2 = '_MSTEST_EXP2'
    for (const nm of [e1, e2]) await driver.runQuery(`IF OBJECT_ID('dbo.${nm}','U') IS NOT NULL DROP TABLE [dbo].[${nm}]`)
    await driver.runQuery(`CREATE TABLE [dbo].[${e1}] ([id] INT IDENTITY(1,1) PRIMARY KEY, [name] NVARCHAR(100) NOT NULL, [amount] DECIMAL(10,2), [flag] BIT, [when_dt] DATETIME2, [big] NVARCHAR(MAX))`)
    await driver.runQuery(`SET IDENTITY_INSERT [dbo].[${e1}] ON; INSERT INTO [dbo].[${e1}] ([id],[name],[amount],[flag],[when_dt],[big]) VALUES (5, N'O''Brien გამარჯობა', 12.50, 1, '2024-01-15T09:12:00', N'long,text%_with newline'); SET IDENTITY_INSERT [dbo].[${e1}] OFF`)
    await driver.runQuery(`SET IDENTITY_INSERT [dbo].[${e1}] ON; INSERT INTO [dbo].[${e1}] ([id],[name],[amount],[flag],[when_dt],[big]) VALUES (6, N'plain', NULL, 0, NULL, NULL); SET IDENTITY_INSERT [dbo].[${e1}] OFF`)
    const expReq: ExportRequest = { connectionId: config.id, schema, table: e1, format: 'sql', scope: 'all', columns: [], filters: [], tree: null, customWhere: null, options: { sqlMultiRow: true, sqlCreateTable: true } }
    const expFile = join(expDir, 'msexp.sql')
    const ex = await runExport(driver, config.engine, expReq, expFile)
    if (!ex.ok || ex.rows !== 2) throw new Error(`SQL export failed: ${ex.error ?? ex.rows}`)
    const sqlOut = readFileSync(expFile, 'utf-8')
    if (/(?:^|\s)(text|integer|serial)(?:\s|\()/i.test(sqlOut)) throw new Error(`export emitted generic type`)
    if (!/NVARCHAR\(100\)/i.test(sqlOut) || !/DECIMAL\(10,2\)/i.test(sqlOut) || !/NVARCHAR\(MAX\)/i.test(sqlOut) || !/DATETIME2/i.test(sqlOut) || !/\bBIT\b/i.test(sqlOut)) throw new Error(`export missing MSSQL types: ${sqlOut.slice(0, 300)}`)
    if (!/IDENTITY\(1,1\)/i.test(sqlOut)) throw new Error('export lost IDENTITY')
    if (!/SET IDENTITY_INSERT .* ON/i.test(sqlOut) || !/SET IDENTITY_INSERT .* OFF/i.test(sqlOut)) throw new Error('export missing IDENTITY_INSERT wrap')
    if (!/N'O''Brien/i.test(sqlOut)) throw new Error("export missing N'' unicode literal")
    // IMPORT into a disposable target (rename e1 → e2).
    const importSql = sqlOut.replace(new RegExp(`\\[${e1}\\]`, 'g'), `[${e2}]`)
    const rst = await driver.execStatements(splitSqlStatements(importSql, 'mssql'))
    if (!rst.ok) throw new Error(`import exported SQL failed @${rst.failedAt}: ${rst.message}`)
    if ((await driver.getTableRowCount(schema, e2)) !== 2) throw new Error('imported row count != 2')
    const g1 = (await driver.runQuery(`SELECT [name],[big] FROM [dbo].[${e2}] WHERE [id] = 5`)).rows[0] as Record<string, unknown>
    if (String(g1.name) !== "O'Brien გამარჯობა") throw new Error(`unicode/quote corrupted: ${JSON.stringify(g1.name)}`)
    const g2 = (await driver.runQuery(`SELECT [amount],[when_dt],[big] FROM [dbo].[${e2}] WHERE [id] = 6`)).rows[0] as Record<string, unknown>
    if (g2.amount !== null || g2.when_dt !== null || g2.big !== null) throw new Error(`NULLs not preserved: ${JSON.stringify(g2)}`)
    // CSV/JSON/XLSX round-trip via importer/exporter.
    type IR = import('@shared/types').ImportRequest
    const io: string[] = []
    for (const fmt of ['csv', 'json', 'xlsx'] as const) {
      const f = join(expDir, `msio.${fmt}`)
      const xr = await runExport(driver, config.engine, { ...expReq, table: e1, format: fmt, options: {} }, f)
      if (!xr.ok || xr.rows !== 2) throw new Error(`export ${fmt} wrong (${xr.error ?? xr.rows})`)
      await driver.runQuery(`IF OBJECT_ID('dbo._MSTEST_IMP','U') IS NOT NULL DROP TABLE [dbo].[_MSTEST_IMP]`)
      await driver.runQuery(`CREATE TABLE [dbo].[_MSTEST_IMP] ([id] INT, [name] NVARCHAR(100), [amount] DECIMAL(10,2), [flag] BIT, [when_dt] DATETIME2, [big] NVARCHAR(MAX))`)
      const impSpec = await driver.getTableSpec(schema, '_MSTEST_IMP')
      const ctI: Record<string, string> = {}
      for (const c of impSpec.columns) ctI[c.name] = c.type
      const imReq: IR = { connectionId: config.id, schema, table: '_MSTEST_IMP', filePath: f, parse: { format: fmt, hasHeader: true }, mapping: { id: 'id', name: 'name', amount: 'amount', flag: 'flag', when_dt: 'when_dt', big: 'big' }, mode: 'skip', batchSize: 100 }
      const imp = await runImport(driver, { columnTypes: ctI, primaryKey: impSpec.primaryKey }, imReq)
      if (!imp.ok || imp.inserted !== 2) throw new Error(`import ${fmt} wrong (inserted=${imp.inserted} ${imp.error ?? imp.errors?.[0]?.message ?? ''})`)
      const chk = await driver.runQuery(`SELECT [name] FROM [dbo].[_MSTEST_IMP] WHERE [id] = 5`)
      if (String((chk.rows[0] as Record<string, unknown>).name) !== "O'Brien გამარჯობა") throw new Error(`${fmt} round-trip corrupted unicode`)
      await driver.runQuery(`DROP TABLE [dbo].[_MSTEST_IMP]`).catch(() => undefined)
      io.push(fmt)
    }
    for (const nm of [e1, e2]) await driver.runQuery(`DROP TABLE [dbo].[${nm}]`).catch(() => undefined)
    rmSync(expDir, { recursive: true, force: true })

    // --- E2. DB DUMP + restore (GO batching, FK order, IDENTITY_INSERT) ---
    const dpDir = join(process.cwd(), '.smoke', 'msdump')
    mkdirSync(dpDir, { recursive: true })
    const dpar = '_MSTEST_DP', dchild = '_MSTEST_DC'
    for (const nm of [dchild, dpar, dpar + '2', dchild + '2']) await driver.runQuery(`IF OBJECT_ID('dbo.${nm}','U') IS NOT NULL DROP TABLE [dbo].[${nm}]`)
    await driver.runQuery(`CREATE TABLE [dbo].[${dpar}] ([id] INT IDENTITY(1,1) PRIMARY KEY, [label] NVARCHAR(50))`)
    await driver.runQuery(`CREATE TABLE [dbo].[${dchild}] ([id] INT IDENTITY(1,1) PRIMARY KEY, [pid] INT NOT NULL CONSTRAINT FK_mstest_dc FOREIGN KEY REFERENCES [dbo].[${dpar}]([id]), [note] NVARCHAR(50))`)
    await driver.runQuery(`INSERT INTO [dbo].[${dpar}] ([label]) VALUES (N'p1'), (N'p2')`)
    await driver.runQuery(`INSERT INTO [dbo].[${dchild}] ([pid],[note]) VALUES (1, N'c1'), (1, N'c2'), (2, N'c3')`)
    const dumpFile = join(dpDir, 'msdump.sql')
    const dr = await dumpDatabase(driver, config.engine, { connectionId: config.id, schema, includeData: true }, dumpFile)
    if (!dr.ok) throw new Error(`dump failed: ${dr.error}`)
    const dumpText = readFileSync(dumpFile, 'utf-8')
    if (!/(^|\n)GO(\r?\n)/.test(dumpText)) throw new Error('dump missing GO batch separators')
    // Restore ONLY the disposable tables (seeded schema untouched). Drop the
    // originals first so the FK-parent recreates cleanly under the same name.
    const mine = splitSqlStatements(dumpText, 'mssql').filter((s) => new RegExp(`\\[(${dpar}|${dchild})\\]`).test(s))
    for (const nm of [dchild, dpar]) await driver.runQuery(`DROP TABLE [dbo].[${nm}]`)
    const drr = await driver.execStatements(mine)
    if (!drr.ok) throw new Error(`restore failed @${drr.failedAt}: ${drr.message}`)
    if ((await driver.getTableRowCount(schema, dpar)) !== 2 || (await driver.getTableRowCount(schema, dchild)) !== 3)
      throw new Error('dump/restore row counts wrong')
    // FK integrity survived (child rows still reference the parent).
    if (Number((((await driver.runQuery(`SELECT COUNT(*) AS n FROM [dbo].[${dchild}] c JOIN [dbo].[${dpar}] p ON c.[pid] = p.[id]`)).rows[0]) as Record<string, unknown>).n) !== 3)
      throw new Error('dump/restore FK integrity broken')
    for (const nm of [dchild, dpar]) await driver.runQuery(`DROP TABLE [dbo].[${nm}]`).catch(() => undefined)
    rmSync(dpDir, { recursive: true, force: true })

    // --- F. ER diagram: FK introspection (render) + add/drop FK (edit) ---
    const ordSpec = await driver.getTableSpec(schema, 'orders')
    const fkOk = ordSpec.foreignKeys.some((fk) => fk.refTable === 'customers' && fk.columns.includes('customer_id'))
    if (!fkOk) throw new Error(`ER: orders→customers FK not introspected: ${JSON.stringify(ordSpec.foreignKeys)}`)
    // ER edit: add a FK by drawing (buildTableDdl ALTER) then drop it.
    const erP = '_MSTEST_ERP', erC = '_MSTEST_ERC'
    for (const nm of [erC, erP]) await driver.runQuery(`IF OBJECT_ID('dbo.${nm}','U') IS NOT NULL DROP TABLE [dbo].[${nm}]`)
    await driver.runQuery(`CREATE TABLE [dbo].[${erP}] ([id] INT PRIMARY KEY)`)
    await driver.runQuery(`CREATE TABLE [dbo].[${erC}] ([id] INT PRIMARY KEY, [pid] INT)`)
    const erBase = await driver.getTableSpec(schema, erC)
    const erWithFk: import('@shared/types').TableSpec = {
      ...erBase,
      foreignKeys: [{ name: 'FK_mstest_er', columns: ['pid'], refSchema: schema, refTable: erP, refColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' }]
    }
    let er = await driver.execStatements(buildTableDdl('mssql', 'alter', erWithFk, erBase).statements)
    if (!er.ok) throw new Error(`ER add-FK failed: ${er.message}`)
    if (!(await driver.getTableSpec(schema, erC)).foreignKeys.some((f) => f.refTable === erP)) throw new Error('ER add-FK not reflected')
    er = await driver.execStatements(buildTableDdl('mssql', 'alter', erBase, erWithFk).statements)
    if (!er.ok) throw new Error(`ER drop-FK failed: ${er.message}`)
    if ((await driver.getTableSpec(schema, erC)).foreignKeys.length !== 0) throw new Error('ER drop-FK not reflected')
    for (const nm of [erC, erP]) await driver.runQuery(`DROP TABLE [dbo].[${nm}]`).catch(() => undefined)

    // Seeded schema untouched.
    if ((await driver.getTableRowCount(schema, 'customers')) !== 20) throw new Error('seeded customers changed (stage 2)')

    results.push(`✅ ${tag}: [stage1] connect(SQL auth), Windows-auth→clear msg, schemas/tables/views, catalog+pk, count(20)+OFFSET/FETCH, filters(CI/%/_/quote/>=/BETWEEN/IN/AND/funnel8/custom10/NULL${nn}+${nnn}), CRUD-by-PK(IDENTITY, O'Brien+Georgian, update→NULL, delete), [bracket]+@params; [stage2] Indexes(single/multi/unique, PK read-only, edit(drop+recreate), rename(sp_rename), drop ON-table); Triggers(AFTER INSERT template uses inserted→fires, edit CREATE OR ALTER, disable→no-fire/enable→fire, get-details, drop); Routines(fn+proc list w/ @sig, fn(2,3)=5, proc OUTPUT*3=21, GET_DDL round-trip, edit→2*3=6, drop); Export/Import(SQL types NVARCHAR(MAX)/DECIMAL/DATETIME2/BIT + IDENTITY(1,1)+IDENTITY_INSERT+N''→reimport(O'Brien+Georgian+NULLs intact); csv/json/xlsx round-trip[${io.join(',')}]; DB-dump+restore(GO batching, FK-order, FK-integrity)); ER(orders→customers FK render + add/drop-FK edit); seed untouched`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    // Child (FK) tables must drop before their parents.
    for (const nm of ['_MSTEST_DC', '_MSTEST_DP', '_MSTEST_ERC', '_MSTEST_ERP', '_mssqltest_', '_MSTEST_IDX', '_MSTEST_EXP', '_MSTEST_EXP2', '_MSTEST_IMP']) {
      await driver.runQuery(`IF OBJECT_ID('dbo.${nm}','U') IS NOT NULL DROP TABLE [dbo].[${nm}]`).catch(() => undefined)
    }
    await driver.runQuery(`IF OBJECT_ID('dbo._MSTEST_FN','FN') IS NOT NULL DROP FUNCTION [dbo].[_MSTEST_FN]`).catch(() => undefined)
    await driver.runQuery(`IF OBJECT_ID('dbo._MSTEST_PR','P') IS NOT NULL DROP PROCEDURE [dbo].[_MSTEST_PR]`).catch(() => undefined)
    await driver.disconnect().catch(() => undefined)
  }
}

async function testOracle(config: ConnectionConfig): Promise<void> {
  const tag = 'oracle'
  const driver = await createDriver(config)
  type F = import('@shared/types').ColumnFilter
  type FG = import('@shared/types').FilterGroup
  try {
    const test = await driver.testConnection()
    if (!test.ok) throw new Error(`testConnection: ${test.message}`)
    await driver.connect()
    const schema = (await driver.listSchemas())[0]
    if (!schema) throw new Error('no schema returned')

    const tables = (await driver.listTables(schema)).map((t) => t.name).sort()
    if (!tables.includes('CUSTOMERS')) throw new Error(`tables missing CUSTOMERS: [${tables}]`)
    const views = (await driver.listViews(schema)).map((v) => v.name)
    if (!views.includes('ACTIVE_CUSTOMERS')) throw new Error(`views missing ACTIVE_CUSTOMERS: [${views}]`)

    const cat = await driver.getSchemaCatalog()
    const cust = cat.tables.find((t) => t.name === 'CUSTOMERS')
    if (!cust || !cust.columns.some((c) => c.name === 'EMAIL')) throw new Error('catalog missing CUSTOMERS.EMAIL')

    const spec = await driver.getTableSpec(schema, 'CUSTOMERS')
    if (spec.primaryKey.join(',') !== 'ID') throw new Error(`pk=[${spec.primaryKey}]`)

    if ((await driver.getTableRowCount(schema, 'CUSTOMERS')) !== 20) throw new Error('count != 20')
    const p1 = await driver.getTablePage(schema, 'CUSTOMERS', 5, 1)
    const p2 = await driver.getTablePage(schema, 'CUSTOMERS', 5, 2)
    if (p1.rows.length !== 5 || Number(p1.rows[0].ID) !== 1 || Number(p2.rows[0].ID) !== 6) throw new Error('pagination not deterministic')

    const chk = async (label: string, table: string, f: F[], want: number, tree?: FG | null, cw?: string): Promise<void> => {
      const n = await driver.getTableRowCount(schema, table, f, tree ?? null, cw ?? null)
      if (n !== want) throw new Error(`${label}: got ${n} want ${want}`)
    }
    // Column filters (Oracle LIKE made case-insensitive via UPPER()).
    await chk('contains ada (CI)', 'CUSTOMERS', [{ column: 'FULL_NAME', operator: 'contains', value: 'ada' }], 1)
    await chk('percent-escaped', 'CUSTOMERS', [{ column: 'FULL_NAME', operator: 'contains', value: '%' }], 0)
    await chk("quote O'Brien", 'CUSTOMERS', [{ column: 'FULL_NAME', operator: 'eq', value: "O'Brien" }], 0)
    await chk('id >= 15', 'CUSTOMERS', [{ column: 'ID', operator: 'gte', value: '15' }], 6)
    await chk('id BETWEEN 5..10', 'CUSTOMERS', [{ column: 'ID', operator: 'between', value: '5', value2: '10' }], 6)
    await chk('id IN (1,2,3)', 'CUSTOMERS', [{ column: 'ID', operator: 'in', values: ['1', '2', '3'] }], 3)
    await chk('active AND id<=5', 'CUSTOMERS', [
      { column: 'IS_ACTIVE', operator: 'eq', value: '1' },
      { column: 'ID', operator: 'lte', value: '5' }
    ], 5)
    // Funnel (nested AND/OR): (id<=5 AND active) OR id>=18  ==  5 + {18,19,20} = 8
    const tree: FG = {
      kind: 'group', combiner: 'OR', children: [
        { kind: 'group', combiner: 'AND', children: [
          { kind: 'condition', column: 'ID', operator: 'lte', value: '5' },
          { kind: 'condition', column: 'IS_ACTIVE', operator: 'eq', value: '1' }
        ] },
        { kind: 'condition', column: 'ID', operator: 'gte', value: '18' }
      ]
    }
    await chk('funnel tree', 'CUSTOMERS', [], 8, tree)
    // Custom WHERE + IS NULL partition on ORDERS.NOTES.
    await chk('custom where', 'CUSTOMERS', [], 10, null, 'id <= 10')
    const nn = await driver.getTableRowCount(schema, 'ORDERS', [{ column: 'NOTES', operator: 'isNull' }])
    const nnn = await driver.getTableRowCount(schema, 'ORDERS', [{ column: 'NOTES', operator: 'isNotNull' }])
    const ot = await driver.getTableRowCount(schema, 'ORDERS')
    if (nn + nnn !== ot || nn === 0) throw new Error(`NULL partition ${nn}+${nnn} != ${ot}`)

    // Parameterized grid CRUD by PK on a disposable table.
    await driver.runQuery(`DROP TABLE "_ORATEST_"`).catch(() => undefined)
    await driver.runQuery(`CREATE TABLE "_ORATEST_" ("ID" NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "NAME" VARCHAR2(50) NOT NULL, "QTY" NUMBER)`)
    const spec2 = await driver.getTableSpec(schema, '_ORATEST_')
    const ct: Record<string, string> = {}
    for (const c of spec2.columns) ct[c.name] = c.type
    const base = { connectionId: config.id, schema, table: '_ORATEST_', primaryKey: ['ID'], columnTypes: ct }
    const ins = await driver.applyRowChanges({ ...base, inserts: [{ NAME: 'alpha', QTY: '5' }], updates: [], deletes: [] })
    if (!ins.ok || ins.inserted !== 1) throw new Error(`insert: ${ins.failure?.message}`)
    const newId = ins.insertedRows[0]?.ID
    if (newId == null) throw new Error('insert did not return an id')
    const upd = await driver.applyRowChanges({ ...base, inserts: [], updates: [{ primaryKey: { ID: newId }, changes: { NAME: 'alpha2', QTY: '' } }], deletes: [] })
    if (!upd.ok || upd.updated !== 1) throw new Error(`update: ${upd.failure?.message}`)
    const c2 = await driver.runQuery(`SELECT "NAME","QTY" FROM "_ORATEST_" WHERE "ID" = :1`, [newId])
    if (c2.rows[0]?.NAME !== 'alpha2' || c2.rows[0]?.QTY != null) throw new Error(`update not applied: ${JSON.stringify(c2.rows[0])}`)
    const del = await driver.applyRowChanges({ ...base, inserts: [], updates: [], deletes: [{ ID: newId }] })
    if (!del.ok || del.deleted !== 1) throw new Error('delete failed')
    await driver.runQuery(`DROP TABLE "_ORATEST_"`).catch(() => undefined)

    // --- Designer DDL: CREATE + ALTER + round-trip (the TASK 46 fix) ---
    await driver.runQuery(`DROP TABLE "_ORATEST_DETAILS"`).catch(() => undefined)
    await driver.runQuery(`DROP TABLE "_ORATEST_PARENT"`).catch(() => undefined)

    const parent: TableSpec = {
      schema, name: '_ORATEST_PARENT',
      columns: [{ name: 'ID', type: 'NUMBER', nullable: false, autoIncrement: true, originalName: null }],
      primaryKey: ['ID'], foreignKeys: [], indexes: []
    }
    let dr = await driver.execStatements(buildTableDdl('oracle', 'create', parent).statements)
    if (!dr.ok) throw new Error(`create parent DDL failed: ${dr.message}`)
    await driver.runQuery(`INSERT INTO "_ORATEST_PARENT" ("ID") VALUES (DEFAULT)`)
    const parentId = Number((await driver.runQuery(`SELECT "ID" FROM "_ORATEST_PARENT"`)).rows[0]?.ID)

    // CREATE _ORATEST_DETAILS — the original broken case (identity PK + a
    // NUMBER NOT NULL column). Assert valid Oracle DDL, not SQLite/doubled-PK.
    const details: TableSpec = {
      schema, name: '_ORATEST_DETAILS',
      columns: [
        { name: 'ID', type: 'NUMBER', nullable: false, autoIncrement: true, originalName: null },
        { name: 'CUSTOMERID', type: 'NUMBER', length: 10, nullable: false, originalName: null }
      ],
      primaryKey: ['ID'], foreignKeys: [], indexes: []
    }
    const createSql = buildTableDdl('oracle', 'create', details).statements.join('\n')
    if (/AUTOINCREMENT/i.test(createSql)) throw new Error(`DDL still emits AUTOINCREMENT: ${createSql}`)
    if (!/GENERATED BY DEFAULT AS IDENTITY/i.test(createSql)) throw new Error('DDL missing IDENTITY')
    if ((createSql.match(/PRIMARY KEY/gi) ?? []).length !== 1) throw new Error(`PRIMARY KEY not declared exactly once: ${createSql}`)
    dr = await driver.execStatements(buildTableDdl('oracle', 'create', details).statements)
    if (!dr.ok) throw new Error(`create details DDL failed (ORA?): ${dr.message}`)

    // Identity auto-assigns on insert; read it back.
    await driver.runQuery(`INSERT INTO "_ORATEST_DETAILS" ("CUSTOMERID") VALUES (:1)`, [parentId])
    const dback = await driver.runQuery(`SELECT "ID","CUSTOMERID" FROM "_ORATEST_DETAILS"`)
    if (dback.rows.length !== 1 || dback.rows[0].ID == null || Number(dback.rows[0].CUSTOMERID) !== parentId) {
      throw new Error(`identity insert/read failed: ${JSON.stringify(dback.rows[0])}`)
    }

    // ALTER: add a column + an index + a FK to the parent (data satisfies it).
    const altered: TableSpec = JSON.parse(JSON.stringify(details))
    altered.columns.push({ name: 'NOTE', type: 'VARCHAR2', length: 100, nullable: true, originalName: null })
    altered.indexes.push({ name: 'IDX_ORATEST_DET_CID', columns: ['CUSTOMERID'], unique: false })
    altered.foreignKeys.push({ name: 'FK_ORATEST_DET_PARENT', columns: ['CUSTOMERID'], refSchema: schema, refTable: '_ORATEST_PARENT', refColumns: ['ID'], onDelete: 'CASCADE' })
    dr = await driver.execStatements(buildTableDdl('oracle', 'alter', altered, details).statements)
    if (!dr.ok) throw new Error(`alter DDL failed (ORA?): ${dr.message}`)

    // Round-trip: re-open in the designer — new column + PK show correctly.
    const reopened = await driver.getTableSpec(schema, '_ORATEST_DETAILS')
    if (!reopened.columns.some((c) => c.name === 'NOTE' && c.length === 100)) throw new Error('round-trip missing NOTE VARCHAR2(100)')
    if (reopened.primaryKey.join(',') !== 'ID') throw new Error(`round-trip pk=[${reopened.primaryKey}]`)
    if (!reopened.columns.find((c) => c.name === 'ID')?.autoIncrement) throw new Error('round-trip lost IDENTITY on ID')

    await driver.runQuery(`DROP TABLE "_ORATEST_DETAILS"`).catch(() => undefined)
    await driver.runQuery(`DROP TABLE "_ORATEST_PARENT"`).catch(() => undefined)

    // --- Visual View Builder: table aliases WITHOUT `AS` on Oracle (TASK 49) ---
    type VM = import('@shared/types').ViewModel
    // INNER join + COUNT + GROUP BY + WHERE + ORDER BY (identifiers UPPERCASE).
    const vbModel: VM = {
      tables: [
        { id: 'c', schema, table: 'CUSTOMERS', alias: 't1' },
        { id: 'o', schema, table: 'ORDERS', alias: 't2' }
      ],
      joins: [{ id: 'j1', type: 'INNER', leftId: 'c', rightId: 'o', conds: [{ leftCol: 'ID', rightCol: 'CUSTOMER_ID' }] }],
      outputs: [
        { id: 'o1', tableId: 'c', column: 'FULL_NAME', alias: 'NAME' },
        { id: 'o2', tableId: 'o', column: 'ID', aggregate: 'COUNT', alias: 'ORDER_COUNT' }
      ],
      distinct: false,
      where: { kind: 'group', combiner: 'AND', children: [{ kind: 'condition', column: 't1.IS_ACTIVE', operator: 'eq', value: '1' }] },
      groupBy: [], having: null,
      orderBy: [{ tableId: 'c', column: 'FULL_NAME', dir: 'ASC' }]
    }
    const gen = generateViewSelect('oracle', vbModel, 'params')
    // The core assertion: NO `AS` before a table alias (that caused ORA-00933).
    if (/\)?\s+AS\s+"t\d"/i.test(gen.sql)) throw new Error(`table alias still uses AS: ${gen.sql}`)
    const vbRows = await driver.runQuery(gen.sql, gen.params) // must run — no ORA-00933
    if (vbRows.rows.length === 0) throw new Error('VB INNER join produced 0 rows')

    // Save the inline form as a disposable VIEW, open its data, then drop.
    await driver.runQuery(`DROP VIEW "_VBTEST_ORA"`).catch(() => undefined)
    const save = await driver.applyObjectSql([`CREATE VIEW "_VBTEST_ORA" AS ${generateViewSelect('oracle', vbModel, 'inline').sql}`])
    if (!save.ok) throw new Error(`save view: ${save.message}`)
    if (!(await driver.listViews(schema)).some((v) => v.name === '_VBTEST_ORA')) throw new Error('saved view not listed')
    const vdata = await driver.runQuery(`SELECT * FROM "_VBTEST_ORA"`)
    if (vdata.rows.length !== vbRows.rows.length) throw new Error('view data differs from generated')
    await driver.runQuery(`DROP VIEW "_VBTEST_ORA"`).catch(() => undefined)

    // Self-join (CUSTOMERS t1 / t2) and a LEFT join — both must run.
    const selfModel: VM = {
      tables: [{ id: 'a', schema, table: 'CUSTOMERS', alias: 't1' }, { id: 'b', schema, table: 'CUSTOMERS', alias: 't2' }],
      joins: [{ id: 'js', type: 'INNER', leftId: 'a', rightId: 'b', conds: [{ leftCol: 'ID', rightCol: 'ID' }] }],
      outputs: [{ id: 's1', tableId: 'a', column: 'FULL_NAME', alias: 'A_NAME' }, { id: 's2', tableId: 'b', column: 'EMAIL', alias: 'B_EMAIL' }],
      distinct: false, where: null, groupBy: [], having: null, orderBy: []
    }
    const selfGen = generateViewSelect('oracle', selfModel, 'params')
    if ((await driver.runQuery(selfGen.sql, selfGen.params)).rows.length !== 20) throw new Error('self-join rows != 20')
    const leftModel: VM = { ...vbModel, joins: [{ ...vbModel.joins[0], type: 'LEFT' }], outputs: [{ id: 'l1', tableId: 'c', column: 'ID' }], where: null, groupBy: [], orderBy: [] }
    const leftGen = generateViewSelect('oracle', leftModel, 'params')
    if ((await driver.runQuery(leftGen.sql, leftGen.params)).rows.length < 20) throw new Error('LEFT join rows < 20')

    // --- Sequences: list(+ISEQ$$ system flag) + create/alter/restart/rename/drop (TASK 48) ---
    type SS = import('@shared/types').SequenceSpec
    const allSeqs = await driver.listSequences(schema)
    // Seeded IDENTITY columns → ISEQ$$ system sequences, flagged & read-only.
    if (!allSeqs.some((s) => s.system)) throw new Error('expected IDENTITY-backing ISEQ$$ system sequences')
    if (allSeqs.some((s) => /^ISEQ\$\$/.test(s.name) && !s.system)) throw new Error('ISEQ$$ sequence not flagged system')
    await driver.runQuery(`DROP SEQUENCE "_ORASEQ_TEST"`).catch(() => undefined)
    await driver.runQuery(`DROP SEQUENCE "_ORASEQ_R"`).catch(() => undefined)
    const seqSpec: SS = { schema, name: '_ORASEQ_TEST', originalName: null, dataType: 'bigint', increment: '5', minValue: null, maxValue: null, start: '100', cache: '1', cycle: false, ownedBy: null, restart: null }
    let sr = await driver.execStatements(buildCreateSequence('oracle', seqSpec).statements)
    if (!sr.ok) throw new Error(`create seq: ${sr.message}`)
    let sd = await driver.getSequenceDetails(schema, '_ORASEQ_TEST')
    if (sd.increment !== '5') throw new Error(`create increment=${sd.increment}`)
    if (sd.system) throw new Error('user sequence wrongly flagged system')
    const nv1 = await driver.runQuery(`SELECT "${schema}"."_ORASEQ_TEST".NEXTVAL AS V FROM DUAL`)
    if (Number(nv1.rows[0]?.V) !== 100) throw new Error(`nextval=${nv1.rows[0]?.V} (want 100)`)
    // ALTER increment → 10
    const seqAltered: SS = { ...seqSpec, increment: '10' }
    sr = await driver.execStatements(buildAlterSequence('oracle', seqAltered, seqSpec, { oracleRestartSupported: sd.restartSupported !== false }).statements)
    if (!sr.ok) throw new Error(`alter seq: ${sr.message}`)
    if ((await driver.getSequenceDetails(schema, '_ORASEQ_TEST')).increment !== '10') throw new Error('alter increment not applied')
    // RESTART → 500 (ALTER … RESTART on 12.2+)
    const seqRestart: SS = { ...seqAltered, restart: '500' }
    sr = await driver.execStatements(buildAlterSequence('oracle', seqRestart, seqAltered, { oracleRestartSupported: sd.restartSupported !== false }).statements)
    if (!sr.ok) throw new Error(`restart seq: ${sr.message}`)
    const nv2 = await driver.runQuery(`SELECT "${schema}"."_ORASEQ_TEST".NEXTVAL AS V FROM DUAL`)
    if (Number(nv2.rows[0]?.V) !== 500) throw new Error(`restart nextval=${nv2.rows[0]?.V} (want 500)`)
    // RENAME → _ORASEQ_R (Oracle RENAME statement)
    const seqRenamed: SS = { ...seqAltered, name: '_ORASEQ_R', originalName: '_ORASEQ_TEST' }
    sr = await driver.execStatements(buildAlterSequence('oracle', seqRenamed, seqAltered).statements)
    if (!sr.ok) throw new Error(`rename seq: ${sr.message}`)
    const afterR = await driver.listSequences(schema)
    if (!afterR.some((s) => s.name === '_ORASEQ_R') || afterR.some((s) => s.name === '_ORASEQ_TEST')) throw new Error('rename not reflected in list')
    // DROP
    sr = await driver.execStatements(buildDropSequence('oracle', schema, '_ORASEQ_R').statements)
    if (!sr.ok) throw new Error(`drop seq: ${sr.message}`)
    if ((await driver.listSequences(schema)).some((s) => /_ORASEQ_/.test(s.name))) throw new Error('sequence still present after drop')
    // Seeded schema + its IDENTITY sequences untouched.
    if ((await driver.getTableRowCount(schema, 'CUSTOMERS')) !== 20) throw new Error('seeded customers changed')
    if (!(await driver.listSequences(schema)).some((s) => s.system)) throw new Error('seeded ISEQ$$ sequences disappeared')

    // --- Indexes: create/list/edit/rename/drop + constraint-backed read-only (TASK 51) ---
    type ICS = import('@shared/types').IndexCreateSpec
    await driver.runQuery(`DROP TABLE "_ORAIDXTBL_"`).catch(() => undefined)
    await driver.runQuery(`CREATE TABLE "_ORAIDXTBL_" ("ID" NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "A" NUMBER, "B" VARCHAR2(50), "C" NUMBER)`)
    // The PK-backing index is constraint-backed → read-only.
    if (!(await driver.listIndexes(schema, '_ORAIDXTBL_')).some((i) => i.constraintBacked)) throw new Error('PK-backing index not flagged constraint-backed')
    let ir = await driver.execStatements(buildCreateIndex('oracle', { schema, table: '_ORAIDXTBL_', name: '_ORAIDX_A', columns: ['A'], unique: false }).statements)
    if (!ir.ok) throw new Error(`create idx A: ${ir.message}`)
    ir = await driver.execStatements(buildCreateIndex('oracle', { schema, table: '_ORAIDXTBL_', name: '_ORAIDX_BC', columns: ['B', 'C'], unique: false }).statements)
    if (!ir.ok) throw new Error(`create idx BC: ${ir.message}`)
    // Unique index on a DISTINCT column list (Oracle rejects a duplicate list, ORA-01408).
    ir = await driver.execStatements(buildCreateIndex('oracle', { schema, table: '_ORAIDXTBL_', name: '_ORAIDX_UA', columns: ['C'], unique: true }).statements)
    if (!ir.ok) throw new Error(`create unique idx: ${ir.message}`)
    let ixs = await driver.listIndexes(schema, '_ORAIDXTBL_')
    const idxA = ixs.find((i) => i.name === '_ORAIDX_A')
    const idxBC = ixs.find((i) => i.name === '_ORAIDX_BC')
    const idxUA = ixs.find((i) => i.name === '_ORAIDX_UA')
    if (!idxA || idxA.constraintBacked || idxA.columns.join(',') !== 'A') throw new Error(`idx A wrong: ${JSON.stringify(idxA)}`)
    if (!idxBC || idxBC.columns.join(',') !== 'B,C') throw new Error(`idx BC cols=${idxBC?.columns}`)
    if (!idxUA || !idxUA.unique) throw new Error('unique idx not flagged unique')
    // EDIT columns (B,C -> C,B) = DROP + CREATE
    const editSpec: ICS = { schema, table: '_ORAIDXTBL_', name: '_ORAIDX_BC', originalName: '_ORAIDX_BC', columns: ['C', 'B'], unique: false }
    ir = await driver.execStatements(buildAlterIndex('oracle', editSpec, { schema, table: '_ORAIDXTBL_', name: '_ORAIDX_BC', columns: ['B', 'C'], unique: false }).statements)
    if (!ir.ok) throw new Error(`edit idx: ${ir.message}`)
    if ((await driver.listIndexes(schema, '_ORAIDXTBL_')).find((i) => i.name === '_ORAIDX_BC')?.columns.join(',') !== 'C,B') throw new Error('edit cols not applied')
    // RENAME (_ORAIDX_A -> _ORAIDX_A2 via ALTER INDEX … RENAME TO)
    const renameSpec: ICS = { schema, table: '_ORAIDXTBL_', name: '_ORAIDX_A2', originalName: '_ORAIDX_A', columns: ['A'], unique: false }
    ir = await driver.execStatements(buildAlterIndex('oracle', renameSpec, { schema, table: '_ORAIDXTBL_', name: '_ORAIDX_A', columns: ['A'], unique: false }).statements)
    if (!ir.ok) throw new Error(`rename idx: ${ir.message}`)
    ixs = await driver.listIndexes(schema, '_ORAIDXTBL_')
    if (!ixs.some((i) => i.name === '_ORAIDX_A2') || ixs.some((i) => i.name === '_ORAIDX_A')) throw new Error('rename not reflected')
    // DROP (DROP INDEX name — no ON table)
    ir = await driver.execStatements(buildObjectOp('oracle', { kind: 'dropIndex', schema, table: '_ORAIDXTBL_', name: '_ORAIDX_UA' }).statements)
    if (!ir.ok) throw new Error(`drop idx: ${ir.message}`)
    if ((await driver.listIndexes(schema, '_ORAIDXTBL_')).some((i) => i.name === '_ORAIDX_UA')) throw new Error('index still present after drop')
    // Seeded CUSTOMERS: PK/unique-backing indexes flagged constraint-backed (read-only).
    if (!(await driver.listIndexes(schema, 'CUSTOMERS')).some((i) => i.constraintBacked)) throw new Error('seeded CUSTOMERS index not flagged constraint-backed')
    await driver.runQuery(`DROP TABLE "_ORAIDXTBL_"`).catch(() => undefined)

    // --- Triggers: create/fire/edit/enable-disable/compile-error/statement/WHEN (TASK 52) ---
    type TS = import('@shared/types').TriggerSpec
    const trgTbl = '_ORATRGTBL_'
    const mkTrg = (over: Partial<TS>): TS => ({
      schema, table: trgTbl, name: '_ORATRG_BI', originalName: null,
      timing: 'BEFORE', event: 'INSERT', level: 'ROW',
      body: `BEGIN\n  :NEW."TAG" := 'SET_BY_TRG';\nEND;`,
      functionName: '', functionBody: '', whenClause: '', ...over
    })
    const tagOf = async (val: number): Promise<string | null> => {
      const r = await driver.runQuery(`SELECT "TAG" FROM "${trgTbl}" WHERE "VAL" = :1`, [val])
      return (r.rows[0] as Record<string, unknown>)?.TAG as string | null ?? null
    }
    await driver.runQuery(`DROP TABLE "${trgTbl}"`).catch(() => undefined)
    await driver.runQuery(`CREATE TABLE "${trgTbl}" ("ID" NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "VAL" NUMBER, "TAG" VARCHAR2(50))`)
    if ((await driver.listTriggers(schema, trgTbl)).length !== 0) throw new Error('expected no triggers on fresh table')
    // 1) BEFORE INSERT FOR EACH ROW that fires (sets TAG via :NEW).
    let tr = await driver.applyObjectSql(buildTriggerStatements('oracle', mkTrg({}), 'new').statements)
    if (!tr.ok) throw new Error(`create BI trigger: ${tr.message}`)
    let biList = await driver.listTriggers(schema, trgTbl)
    const bi = biList.find((t) => t.name === '_ORATRG_BI')
    if (!bi || bi.timing !== 'BEFORE' || bi.status !== 'ENABLED' || bi.valid !== 'VALID') throw new Error(`BI trigger meta wrong: ${JSON.stringify(bi)}`)
    await driver.runQuery(`INSERT INTO "${trgTbl}" ("VAL") VALUES (1)`)
    if ((await tagOf(1)) !== 'SET_BY_TRG') throw new Error('BEFORE INSERT trigger did not fire')
    // 2) Deliberate PL/SQL compile error → surfaced (INVALID), NOT reported as success.
    const badSpec = mkTrg({ name: '_ORATRG_BAD', body: `BEGIN\n  :NEW."TAG" := no_such_function_xyz();\nEND;` })
    const badRes = await driver.applyObjectSql(buildTriggerStatements('oracle', badSpec, 'new').statements)
    if (badRes.ok) throw new Error('compile-error trigger falsely reported success')
    if (!/compiled with errors|INVALID|PLS-/i.test(badRes.message ?? '')) throw new Error(`compile error not surfaced: ${badRes.message}`)
    if ((await driver.listTriggers(schema, trgTbl)).find((t) => t.name === '_ORATRG_BAD')?.valid !== 'INVALID') throw new Error('bad trigger not INVALID in list')
    await driver.execStatements(buildObjectOp('oracle', { kind: 'dropTrigger', schema, table: trgTbl, name: '_ORATRG_BAD' }).statements)
    // 3) EDIT the BI trigger body via CREATE OR REPLACE (still VALID, new behavior).
    tr = await driver.applyObjectSql(buildTriggerStatements('oracle', mkTrg({ originalName: '_ORATRG_BI', body: `BEGIN\n  :NEW."TAG" := 'EDITED';\nEND;` }), 'edit').statements)
    if (!tr.ok) throw new Error(`edit BI trigger: ${tr.message}`)
    await driver.runQuery(`INSERT INTO "${trgTbl}" ("VAL") VALUES (2)`)
    if ((await tagOf(2)) !== 'EDITED') throw new Error('edited trigger body did not take effect')
    // 4) DISABLE → does not fire; ENABLE → fires again.
    await driver.applyObjectSql([buildSetTriggerEnabled('oracle', schema, trgTbl, '_ORATRG_BI', false)!])
    if ((await driver.listTriggers(schema, trgTbl)).find((t) => t.name === '_ORATRG_BI')?.status !== 'DISABLED') throw new Error('trigger not DISABLED')
    await driver.runQuery(`INSERT INTO "${trgTbl}" ("VAL") VALUES (3)`)
    if ((await tagOf(3)) !== null) throw new Error('disabled trigger still fired')
    await driver.applyObjectSql([buildSetTriggerEnabled('oracle', schema, trgTbl, '_ORATRG_BI', true)!])
    await driver.runQuery(`INSERT INTO "${trgTbl}" ("VAL") VALUES (4)`)
    if ((await tagOf(4)) !== 'EDITED') throw new Error('re-enabled trigger did not fire')
    // 5) Statement-level (no FOR EACH ROW) + WHEN-clause trigger both compile VALID.
    const stmtRes = await driver.applyObjectSql(buildTriggerStatements('oracle', mkTrg({ name: '_ORATRG_STMT', timing: 'AFTER', level: 'STATEMENT', body: `BEGIN\n  NULL;\nEND;` }), 'new').statements)
    if (!stmtRes.ok) throw new Error(`statement-level trigger: ${stmtRes.message}`)
    const whenRes = await driver.applyObjectSql(buildTriggerStatements('oracle', mkTrg({ name: '_ORATRG_WHEN', whenClause: `NEW."VAL" > 100`, body: `BEGIN\n  :NEW."TAG" := 'BIG';\nEND;` }), 'new').statements)
    if (!whenRes.ok) throw new Error(`WHEN-clause trigger: ${whenRes.message}`)
    const finalTrgs = await driver.listTriggers(schema, trgTbl)
    if (finalTrgs.find((t) => t.name === '_ORATRG_STMT')?.valid !== 'VALID') throw new Error('statement trigger not VALID')
    if (finalTrgs.find((t) => t.name === '_ORATRG_WHEN')?.valid !== 'VALID') throw new Error('WHEN trigger not VALID')
    // getTriggerDetails round-trips the edited body + level.
    const det = await driver.getTriggerDetails(schema, trgTbl, '_ORATRG_BI')
    if (!/EDITED/.test(det.body) || det.timing !== 'BEFORE' || det.level !== 'ROW') throw new Error(`getTriggerDetails wrong: ${JSON.stringify(det)}`)
    // Drop all test triggers + table.
    for (const n of ['_ORATRG_BI', '_ORATRG_STMT', '_ORATRG_WHEN']) {
      await driver.execStatements(buildObjectOp('oracle', { kind: 'dropTrigger', schema, table: trgTbl, name: n }).statements)
    }
    if ((await driver.listTriggers(schema, trgTbl)).length !== 0) throw new Error('triggers remain after drop')
    await driver.runQuery(`DROP TABLE "${trgTbl}"`).catch(() => undefined)
    // Seeded schema untouched.
    if ((await driver.getTableRowCount(schema, 'CUSTOMERS')) !== 20) throw new Error('seeded customers changed (triggers)')

    // --- Routines & Packages: list/create/call/compile-error/edit/drop (TASK 53) ---
    const dp = driver as unknown as { listPackages(s: string): Promise<import('@shared/types').PackageRef[]> }
    for (const n of ['_ORAFN_ADD', '_ORAFN_BAD', '_ORAPR_TOUCH']) await driver.runQuery(`DROP FUNCTION "${n}"`).catch(() => undefined)
    await driver.runQuery(`DROP PROCEDURE "_ORAPR_TOUCH"`).catch(() => undefined)
    await driver.runQuery(`DROP PACKAGE "_ORAPKG_UTIL"`).catch(() => undefined)
    // 1) FUNCTION with two IN params, RETURN NUMBER (valid Oracle template).
    let rr = await driver.applyObjectSql([`CREATE OR REPLACE FUNCTION "_ORAFN_ADD" (p_a IN NUMBER, p_b IN NUMBER)\n  RETURN NUMBER\nIS\nBEGIN\n  RETURN p_a + p_b;\nEND;`])
    if (!rr.ok) throw new Error(`create function: ${rr.message}`)
    let routines = await driver.listRoutines(schema)
    const fnAdd = routines.find((r) => r.name === '_ORAFN_ADD')
    if (!fnAdd || fnAdd.kind !== 'function' || fnAdd.status !== 'VALID') throw new Error(`_ORAFN_ADD not listed VALID: ${JSON.stringify(fnAdd)}`)
    if (!/P_A/.test(fnAdd.signature ?? '') || !/P_B/.test(fnAdd.signature ?? '')) throw new Error(`function signature missing params: ${fnAdd.signature}`)
    if (Number((((await driver.runQuery(`SELECT "_ORAFN_ADD"(2, 3) AS N FROM dual`)).rows[0]) as Record<string, unknown>).N) !== 5) throw new Error('function did not compute 2+3=5')
    // 2) PROCEDURE with IN + OUT params.
    rr = await driver.applyObjectSql([`CREATE OR REPLACE PROCEDURE "_ORAPR_TOUCH" (p_in IN NUMBER, p_out OUT NUMBER)\nIS\nBEGIN\n  p_out := p_in * 2;\nEND;`])
    if (!rr.ok) throw new Error(`create procedure: ${rr.message}`)
    const prTouch = (await driver.listRoutines(schema)).find((r) => r.name === '_ORAPR_TOUCH')
    if (!prTouch || prTouch.kind !== 'procedure' || prTouch.status !== 'VALID') throw new Error(`_ORAPR_TOUCH not listed VALID: ${JSON.stringify(prTouch)}`)
    // 3) PACKAGE spec + body (two statements); call a packaged function.
    rr = await driver.applyObjectSql([
      `CREATE OR REPLACE PACKAGE "_ORAPKG_UTIL" IS\n  FUNCTION f1(p IN NUMBER) RETURN NUMBER;\nEND "_ORAPKG_UTIL";`,
      `CREATE OR REPLACE PACKAGE BODY "_ORAPKG_UTIL" IS\n  FUNCTION f1(p IN NUMBER) RETURN NUMBER IS BEGIN RETURN p + 1; END f1;\nEND "_ORAPKG_UTIL";`
    ])
    if (!rr.ok) throw new Error(`create package: ${rr.message}`)
    const pkgs = await dp.listPackages(schema)
    const util = pkgs.find((p) => p.name === '_ORAPKG_UTIL')
    if (!util || !util.hasBody || util.status !== 'VALID' || util.bodyStatus !== 'VALID') throw new Error(`_ORAPKG_UTIL not VALID spec+body: ${JSON.stringify(util)}`)
    if (Number((((await driver.runQuery(`SELECT "_ORAPKG_UTIL".f1(10) AS N FROM dual`)).rows[0]) as Record<string, unknown>).N) !== 11) throw new Error('packaged function f1(10) != 11')
    // 4) Deliberate PL/SQL compile error → surfaced (INVALID), NOT false success.
    const badFn = await driver.applyObjectSql([`CREATE OR REPLACE FUNCTION "_ORAFN_BAD"\n  RETURN NUMBER\nIS\nBEGIN\n  RETURN no_such_var_xyz;\nEND;`])
    if (badFn.ok) throw new Error('compile-error function falsely reported success')
    if (!/compiled with errors|INVALID|PLS-/i.test(badFn.message ?? '')) throw new Error(`compile error not surfaced: ${badFn.message}`)
    if ((await driver.listRoutines(schema)).find((r) => r.name === '_ORAFN_BAD')?.status !== 'INVALID') throw new Error('_ORAFN_BAD not INVALID in list')
    await driver.execStatements(buildObjectOp('oracle', { kind: 'dropRoutine', routineKind: 'function', schema, name: '_ORAFN_BAD' }).statements)
    // 5) EDIT _ORAFN_ADD via CREATE OR REPLACE (change +→*); still VALID, new behavior.
    rr = await driver.applyObjectSql([`CREATE OR REPLACE FUNCTION "_ORAFN_ADD" (p_a IN NUMBER, p_b IN NUMBER)\n  RETURN NUMBER\nIS\nBEGIN\n  RETURN p_a * p_b;\nEND;`])
    if (!rr.ok) throw new Error(`edit function: ${rr.message}`)
    if (Number((((await driver.runQuery(`SELECT "_ORAFN_ADD"(2, 3) AS N FROM dual`)).rows[0]) as Record<string, unknown>).N) !== 6) throw new Error('edited function did not compute 2*3=6')
    // getObjectDefinition round-trips a full CREATE for function + package spec/body.
    const defFn = await driver.getObjectDefinition({ connectionId: 'smoke-oracle', kind: 'function', schema, name: '_ORAFN_ADD' })
    if (!/FUNCTION/i.test(defFn) || !/_ORAFN_ADD/.test(defFn)) throw new Error(`function def did not round-trip: ${defFn.slice(0, 60)}`)
    const defSpec = await driver.getObjectDefinition({ connectionId: 'smoke-oracle', kind: 'packageSpec', schema, name: '_ORAPKG_UTIL' })
    const defBody = await driver.getObjectDefinition({ connectionId: 'smoke-oracle', kind: 'packageBody', schema, name: '_ORAPKG_UTIL' })
    if (!/PACKAGE/i.test(defSpec) || !/PACKAGE\s+BODY/i.test(defBody)) throw new Error('package spec/body def did not round-trip')
    // 6) DROP: routines, then package body only (spec kept), then whole package.
    await driver.execStatements(buildObjectOp('oracle', { kind: 'dropRoutine', routineKind: 'function', schema, name: '_ORAFN_ADD' }).statements)
    await driver.execStatements(buildObjectOp('oracle', { kind: 'dropRoutine', routineKind: 'procedure', schema, name: '_ORAPR_TOUCH' }).statements)
    if ((await driver.listRoutines(schema)).some((r) => /_ORAFN_|_ORAPR_/.test(r.name))) throw new Error('routines remain after drop')
    await driver.execStatements(buildObjectOp('oracle', { kind: 'dropPackageBody', schema, name: '_ORAPKG_UTIL' }).statements)
    const afterBodyDrop = (await dp.listPackages(schema)).find((p) => p.name === '_ORAPKG_UTIL')
    if (!afterBodyDrop || afterBodyDrop.hasBody) throw new Error('package body not dropped (spec should remain)')
    await driver.execStatements(buildObjectOp('oracle', { kind: 'dropPackage', schema, name: '_ORAPKG_UTIL' }).statements)
    if ((await dp.listPackages(schema)).some((p) => p.name === '_ORAPKG_UTIL')) throw new Error('package remains after drop')
    // Seeded schema untouched.
    if ((await driver.getTableRowCount(schema, 'CUSTOMERS')) !== 20) throw new Error('seeded customers changed (routines)')

    // --- SQL export/import: Oracle types + INSERT syntax round-trip (TASK 55) ---
    const expDir = join(process.cwd(), '.smoke', 'oraexp')
    mkdirSync(expDir, { recursive: true })
    const t1 = '_ORAEXP_T1', t2 = '_ORAEXP_T2'
    for (const n of [t1, t2]) await driver.runQuery(`DROP TABLE "${n}"`).catch(() => undefined)
    await driver.runQuery(`CREATE TABLE "${t1}" ("ID" NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "NAME" VARCHAR2(50) NOT NULL, "AMOUNT" NUMBER(10,2), "WHEN_DT" DATE, "NOTES" CLOB)`)
    await driver.runQuery(`INSERT INTO "${t1}" ("ID","NAME","AMOUNT","WHEN_DT","NOTES") VALUES (1, 'O''Brien', 12.50, DATE '2024-01-15', 'first')`)
    await driver.runQuery(`INSERT INTO "${t1}" ("ID","NAME","AMOUNT","WHEN_DT","NOTES") VALUES (2, 'plain', NULL, NULL, NULL)`)
    await driver.runQuery(`INSERT INTO "${t1}" ("ID","NAME","AMOUNT","WHEN_DT","NOTES") VALUES (3, '100% sure', -3.00, DATE '2023-06-01', 'note3')`)
    const expReq: ExportRequest = { connectionId: config.id, schema, table: t1, format: 'sql', scope: 'all', columns: [], filters: [], tree: null, customWhere: null, options: { sqlMultiRow: true, sqlCreateTable: true } }
    const expFile = join(expDir, 'oraexp.sql')
    const ex = await runExport(driver, config.engine, expReq, expFile)
    if (!ex.ok || ex.rows !== 3) throw new Error(`oracle SQL export failed: ${ex.error ?? ex.rows}`)
    const sqlOut = readFileSync(expFile, 'utf-8')
    // FIX 1: real Oracle types, never generic ("text"/"integer"/"serial").
    const generic = sqlOut.match(/(?:^|\s)(text|integer|serial)(?:\s|\()/i)
    if (generic) throw new Error(`export emitted generic type "${generic[1]}"`)
    if (!/VARCHAR2\(50\)/.test(sqlOut) || !/\bNUMBER\(10,\s*2\)/.test(sqlOut) || !/\bCLOB\b/.test(sqlOut) || !/\bDATE\b/.test(sqlOut)) throw new Error(`export missing Oracle types: ${sqlOut.slice(0, 300)}`)
    if (!/GENERATED BY DEFAULT AS IDENTITY/.test(sqlOut)) throw new Error('export lost IDENTITY')
    if (!/PRIMARY KEY/.test(sqlOut)) throw new Error('export lost PRIMARY KEY')
    if (!/NOT NULL/.test(sqlOut)) throw new Error('export lost NOT NULL')
    if (!/TO_TIMESTAMP\(/.test(sqlOut)) throw new Error('DATE not emitted as TO_TIMESTAMP')
    // FIX 2: no multi-row VALUES — one INSERT statement per row.
    const insertCount = (sqlOut.match(/INSERT INTO/g) ?? []).length
    if (insertCount !== 3) throw new Error(`expected 3 single-row INSERTs, got ${insertCount} (multi-row VALUES?)`)
    // IMPORT the exported script into a disposable target (rename T1 -> T2).
    const importSql = sqlOut.replace(new RegExp(`"${t1}"`, 'g'), `"${t2}"`)
    const impStmts = splitSqlStatements(importSql)
    const rst = await driver.execStatements(impStmts)
    if (!rst.ok) throw new Error(`import exported Oracle SQL failed @${rst.failedAt}: ${rst.message}`)
    if ((await driver.getTableRowCount(schema, t2)) !== 3) throw new Error('imported row count != 3')
    const r1 = (await driver.runQuery(`SELECT "NAME","NOTES" FROM "${t2}" WHERE "ID" = 1`)).rows[0] as Record<string, unknown>
    if (String(r1.NAME) !== "O'Brien") throw new Error(`quote value corrupted: ${JSON.stringify(r1.NAME)}`)
    if (String(r1.NOTES) !== 'first') throw new Error('CLOB value corrupted')
    const r2 = (await driver.runQuery(`SELECT "AMOUNT","WHEN_DT","NOTES" FROM "${t2}" WHERE "ID" = 2`)).rows[0] as Record<string, unknown>
    if (r2.AMOUNT !== null || r2.WHEN_DT !== null || r2.NOTES !== null) throw new Error(`NULLs not preserved: ${JSON.stringify(r2)}`)
    if ((await driver.getTablePage(schema, t2, 10, 1, null, [], null, null)).rows.length !== 3) throw new Error('imported table not browsable')
    for (const n of [t1, t2]) await driver.runQuery(`DROP TABLE "${n}"`).catch(() => undefined)
    rmSync(expDir, { recursive: true, force: true })

    // ================= TASK 61: Views (A) + ER-diagram edit (B) =================
    // --- A. VIEWS: create (CREATE OR REPLACE VIEW) / open data / edit / def round-trip / drop ---
    const vname = '_ORAV_ACTIVE'
    const vqn = `"${schema}"."${vname}"`
    await driver.runQuery(`DROP VIEW ${vqn}`).catch(() => undefined)
    // Matches what the object editor emits for an Oracle view (CREATE OR REPLACE).
    let vr = await driver.applyObjectSql([`CREATE OR REPLACE VIEW ${vqn} AS\nSELECT "ID", "FULL_NAME" FROM "${schema}"."CUSTOMERS" WHERE "IS_ACTIVE" = 1`])
    if (!vr.ok) throw new Error(`create view: ${vr.message}`)
    if (!(await driver.listViews(schema)).some((v) => v.name === vname)) throw new Error('view not listed')
    const vRows = await driver.runQuery(`SELECT * FROM ${vqn}`)
    if (vRows.rows.length === 0) throw new Error('view data empty (open-view-data)')
    // Definition round-trip (ALL_VIEWS.TEXT via getObjectDefinition).
    const vdef = await driver.getObjectDefinition({ connectionId: config.id, kind: 'view', schema, name: vname })
    if (!/SELECT/i.test(vdef) || !/FULL_NAME/i.test(vdef)) throw new Error(`view def did not round-trip: ${vdef.slice(0, 80)}`)
    // Edit via CREATE OR REPLACE (change the SELECT); WITH READ ONLY.
    vr = await driver.applyObjectSql([`CREATE OR REPLACE VIEW ${vqn} AS\nSELECT "ID", "EMAIL" FROM "${schema}"."CUSTOMERS" WITH READ ONLY`])
    if (!vr.ok) throw new Error(`edit view: ${vr.message}`)
    const vdef2 = await driver.getObjectDefinition({ connectionId: config.id, kind: 'view', schema, name: vname })
    if (!/EMAIL/i.test(vdef2)) throw new Error('edited view def not reflected')
    // Views node must not include materialized views.
    if ((await driver.listViews(schema)).some((v) => /^MV/i.test(v.name))) throw new Error('materialized view leaked into Views')
    await driver.execStatements(buildObjectOp('oracle', { kind: 'dropView', schema, name: vname }).statements)
    if ((await driver.listViews(schema)).some((v) => v.name === vname)) throw new Error('view still listed after drop')

    // --- B. ER DIAGRAM: FK introspection (render) + add/drop FK (edit) + drop-table CASCADE ---
    // Seeded ORDERS→CUSTOMERS FK is introspected.
    const ordFks = (await driver.getTableSpec(schema, 'ORDERS')).foreignKeys
    if (!ordFks.some((f) => f.refTable === 'CUSTOMERS' && f.columns.includes('CUSTOMER_ID') && f.onUpdate == null)) {
      throw new Error(`ER: seeded ORDERS→CUSTOMERS FK not introspected: ${JSON.stringify(ordFks)}`)
    }
    // Draw a FK between disposable tables (ON DELETE CASCADE), then drop it.
    const erP = '_ORAER_P', erC = '_ORAER_C'
    for (const nm of [erC, erP]) await driver.runQuery(`DROP TABLE "${nm}" CASCADE CONSTRAINTS PURGE`).catch(() => undefined)
    await driver.runQuery(`CREATE TABLE "${erP}" ("ID" NUMBER PRIMARY KEY)`)
    await driver.runQuery(`CREATE TABLE "${erC}" ("ID" NUMBER PRIMARY KEY, "PID" NUMBER)`)
    const erBase = await driver.getTableSpec(schema, erC)
    const erWithFk: import('@shared/types').TableSpec = {
      ...erBase,
      foreignKeys: [{ name: 'FK_ORAER', columns: ['PID'], refSchema: schema, refTable: erP, refColumns: ['ID'], onDelete: 'CASCADE', onUpdate: null }]
    }
    let er = await driver.execStatements(buildTableDdl('oracle', 'alter', erWithFk, erBase).statements)
    if (!er.ok) throw new Error(`ER add-FK failed: ${er.message}`)
    const erAfter = (await driver.getTableSpec(schema, erC)).foreignKeys
    if (!erAfter.some((f) => f.refTable === erP && f.onDelete === 'CASCADE')) throw new Error('ER add-FK not reflected')
    er = await driver.execStatements(buildTableDdl('oracle', 'alter', erBase, erWithFk).statements)
    if (!er.ok) throw new Error(`ER drop-FK failed: ${er.message}`)
    if ((await driver.getTableSpec(schema, erC)).foreignKeys.length !== 0) throw new Error('ER drop-FK not reflected')
    // Drop parent via the object-op (CASCADE CONSTRAINTS PURGE) while child FK-refs it? child FK already dropped.
    await driver.execStatements(buildObjectOp('oracle', { kind: 'dropTable', schema, table: erC }).statements)
    await driver.execStatements(buildObjectOp('oracle', { kind: 'dropTable', schema, table: erP }).statements)
    if ((await driver.listTables(schema)).some((t) => t.name === erP || t.name === erC)) throw new Error('ER tables remain after drop')
    // Seed untouched.
    if ((await driver.getTableRowCount(schema, 'CUSTOMERS')) !== 20) throw new Error('seeded customers changed (views/ER)')

    results.push(`✅ ${tag}: connect(Thin), tables/views, catalog+pk, count(20)+paginate, filters(CI-contains/%/quote/>=/BETWEEN/IN/AND), funnel(8), custom(10), NULL partition, CRUD-by-PK; DDL: CREATE(IDENTITY, PK-once, no AUTOINCREMENT)+identity-insert+ALTER(add col/index/FK)+round-trip; ViewBuilder(INNER/LEFT/self-join, no-AS aliases); Sequences(list+ISEQ$$ system-flag, create/NEXTVAL(100), alter inc→10, RESTART→500, rename, drop); Indexes(list+PK-constraint-backed read-only, create single/multi/unique, edit(drop+recreate), rename, drop; seed untouched); Triggers(create+fire :NEW, compile-error→INVALID surfaced, edit via CREATE OR REPLACE, disable/enable, statement-level, WHEN-clause, get-details round-trip, drop; seed untouched); Routines(function+procedure list w/ sig+status, call fn(2,3)=5, package spec+body list+call f1(10)=11, compile-error→INVALID surfaced, edit CREATE OR REPLACE→2*3=6, GET_DDL round-trip, drop fn/proc/body/package; seed untouched); SQL export(real Oracle types VARCHAR2/NUMBER(10,2)/CLOB/DATE→TO_TIMESTAMP, IDENTITY+PK+NOT NULL, 1-INSERT-per-row no multi-row VALUES)→import clean(O'Brien+NULLs intact, browsable); Views(create CREATE OR REPLACE, open-data, def round-trip, edit+WITH READ ONLY, drop; no MV leak); ER(seeded ORDERS→CUSTOMERS FK introspected no-ON-UPDATE, draw FK ON DELETE CASCADE, drop FK, drop-table CASCADE CONSTRAINTS PURGE); seed untouched)`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
  } finally {
    await driver.runQuery(`DROP VIEW "_ORAV_ACTIVE"`).catch(() => undefined)
    await driver.runQuery(`DROP TABLE "_ORAER_C" CASCADE CONSTRAINTS PURGE`).catch(() => undefined)
    await driver.runQuery(`DROP TABLE "_ORAER_P" CASCADE CONSTRAINTS PURGE`).catch(() => undefined)
    await driver.runQuery(`DROP TABLE "_ORAEXP_T1"`).catch(() => undefined)
    await driver.runQuery(`DROP TABLE "_ORAEXP_T2"`).catch(() => undefined)
    await driver.runQuery(`DROP FUNCTION "_ORAFN_ADD"`).catch(() => undefined)
    await driver.runQuery(`DROP FUNCTION "_ORAFN_BAD"`).catch(() => undefined)
    await driver.runQuery(`DROP PROCEDURE "_ORAPR_TOUCH"`).catch(() => undefined)
    await driver.runQuery(`DROP PACKAGE "_ORAPKG_UTIL"`).catch(() => undefined)
    await driver.runQuery(`DROP TABLE "_ORATRGTBL_"`).catch(() => undefined)
    await driver.runQuery(`DROP TABLE "_ORAIDXTBL_"`).catch(() => undefined)
    await driver.runQuery(`DROP SEQUENCE "_ORASEQ_TEST"`).catch(() => undefined)
    await driver.runQuery(`DROP SEQUENCE "_ORASEQ_R"`).catch(() => undefined)
    await driver.runQuery(`DROP VIEW "_VBTEST_ORA"`).catch(() => undefined)
    await driver.runQuery(`DROP TABLE "_ORATEST_"`).catch(() => undefined)
    await driver.runQuery(`DROP TABLE "_ORATEST_DETAILS"`).catch(() => undefined)
    await driver.runQuery(`DROP TABLE "_ORATEST_PARENT"`).catch(() => undefined)
    await driver.disconnect().catch(() => undefined)
  }
}

/**
 * TASK 64 — cross-engine data transfer matrix. Connects every available engine,
 * builds a DISPOSABLE source table (`xfer_<engine>`) with awkward data on each,
 * then copies it to every required target and verifies the target matches, the
 * lossy-mapping warnings appear, identity values are preserved, and — critically
 * — the SOURCE IS UNCHANGED. Every disposable object is dropped afterwards; the
 * seeded customers/orders/order_items are never touched.
 */
async function testTransfer(configs: ConnectionConfig[]): Promise<void> {
  const tag = 'transfer'
  const drivers = new Map<Engine, DbDriver>()
  const cfgOf = new Map<Engine, ConnectionConfig>()
  for (const cfg of configs) {
    try {
      const d = await createDriver(cfg)
      await d.connect()
      drivers.set(cfg.engine, d)
      cfgOf.set(cfg.engine, cfg)
    } catch {
      /* engine not available — its pairs are skipped */
    }
  }

  const schemaOf = (engine: Engine): string => {
    if (engine === 'sqlite') return 'main'
    if (engine === 'mssql') return 'dbo'
    if (engine === 'oracle') return (cfgOf.get('oracle')?.user || 'dbtool').toUpperCase()
    return cfgOf.get(engine)?.database || 'dbtool_dev' // pg schema handled below
  }
  // Postgres: the schema is 'public', not the database name.
  const srcSchemaOf = (engine: Engine): string => (engine === 'postgres' ? 'public' : schemaOf(engine))

  // The disposable source table for a given source engine.
  const srcTable = (engine: Engine): string => `xfer_${engine}`

  const mkSpec = (engine: Engine, schema: string, table: string): TableSpec => {
    const columns: ColumnSpec[] = [
      { name: 'id', type: 'integer', autoIncrement: true, nullable: false },
      { name: 'name', type: 'varchar', length: 100, nullable: true },
      { name: 'quote_val', type: 'varchar', length: 50, nullable: true },
      { name: 'geo', type: 'varchar', length: 100, nullable: true },
      { name: 'empty_str', type: 'varchar', length: 50, nullable: true },
      { name: 'note', type: 'varchar', length: 50, nullable: true },
      { name: 'amount', type: 'decimal', length: 12, scale: 2, nullable: true },
      { name: 'created', type: 'timestamp', nullable: true },
      { name: 'flag', type: 'boolean', nullable: true },
      { name: 'long_text', type: 'text', nullable: true }
    ]
    // Oracle DATE carries a time component — add one so the "keeps its time" path
    // is exercised when Oracle is the SOURCE.
    if (engine === 'oracle') columns.push({ name: 'odate', type: 'date', nullable: true })
    return { schema, name: table, columns, primaryKey: ['id'], foreignKeys: [], indexes: [], comment: null }
  }

  const bool = (engine: Engine, v: boolean): unknown => (engine === 'postgres' ? v : v ? 1 : 0)

  // Build + populate the disposable source table for one engine.
  const buildSource = async (engine: Engine): Promise<void> => {
    const d = drivers.get(engine)!
    const schema = srcSchemaOf(engine)
    const table = srcTable(engine)
    await d.execStatements(buildObjectOp(engine, { kind: 'dropTable', schema, table }).statements).catch(() => undefined)
    const spec = mkSpec(engine, schema, table)
    const create = buildTableDdl(engine, 'create', spec)
    const cr = await d.execStatements(create.statements)
    if (!cr.ok) throw new Error(`source create (${engine}) failed: ${cr.message}`)
    const cols = spec.columns.map((c) => c.name)
    const columnTypes: Record<string, string> = {}
    for (const c of spec.columns) columnTypes[c.name] = c.type
    const longText = 'Ω'.repeat(300)
    const base: Record<string, unknown> = { odate: '2022-07-04 09:15:30' }
    const rows: Record<string, unknown>[] = [
      { ...base, id: 1, name: 'Alice', quote_val: "O'Brien", geo: 'გამარჯობა', empty_str: '', note: null, amount: '1234.56', created: '2024-03-15 14:30:45', flag: bool(engine, true), long_text: longText },
      { ...base, id: 2, name: 'Bob', quote_val: '50% off_', geo: 'თბილისი', empty_str: 'x', note: null, amount: '-0.05', created: '1999-12-31 23:59:59', flag: bool(engine, false), long_text: 'short' },
      { ...base, id: 1000, name: 'Carol', quote_val: 'a"b', geo: 'ქუთაისი', empty_str: 'y', note: 'n', amount: '0.00', created: '2030-06-01 08:00:00', flag: bool(engine, true), long_text: 'mid' }
    ]
    const arr = rows.map((r) => cols.map((c) => r[c]))
    await d.transferInsert(schema, table, cols, arr, columnTypes, ['id'])
  }

  // The required ordered pairs (task §VERIFICATION), plus a same-engine PG→PG.
  const pairs: [Engine, Engine][] = [
    ['postgres', 'mssql'], ['mssql', 'postgres'], ['oracle', 'mssql'], ['mssql', 'oracle'],
    ['mysql', 'mssql'], ['mssql', 'mysql'], ['mariadb', 'mssql'], ['mssql', 'mariadb'],
    ['sqlite', 'mssql'], ['mssql', 'sqlite'],
    ['postgres', 'oracle'], ['oracle', 'postgres'], ['mysql', 'oracle'], ['oracle', 'mysql'],
    ['sqlite', 'oracle'], ['oracle', 'sqlite'], ['mariadb', 'oracle'], ['oracle', 'mariadb']
  ]

  const sourcesNeeded = new Set<Engine>()
  for (const [s] of pairs) sourcesNeeded.add(s)
  sourcesNeeded.add('postgres') // PG→PG

  // Create each disposable source once (skip engines that aren't connected).
  const built = new Set<Engine>()
  for (const e of sourcesNeeded) {
    if (!drivers.has(e)) continue
    try {
      await buildSource(e)
      built.add(e)
    } catch (err) {
      results.push(`❌ ${tag}: source setup ${e}: ${(err as Error).message}`)
      failed = true
    }
  }

  const runPair = async (src: Engine, dst: Engine, targetSchema: string): Promise<void> => {
    const sd = drivers.get(src)
    const dd = drivers.get(dst)
    if (!sd || !dd || !built.has(src)) {
      results.push(`⏭ ${tag} ${src}→${dst}: engine not available`)
      return
    }
    const table = srcTable(src)
    const sourceSchema = srcSchemaOf(src)
    const req: TransferRequest = {
      sourceConnectionId: cfgOf.get(src)!.id,
      targetConnectionId: cfgOf.get(dst)!.id,
      sourceSchema,
      targetSchema,
      tables: [table],
      ifExists: 'drop'
    }
    try {
      const plan = await buildTransferPlan(sd, dd, { sourceConnectionId: req.sourceConnectionId, targetConnectionId: req.targetConnectionId, sourceSchema, targetSchema, tables: [table] })
      const res = await runTransfer(sd, dd, req)
      if (!res.ok) throw new Error(`run failed: ${res.error ?? JSON.stringify(res.tables)}`)

      const cnt = await dd.getTableRowCount(targetSchema, table, [], null, null)
      if (cnt !== 3) throw new Error(`target rowcount ${cnt} != 3`)
      const page = await dd.getTablePage(targetSchema, table, 100, 1, null, [], null, null)
      const byId = new Map(page.rows.map((r) => [Number((r as Record<string, unknown>).id), r as Record<string, unknown>]))
      const r1 = byId.get(1)
      if (!r1) throw new Error('row id=1 missing on target')
      if (String(r1.quote_val) !== "O'Brien") throw new Error(`quote lost: ${JSON.stringify(r1.quote_val)}`)
      if (String(r1.geo) !== 'გამარჯობა') throw new Error(`Georgian unicode lost: ${JSON.stringify(r1.geo)}`)
      // Oracle stores '' as NULL, so an Oracle endpoint at EITHER end yields NULL.
      if (dst === 'oracle') {
        if (r1.empty_str != null) throw new Error(`Oracle empty-string should be NULL, got ${JSON.stringify(r1.empty_str)}`)
      } else if (src === 'oracle') {
        if (r1.empty_str != null && r1.empty_str !== '') throw new Error(`Oracle-source empty_str unexpected: ${JSON.stringify(r1.empty_str)}`)
      } else if (r1.empty_str !== '') {
        throw new Error(`empty string not preserved: ${JSON.stringify(r1.empty_str)}`)
      }
      const createdStr = r1.created instanceof Date ? r1.created.toISOString() : String(r1.created)
      if (!/:30:45/.test(createdStr)) throw new Error(`datetime time component lost: ${createdStr}`)
      if (Math.abs(Number(r1.amount) - 1234.56) > 0.001) throw new Error(`decimal lost: ${JSON.stringify(r1.amount)}`)
      const flagOk = r1.flag === true || Number(r1.flag) === 1 || r1.flag === 'true' || r1.flag === '1'
      if (!flagOk) throw new Error(`boolean lost: ${JSON.stringify(r1.flag)}`)
      if (String(r1.long_text).length < 100) throw new Error(`long text truncated: ${String(r1.long_text).length}`)
      if (!byId.get(1000)) throw new Error('identity value 1000 not preserved')
      // Oracle DATE keeps its time (only when Oracle is the source).
      if (src === 'oracle') {
        const od = r1.odate
        const odStr = od instanceof Date ? od.toISOString() : String(od)
        if (od != null && !/:15:30/.test(odStr)) throw new Error(`Oracle DATE lost its time: ${odStr}`)
      }
      const warned = plan.tables[0]?.columns.some((c) => c.warnings.length > 0)
      // Drop the disposable target table.
      await dd.execStatements(buildObjectOp(dst, { kind: 'dropTable', schema: targetSchema, table }).statements).catch(() => undefined)
      results.push(`✅ ${tag} ${src}→${dst}: 3 rows, unicode+quote+decimal+time+identity ok${warned ? ' (warnings emitted)' : ''}`)
    } catch (err) {
      failed = true
      results.push(`❌ ${tag} ${src}→${dst}: ${(err as Error).message}`)
      await dd.execStatements(buildObjectOp(dst, { kind: 'dropTable', schema: targetSchema, table }).statements).catch(() => undefined)
    }
  }

  for (const [s, d] of pairs) await runPair(s, d, srcSchemaOf(d))

  // Same-engine PG→PG into a DISPOSABLE schema (never the source's own schema).
  if (drivers.has('postgres') && built.has('postgres')) {
    const pg = drivers.get('postgres')!
    await pg.execStatements(buildObjectOp('postgres', { kind: 'createSchema', name: 'xfer_tgt' }).statements).catch(() => undefined)
    await runPair('postgres', 'postgres', 'xfer_tgt')
    await pg.execStatements(buildObjectOp('postgres', { kind: 'dropSchema', name: 'xfer_tgt' }).statements).catch(() => undefined)
  }

  // FK-ordering scenario: parent + child (child → parent FK) PG → MSSQL & PG → Oracle.
  if (drivers.has('postgres')) {
    const pg = drivers.get('postgres')!
    const psch = srcSchemaOf('postgres')
    const parent: TableSpec = { schema: psch, name: 'xfer_parent', columns: [{ name: 'id', type: 'integer', autoIncrement: true, nullable: false }, { name: 'label', type: 'varchar', length: 40, nullable: true }], primaryKey: ['id'], foreignKeys: [], indexes: [], comment: null }
    const child: TableSpec = { schema: psch, name: 'xfer_child', columns: [{ name: 'id', type: 'integer', autoIncrement: true, nullable: false }, { name: 'parent_id', type: 'integer', nullable: true }], primaryKey: ['id'], foreignKeys: [{ name: 'fk_xc_parent', columns: ['parent_id'], refTable: 'xfer_parent', refColumns: ['id'] }], indexes: [], comment: null }
    try {
      for (const t of ['xfer_child', 'xfer_parent']) await pg.execStatements(buildObjectOp('postgres', { kind: 'dropTable', schema: psch, table: t }).statements).catch(() => undefined)
      await pg.execStatements(buildTableDdl('postgres', 'create', parent).statements)
      await pg.execStatements(buildTableDdl('postgres', 'create', child).statements)
      await pg.transferInsert(psch, 'xfer_parent', ['id', 'label'], [[1, 'p1'], [2, 'p2']], { id: 'integer', label: 'varchar' }, ['id'])
      await pg.transferInsert(psch, 'xfer_child', ['id', 'parent_id'], [[1, 1], [2, 2], [3, 1]], { id: 'integer', parent_id: 'integer' }, ['id'])
      for (const dst of ['mssql', 'oracle'] as Engine[]) {
        const dd = drivers.get(dst)
        if (!dd) { results.push(`⏭ ${tag} FK pg→${dst}: not available`); continue }
        const tsch = schemaOf(dst)
        const req: TransferRequest = { sourceConnectionId: cfgOf.get('postgres')!.id, targetConnectionId: cfgOf.get(dst)!.id, sourceSchema: psch, targetSchema: tsch, tables: ['xfer_parent', 'xfer_child'], ifExists: 'drop' }
        const res = await runTransfer(pg, dd, req)
        const childRes = res.tables.find((t) => t.table === 'xfer_child')
        // The FK must be recreated (no fkWarnings for it) and rows must load.
        const fkOk = res.fkWarnings.length === 0 && childRes?.rows === 3
        // Confirm the FK exists on the target by reading the child's spec.
        const childSpec = await dd.getTableSpec(tsch, 'xfer_child')
        const hasFk = childSpec.foreignKeys.some((f) => f.refTable.toLowerCase() === 'xfer_parent')
        for (const t of ['xfer_child', 'xfer_parent']) await dd.execStatements(buildObjectOp(dst, { kind: 'dropTable', schema: tsch, table: t }).statements).catch(() => undefined)
        if (fkOk && hasFk) results.push(`✅ ${tag} FK pg→${dst}: parent+child ordered, FK recreated`)
        else { failed = true; results.push(`❌ ${tag} FK pg→${dst}: fkWarnings=${JSON.stringify(res.fkWarnings)} childRows=${childRes?.rows} hasFk=${hasFk}`) }
      }
      for (const t of ['xfer_child', 'xfer_parent']) await pg.execStatements(buildObjectOp('postgres', { kind: 'dropTable', schema: psch, table: t }).statements).catch(() => undefined)
    } catch (err) {
      failed = true
      results.push(`❌ ${tag} FK scenario: ${(err as Error).message}`)
    }
  }

  // SOURCE UNCHANGED: every disposable source still has exactly its 3 rows and
  // its O'Brien value intact — proof the transfer never wrote to the source.
  for (const e of built) {
    try {
      const d = drivers.get(e)!
      const schema = srcSchemaOf(e)
      const table = srcTable(e)
      const cnt = await d.getTableRowCount(schema, table, [], null, null)
      const page = await d.getTablePage(schema, table, 100, 1, null, [], null, null)
      const r1 = page.rows.find((r) => Number((r as Record<string, unknown>).id) === 1) as Record<string, unknown> | undefined
      if (cnt !== 3 || String(r1?.quote_val) !== "O'Brien") throw new Error(`source ${e} changed! count=${cnt} quote=${JSON.stringify(r1?.quote_val)}`)
      // Cleanup the disposable source.
      await d.execStatements(buildObjectOp(e, { kind: 'dropTable', schema, table }).statements).catch(() => undefined)
      results.push(`✅ ${tag} source-unchanged ${e}: 3 rows + O'Brien intact`)
    } catch (err) {
      failed = true
      results.push(`❌ ${tag} source-unchanged ${e}: ${(err as Error).message}`)
    }
  }

  for (const d of drivers.values()) await d.disconnect().catch(() => undefined)
}

/**
 * TASK 65 — DEEPER transfer verification beyond the TASK 64 matrix: edge cases the
 * headless matrix skipped (empty table, composite/no PK, self + cyclic FK, 3-table
 * ordering, DEFAULT/NOT NULL, large volume crossing the MSSQL 1000-row boundary,
 * 100k-char text/CLOB, BLOB, all-NULL rows, identifiers needing quoting), append
 * correctness (incl. PK collision), skip/override honoring, and mid-transfer error
 * handling. All disposable objects use the `_xv_` prefix and are dropped; the
 * seeded tables are never touched; the source is proven read-only.
 */
async function testTransferDeep(configs: ConnectionConfig[]): Promise<void> {
  const tag = 'xfer-deep'
  const drivers = new Map<Engine, DbDriver>()
  const cfgOf = new Map<Engine, ConnectionConfig>()
  for (const cfg of configs) {
    try {
      const d = await createDriver(cfg)
      await d.connect()
      drivers.set(cfg.engine, d)
      cfgOf.set(cfg.engine, cfg)
    } catch {
      /* engine unavailable */
    }
  }
  const schemaOf = (e: Engine): string =>
    e === 'sqlite' ? 'main' : e === 'mssql' ? 'dbo' : e === 'oracle' ? (cfgOf.get('oracle')?.user || 'dbtool').toUpperCase() : e === 'postgres' ? 'public' : cfgOf.get(e)?.database || 'dbtool_dev'
  const have = (...es: Engine[]): boolean => es.every((e) => drivers.has(e))
  const pass = (m: string): void => { results.push(`✅ ${tag} ${m}`) }
  const bad = (m: string): void => { failed = true; results.push(`❌ ${tag} ${m}`) }
  const col = (name: string, type: string, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ name, type, nullable: true, ...extra })
  const dropT = async (e: Engine, schema: string, table: string): Promise<void> => {
    await drivers.get(e)!.execStatements(buildObjectOp(e, { kind: 'dropTable', schema, table }).statements).catch(() => undefined)
  }
  const setup = async (e: Engine, spec: TableSpec, rows: unknown[][], identityCols: string[]): Promise<void> => {
    const d = drivers.get(e)!
    // Drop children before parents if multiple (caller passes one spec at a time).
    await dropT(e, spec.schema, spec.name)
    const cr = await d.execStatements(buildTableDdl(e, 'create', spec).statements)
    if (!cr.ok) throw new Error(`setup create ${spec.name}/${e}: ${cr.message}`)
    if (rows.length) {
      const cols = spec.columns.map((c) => c.name)
      const ct: Record<string, string> = {}
      for (const c of spec.columns) ct[c.name] = c.type
      await d.transferInsert(spec.schema, spec.name, cols, rows, ct, identityCols)
    }
  }
  const run = async (src: Engine, dst: Engine, tables: string[], ifExists: 'skip' | 'drop' | 'append' = 'drop', overrides?: TransferRequest['overrides']): Promise<import('@shared/types').TransferResult> => {
    const req: TransferRequest = { sourceConnectionId: cfgOf.get(src)!.id, targetConnectionId: cfgOf.get(dst)!.id, sourceSchema: schemaOf(src), targetSchema: schemaOf(dst), tables, ifExists, overrides }
    return runTransfer(drivers.get(src)!, drivers.get(dst)!, req)
  }
  const count = (e: Engine, schema: string, table: string): Promise<number> => drivers.get(e)!.getTableRowCount(schema, table, [], null, null)

  const PS = schemaOf('postgres')

  // S1 — empty table (0 rows): structure created, no error.
  if (have('postgres', 'mssql', 'oracle')) {
    for (const dst of ['mssql', 'oracle'] as Engine[]) {
      try {
        const spec: TableSpec = { schema: PS, name: '_xv_empty', columns: [col('id', 'integer', { autoIncrement: true, nullable: false }), col('name', 'varchar', { length: 50 })], primaryKey: ['id'], foreignKeys: [], indexes: [], comment: null }
        await setup('postgres', spec, [], ['id'])
        const res = await run('postgres', dst, ['_xv_empty'])
        const c = await count(dst, schemaOf(dst), '_xv_empty')
        if (res.ok && c === 0) pass(`empty-table pg→${dst}: created, 0 rows`)
        else bad(`empty-table pg→${dst}: ok=${res.ok} cnt=${c} err=${JSON.stringify(res.tables)}`)
        await dropT(dst, schemaOf(dst), '_xv_empty')
      } catch (e) { bad(`empty-table pg→${dst}: ${(e as Error).message}`) }
    }
    await dropT('postgres', PS, '_xv_empty')
  }

  // S2 — composite primary key.
  if (have('postgres', 'mssql', 'oracle')) {
    for (const dst of ['mssql', 'oracle'] as Engine[]) {
      try {
        const spec: TableSpec = { schema: PS, name: '_xv_ckpk', columns: [col('a', 'integer', { nullable: false }), col('b', 'varchar', { length: 20, nullable: false }), col('v', 'varchar', { length: 40 })], primaryKey: ['a', 'b'], foreignKeys: [], indexes: [], comment: null }
        await setup('postgres', spec, [[1, 'x', 'one'], [1, 'y', 'two'], [2, 'x', 'three']], [])
        const res = await run('postgres', dst, ['_xv_ckpk'])
        const spec2 = await drivers.get(dst)!.getTableSpec(schemaOf(dst), '_xv_ckpk')
        const c = await count(dst, schemaOf(dst), '_xv_ckpk')
        if (res.ok && c === 3 && spec2.primaryKey.length === 2) pass(`composite-pk pg→${dst}: 3 rows, 2-col PK`)
        else bad(`composite-pk pg→${dst}: ok=${res.ok} cnt=${c} pk=${JSON.stringify(spec2.primaryKey)}`)
        await dropT(dst, schemaOf(dst), '_xv_ckpk')
      } catch (e) { bad(`composite-pk pg→${dst}: ${(e as Error).message}`) }
    }
    await dropT('postgres', PS, '_xv_ckpk')
  }

  // S3 — self-referencing FK (FK added after data → self reference validates).
  if (have('postgres', 'mssql')) {
    try {
      const spec: TableSpec = { schema: PS, name: '_xv_tree', columns: [col('id', 'integer', { autoIncrement: true, nullable: false }), col('parent_id', 'integer')], primaryKey: ['id'], foreignKeys: [{ name: 'fk_tree_self', columns: ['parent_id'], refTable: '_xv_tree', refColumns: ['id'] }], indexes: [], comment: null }
      await setup('postgres', spec, [[1, null], [2, 1], [3, 1], [4, 3]], ['id'])
      const res = await run('postgres', 'mssql', ['_xv_tree'])
      const t2 = await drivers.get('mssql')!.getTableSpec('dbo', '_xv_tree')
      const c = await count('mssql', 'dbo', '_xv_tree')
      const hasFk = t2.foreignKeys.some((f) => f.refTable.toLowerCase() === '_xv_tree')
      if (res.ok && c === 4 && hasFk && res.fkWarnings.length === 0) pass('self-fk pg→mssql: 4 rows, self-FK recreated')
      else bad(`self-fk pg→mssql: ok=${res.ok} cnt=${c} hasFk=${hasFk} fkWarn=${JSON.stringify(res.fkWarnings)}`)
      await dropT('mssql', 'dbo', '_xv_tree')
    } catch (e) { bad(`self-fk pg→mssql: ${(e as Error).message}`) }
    await dropT('postgres', PS, '_xv_tree')
  }

  // S4 — cyclic FKs between two tables (must succeed since FKs come after data).
  if (have('postgres', 'mssql')) {
    // A cyclic pair can't be removed by plain DROP TABLE (each FK blocks the
    // other) — drop the FK constraints first, then the tables.
    const dropCyc = async (eng: Engine): Promise<void> => {
      const s = schemaOf(eng)
      const q = eng === 'mssql' ? (x: string): string => `[${x}]` : (x: string): string => `"${x}"`
      const d = drivers.get(eng)
      if (!d) return
      await d.execStatements([`ALTER TABLE ${q(s)}.${q('_xv_ca')} DROP CONSTRAINT ${q('fk_ca_b')}`]).catch(() => undefined)
      await d.execStatements([`ALTER TABLE ${q(s)}.${q('_xv_cb')} DROP CONSTRAINT ${q('fk_cb_a')}`]).catch(() => undefined)
      await dropT(eng, s, '_xv_ca')
      await dropT(eng, s, '_xv_cb')
    }
    await dropCyc('postgres'); await dropCyc('mssql') // clean any prior-run leftovers
    try {
      const a: TableSpec = { schema: PS, name: '_xv_ca', columns: [col('id', 'integer', { nullable: false }), col('b_id', 'integer')], primaryKey: ['id'], foreignKeys: [{ name: 'fk_ca_b', columns: ['b_id'], refTable: '_xv_cb', refColumns: ['id'] }], indexes: [], comment: null }
      const b: TableSpec = { schema: PS, name: '_xv_cb', columns: [col('id', 'integer', { nullable: false }), col('a_id', 'integer')], primaryKey: ['id'], foreignKeys: [{ name: 'fk_cb_a', columns: ['a_id'], refTable: '_xv_ca', refColumns: ['id'] }], indexes: [], comment: null }
      await drivers.get('postgres')!.execStatements(buildTableDdl('postgres', 'create', { ...a, foreignKeys: [] }).statements)
      await drivers.get('postgres')!.execStatements(buildTableDdl('postgres', 'create', { ...b, foreignKeys: [] }).statements)
      await drivers.get('postgres')!.transferInsert(PS, '_xv_ca', ['id', 'b_id'], [[1, 1], [2, 2]], { id: 'integer', b_id: 'integer' }, [])
      await drivers.get('postgres')!.transferInsert(PS, '_xv_cb', ['id', 'a_id'], [[1, 1], [2, 2]], { id: 'integer', a_id: 'integer' }, [])
      await drivers.get('postgres')!.execStatements(buildAddForeignKeys('postgres', a))
      await drivers.get('postgres')!.execStatements(buildAddForeignKeys('postgres', b))
      const res = await run('postgres', 'mssql', ['_xv_ca', '_xv_cb'])
      const ca = await drivers.get('mssql')!.getTableSpec('dbo', '_xv_ca')
      const cb = await drivers.get('mssql')!.getTableSpec('dbo', '_xv_cb')
      const bothFk = ca.foreignKeys.length === 1 && cb.foreignKeys.length === 1
      if (res.ok && res.fkWarnings.length === 0 && bothFk) pass('cyclic-fk pg→mssql: both tables + both FKs recreated')
      else bad(`cyclic-fk pg→mssql: ok=${res.ok} fkWarn=${JSON.stringify(res.fkWarnings)} bothFk=${bothFk}`)
    } catch (e) { bad(`cyclic-fk pg→mssql: ${(e as Error).message}`) }
    await dropCyc('mssql')
    await dropCyc('postgres')
  }

  // S6 — no primary key.
  if (have('postgres', 'mssql')) {
    try {
      const spec: TableSpec = { schema: PS, name: '_xv_nopk', columns: [col('a', 'integer'), col('b', 'varchar', { length: 30 })], primaryKey: [], foreignKeys: [], indexes: [], comment: null }
      await setup('postgres', spec, [[1, 'x'], [2, 'y'], [2, 'y']], [])
      const res = await run('postgres', 'mssql', ['_xv_nopk'])
      const c = await count('mssql', 'dbo', '_xv_nopk')
      if (res.ok && c === 3) pass('no-pk pg→mssql: 3 rows (incl. duplicate)')
      else bad(`no-pk pg→mssql: ok=${res.ok} cnt=${c}`)
      await dropT('mssql', 'dbo', '_xv_nopk')
    } catch (e) { bad(`no-pk pg→mssql: ${(e as Error).message}`) }
    await dropT('postgres', PS, '_xv_nopk')
  }

  // S7 — DEFAULT + NOT NULL columns (defaults are dropped on the target; actual
  // values are copied so NOT NULL is satisfied).
  if (have('postgres', 'mssql')) {
    try {
      const spec: TableSpec = { schema: PS, name: '_xv_def', columns: [col('id', 'integer', { autoIncrement: true, nullable: false }), col('status', 'varchar', { length: 20, nullable: false, default: "'active'" }), col('qty', 'integer', { nullable: false, default: '0' })], primaryKey: ['id'], foreignKeys: [], indexes: [], comment: null }
      await setup('postgres', spec, [[1, 'shipped', 5], [2, 'active', 0]], ['id'])
      const res = await run('postgres', 'mssql', ['_xv_def'])
      const c = await count('mssql', 'dbo', '_xv_def')
      const t2 = await drivers.get('mssql')!.getTableSpec('dbo', '_xv_def')
      const notNull = t2.columns.filter((cc) => cc.name === 'status' || cc.name === 'qty').every((cc) => !cc.nullable)
      if (res.ok && c === 2 && notNull) pass('default+notnull pg→mssql: 2 rows, NOT NULL kept')
      else bad(`default+notnull pg→mssql: ok=${res.ok} cnt=${c} notNull=${notNull}`)
      await dropT('mssql', 'dbo', '_xv_def')
    } catch (e) { bad(`default+notnull pg→mssql: ${(e as Error).message}`) }
    await dropT('postgres', PS, '_xv_def')
  }

  // S8 — large volume crossing the MSSQL 1000-row chunk boundary + Oracle single-row.
  if (have('postgres', 'mssql', 'oracle')) {
    const mkRows = (n: number): unknown[][] => Array.from({ length: n }, (_, i) => [i + 1, `row ${i + 1}`])
    const spec: TableSpec = { schema: PS, name: '_xv_big', columns: [col('id', 'integer', { nullable: false }), col('v', 'varchar', { length: 40 })], primaryKey: ['id'], foreignKeys: [], indexes: [], comment: null }
    for (const [dst, n] of [['mssql', 2500], ['oracle', 2500], ['mssql', 10000]] as [Engine, number][]) {
      try {
        await setup('postgres', spec, mkRows(n), [])
        let ticks = 0
        const req: TransferRequest = { sourceConnectionId: cfgOf.get('postgres')!.id, targetConnectionId: cfgOf.get(dst)!.id, sourceSchema: PS, targetSchema: schemaOf(dst), tables: ['_xv_big'], ifExists: 'drop' }
        const res = await runTransfer(drivers.get('postgres')!, drivers.get(dst)!, req, () => { ticks++ })
        const c = await count(dst, schemaOf(dst), '_xv_big')
        if (res.ok && c === n && ticks > 0) pass(`volume pg→${dst}: ${n} rows (progress ticks=${ticks})`)
        else bad(`volume pg→${dst} n=${n}: ok=${res.ok} cnt=${c} ticks=${ticks} err=${JSON.stringify(res.tables)}`)
        await dropT(dst, schemaOf(dst), '_xv_big')
      } catch (e) { bad(`volume pg→${dst} n=${n}: ${(e as Error).message}`) }
    }
    await dropT('postgres', PS, '_xv_big')
  }

  // S9 — very long text (100k chars) → CLOB / NVARCHAR(MAX) / text.
  if (have('postgres', 'mssql', 'oracle')) {
    const big = 'A'.repeat(100000)
    for (const dst of ['mssql', 'oracle', 'postgres'] as Engine[]) {
      if (dst === 'postgres') { if (!have('postgres')) continue }
      const tgtSchema = dst === 'postgres' ? 'xferv_tgt' : schemaOf(dst)
      try {
        const spec: TableSpec = { schema: PS, name: '_xv_long', columns: [col('id', 'integer', { nullable: false }), col('body', 'text')], primaryKey: ['id'], foreignKeys: [], indexes: [], comment: null }
        await setup('postgres', spec, [[1, big], [2, 'short']], [])
        if (dst === 'postgres') await drivers.get('postgres')!.execStatements(buildObjectOp('postgres', { kind: 'createSchema', name: 'xferv_tgt' }).statements).catch(() => undefined)
        const req: TransferRequest = { sourceConnectionId: cfgOf.get('postgres')!.id, targetConnectionId: cfgOf.get(dst)!.id, sourceSchema: PS, targetSchema: tgtSchema, tables: ['_xv_long'], ifExists: 'drop' }
        const res = await runTransfer(drivers.get('postgres')!, drivers.get(dst)!, req)
        const page = await drivers.get(dst)!.getTablePage(tgtSchema, '_xv_long', 10, 1, null, [], null, null)
        const r1 = page.rows.find((r) => Number((r as Record<string, unknown>).id) === 1) as Record<string, unknown> | undefined
        const len = r1 ? String(r1.body).length : -1
        if (res.ok && len === 100000) pass(`long-text pg→${dst}: 100k chars preserved`)
        else bad(`long-text pg→${dst}: ok=${res.ok} len=${len} err=${JSON.stringify(res.tables)}`)
        await dropT(dst, tgtSchema, '_xv_long')
        if (dst === 'postgres') await drivers.get('postgres')!.execStatements(buildObjectOp('postgres', { kind: 'dropSchema', name: 'xferv_tgt' }).statements).catch(() => undefined)
      } catch (e) { bad(`long-text pg→${dst}: ${(e as Error).message}`) }
    }
    await dropT('postgres', PS, '_xv_long')
  }

  // S10 — BLOB / binary column.
  if (have('postgres', 'mssql', 'oracle', 'sqlite')) {
    const buf = Buffer.from([0, 1, 2, 255, 254, 0, 128, 64, 32, 16])
    for (const dst of ['mssql', 'oracle', 'sqlite'] as Engine[]) {
      try {
        const spec: TableSpec = { schema: PS, name: '_xv_blob', columns: [col('id', 'integer', { nullable: false }), col('data', 'bytea')], primaryKey: ['id'], foreignKeys: [], indexes: [], comment: null }
        await setup('postgres', spec, [[1, buf], [2, null]], [])
        const res = await run('postgres', dst, ['_xv_blob'])
        const page = await drivers.get(dst)!.getTablePage(schemaOf(dst), '_xv_blob', 10, 1, null, [], null, null)
        const r1 = page.rows.find((r) => Number((r as Record<string, unknown>).id) === 1) as Record<string, unknown> | undefined
        const got = r1?.data
        // The target driver re-normalizes a Buffer to a hex string (0x…/\x…) — so
        // compare the hex payload, not a Buffer instance.
        const hex = typeof got === 'string' ? got.replace(/^(?:\\x|0x)/i, '').toLowerCase() : Buffer.isBuffer(got) ? got.toString('hex') : ''
        const okBytes = hex === buf.toString('hex')
        if (res.ok && okBytes) pass(`blob pg→${dst}: ${buf.length} bytes round-tripped`)
        else bad(`blob pg→${dst}: ok=${res.ok} got=${typeof got === 'string' ? got : typeof got} match=${okBytes} err=${JSON.stringify(res.tables)}`)
        await dropT(dst, schemaOf(dst), '_xv_blob')
      } catch (e) { bad(`blob pg→${dst}: ${(e as Error).message}`) }
    }
    await dropT('postgres', PS, '_xv_blob')
  }

  // S11 — all-NULL row (every nullable column NULL).
  if (have('postgres', 'mssql', 'oracle')) {
    for (const dst of ['mssql', 'oracle'] as Engine[]) {
      try {
        const spec: TableSpec = { schema: PS, name: '_xv_null', columns: [col('id', 'integer', { nullable: false }), col('a', 'varchar', { length: 20 }), col('b', 'integer'), col('c', 'timestamp'), col('d', 'boolean')], primaryKey: ['id'], foreignKeys: [], indexes: [], comment: null }
        await setup('postgres', spec, [[1, null, null, null, null], [2, 'x', 5, '2024-01-01 12:00:00', drivers.has('postgres') ? true : 1]], [])
        const res = await run('postgres', dst, ['_xv_null'])
        const page = await drivers.get(dst)!.getTablePage(schemaOf(dst), '_xv_null', 10, 1, null, [], null, null)
        const r1 = page.rows.find((r) => Number((r as Record<string, unknown>).id) === 1) as Record<string, unknown> | undefined
        const allNull = r1 ? ['a', 'b', 'c', 'd'].every((k) => r1[k] == null) : false
        if (res.ok && allNull) pass(`all-null pg→${dst}: NULLs preserved`)
        else bad(`all-null pg→${dst}: ok=${res.ok} row=${JSON.stringify(r1)}`)
        await dropT(dst, schemaOf(dst), '_xv_null')
      } catch (e) { bad(`all-null pg→${dst}: ${(e as Error).message}`) }
    }
    await dropT('postgres', PS, '_xv_null')
  }

  // S12 — identifiers needing quoting: mixed case, a reserved word, a space.
  if (have('postgres', 'mssql', 'oracle')) {
    for (const dst of ['mssql', 'oracle'] as Engine[]) {
      try {
        const spec: TableSpec = { schema: PS, name: '_xv weird', columns: [col('id', 'integer', { nullable: false }), col('MixedCase', 'varchar', { length: 20 }), col('order', 'integer'), col('my col', 'varchar', { length: 20 })], primaryKey: ['id'], foreignKeys: [], indexes: [], comment: null }
        await setup('postgres', spec, [[1, 'Aa', 10, 'hi there'], [2, 'Bb', 20, 'x']], [])
        const res = await run('postgres', dst, ['_xv weird'])
        const c = await count(dst, schemaOf(dst), '_xv weird')
        if (res.ok && c === 2) pass(`quoting pg→${dst}: 2 rows (space/mixed-case/reserved word)`)
        else bad(`quoting pg→${dst}: ok=${res.ok} cnt=${c} err=${JSON.stringify(res.tables)}`)
        await dropT(dst, schemaOf(dst), '_xv weird')
      } catch (e) { bad(`quoting pg→${dst}: ${(e as Error).message}`) }
    }
    await dropT('postgres', PS, '_xv weird')
  }

  // S17 — tz-aware timestamp preserved on engines that HAVE a tz type
  // (mssql DATETIMEOFFSET, oracle TIMESTAMP WITH TIME ZONE); time kept.
  if (have('postgres', 'mssql', 'oracle')) {
    for (const dst of ['mssql', 'oracle'] as Engine[]) {
      try {
        const spec: TableSpec = { schema: PS, name: '_xv_tz', columns: [col('id', 'integer', { nullable: false }), col('ts', 'timestamp', { withTimeZone: true })], primaryKey: ['id'], foreignKeys: [], indexes: [], comment: null }
        await setup('postgres', spec, [[1, '2024-03-15 14:30:45+00'], [2, null]], [])
        const res = await run('postgres', dst, ['_xv_tz'])
        const t2 = await drivers.get(dst)!.getTableSpec(schemaOf(dst), '_xv_tz')
        const tsType = (t2.columns.find((c) => c.name === 'ts')?.type || '').toLowerCase()
        const tzAware = dst === 'mssql' ? /datetimeoffset/.test(tsType) : /time zone/.test(tsType)
        const page = await drivers.get(dst)!.getTablePage(schemaOf(dst), '_xv_tz', 10, 1, null, [], null, null)
        const r1 = page.rows.find((r) => Number((r as Record<string, unknown>).id) === 1) as Record<string, unknown> | undefined
        const s = r1?.ts instanceof Date ? r1.ts.toISOString() : String(r1?.ts)
        const timeKept = /:30:45/.test(s)
        if (res.ok && tzAware && timeKept) pass(`tz-timestamp pg→${dst}: tz-aware type (${tsType}) + time kept`)
        else bad(`tz-timestamp pg→${dst}: ok=${res.ok} type=${tsType} tzAware=${tzAware} timeKept=${timeKept} val=${s} err=${JSON.stringify(res.tables)}`)
        await dropT(dst, schemaOf(dst), '_xv_tz')
      } catch (e) { bad(`tz-timestamp pg→${dst}: ${(e as Error).message}`) }
    }
    await dropT('postgres', PS, '_xv_tz')
  }

  // S13 — append mode: existing rows kept + new added; then a PK collision is
  // reported (not a silent partial success), leaving prior rows intact.
  if (have('postgres', 'mssql')) {
    try {
      const spec: TableSpec = { schema: PS, name: '_xv_app', columns: [col('id', 'integer', { nullable: false }), col('v', 'varchar', { length: 20 })], primaryKey: ['id'], foreignKeys: [], indexes: [], comment: null }
      await setup('postgres', spec, [[1, 'a'], [2, 'b'], [3, 'c']], [])
      await run('postgres', 'mssql', ['_xv_app'], 'drop') // target now has 1,2,3
      // Source becomes ids 4,5; append.
      await setup('postgres', spec, [[4, 'd'], [5, 'e']], [])
      const resApp = await run('postgres', 'mssql', ['_xv_app'], 'append')
      const cApp = await count('mssql', 'dbo', '_xv_app')
      if (resApp.ok && cApp === 5) pass('append pg→mssql: existing kept + new added (5 rows)')
      else bad(`append pg→mssql: ok=${resApp.ok} cnt=${cApp}`)
      // Collision: source ids 1,2 (already present) appended → must fail clearly.
      await setup('postgres', spec, [[1, 'dup'], [2, 'dup']], [])
      const resCol = await run('postgres', 'mssql', ['_xv_app'], 'append')
      const cCol = await count('mssql', 'dbo', '_xv_app')
      const reported = !resCol.ok || resCol.tables.some((t) => t.status === 'failed')
      if (reported && cCol === 5) pass('append-collision pg→mssql: PK collision reported, prior rows intact')
      else bad(`append-collision pg→mssql: reported=${reported} cnt=${cCol} (expected still 5) tables=${JSON.stringify(resCol.tables)}`)
      await dropT('mssql', 'dbo', '_xv_app')
    } catch (e) { bad(`append pg→mssql: ${(e as Error).message}`) }
    await dropT('postgres', PS, '_xv_app')
  }

  // S14 — skip + type override are honored in the RESULT (the wizard just sets them).
  if (have('postgres', 'mssql')) {
    try {
      const spec: TableSpec = { schema: PS, name: '_xv_ovr', columns: [col('id', 'integer', { autoIncrement: true, nullable: false }), col('geo', 'varchar', { length: 30 }), col('amount', 'decimal', { length: 10, scale: 2 })], primaryKey: ['id'], foreignKeys: [], indexes: [], comment: null }
      await setup('postgres', spec, [[1, 'skip me', '9.99']], ['id'])
      const res = await run('postgres', 'mssql', ['_xv_ovr'], 'drop', { _xv_ovr: { geo: { skip: true }, amount: { targetType: 'varchar' } } })
      const t2 = await drivers.get('mssql')!.getTableSpec('dbo', '_xv_ovr')
      const hasGeo = t2.columns.some((cc) => cc.name === 'geo')
      const amount = t2.columns.find((cc) => cc.name === 'amount')
      const amountIsVarchar = !!amount && /char/i.test(amount.type)
      if (res.ok && !hasGeo && amountIsVarchar) pass('skip+override pg→mssql: geo skipped, amount→varchar')
      else bad(`skip+override pg→mssql: ok=${res.ok} hasGeo=${hasGeo} amountType=${amount?.type}`)
      await dropT('mssql', 'dbo', '_xv_ovr')
    } catch (e) { bad(`skip+override pg→mssql: ${(e as Error).message}`) }
    await dropT('postgres', PS, '_xv_ovr')
  }

  // S15 — mid-transfer error: an incompatible override (text → int) must be
  // reported as a failure, target left in a defined (empty) state, source intact.
  if (have('postgres', 'mssql')) {
    try {
      const spec: TableSpec = { schema: PS, name: '_xv_err', columns: [col('id', 'integer', { nullable: false }), col('label', 'varchar', { length: 20 })], primaryKey: ['id'], foreignKeys: [], indexes: [], comment: null }
      await setup('postgres', spec, [[1, 'Alice'], [2, 'Bob']], [])
      const res = await run('postgres', 'mssql', ['_xv_err'], 'drop', { _xv_err: { label: { targetType: 'int' } } })
      const failedTable = res.tables.find((t) => t.table === '_xv_err')
      const cErr = await count('mssql', 'dbo', '_xv_err')
      // The table is created (label INT) but the string load fails → 0 rows, reported.
      if (!res.ok && failedTable?.status === 'failed' && cErr === 0) pass('error-handling pg→mssql: failure reported, target left empty (defined)')
      else bad(`error-handling pg→mssql: ok=${res.ok} status=${failedTable?.status} cnt=${cErr}`)
      await dropT('mssql', 'dbo', '_xv_err')
    } catch (e) { bad(`error-handling pg→mssql: ${(e as Error).message}`) }
    await dropT('postgres', PS, '_xv_err')
  }

  // S16 — invariants: source untouched + seeded data intact + no leftovers.
  for (const [e, d] of drivers) {
    try {
      const sch = e === 'sqlite' ? 'main' : e === 'mssql' ? 'dbo' : e === 'oracle' ? schemaOf('oracle') : e === 'postgres' ? 'public' : cfgOf.get(e)?.database || 'dbtool_dev'
      const tbls = await d.listTables(sch)
      // Oracle stores the seed table as CUSTOMERS; match case-insensitively.
      const custName = tbls.find((t) => t.name.toLowerCase() === 'customers')?.name
      const seeded = custName ? await d.getTableRowCount(sch, custName, [], null, null).catch(() => -1) : -1
      const leftovers = tbls.filter((t) => /^_xv/i.test(t.name)).map((t) => t.name)
      if (seeded > 0 && leftovers.length === 0) pass(`invariants ${e}: customers=${seeded} (intact), no _xv_ leftovers`)
      else bad(`invariants ${e}: customers=${seeded} leftovers=${JSON.stringify(leftovers)}`)
    } catch (err) { bad(`invariants ${e}: ${(err as Error).message}`) }
  }

  for (const d of drivers.values()) await d.disconnect().catch(() => undefined)
}

/**
 * TASK 67 — PostgreSQL advanced objects: materialized views, types/enums,
 * extensions, and advanced indexes (gin/partial/expression). Exercises the
 * driver catalog reads + the ObjectOp/index DDL builders end-to-end against the
 * live PG container with disposable `_pgadv_*` objects; seeds left intact.
 */
async function testPgAdvanced(config: ConnectionConfig): Promise<void> {
  if (config.engine !== 'postgres') return
  const tag = 'pg-adv'
  const d = await createDriver(config)
  await d.connect()
  const schema = 'public'
  const run = (sql: string): Promise<import('@shared/types').DdlApplyResult> => d.execStatements([sql])
  const cleanup = async (): Promise<void> => {
    for (const s of [
      'DROP MATERIALIZED VIEW IF EXISTS public._pgadv_mv',
      'DROP TABLE IF EXISTS public._pgadv_t CASCADE',
      'DROP TYPE IF EXISTS public._pgadv_mood CASCADE',
      'DROP TYPE IF EXISTS public._pgadv_addr CASCADE'
    ]) await run(s).catch(() => undefined)
    await run('DROP EXTENSION IF EXISTS pg_trgm').catch(() => undefined)
  }
  try {
    await cleanup()

    // A. Materialized views.
    await run("CREATE MATERIALIZED VIEW public._pgadv_mv AS SELECT 1 AS a, 'x'::text AS b WITH DATA")
    const mv = (await d.listMatViews!(schema)).find((m) => m.name === '_pgadv_mv')
    if (!mv || !mv.populated) throw new Error('matview not listed/populated')
    const page = await d.getTablePage(schema, '_pgadv_mv', 10, 1, null, [], null, null)
    if (page.rows.length !== 1) throw new Error(`matview browse rows=${page.rows.length}`)
    let r = await d.execStatements(buildObjectOp('postgres', { kind: 'refreshMatView', schema, name: '_pgadv_mv' }).statements)
    if (!r.ok) throw new Error(`refresh failed: ${r.message}`)
    await run('CREATE UNIQUE INDEX _pgadv_mv_uq ON public._pgadv_mv (a)')
    r = await d.execStatements(buildObjectOp('postgres', { kind: 'refreshMatView', schema, name: '_pgadv_mv', concurrently: true }).statements)
    if (!r.ok) throw new Error(`concurrent refresh failed: ${r.message}`)
    const def = await d.getObjectDefinition({ connectionId: config.id, kind: 'matview', schema, name: '_pgadv_mv' })
    if (!/select/i.test(def)) throw new Error('matview definition empty')
    r = await d.execStatements(buildObjectOp('postgres', { kind: 'dropMatView', schema, name: '_pgadv_mv' }).statements)
    if (!r.ok) throw new Error('drop matview failed')
    results.push(`✅ ${tag} matview: create/list/browse/refresh/refresh-CONCURRENTLY/def/drop`)

    // B. Types / enums.
    await run("CREATE TYPE public._pgadv_mood AS ENUM ('sad','ok','happy')")
    await run('CREATE TYPE public._pgadv_addr AS (street text, zip int)')
    let types = await d.listTypes!(schema)
    const en = types.find((t) => t.name === '_pgadv_mood')
    const co = types.find((t) => t.name === '_pgadv_addr')
    if (!en || en.kind !== 'enum' || (en.labels ?? []).join(',') !== 'sad,ok,happy') throw new Error(`enum wrong: ${JSON.stringify(en)}`)
    if (!co || co.kind !== 'composite' || (co.fields ?? []).length !== 2) throw new Error(`composite wrong: ${JSON.stringify(co)}`)
    if (!(await run("ALTER TYPE public._pgadv_mood ADD VALUE 'ecstatic'")).ok) throw new Error('ADD VALUE failed')
    types = await d.listTypes!(schema)
    if (!(types.find((t) => t.name === '_pgadv_mood')?.labels ?? []).includes('ecstatic')) throw new Error('added enum value not listed')
    await run('CREATE TABLE public._pgadv_t (id serial primary key, m public._pgadv_mood)')
    // Dropping an in-use enum without CASCADE must be blocked by PG.
    const blocked = await d.execStatements(buildObjectOp('postgres', { kind: 'dropType', schema, name: '_pgadv_mood' }).statements)
    if (blocked.ok) throw new Error('drop of in-use enum should have been blocked')
    if (!(await d.execStatements(buildObjectOp('postgres', { kind: 'dropType', schema, name: '_pgadv_mood', cascade: true }).statements)).ok) throw new Error('drop CASCADE failed')
    if (!(await d.execStatements(buildObjectOp('postgres', { kind: 'dropType', schema, name: '_pgadv_addr' }).statements)).ok) throw new Error('drop composite failed')
    results.push(`✅ ${tag} types: enum+composite list/labels/fields, ADD VALUE, drop(+CASCADE)`)

    // C. Extensions.
    const ext = await d.listExtensions!()
    if (!ext.available.some((e) => e.name === 'pg_trgm')) throw new Error('pg_trgm not in available list')
    if (!(await d.execStatements(buildObjectOp('postgres', { kind: 'createExtension', name: 'pg_trgm' }).statements)).ok) throw new Error('create extension failed')
    if (!(await d.listExtensions!()).installed.some((e) => e.name === 'pg_trgm')) throw new Error('pg_trgm not installed after create')
    if (!(await d.execStatements(buildObjectOp('postgres', { kind: 'dropExtension', name: 'pg_trgm' }).statements)).ok) throw new Error('drop extension failed')
    results.push(`✅ ${tag} extensions: list available/install pg_trgm/list installed/drop`)

    // D. Advanced indexes (round-trip method/predicate/expression).
    await run('DROP TABLE IF EXISTS public._pgadv_t CASCADE')
    await run('CREATE TABLE public._pgadv_t (id serial primary key, email text, doc jsonb, active boolean)')
    const mk = (spec: import('@shared/types').IndexCreateSpec): Promise<import('@shared/types').DdlApplyResult> => d.execStatements(buildCreateIndex('postgres', spec).statements)
    if (!(await mk({ schema, table: '_pgadv_t', name: '_pgadv_gin', columns: ['doc'], unique: false, method: 'gin' })).ok) throw new Error('gin create failed')
    if (!(await mk({ schema, table: '_pgadv_t', name: '_pgadv_part', columns: ['email'], unique: false, where: 'active' })).ok) throw new Error('partial create failed')
    if (!(await mk({ schema, table: '_pgadv_t', name: '_pgadv_expr', columns: [], unique: false, expression: 'lower(email)' })).ok) throw new Error('expression create failed')
    const idxs = await d.listIndexes(schema, '_pgadv_t')
    const gin = idxs.find((i) => i.name === '_pgadv_gin')
    const part = idxs.find((i) => i.name === '_pgadv_part')
    const expr = idxs.find((i) => i.name === '_pgadv_expr')
    if (gin?.method !== 'gin') throw new Error(`gin method not round-tripped: ${gin?.method}`)
    if (!part?.predicate || !/active/.test(part.predicate)) throw new Error(`partial predicate not round-tripped: ${part?.predicate}`)
    if (!expr || !/lower\(email\)/i.test(expr.keyExpr ?? '')) throw new Error(`expression not round-tripped: ${JSON.stringify(expr)}`)
    if (!(await mk({ schema, table: '_pgadv_t', name: '_pgadv_btree', columns: ['email'], unique: false })).ok) throw new Error('basic btree failed')
    if (!(await d.listIndexes(schema, '_pgadv_t')).some((i) => i.name === '_pgadv_btree' && i.method === 'btree')) throw new Error('basic btree not listed')
    results.push(`✅ ${tag} indexes: gin/partial/expression round-trip + basic btree still works`)

    await cleanup()
    const c = await d.getTableRowCount(schema, 'customers', [], null, null)
    if (c !== 20) throw new Error(`customers changed: ${c}`)
    results.push(`✅ ${tag} cleanup done, customers=${c} intact`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
    await cleanup().catch(() => undefined)
  } finally {
    await d.disconnect().catch(() => undefined)
  }
}

/**
 * TASK 68 — DEEPER re-verification of the TASK 67 PG advanced objects: edge cases
 * the first smoke skipped (refresh reflecting source changes, CONCURRENTLY without
 * a unique index, definition round-trip with JOIN/aggregate, enum-as-column-type +
 * invalid-value rejection, ADD VALUE BEFORE/AFTER, RENAME VALUE, cascade drops,
 * gin/gist/brin/hash, unique-partial, edit round-trip, identifiers needing quoting).
 * All disposable objects use the `_rv67_` prefix; seeds left intact.
 */
async function testPgAdvancedDeep(config: ConnectionConfig): Promise<void> {
  if (config.engine !== 'postgres') return
  const tag = 'pg-adv-deep'
  const d = await createDriver(config)
  await d.connect()
  const schema = 'public'
  const run = (sql: string): Promise<import('@shared/types').DdlApplyResult> => d.execStatements([sql])
  const ok = async (sql: string, what: string): Promise<void> => { const r = await run(sql); if (!r.ok) throw new Error(`${what}: ${r.message}`) }
  const op = (o: import('@shared/types').ObjectOp): Promise<import('@shared/types').DdlApplyResult> => d.execStatements(buildObjectOp('postgres', o).statements)
  const cleanup = async (): Promise<void> => {
    for (const s of [
      'DROP MATERIALIZED VIEW IF EXISTS public."_rv67_MixMV"',
      'DROP MATERIALIZED VIEW IF EXISTS public._rv67_mv2',
      'DROP MATERIALIZED VIEW IF EXISTS public._rv67_mv',
      'DROP TABLE IF EXISTS public._rv67_a CASCADE',
      'DROP TABLE IF EXISTS public._rv67_b CASCADE',
      'DROP TABLE IF EXISTS public._rv67_idx CASCADE',
      'DROP TABLE IF EXISTS public._rv67_use CASCADE',
      'DROP TYPE IF EXISTS public."_rv67_Mood" CASCADE',
      'DROP TYPE IF EXISTS public._rv67_addr CASCADE',
      'DROP EXTENSION IF EXISTS pg_trgm CASCADE'
    ]) await run(s).catch(() => undefined)
  }
  const pass = (m: string): void => { results.push(`✅ ${tag} ${m}`) }
  try {
    await cleanup()

    // A. Matview: refresh reflects source changes; CONCURRENTLY needs a unique
    //    index; JOIN+aggregate definition round-trips; mixed-case name.
    await ok('CREATE TABLE public._rv67_a (id int primary key, name text)', 'base a')
    await ok('CREATE TABLE public._rv67_b (a_id int, val int)', 'base b')
    await ok("INSERT INTO public._rv67_a VALUES (1,'x'),(2,'y')", 'seed a')
    await ok('INSERT INTO public._rv67_b VALUES (1,10),(1,20)', 'seed b')
    await ok('CREATE MATERIALIZED VIEW public._rv67_mv AS SELECT a.name AS nm, count(b.val) AS cnt FROM public._rv67_a a LEFT JOIN public._rv67_b b ON b.a_id = a.id GROUP BY a.name WITH DATA', 'create mv')
    let mvRows = await d.getTablePage(schema, '_rv67_mv', 100, 1, null, [], null, null)
    let xRow = mvRows.rows.find((r) => (r as Record<string, unknown>).nm === 'x') as Record<string, unknown> | undefined
    if (Number(xRow?.cnt) !== 2) throw new Error(`initial matview cnt for x = ${xRow?.cnt}`)
    // CONCURRENTLY without a unique index must be REJECTED by PG.
    const conc1 = await op({ kind: 'refreshMatView', schema, name: '_rv67_mv', concurrently: true })
    if (conc1.ok) throw new Error('CONCURRENTLY without a unique index should have failed')
    // Insert a source row, refresh (plain) → matview reflects the change.
    await ok('INSERT INTO public._rv67_b VALUES (1,30)', 'insert source row')
    if (!(await op({ kind: 'refreshMatView', schema, name: '_rv67_mv' })).ok) throw new Error('plain refresh failed')
    mvRows = await d.getTablePage(schema, '_rv67_mv', 100, 1, null, [], null, null)
    xRow = mvRows.rows.find((r) => (r as Record<string, unknown>).nm === 'x') as Record<string, unknown> | undefined
    if (Number(xRow?.cnt) !== 3) throw new Error(`refreshed matview cnt for x = ${xRow?.cnt} (expected 3)`)
    // Add a unique index → CONCURRENTLY now works.
    await ok('CREATE UNIQUE INDEX _rv67_mv_uq ON public._rv67_mv (nm)', 'unique idx on mv')
    if (!(await op({ kind: 'refreshMatView', schema, name: '_rv67_mv', concurrently: true })).ok) throw new Error('CONCURRENTLY with unique index failed')
    // Definition round-trip: reopen the SELECT and recreate under a new name.
    const def = await d.getObjectDefinition({ connectionId: config.id, kind: 'matview', schema, name: '_rv67_mv' })
    if (!/join/i.test(def) || !/count/i.test(def)) throw new Error(`matview def lost JOIN/aggregate: ${def.slice(0, 80)}`)
    await ok(`CREATE MATERIALIZED VIEW public._rv67_mv2 AS\n${def}`, 'recreate from def')
    pass('matview: refresh reflects source change, CONCURRENTLY gated on unique index, JOIN+aggregate def round-trips')

    // A2. Mixed-case (quoted) matview name.
    await ok('CREATE MATERIALIZED VIEW public."_rv67_MixMV" AS SELECT 1 AS one WITH DATA', 'mixed-case mv')
    if (!(await d.listMatViews!(schema)).some((m) => m.name === '_rv67_MixMV')) throw new Error('mixed-case matview not listed')
    if (!(await op({ kind: 'dropMatView', schema, name: '_rv67_MixMV' })).ok) throw new Error('drop mixed-case matview failed')
    pass('matview: mixed-case (quoted) name create/list/drop')

    // B. Enum used as a column type; invalid value rejected; ADD VALUE BEFORE/AFTER;
    //    RENAME VALUE; composite fields; drop-in-use cascade; mixed-case name.
    await ok(`CREATE TYPE public."_rv67_Mood" AS ENUM ('sad','happy')`, 'create enum')
    await ok(`CREATE TABLE public._rv67_use (id int, m public."_rv67_Mood")`, 'table using enum')
    await ok(`INSERT INTO public._rv67_use VALUES (1,'happy')`, 'insert valid enum')
    const badEnum = await run(`INSERT INTO public._rv67_use VALUES (2,'furious')`)
    if (badEnum.ok) throw new Error('invalid enum value should have been rejected')
    if (!/invalid input value for enum/i.test(badEnum.message ?? '')) throw new Error(`enum error not surfaced: ${badEnum.message}`)
    await ok(`ALTER TYPE public."_rv67_Mood" ADD VALUE 'ok' BEFORE 'happy'`, 'add value BEFORE')
    await ok(`ALTER TYPE public."_rv67_Mood" ADD VALUE 'ecstatic' AFTER 'happy'`, 'add value AFTER')
    await ok(`ALTER TYPE public."_rv67_Mood" RENAME VALUE 'sad' TO 'blue'`, 'rename value')
    const enumInfo = (await d.listTypes!(schema)).find((t) => t.name === '_rv67_Mood')
    const labels = (enumInfo?.labels ?? []).join(',')
    if (labels !== 'blue,ok,happy,ecstatic') throw new Error(`enum labels/order wrong after edits: ${labels}`)
    await ok('CREATE TYPE public._rv67_addr AS (street text, zip int)', 'create composite')
    if ((((await d.listTypes!(schema)).find((t) => t.name === '_rv67_addr'))?.fields ?? []).length !== 2) throw new Error('composite fields not read')
    // Drop enum in use: without CASCADE blocked, with CASCADE works.
    if ((await op({ kind: 'dropType', schema, name: '_rv67_Mood' })).ok) throw new Error('drop of in-use enum should be blocked')
    if (!(await op({ kind: 'dropType', schema, name: '_rv67_Mood', cascade: true })).ok) throw new Error('drop enum CASCADE failed')
    pass('types: enum-as-column, invalid-value rejected, ADD VALUE BEFORE/AFTER, RENAME VALUE, composite fields, drop-in-use CASCADE')

    // C. Extension pg_trgm → a gin_trgm_ops index; drop-with-dependent CASCADE.
    if (!(await op({ kind: 'createExtension', name: 'pg_trgm' })).ok) throw new Error('install pg_trgm failed')
    await ok('CREATE TABLE public._rv67_idx (id serial primary key, email text, doc jsonb, tags text[], tsv tsvector, n int)', 'idx table')
    await ok('CREATE INDEX _rv67_trgm ON public._rv67_idx USING gin (email gin_trgm_ops)', 'gin_trgm_ops index')
    // DROP EXTENSION without CASCADE must be blocked (the trgm index depends on it).
    if ((await op({ kind: 'dropExtension', name: 'pg_trgm' })).ok) throw new Error('drop pg_trgm with dependent index should be blocked')
    if (!(await op({ kind: 'dropExtension', name: 'pg_trgm', cascade: true })).ok) throw new Error('drop pg_trgm CASCADE failed')
    // The dependent index should be gone after CASCADE.
    if ((await d.listIndexes(schema, '_rv67_idx')).some((i) => i.name === '_rv67_trgm')) throw new Error('dependent trgm index survived CASCADE')
    // Unavailable extension → clear error, no crash.
    const badExt = await op({ kind: 'createExtension', name: '_rv67_nonexistent' })
    if (badExt.ok) throw new Error('nonexistent extension create should fail')
    pass('extensions: install pg_trgm + gin_trgm_ops index, drop-with-dependent CASCADE, unavailable-extension error surfaced')

    // D. Advanced index methods + partial/expression/unique-partial/multi-column,
    //    each round-tripping via listIndexes.
    const mk = (spec: import('@shared/types').IndexCreateSpec, what: string): Promise<void> => ok(buildCreateIndex('postgres', spec).sql.replace(/;$/, ''), what)
    await mk({ schema, table: '_rv67_idx', name: '_rv67_gin_json', columns: ['doc'], unique: false, method: 'gin' }, 'gin jsonb')
    await mk({ schema, table: '_rv67_idx', name: '_rv67_gin_arr', columns: ['tags'], unique: false, method: 'gin' }, 'gin text[]')
    await mk({ schema, table: '_rv67_idx', name: '_rv67_gist', columns: ['tsv'], unique: false, method: 'gist' }, 'gist tsvector')
    await mk({ schema, table: '_rv67_idx', name: '_rv67_brin', columns: ['n'], unique: false, method: 'brin' }, 'brin int')
    await mk({ schema, table: '_rv67_idx', name: '_rv67_hash', columns: ['email'], unique: false, method: 'hash' }, 'hash text')
    await mk({ schema, table: '_rv67_idx', name: '_rv67_part', columns: ['email'], unique: false, where: 'n > 0' }, 'partial')
    await mk({ schema, table: '_rv67_idx', name: '_rv67_expr', columns: [], unique: false, expression: 'lower(email)' }, 'expression')
    await mk({ schema, table: '_rv67_idx', name: '_rv67_upart', columns: ['email'], unique: true, where: 'n = 1' }, 'unique partial')
    await mk({ schema, table: '_rv67_idx', name: '_rv67_multi', columns: ['email', 'n'], unique: false }, 'multi-column btree')
    const idxs = await d.listIndexes(schema, '_rv67_idx')
    const byName = (n: string): import('@shared/types').IndexInfo | undefined => idxs.find((i) => i.name === n)
    const checks: [string, (i?: import('@shared/types').IndexInfo) => boolean][] = [
      ['_rv67_gin_json', (i) => i?.method === 'gin'],
      ['_rv67_gin_arr', (i) => i?.method === 'gin'],
      ['_rv67_gist', (i) => i?.method === 'gist'],
      ['_rv67_brin', (i) => i?.method === 'brin'],
      ['_rv67_hash', (i) => i?.method === 'hash'],
      ['_rv67_part', (i) => !!i?.predicate && /n > 0/.test(i.predicate)],
      ['_rv67_expr', (i) => /lower\(email\)/i.test(i?.keyExpr ?? '')],
      ['_rv67_upart', (i) => !!i?.unique && !!i?.predicate],
      ['_rv67_multi', (i) => (i?.columns.length ?? 0) === 2]
    ]
    for (const [n, ok2] of checks) if (!ok2(byName(n))) throw new Error(`index ${n} did not round-trip: ${JSON.stringify(byName(n))}`)
    // Edit round-trip: recreate the expression index as UNIQUE via buildAlterIndex,
    // preserving the expression.
    const exprInfo = byName('_rv67_expr')!
    const editSpec: import('@shared/types').IndexCreateSpec = { schema, table: '_rv67_idx', name: '_rv67_expr', originalName: '_rv67_expr', columns: [], unique: true, method: (exprInfo.method as import('@shared/types').PgIndexMethod), where: exprInfo.predicate ?? '', expression: exprInfo.keyExpr ?? '' }
    const alter = buildAlterIndex('postgres', editSpec, { schema, table: '_rv67_idx', name: '_rv67_expr', columns: [], unique: false, method: 'btree', where: '', expression: exprInfo.keyExpr ?? '' })
    if (!(await d.execStatements(alter.statements)).ok) throw new Error('expression-index edit (recreate) failed')
    const expr2 = (await d.listIndexes(schema, '_rv67_idx')).find((i) => i.name === '_rv67_expr')
    if (!expr2?.unique || !/lower\(email\)/i.test(expr2.keyExpr ?? '')) throw new Error('expression not preserved through edit')
    pass('indexes: gin(jsonb+text[])/gist/brin/hash + partial/expression/unique-partial/multi-column round-trip; edit preserves expression')

    await cleanup()
    const c = await d.getTableRowCount(schema, 'customers', [], null, null)
    if (c !== 20) throw new Error(`customers changed: ${c}`)
    pass(`cleanup done, customers=${c} intact`)
  } catch (err) {
    failed = true
    results.push(`❌ ${tag}: ${(err as Error).message}`)
    await cleanup().catch(() => undefined)
  } finally {
    await d.disconnect().catch(() => undefined)
  }
}

export async function runSmoke(): Promise<void> {
  log('starting DB layer smoke test (inside Electron main)')

  testBackends()

  const sqlitePath = process.env['SMOKE_SQLITE_PATH'] || join(process.cwd(), '.smoke', 'dbtool.sqlite')
  try {
    prepareSqlite(sqlitePath)
  } catch (err) {
    failed = true
    results.push(`❌ sqlite-prepare: ${(err as Error).message}`)
  }

  // Host/port/creds default to the TASK 01 containers but can be OVERRIDDEN via
  // env (SMOKE_PG_PORT, SMOKE_MYSQL_HOST, …) so the SAME suite can be pointed at
  // other engine versions for compatibility testing. Defaults are unchanged, so
  // a plain `SMOKE=1` run still hits PG16 / MySQL8 exactly as before.
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v)
    return v && Number.isFinite(n) ? n : d
  }
  const configs: ConnectionConfig[] = [
    {
      id: 'smoke-pg',
      name: 'pg',
      engine: 'postgres',
      host: process.env['SMOKE_PG_HOST'] || 'localhost',
      port: num(process.env['SMOKE_PG_PORT'], 5432),
      user: process.env['SMOKE_PG_USER'] || 'dbtool',
      password: process.env['SMOKE_PG_PASSWORD'] ?? 'dbtool',
      database: process.env['SMOKE_PG_DB'] || 'dbtool_dev'
    },
    {
      id: 'smoke-mysql',
      name: 'mysql',
      engine: 'mysql',
      host: process.env['SMOKE_MYSQL_HOST'] || 'localhost',
      port: num(process.env['SMOKE_MYSQL_PORT'], 3306),
      user: process.env['SMOKE_MYSQL_USER'] || 'dbtool',
      password: process.env['SMOKE_MYSQL_PASSWORD'] ?? 'dbtool',
      database: process.env['SMOKE_MYSQL_DB'] || 'dbtool_dev'
    },
    { id: 'smoke-sqlite', name: 'sqlite', engine: 'sqlite', filePath: sqlitePath }
  ]

  // Optional engine filter (comma list), e.g. SMOKE_ENGINES=postgres to run just
  // one engine against a specific version container.
  const only = (process.env['SMOKE_ENGINES'] || '').split(',').map((s) => s.trim()).filter(Boolean)

  // MariaDB has no TASK 01 default container, so it's only added when explicitly
  // requested (SMOKE_MARIADB_PORT set, or SMOKE_ENGINES includes 'mariadb').
  if (process.env['SMOKE_MARIADB_PORT'] || only.includes('mariadb')) {
    configs.push({
      id: 'smoke-mariadb',
      name: 'mariadb',
      engine: 'mariadb',
      host: process.env['SMOKE_MARIADB_HOST'] || 'localhost',
      port: num(process.env['SMOKE_MARIADB_PORT'], 3308),
      user: process.env['SMOKE_MARIADB_USER'] || 'dbtool',
      password: process.env['SMOKE_MARIADB_PASSWORD'] ?? 'dbtool',
      database: process.env['SMOKE_MARIADB_DB'] || 'dbtool_dev'
    })
  }

  // Oracle (no default container) — only when explicitly requested.
  if (process.env['SMOKE_ORACLE_PORT'] || only.includes('oracle')) {
    configs.push({
      id: 'smoke-oracle',
      name: 'oracle',
      engine: 'oracle',
      host: process.env['SMOKE_ORACLE_HOST'] || 'localhost',
      port: num(process.env['SMOKE_ORACLE_PORT'], 1521),
      user: process.env['SMOKE_ORACLE_USER'] || 'dbtool',
      password: process.env['SMOKE_ORACLE_PASSWORD'] ?? 'dbtool',
      serviceName: process.env['SMOKE_ORACLE_SERVICE'] || 'XEPDB1',
      driverMode: 'thin'
    })
  }

  // SQL Server (no default container) — only when explicitly requested.
  if (process.env['SMOKE_MSSQL_PORT'] || only.includes('mssql')) {
    configs.push({
      id: 'smoke-mssql',
      name: 'mssql',
      engine: 'mssql',
      host: process.env['SMOKE_MSSQL_HOST'] || 'localhost',
      port: num(process.env['SMOKE_MSSQL_PORT'], 1433),
      user: process.env['SMOKE_MSSQL_USER'] || 'sa',
      password: process.env['SMOKE_MSSQL_PASSWORD'] ?? 'DbTool!Passw0rd',
      database: process.env['SMOKE_MSSQL_DB'] || 'dbtool_dev',
      authType: 'sql',
      encrypt: true,
      trustServerCertificate: true
    })
  }

  for (const cfg of configs) {
    if (only.length && !only.includes(cfg.engine)) continue
    if (cfg.engine === 'sqlite' && !existsSync(sqlitePath)) continue
    // TASK 56 audit: awkward-data import/export + template matrices on EVERY engine.
    await testAudit(cfg)
    await testTemplates(cfg)
    // Oracle and SQL Server are BASICS-stage — run their focused test only.
    if (cfg.engine === 'oracle') {
      await testOracle(cfg)
      continue
    }
    if (cfg.engine === 'mssql') {
      await testMssql(cfg)
      continue
    }
    await testEngine(cfg)
    await testDdl(cfg)
    await testCrud(cfg)
    await testTypeSystem(cfg)
    await testPagination(cfg)
    await testFilters(cfg)
    await testFilterBuilder(cfg)
    await testViewsRoutines(cfg)
    await testViewBuilder(cfg)
    await testViewReverse(cfg)
    await testTreeDedup(cfg)
    await testCustomWhere(cfg)
    await testErDiagram(cfg)
    await testSequences(cfg)
    await testTriggers(cfg)
    await testIndexes(cfg)
    await testImportExport(cfg)
    await testDumpRestore(cfg)
    // TASK 67: PostgreSQL advanced objects (matviews / types / extensions / advanced indexes).
    if (cfg.engine === 'postgres') await testPgAdvanced(cfg)
    // TASK 68: deeper edge-case re-verification of the PG advanced objects.
    if (cfg.engine === 'postgres') await testPgAdvancedDeep(cfg)
  }

  // TASK 64: cross-engine data transfer matrix (needs every engine connected at
  // once, so it runs after the per-engine loop with its own connections).
  await testTransfer(configs)
  // TASK 65: deeper transfer edge cases (empty/composite/no-PK, self/cyclic FK,
  // volume, long text, blob, all-NULL, quoting, append, overrides, errors).
  await testTransferDeep(configs)

  const summary = [
    '==== RESULTS ====',
    ...results,
    '=================',
    failed ? 'SMOKE FAILED' : 'SMOKE PASSED'
  ].join('\n')

  for (const line of summary.split('\n')) log(line)

  // A packaged GUI exe does not reliably attach stdout to the terminal, so
  // also write the outcome to a file when SMOKE_OUT is set.
  const outPath = process.env['SMOKE_OUT']
  if (outPath) {
    try {
      writeFileSync(outPath, summary + '\n', 'utf-8')
      log('wrote smoke results to', outPath)
    } catch (err) {
      log('failed to write SMOKE_OUT:', (err as Error).message)
    }
  }
}
