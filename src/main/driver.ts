// The single database abstraction. All three engines (PostgreSQL, MySQL,
// SQLite) implement this ONE interface, so the rest of the app never cares
// which engine is underneath. Defined once here; implemented three times in
// ./drivers/*.
//
// IMPORTANT: everything in this file and ./drivers/* runs in the Electron
// MAIN process only. The renderer never imports any of it.

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
  PackageRef,
  RowChangeRequest,
  RowChangeResult,
  SchemaCatalog,
  SequenceInfo,
  SequenceRef,
  SortSpec,
  TableRef,
  TriggerDetails,
  TriggerRef,
  TableSpec,
  TestConnectionResult,
  ViewRef
} from '@shared/types'

/**
 * Coerce a grid value for a parameterized write. The grid hands us strings;
 * the DB coerces most of them, but an empty string must become NULL for
 * non-textual columns (e.g. an int/json/date column can't accept '').
 */
export function coerceForWrite(value: unknown, sqlType: string | undefined): unknown {
  if (value === null || value === undefined) return null
  if (value === '') {
    const t = (sqlType ?? '').toLowerCase()
    const textual = /char|text|clob/.test(t) && !/\[\]/.test(t)
    return textual ? '' : null
  }
  return value
}

/**
 * Build a STABLE ORDER BY clause for pagination: use the explicit sort if given,
 * else the primary key (deterministic), else ALL columns (still deterministic,
 * ties broken by every column). Falls back to `1` for an empty column list.
 */
export function orderByClause(
  struct: ColumnDef[],
  sort: SortSpec | null | undefined,
  qid: (id: string) => string
): string {
  if (sort && sort.column) {
    return `${qid(sort.column)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}`
  }
  const pk = struct.filter((c) => c.isPrimaryKey).map((c) => qid(c.name))
  if (pk.length > 0) return pk.join(', ')
  if (struct.length > 0) return struct.map((c) => qid(c.name)).join(', ')
  return '1'
}

export interface DbDriver {
  readonly config: ConnectionConfig

  connect(): Promise<void>
  disconnect(): Promise<void>
  testConnection(): Promise<TestConnectionResult>

  /** Databases on the server (where applicable). */
  listDatabases(): Promise<string[]>
  /** PG: schemas; MySQL: databases; SQLite: ['main']. */
  listSchemas(): Promise<string[]>
  listTables(schema: string): Promise<TableRef[]>
  getTableStructure(schema: string, table: string): Promise<ColumnDef[]>

  /**
   * Full catalog (tables + columns with types) for the current database, used
   * to power schema-aware editor autocomplete. Fetched in MAIN only.
   */
  getSchemaCatalog(): Promise<SchemaCatalog>

  /** Execute arbitrary SQL. */
  runQuery(sql: string, params?: unknown[]): Promise<QueryResult>

  /**
   * Build and run a parameterized `SELECT *` for a table, capped at `limit`.
   * Kept on the driver so each engine can quote identifiers correctly.
   */
  getTableRows(schema: string, table: string, limit: number): Promise<QueryResult>

  /**
   * One page of a table with a STABLE order (sort, else PK, else all columns)
   * and LIMIT/OFFSET — server-side pagination for browsing large tables.
   */
  getTablePage(
    schema: string,
    table: string,
    pageSize: number,
    page: number,
    sort?: SortSpec | null,
    filters?: ColumnFilter[] | null,
    tree?: FilterGroup | null,
    customWhere?: string | null
  ): Promise<QueryResult>

  /** Total row count for a table (filtered when filters/tree/customWhere provided). */
  getTableRowCount(
    schema: string,
    table: string,
    filters?: ColumnFilter[] | null,
    tree?: FilterGroup | null,
    customWhere?: string | null
  ): Promise<number>

  /**
   * Update exactly one column of the row(s) matched by `primaryKey`.
   * Returns number of affected rows. Uses parameterized SQL — never string
   * concatenation of values.
   */
  updateCell(
    schema: string,
    table: string,
    column: string,
    value: unknown,
    primaryKey: Record<string, unknown>
  ): Promise<number>

  /** Introspect a full table design (columns, PK, FKs, indexes) for editing. */
  getTableSpec(schema: string, table: string): Promise<TableSpec>

  // --- programmable / derived objects ---
  listViews(schema: string): Promise<ViewRef[]>
  /** Functions + procedures (empty for SQLite). */
  listRoutines(schema: string): Promise<RoutineRef[]>
  /** Oracle PL/SQL packages (spec + body). Optional — only Oracle implements it. */
  listPackages?(schema: string): Promise<PackageRef[]>
  /** View => SELECT body; function/procedure/package => full CREATE statement. */
  getObjectDefinition(req: ObjectDefRequest): Promise<string>
  /** Execute programmable-object DDL statements (reuses execStatements). */
  applyObjectSql(statements: string[]): Promise<DdlApplyResult>

  /** Sequences (PostgreSQL). MySQL/SQLite return [] (no standalone sequences). */
  listSequences(schema: string): Promise<SequenceRef[]>
  /** Full properties of one sequence (PostgreSQL only). */
  getSequenceDetails(schema: string, name: string): Promise<SequenceInfo>

  /** Triggers attached to a table (all engines). */
  listTriggers(schema: string, table: string): Promise<TriggerRef[]>
  /** Full definition of one trigger, parsed into fields for the edit form. */
  getTriggerDetails(schema: string, table: string, name: string): Promise<TriggerDetails>

  /** Indexes on a table (all engines), with unique + constraint-backed flags. */
  listIndexes(schema: string, table: string): Promise<IndexInfo[]>

  // --- PostgreSQL advanced objects (TASK 67). Optional — only PG implements. ---
  /** Materialized views in a schema. */
  listMatViews?(schema: string): Promise<import('@shared/types').MatViewRef[]>
  /** User-defined types (enum + composite) in a schema. */
  listTypes?(schema: string): Promise<import('@shared/types').TypeRef[]>
  /** Installed + available extensions (database-wide). */
  listExtensions?(): Promise<{ installed: import('@shared/types').ExtensionRef[]; available: import('@shared/types').ExtensionRef[] }>

  /**
   * Apply a batch of INSERT/UPDATE/DELETE row changes in one transaction.
   * All values are parameterized. Returns per-phase counts and the inserted
   * rows (with DB-assigned ids where the engine can return them). On error the
   * transaction is rolled back and `failure` says which phase/row failed.
   */
  applyRowChanges(req: RowChangeRequest): Promise<RowChangeResult>

  /**
   * Execute a list of DDL statements with this engine's transaction semantics
   * (PG/SQLite transactional; MySQL statement-by-statement). Reports which
   * statement failed on error.
   */
  execStatements(statements: string[]): Promise<DdlApplyResult>

  /**
   * Bulk-insert rows for a cross-engine data transfer, PRESERVING the explicit
   * column values (including PK/identity) so foreign keys stay valid. Values are
   * PARAMETERIZED — never string-concatenated. Per-engine mechanics:
   *  - pg/mysql/sqlite: batched multi-row VALUES
   *  - oracle: single-row binds (no multi-row VALUES)
   *  - mssql: 1000-row chunks wrapped in SET IDENTITY_INSERT when `identityCols`
   *    is non-empty (so server-side identity values are overridden by the source).
   * Runs inside one transaction; returns the number of rows inserted. `columns`
   * are target column names; each `rows[i]` is aligned to `columns`; `columnTypes`
   * maps a target column name to its type (for the driver's own value coercion —
   * ''→NULL, ISO-string→Date on Oracle, etc.).
   */
  transferInsert(
    schema: string,
    table: string,
    columns: string[],
    rows: unknown[][],
    columnTypes: Record<string, string>,
    identityCols: string[]
  ): Promise<number>
}

// The factory is created lazily to avoid importing native drivers (which are
// external at build time) until a driver is actually needed.
export async function createDriver(config: ConnectionConfig): Promise<DbDriver> {
  switch (config.engine) {
    case 'postgres': {
      const { PostgresDriver } = await import('./drivers/postgres')
      return new PostgresDriver(config)
    }
    case 'mysql': {
      const { MysqlDriver } = await import('./drivers/mysql')
      return new MysqlDriver(config)
    }
    case 'mariadb': {
      const { MariadbDriver } = await import('./drivers/mariadb')
      return new MariadbDriver(config)
    }
    case 'oracle': {
      const { OracleDriver } = await import('./drivers/oracle')
      return new OracleDriver(config)
    }
    case 'mssql': {
      const { MssqlDriver } = await import('./drivers/mssql')
      return new MssqlDriver(config)
    }
    case 'sqlite': {
      const { SqliteDriver } = await import('./drivers/sqlite')
      return new SqliteDriver(config)
    }
    default: {
      const _exhaustive: never = config.engine
      throw new Error(`Unsupported engine: ${String(_exhaustive)}`)
    }
  }
}
