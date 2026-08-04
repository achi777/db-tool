// Zustand store: the renderer's single source of UI state. It talks to main
// ONLY through window.dbApi (the typed preload bridge) — never any driver.
//
// State is organized around query TABS: each tab has its own editor buffer,
// chosen connection, and result grid. Connections (and their live status +
// object tree + schema catalog) are shared across tabs, keyed by connection id.
import { create } from 'zustand'
import type {
  ColumnFilter,
  FilterGroup,
  ConnectionConfig,
  DdlMode,
  DdlPreview,
  ExportFormat,
  HistoryEntry,
  IndexCreateSpec,
  IndexInfo,
  MatViewRef,
  TypeRef,
  ExtensionRef,
  ObjectOp,
  PersistedTab,
  QueryResult,
  RoutineRef,
  RoutineKind,
  PackageRef,
  SafeConnectionConfig,
  SavedFilter,
  SavedFilterState,
  SchemaCatalog,
  SequenceInfo,
  SequenceRef,
  SequenceSpec,
  SortSpec,
  TableRef,
  TableSpec,
  ThemeMode,
  TriggerRef,
  TriggerSpec,
  ViewModel,
  ViewRef
} from '@shared/types'
import { generateViewSelect } from '@shared/viewBuilder'
import { resolveViewModel } from '@shared/viewResolve'
import { buildAlterSequence, buildCreateSequence } from '@shared/sequenceDdl'
import { buildTriggerStatements, buildSetTriggerEnabled } from '@shared/triggerDdl'
import { buildAlterIndex, buildCreateIndex } from '@shared/indexDdl'
import { PAGE_SIZE_DEFAULT, sqlDialect } from '@shared/types'

export interface DesignerState {
  mode: DdlMode
  spec: TableSpec
  original: TableSpec | null
  preview: DdlPreview | null
  applying: boolean
  message: string | null
}

export interface ObjectOpState {
  connectionId: string
  op: ObjectOp
  preview: DdlPreview | null
  applying: boolean
  message: string | null
}

/** Context for the Export dialog: target + (optional) captured active filter. */
export interface IoExportCtx {
  connectionId: string
  schema: string
  table: string
  /** Present when launched from a filtered grid — enables scope "current filter". */
  filter: { filters: ColumnFilter[]; tree: FilterGroup | null; customWhere: string | null } | null
  /** Initial format (e.g. 'sql' for "Dump table…"). */
  presetFormat?: ExportFormat
}

/** Context for the Import wizard: the target table to insert into. */
export interface IoImportCtx {
  connectionId: string
  schema: string
  table: string
}

/** Context for the database Dump dialog. */
export interface IoDbDumpCtx {
  connectionId: string
  schema: string
}

/** Context for the Execute-SQL-file (restore) dialog. */
export interface IoRestoreCtx {
  connectionId: string
  schema: string
}

/** State for the PostgreSQL Extensions dialog (installed + available list). */
export interface ExtDialogState {
  connectionId: string
  installed: ExtensionRef[]
  available: ExtensionRef[]
  loading: boolean
  message: string | null
}

/** Context for the cross-engine Data Transfer wizard (pre-selected source). */
export interface IoTransferCtx {
  connectionId: string
  schema: string
  /** Optional table to pre-select in the source list. */
  table?: string
}

export type TreeTarget =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'schema'; connectionId: string; schema: string }
  | { kind: 'table'; connectionId: string; schema: string; table: string }
  | { kind: 'view'; connectionId: string; schema: string; name: string }
  | { kind: 'routine'; connectionId: string; schema: string; name: string; routineKind: RoutineKind; signature?: string | null }
  | { kind: 'package'; connectionId: string; schema: string; name: string; hasBody: boolean }
  | { kind: 'sequence'; connectionId: string; schema: string; name: string }
  | { kind: 'triggersCat'; connectionId: string; schema: string; table: string }
  | { kind: 'trigger'; connectionId: string; schema: string; table: string; name: string; enabled?: boolean }
  | { kind: 'indexesCat'; connectionId: string; schema: string; table: string }
  | { kind: 'index'; connectionId: string; schema: string; table: string; name: string; constraintBacked: boolean }
  // PostgreSQL advanced objects (TASK 67)
  | { kind: 'matview'; connectionId: string; schema: string; name: string; populated: boolean }
  | { kind: 'type'; connectionId: string; schema: string; name: string; typeKind: 'enum' | 'composite' | 'other' }
  | { kind: 'extensionsCat'; connectionId: string; schema: string }
  | { kind: 'extension'; connectionId: string; name: string; installedVersion: string | null; defaultVersion: string | null }

export interface ContextMenuState {
  x: number
  y: number
  target: TreeTarget
}

export interface OpenTable {
  schema: string
  table: string
}

export interface PendingEdit {
  primaryKey: Record<string, unknown>
  changes: Record<string, unknown>
}

export interface GridPending {
  /** rowKey -> pending update (edits to an existing row). */
  edits: Record<string, PendingEdit>
  /** rowKey -> pk map (existing rows staged for delete). */
  deletes: Record<string, Record<string, unknown>>
  /** New rows being typed (col -> value); committed as INSERTs. */
  newRows: Record<string, unknown>[]
}

export interface ObjectEditorState {
  // Oracle adds packages: 'package' (new — spec + body in one editor, split on
  // the `/` line), and 'packageSpec' / 'packageBody' (edit one part).
  objKind: 'view' | 'matview' | 'type' | RoutineKind | 'package' | 'packageSpec' | 'packageBody'
  mode: 'new' | 'edit'
  schema: string
  /** View: editable target name. Routine/package: original name for display/drop. */
  name: string
  signature?: string | null
  /** View: the SELECT body. Routine/package: the full CREATE statement(s). */
  body: string
  /** View option (PG/MySQL): CREATE OR REPLACE. */
  orReplace: boolean
  applying: boolean
  message: string | null
  /** For destructive edits (drop+recreate), require an explicit confirm. */
  confirmed: boolean
}

/** Form-based editor state for a PostgreSQL sequence (kind 'sequence'). */
export interface SequenceEditorState {
  mode: 'new' | 'edit'
  spec: SequenceSpec
  /** EDIT: the original properties, to diff for ALTER. */
  original: SequenceSpec | null
  /** EDIT: loaded details (owned-by + current/last value). */
  details: SequenceInfo | null
  applying: boolean
  message: string | null
}

/** Editor state for a trigger (kind 'trigger'). */
export interface TriggerEditorState {
  mode: 'new' | 'edit'
  spec: TriggerSpec
  applying: boolean
  message: string | null
}

/** Editor state for a standalone index (kind 'index'). */
export interface IndexEditorState {
  mode: 'new' | 'edit'
  spec: IndexCreateSpec
  original: IndexCreateSpec | null
  applying: boolean
  message: string | null
}

export interface Tab {
  id: string
  title: string
  connectionId: string | null
  sql: string
  kind: 'query' | 'designer' | 'object' | 'viewbuilder' | 'erdiagram' | 'sequence' | 'trigger' | 'index'
  designer?: DesignerState
  objectEditor?: ObjectEditorState
  /** Sequence form editor (kind 'sequence'). */
  sequenceEditor?: SequenceEditorState
  /** Trigger editor (kind 'trigger'). */
  triggerEditor?: TriggerEditorState
  /** Index editor (kind 'index'). */
  indexEditor?: IndexEditorState
  /** Visual view builder model + target schema (kind 'viewbuilder'). */
  viewModel?: ViewModel
  vbSchema?: string
  /** When editing an existing view in the builder, its name (prefills Save as). */
  vbName?: string
  /** ER diagram target schema (kind 'erdiagram'). */
  erSchema?: string
  // transient (never persisted)
  result: QueryResult | null
  resultError: string | null
  running: boolean
  gridTable: OpenTable | null
  /** Full spec of the open table (columns/pk/autoinc/defaults) for CRUD; null for ad-hoc queries. */
  gridSpec: TableSpec | null
  pending: GridPending
  crudMessage: string | null
  statusMessage: string | null
  // --- server-side pagination (table browsing only) ---
  page: number
  pageSize: number
  /** Total row count (filtered when filters are active); null while COUNT runs. */
  total: number | null
  countLoading: boolean
  sort: SortSpec | null
  /** Active per-column quick filters (AND-combined). */
  filters: ColumnFilter[]
  /** Advanced visual-builder filter tree (nested AND/OR); null if unused. */
  builderTree: FilterGroup | null
  /** Which filter mode drives the current view; exactly one applies at a time. */
  filterMode: FilterMode
  /** Raw predicate text for Custom WHERE mode (retained across mode switches). */
  customWhere: string
  /** Error from the last Custom WHERE apply (guard/engine), shown by the input. */
  customWhereError: string | null
}

export type FilterMode = 'quick' | 'builder' | 'custom'

function emptyPending(): GridPending {
  return { edits: {}, deletes: {}, newRows: [] }
}

interface TreeState {
  schemas: string[]
  expanded: string[]
  tablesBySchema: Record<string, TableRef[]>
  /** Expanded category keys, e.g. `${schema}::views`. */
  expandedCats: string[]
  viewsBySchema: Record<string, ViewRef[]>
  functionsBySchema: Record<string, RoutineRef[]>
  proceduresBySchema: Record<string, RoutineRef[]>
  /** Oracle PL/SQL packages per schema. */
  packagesBySchema: Record<string, PackageRef[]>
  sequencesBySchema: Record<string, SequenceRef[]>
  /** PostgreSQL advanced objects (TASK 67), per schema. Extensions are DB-wide but keyed by schema for tree layout. */
  matviewsBySchema: Record<string, MatViewRef[]>
  typesBySchema: Record<string, TypeRef[]>
  extensionsBySchema: Record<string, ExtensionRef[]>
  /** Tables whose child nodes (Columns/Triggers/Indexes) are expanded — keys `${schema}::${table}`. */
  expandedTables: string[]
  /** Triggers per table — keys `${schema}::${table}`. */
  triggersByTable: Record<string, TriggerRef[]>
  /** Indexes per table — keys `${schema}::${table}`. */
  indexesByTable: Record<string, IndexInfo[]>
  /** Columns per table (for the tree's Columns node) — keys `${schema}::${table}`. */
  columnsByTable: Record<string, TreeColumn[]>
  /** Keys (schema / category / per-table-cat) currently lazy-loading — drives a spinner. */
  loadingKeys: string[]
}

/** A column as shown in the object tree (name + type + PK/FK/nullable markers). */
export interface TreeColumn {
  name: string
  type: string
  isPrimaryKey: boolean
  isForeignKey: boolean
  nullable: boolean
}

function emptyTree(): TreeState {
  return {
    schemas: [],
    expanded: [],
    tablesBySchema: {},
    expandedCats: [],
    viewsBySchema: {},
    functionsBySchema: {},
    proceduresBySchema: {},
    packagesBySchema: {},
    sequencesBySchema: {},
    matviewsBySchema: {},
    typesBySchema: {},
    extensionsBySchema: {},
    expandedTables: [],
    triggersByTable: {},
    indexesByTable: {},
    columnsByTable: {},
    loadingKeys: []
  }
}

/** Composite key for per-table maps. */
function tkey(schema: string, table: string): string {
  return `${schema}::${table}`
}

/** Apply the color theme by setting data-theme on the document root. */
function applyTheme(theme: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', theme)
}

export type ObjCategory = 'tables' | 'views' | 'functions' | 'procedures' | 'packages' | 'sequences' | 'matviews' | 'types' | 'extensions'

interface AppState {
  // Connections (shared across tabs)
  connections: SafeConnectionConfig[]
  defaults: ConnectionConfig[]
  connectedIds: string[]

  // Per-connection object tree + autocomplete catalog
  treeByConn: Record<string, TreeState>
  catalogByConn: Record<string, SchemaCatalog>

  // Tabs
  tabs: Tab[]
  activeTabId: string | null

  // History drawer
  historyOpen: boolean
  history: HistoryEntry[]
  historySearch: string

  // DDL: object-op modal + tree context menu
  objectOp: ObjectOpState | null
  contextMenu: ContextMenuState | null

  // Import / Export modals
  ioExport: IoExportCtx | null
  ioImport: IoImportCtx | null
  ioDbDump: IoDbDumpCtx | null
  ioRestore: IoRestoreCtx | null
  ioTransfer: IoTransferCtx | null
  /** PostgreSQL Extensions manager dialog (TASK 67). */
  extDialog: ExtDialogState | null

  // Layout
  sidebarCollapsed: boolean
  filterSqlCollapsed: boolean
  theme: ThemeMode
  /** Keyboard-shortcuts reference modal (TASK 71). */
  shortcutsOpen: boolean
  // Native menu wiring (TASK 72)
  /** About dialog open (shared so the menu + the status-bar button both drive it). */
  aboutOpen: boolean
  /** Bumped to ask the ConnectionManager to open its New-connection form. */
  newConnSignal: number
  /** Bumped to ask the active table's DataGrid to open its Saved-filters popover. */
  savedFiltersSignal: number
  /** Transient status-bar notice (auto-clears) for menu no-ops etc. */
  notice: string | null

  ready: boolean

  // --- lifecycle
  init: () => Promise<void>
  refreshConnections: () => Promise<void>

  // --- connection ops (shared)
  connect: (id: string) => Promise<void>
  disconnect: (id: string) => Promise<void>
  useConnectionInActiveTab: (id: string) => Promise<void>
  saveConnection: (c: ConnectionConfig) => Promise<(SafeConnectionConfig & { warning?: string }) | null>
  deleteConnection: (id: string) => Promise<void>

  // --- tree ops
  loadSchemas: (connId: string) => Promise<void>
  /**
   * Cache-busting reload of a connection's object tree: re-reads the live schema
   * list and re-fetches every currently-EXPANDED schema/category/table-child from
   * the database, dropping stale cached lists (so a newly created table appears
   * and a dropped one disappears without a reconnect). Scoped to `connId` and to
   * what is expanded, so large schemas stay responsive.
   */
  refreshTree: (connId: string) => Promise<void>
  toggleSchema: (connId: string, schema: string) => Promise<void>
  openTable: (ref: TableRef) => Promise<void>

  // --- tab ops
  addTab: (connectionId?: string | null) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  renameTab: (id: string, title: string) => void
  setTabSql: (id: string, sql: string) => void
  setTabConnection: (id: string, connectionId: string | null) => void

  // --- run + edit
  runActiveTab: () => Promise<void>

  // --- pagination (table browsing)
  goToPage: (page: number) => Promise<void>
  setPageSize: (size: number) => Promise<void>
  setSort: (sort: SortSpec | null) => Promise<void>
  refreshPage: () => Promise<void>
  reloadFiltered: () => Promise<void>

  // --- quick filters
  setColumnFilter: (column: string, filter: ColumnFilter | null) => Promise<void>
  clearFilters: () => Promise<void>

  // --- advanced filter builder
  setBuilderTree: (tree: FilterGroup | null) => Promise<void>
  clearAllFilters: () => Promise<void>

  // --- filter mode (quick | builder | custom WHERE)
  setFilterMode: (mode: FilterMode) => Promise<void>
  setCustomWhere: (text: string) => Promise<void>
  // --- saved filters (TASK 70)
  /** Table key (engine::schema::table) for the active grid, or null. */
  savedFilterKey: () => string | null
  /** The active tab's current filter state (for saving). */
  captureCurrentFilter: () => SavedFilterState | null
  /** Load the saved filter's state into the active tab and run it (page-1 reset);
   *  drops any condition on a column that no longer exists and returns a warning. */
  applySavedFilter: (state: SavedFilterState) => Promise<{ warning?: string }>

  // --- grid CRUD (staged pending changes)
  stageEdit: (primaryKey: Record<string, unknown>, column: string, value: unknown) => void
  setNewRowCell: (rowIndex: number, column: string, value: unknown) => void
  toggleDeleteRows: (rows: Record<string, unknown>[]) => void
  discardChanges: () => void
  applyChanges: () => Promise<void>

  // --- autocomplete
  refreshCatalog: (connId: string) => Promise<void>

  // --- history
  toggleHistory: () => void
  loadHistory: () => Promise<void>
  setHistorySearch: (s: string) => void
  loadHistoryIntoActive: (entry: HistoryEntry, run: boolean) => Promise<void>

  // --- DDL: table designer
  openNewTableDesigner: (connectionId: string, schema: string) => void
  openEditTableDesigner: (connectionId: string, schema: string, table: string) => Promise<void>
  setDesignerSpec: (tabId: string, spec: TableSpec) => void
  refreshDesignerPreview: (tabId: string) => Promise<void>
  applyDesigner: (tabId: string) => Promise<void>

  // --- DDL: object ops (drop/truncate/rename/create schema)
  openObjectOp: (connectionId: string, op: ObjectOp) => Promise<void>
  updateObjectOp: (op: ObjectOp) => Promise<void>
  applyObjectOpNow: () => Promise<void>
  closeObjectOp: () => void

  // --- tree context menu
  openContextMenu: (menu: ContextMenuState) => void
  closeContextMenu: () => void

  // --- views + routines (programmable objects)
  toggleCategory: (connId: string, schema: string, cat: ObjCategory) => Promise<void>
  openNewView: (connId: string, schema: string) => void
  openEditView: (connId: string, schema: string, name: string) => Promise<void>
  openNewRoutine: (connId: string, schema: string, kind: RoutineKind) => void
  openEditRoutine: (connId: string, ref: RoutineRef) => Promise<void>
  /** Oracle: open a new package editor (spec + body template). */
  openNewPackage: (connId: string, schema: string) => void
  /** Oracle: open an editor for a package's SPEC or BODY, loaded from the DB. */
  openEditPackagePart: (connId: string, schema: string, name: string, part: 'packageSpec' | 'packageBody') => Promise<void>
  setObjectEditor: (tabId: string, patch: Partial<ObjectEditorState>) => void
  applyObjectEditor: (tabId: string) => Promise<void>
  openViewData: (connId: string, schema: string, name: string) => Promise<void>

  // --- PostgreSQL advanced objects (TASK 67)
  /** Materialized views: create (SQL editor) / edit (drop+recreate) / browse via openViewData. */
  openNewMatView: (connId: string, schema: string) => void
  openEditMatView: (connId: string, schema: string, name: string) => Promise<void>
  /** Types/enums: create (SQL editor), and enum ALTER helpers pre-filled in the editor. */
  openNewType: (connId: string, schema: string) => void
  openTypeAlter: (connId: string, schema: string, name: string, kind: 'addValue' | 'rename') => void
  /** Extensions dialog (list installed + available, install/update/drop). */
  openExtensions: (connId: string) => void
  closeExtensions: () => void
  refreshExtensions: (connId: string) => Promise<void>

  // --- sequences (PostgreSQL)
  openNewSequence: (connId: string, schema: string) => void
  openEditSequence: (connId: string, schema: string, name: string) => Promise<void>
  setSequenceEditor: (tabId: string, patch: Partial<SequenceEditorState>) => void
  applySequenceEditor: (tabId: string) => Promise<void>

  // --- triggers (all engines, per table)
  toggleTableExpand: (connId: string, schema: string, table: string) => void
  toggleTableTriggers: (connId: string, schema: string, table: string) => Promise<void>
  openNewTrigger: (connId: string, schema: string, table: string) => void
  openEditTrigger: (connId: string, schema: string, table: string, name: string) => Promise<void>
  setTriggerEditor: (tabId: string, patch: Partial<TriggerEditorState>) => void
  applyTriggerEditor: (tabId: string) => Promise<void>
  /** Oracle: ALTER TRIGGER … ENABLE|DISABLE, then refresh the table's list. */
  setTriggerEnabled: (connId: string, schema: string, table: string, name: string, enable: boolean) => Promise<void>

  // --- columns (tree Columns node)
  toggleTableColumns: (connId: string, schema: string, table: string) => Promise<void>

  // --- indexes (all engines, per table)
  toggleTableIndexes: (connId: string, schema: string, table: string) => Promise<void>
  openNewIndex: (connId: string, schema: string, table: string) => void
  openEditIndex: (connId: string, schema: string, table: string, name: string) => void
  setIndexEditor: (tabId: string, patch: Partial<IndexEditorState>) => void
  applyIndexEditor: (tabId: string) => Promise<void>

  // --- visual view builder
  openViewBuilder: (connId: string, schema: string) => void
  /** Reverse-parse an existing view into the builder, or fall back to SQL editor. */
  openViewInBuilder: (connId: string, schema: string, name: string) => Promise<void>
  setViewModel: (tabId: string, model: ViewModel) => void
  previewViewBuilder: (tabId: string) => Promise<void>
  saveViewBuilder: (tabId: string, name: string) => Promise<{ ok: boolean; message: string }>

  // --- ER diagram
  openErDiagram: (connId: string, schema: string) => void
  /** After a DDL edit from the diagram, refresh the tree + catalog for a schema. */
  refreshErSchema: (connId: string, schema: string) => Promise<void>

  // --- import / export
  openExport: (connId: string, schema: string, table: string, useActiveFilter: boolean, presetFormat?: ExportFormat) => void
  openImport: (connId: string, schema: string, table: string) => void
  openDbDump: (connId: string, schema: string) => void
  openRestore: (connId: string, schema: string) => void
  /** Open the cross-engine Data Transfer wizard (optionally pre-select a table). */
  openTransfer: (connId: string, schema: string, table?: string) => void
  closeIo: () => void

  // --- layout
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleFilterSql: () => void
  /** Switch color theme (persisted + applied to <html data-theme>). */
  setTheme: (theme: ThemeMode) => void
  toggleTheme: () => void
  // --- keyboard shortcuts (TASK 71)
  setShortcutsOpen: (open: boolean) => void
  /** Close the topmost open overlay (for Esc). Returns true if one was closed. */
  closeTopOverlay: () => boolean
  // --- native menu (TASK 72)
  setAboutOpen: (open: boolean) => void
  /** Ask the ConnectionManager to open its New-connection form. */
  requestNewConnection: () => void
  /** Ask the active table's DataGrid to open its Saved-filters popover. */
  requestSavedFilters: () => void
  /** Show a transient status-bar notice (auto-clears after a few seconds). */
  setNotice: (msg: string | null) => void
  /** Open a SQL string in a NEW query tab (explicit "send to editor"). */
  openSqlInNewTab: (connId: string | null, sql: string) => void

  // helpers
  getActiveTab: () => Tab | undefined
  engineOf: (connectionId: string | null | undefined) => ConnectionConfig['engine'] | null
}

let tabSeq = 1
function newTabId(): string {
  return `tab-${Date.now()}-${tabSeq++}`
}

type Engine = ConnectionConfig['engine']

function qidT(engine: Engine, id: string): string {
  if (engine === 'mysql') return '`' + id.replace(/`/g, '``') + '`'
  if (engine === 'mssql') return '[' + id.replace(/]/g, ']]') + ']'
  return '"' + id.replace(/"/g, '""') + '"'
}
function qnameT(engine: Engine, schema: string, name: string): string {
  return engine === 'sqlite' ? qidT(engine, name) : `${qidT(engine, schema)}.${qidT(engine, name)}`
}

function routineTemplate(engine: Engine, kind: RoutineKind, schema: string, name: string): string {
  const qn = qnameT(engine, schema, name)
  if (engine === 'postgres') {
    return kind === 'function'
      ? `CREATE OR REPLACE FUNCTION ${qn}(p_arg integer)\nRETURNS integer\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN p_arg + 1;\nEND;\n$$;`
      : `CREATE OR REPLACE PROCEDURE ${qn}(p_arg integer)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RAISE NOTICE 'called with %', p_arg;\nEND;\n$$;`
  }
  if (sqlDialect(engine) === 'oracle') {
    // Valid Oracle PL/SQL: RETURN (not RETURNS), IS/AS, IN/OUT params, END;.
    return kind === 'function'
      ? `CREATE OR REPLACE FUNCTION ${qn} (p_a IN NUMBER, p_b IN NUMBER)\n  RETURN NUMBER\nIS\nBEGIN\n  RETURN p_a + p_b;\nEND;`
      : `CREATE OR REPLACE PROCEDURE ${qn} (p_in IN NUMBER, p_out OUT NUMBER)\nIS\nBEGIN\n  p_out := p_in * 2;\nEND;`
  }
  if (engine === 'mssql') {
    // Valid T-SQL: @-params, RETURNS/AS/BEGIN…END, CREATE OR ALTER (2016 SP1+).
    return kind === 'function'
      ? `CREATE OR ALTER FUNCTION ${qn} (@a INT, @b INT)\nRETURNS INT\nAS\nBEGIN\n  RETURN @a + @b;\nEND;`
      : `CREATE OR ALTER PROCEDURE ${qn}\n  @p_in INT,\n  @p_out INT OUTPUT\nAS\nBEGIN\n  SET NOCOUNT ON;\n  SET @p_out = @p_in * 2;\nEND;`
  }
  return kind === 'function'
    ? `CREATE FUNCTION ${qn}(p_arg INT)\nRETURNS INT\nDETERMINISTIC\nRETURN p_arg + 1;`
    : `CREATE PROCEDURE ${qn}(IN p_arg INT)\nBEGIN\n  SELECT p_arg;\nEND;`
}

/** Oracle package template: a SPEC and a BODY separated by a `/` line. */
function packageTemplate(schema: string, name: string): string {
  const qn = qnameT('oracle', schema, name)
  return (
    `CREATE OR REPLACE PACKAGE ${qn} IS\n  FUNCTION f1(p IN NUMBER) RETURN NUMBER;\n  PROCEDURE p1(p IN VARCHAR2);\nEND ${qidT('oracle', name)};\n` +
    `/\n` +
    `CREATE OR REPLACE PACKAGE BODY ${qn} IS\n  FUNCTION f1(p IN NUMBER) RETURN NUMBER IS\n  BEGIN\n    RETURN p + 1;\n  END f1;\n\n  PROCEDURE p1(p IN VARCHAR2) IS\n  BEGIN\n    NULL;\n  END p1;\nEND ${qidT('oracle', name)};\n`
  )
}

/** A sensible default trigger spec (dialect body templates). */
function defaultTriggerSpec(engine: Engine, schema: string, table: string): TriggerSpec {
  const pgBody = `BEGIN\n  -- e.g. NEW.updated_at := now();\n  RETURN NEW;\nEND;`
  const myBody = `BEGIN\n  -- e.g. SET NEW.updated_at = NOW();\n  SET @x = 1;\nEND`
  const liteBody = `BEGIN\n  -- e.g. UPDATE ${table} SET note = 'changed' WHERE rowid = NEW.rowid;\n  SELECT 1;\nEND`
  // Oracle: PL/SQL block using :NEW / :OLD; ends in END;.
  const oraBody = `BEGIN\n  -- e.g. :NEW."UPDATED_AT" := SYSTIMESTAMP;\n  NULL;\nEND;`
  // SQL Server: statement-level; use the inserted/deleted pseudo-tables.
  const msBody = `BEGIN\n  SET NOCOUNT ON;\n  -- e.g. UPDATE t SET updated_at = SYSUTCDATETIME()\n  --   FROM ${table} t JOIN inserted i ON t.id = i.id;\n  SELECT 1;\nEND`
  const isOracle = sqlDialect(engine) === 'oracle'
  const isMssql = engine === 'mssql'
  return {
    schema,
    table,
    name: isOracle ? `_TRG_${table}` : `_trg_${table}`,
    originalName: null,
    timing: engine === 'postgres' || isOracle ? 'BEFORE' : 'AFTER',
    event: 'INSERT',
    level: 'ROW',
    body: engine === 'mysql' ? myBody : engine === 'sqlite' ? liteBody : isOracle ? oraBody : isMssql ? msBody : '',
    functionName: `_trg_${table}_fn`,
    functionBody: engine === 'postgres' ? pgBody : '',
    whenClause: ''
  }
}

/** Build the executable statements for an object-editor apply + destructive flag. */
export function buildObjectStatements(
  engine: Engine,
  oe: ObjectEditorState
): { statements: string[]; destructive: boolean } {
  const qn = qnameT(engine, oe.schema, oe.name)
  if (oe.objKind === 'view') {
    const body = oe.body.trim()
    if (oe.mode === 'edit' && engine === 'sqlite') {
      return { statements: [`DROP VIEW IF EXISTS ${qn}`, `CREATE VIEW ${qn} AS\n${body}`], destructive: true }
    }
    // SQL Server: CREATE OR ALTER VIEW (no OR REPLACE). Others: OR REPLACE.
    if (engine === 'mssql') {
      return { statements: [`CREATE OR ALTER VIEW ${qn} AS\n${body}`], destructive: false }
    }
    const orReplace = oe.orReplace && engine !== 'sqlite' ? 'OR REPLACE ' : ''
    return { statements: [`CREATE ${orReplace}VIEW ${qn} AS\n${body}`], destructive: false }
  }
  if (oe.objKind === 'matview') {
    // Materialized views have no CREATE OR REPLACE — an edit is DROP + CREATE.
    const body = oe.body.trim()
    if (oe.mode === 'edit') {
      return { statements: [`DROP MATERIALIZED VIEW IF EXISTS ${qn}`, `CREATE MATERIALIZED VIEW ${qn} AS\n${body}`], destructive: true }
    }
    return { statements: [`CREATE MATERIALIZED VIEW ${qn} AS\n${body}`], destructive: false }
  }
  if (oe.objKind === 'type') {
    // The editor holds the raw CREATE TYPE / ALTER TYPE SQL; run it verbatim.
    return { statements: [oe.body], destructive: false }
  }
  // package (Oracle): the editor holds one or two CREATE OR REPLACE blocks
  // separated by a lone `/` line (the SQL*Plus block separator). Never split on
  // ';' — PL/SQL bodies contain many. CREATE OR REPLACE ⇒ not destructive.
  if (oe.objKind === 'package' || oe.objKind === 'packageSpec' || oe.objKind === 'packageBody') {
    const statements = oe.body
      .split(/^[ \t]*\/[ \t]*$/m)
      .map((s) => s.trim())
      .filter(Boolean)
    return { statements, destructive: false }
  }
  // routine
  if (oe.mode === 'edit' && engine === 'mysql') {
    const kw = oe.objKind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
    return { statements: [`DROP ${kw} IF EXISTS ${qn}`, oe.body], destructive: true }
  }
  // SQL Server: normalize a bare CREATE (e.g. loaded from sys.sql_modules on edit)
  // to CREATE OR ALTER so re-applying an existing routine/trigger succeeds.
  if (engine === 'mssql') {
    const body = oe.body.replace(/^\s*CREATE\s+(?:OR\s+ALTER\s+)?(PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW)\b/i, 'CREATE OR ALTER $1')
    return { statements: [body], destructive: false }
  }
  return { statements: [oe.body], destructive: false }
}

function freshTab(connectionId: string | null, title?: string, sql?: string): Tab {
  return {
    id: newTabId(),
    title: title ?? `Query ${tabSeq}`,
    connectionId,
    sql: sql ?? 'SELECT * FROM customers LIMIT 10;',
    kind: 'query',
    result: null,
    resultError: null,
    running: false,
    gridTable: null,
    gridSpec: null,
    pending: emptyPending(),
    crudMessage: null,
    statusMessage: null,
    page: 1,
    pageSize: PAGE_SIZE_DEFAULT,
    total: null,
    countLoading: false,
    sort: null,
    filters: [],
    builderTree: null,
    filterMode: 'quick',
    customWhere: '',
    customWhereError: null
  }
}

/** The one active mode's filter payload for a tab (others sent empty/null). */
function effectiveFilter(t: Tab): { filters: ColumnFilter[]; tree: FilterGroup | null; customWhere: string | null } {
  // Two filter surfaces after the TASK 36 consolidation:
  //  - STRUCTURED: per-column header filters AND the funnel's builder tree
  //    combine (AND) — both feed compileFilter together.
  //  - CUSTOM WHERE: the exclusive raw-predicate alternative; while active it
  //    replaces the structured filter entirely.
  // ('quick' and 'builder' are legacy structured values kept for persisted-tab
  //  compatibility; both mean "structured" here.)
  const custom = t.filterMode === 'custom'
  return {
    filters: custom ? [] : t.filters,
    tree: custom ? null : t.builderTree,
    customWhere: custom ? (t.customWhere.trim() || null) : null
  }
}

/** A sensible default new-sequence spec (PostgreSQL bigint defaults). */
function defaultSequenceSpec(schema: string): SequenceSpec {
  return {
    schema,
    name: 'new_sequence',
    originalName: null,
    dataType: 'bigint',
    increment: '1',
    minValue: null,
    maxValue: null,
    start: '1',
    cache: '1',
    cycle: false,
    ownedBy: null,
    restart: null
  }
}

/** Build a SequenceSpec from loaded details (edit mode). */
function specFromInfo(info: SequenceInfo): SequenceSpec {
  return {
    schema: info.schema,
    name: info.name,
    originalName: info.name,
    dataType: info.dataType || 'bigint',
    increment: info.increment,
    minValue: info.minValue || null,
    maxValue: info.maxValue || null,
    start: info.start,
    cache: info.cache,
    cycle: info.cycle,
    ownedBy: info.ownedBy,
    restart: null
  }
}

function emptyTableSpec(schema: string, engine?: Engine): TableSpec {
  const oracle = engine === 'oracle'
  const mssql = engine === 'mssql'
  const idType = oracle ? 'NUMBER' : mssql ? 'INT' : 'integer'
  const nameType = oracle ? 'VARCHAR2' : mssql ? 'NVARCHAR' : 'varchar'
  return {
    schema,
    name: 'new_table',
    columns: [
      { name: 'id', type: idType, nullable: false, autoIncrement: true, originalName: null },
      { name: 'name', type: nameType, length: 255, nullable: false, originalName: null }
    ],
    primaryKey: ['id'],
    foreignKeys: [],
    indexes: []
  }
}

// Debounced persistence of tabs (SQL text + metadata only — no rows).
let persistTimer: ReturnType<typeof setTimeout> | null = null
function schedulePersist(getState: () => AppState): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    const { tabs, activeTabId } = getState()
    // Only query tabs persist (SQL text + metadata). Designer tabs are transient.
    const persisted: PersistedTab[] = tabs
      .filter((t) => t.kind === 'query')
      .map((t) => ({
        id: t.id,
        title: t.title,
        connectionId: t.connectionId,
        sql: t.sql
      }))
    const activeIsQuery = tabs.find((t) => t.id === activeTabId)?.kind === 'query'
    void window.dbApi.saveTabs({
      tabs: persisted,
      activeTabId: activeIsQuery ? activeTabId : (persisted[0]?.id ?? null)
    })
  }, 400)
}

export const useStore = create<AppState>((set, get) => {
  const updateTab = (id: string, patch: Partial<Tab>): void => {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })
  }

  return {
    connections: [],
    defaults: [],
    connectedIds: [],
    treeByConn: {},
    catalogByConn: {},
    tabs: [],
    activeTabId: null,
    historyOpen: false,
    history: [],
    historySearch: '',
    objectOp: null,
    contextMenu: null,
    ioExport: null,
    ioImport: null,
    ioDbDump: null,
    ioRestore: null,
    ioTransfer: null,
    extDialog: null,
    shortcutsOpen: false,
    aboutOpen: false,
    newConnSignal: 0,
    savedFiltersSignal: 0,
    notice: null,
    sidebarCollapsed: false,
    filterSqlCollapsed: false,
    theme: 'dark',
    ready: false,

    getActiveTab: () => {
      const { tabs, activeTabId } = get()
      return tabs.find((t) => t.id === activeTabId)
    },

    engineOf: (connectionId) => {
      if (!connectionId) return null
      const all = [...get().connections, ...get().defaults]
      return all.find((c) => c.id === connectionId)?.engine ?? null
    },

    init: async () => {
      await get().refreshConnections()
      try {
        const ui = await window.dbApi.loadUiState()
        const theme: ThemeMode = ui.theme === 'light' ? 'light' : 'dark'
        set({ sidebarCollapsed: !!ui.sidebarCollapsed, filterSqlCollapsed: !!ui.filterSqlCollapsed, theme })
        applyTheme(theme)
      } catch {
        // non-critical UI preference
        applyTheme('dark')
      }
      const persisted = await window.dbApi.loadTabs()
      let tabs: Tab[]
      let activeTabId: string | null
      if (persisted.tabs.length > 0) {
        tabs = persisted.tabs.map((p) => ({
          id: p.id,
          title: p.title,
          connectionId: p.connectionId,
          sql: p.sql,
          kind: 'query' as const,
          result: null,
          resultError: null,
          running: false,
          gridTable: null,
          gridSpec: null,
          pending: emptyPending(),
          crudMessage: null,
          statusMessage: null,
          page: 1,
          pageSize: PAGE_SIZE_DEFAULT,
          total: null,
          countLoading: false,
          sort: null,
          filters: [],
          builderTree: null,
          filterMode: 'quick',
          customWhere: '',
          customWhereError: null
        }))
        activeTabId = persisted.activeTabId ?? tabs[0].id
        // keep tabSeq ahead of restored titles
        tabSeq = tabs.length + 1
      } else {
        const first = freshTab(null, 'Query 1')
        tabs = [first]
        activeTabId = first.id
      }
      set({ tabs, activeTabId, ready: true })
    },

    refreshConnections: async () => {
      const [connections, defaults] = await Promise.all([
        window.dbApi.listConnections(),
        window.dbApi.getDefaults()
      ])
      set({ connections, defaults })
    },

    connect: async (id) => {
      const res = await window.dbApi.connect(id)
      if (!res.ok) {
        const at = get().getActiveTab()
        if (at) updateTab(at.id, { statusMessage: `Connect failed: ${res.error}` })
        return
      }
      if (!get().connectedIds.includes(id)) {
        set({ connectedIds: [...get().connectedIds, id] })
      }
      // If the active tab has no connection yet, bind it to this one.
      const at = get().getActiveTab()
      if (at && !at.connectionId) updateTab(at.id, { connectionId: id })
      await get().loadSchemas(id)
      await get().refreshCatalog(id)
      schedulePersist(get)
    },

    disconnect: async (id) => {
      await window.dbApi.disconnect(id)
      set({
        connectedIds: get().connectedIds.filter((c) => c !== id),
        treeByConn: { ...get().treeByConn, [id]: emptyTree() }
      })
      const { [id]: _removed, ...restCatalog } = get().catalogByConn
      set({ catalogByConn: restCatalog })
    },

    useConnectionInActiveTab: async (id) => {
      const at = get().getActiveTab()
      if (at) get().setTabConnection(at.id, id)
      await get().connect(id)
    },

    saveConnection: async (c) => {
      const res = await window.dbApi.saveConnection(c)
      if (!res.ok) return null
      await get().refreshConnections()
      return res.data
    },

    deleteConnection: async (id) => {
      await window.dbApi.deleteConnection(id)
      set({
        connectedIds: get().connectedIds.filter((c) => c !== id),
        // Unbind any tabs pointing at the deleted connection.
        tabs: get().tabs.map((t) => (t.connectionId === id ? { ...t, connectionId: null } : t))
      })
      await get().refreshConnections()
      schedulePersist(get)
    },

    loadSchemas: async (connId) => {
      const res = await window.dbApi.listSchemas(connId)
      if (!res.ok) return
      const prev = get().treeByConn[connId] ?? emptyTree()
      const next: TreeState = { ...prev, schemas: res.data }
      set({ treeByConn: { ...get().treeByConn, [connId]: next } })
      if (res.data.length > 0) await get().toggleSchema(connId, res.data[0])
    },

    refreshTree: async (connId) => {
      const schemasRes = await window.dbApi.listSchemas(connId)
      if (!schemasRes.ok) return
      const prev = get().treeByConn[connId] ?? emptyTree()
      const schemas = schemasRes.data
      const existing = new Set(schemas)
      // Preserve the user's expansion, dropping any node whose schema disappeared.
      const expanded = prev.expanded.filter((s) => existing.has(s))
      const expandedCatsPrev = prev.expandedCats.filter((k) => existing.has(k.split('::')[0]))
      const expandedTables = prev.expandedTables.filter((s) => existing.has(s.split('::')[0]))
      // Cache-bust: start from empty per-schema/table maps and refill only the
      // currently-expanded scope from the live database.
      const next: TreeState = { ...emptyTree(), schemas, expanded, expandedCats: expandedCatsPrev, expandedTables, loadingKeys: [] }

      const cats: ObjCategory[] = ['tables', 'views', 'functions', 'procedures', 'packages', 'sequences', 'matviews', 'types', 'extensions']
      for (const schema of expanded) {
        for (const cat of cats) {
          if (!expandedCatsPrev.includes(`${schema}::${cat}`)) continue
          if (cat === 'tables') {
            const r = await window.dbApi.listTables(connId, schema)
            if (r.ok) next.tablesBySchema[schema] = r.data
          } else if (cat === 'views') {
            const r = await window.dbApi.listViews(connId, schema)
            if (r.ok) next.viewsBySchema[schema] = r.data
          } else if (cat === 'functions' || cat === 'procedures') {
            if (next.functionsBySchema[schema]) continue // one fetch covers both
            const r = await window.dbApi.listRoutines(connId, schema)
            if (r.ok) {
              next.functionsBySchema[schema] = r.data.filter((x) => x.kind === 'function')
              next.proceduresBySchema[schema] = r.data.filter((x) => x.kind === 'procedure')
            }
          } else if (cat === 'packages') {
            const r = await window.dbApi.listPackages(connId, schema)
            if (r.ok) next.packagesBySchema[schema] = r.data
          } else if (cat === 'sequences') {
            const r = await window.dbApi.listSequences(connId, schema)
            if (r.ok && r.data.supported) next.sequencesBySchema[schema] = r.data.sequences
          } else if (cat === 'matviews') {
            const r = await window.dbApi.listMatViews(connId, schema)
            if (r.ok && r.data.supported) next.matviewsBySchema[schema] = r.data.matviews
          } else if (cat === 'types') {
            const r = await window.dbApi.listTypes(connId, schema)
            if (r.ok && r.data.supported) next.typesBySchema[schema] = r.data.types
          } else if (cat === 'extensions') {
            const r = await window.dbApi.listExtensions(connId)
            if (r.ok && r.data.supported) next.extensionsBySchema[schema] = r.data.installed
          }
        }
      }

      // Re-fetch expanded table-children (columns/triggers/indexes); drop the
      // expansion keys for tables that no longer exist.
      const childKeys = expandedCatsPrev.filter((k) => /::(columns|triggers|indexes)$/.test(k))
      const keptChild = new Set<string>()
      for (const k of childKeys) {
        const parts = k.split('::')
        const kind = parts[parts.length - 1]
        const table = parts[parts.length - 2]
        const schema = parts.slice(0, parts.length - 2).join('::')
        if (!next.tablesBySchema[schema]) {
          const r = await window.dbApi.listTables(connId, schema)
          if (r.ok) next.tablesBySchema[schema] = r.data
        }
        if (!(next.tablesBySchema[schema] ?? []).some((t) => t.name === table)) continue // table dropped
        keptChild.add(k)
        if (kind === 'columns') {
          const r = await window.dbApi.getTableSpec(connId, schema, table)
          if (r.ok) {
            const fkCols = new Set<string>()
            for (const fk of r.data.foreignKeys) for (const c of fk.columns) fkCols.add(c)
            const pk = new Set(r.data.primaryKey)
            next.columnsByTable[tkey(schema, table)] = r.data.columns.map((c) => ({
              name: c.name,
              type: c.type + (c.length != null ? `(${c.length}${c.scale != null ? ',' + c.scale : ''})` : ''),
              isPrimaryKey: pk.has(c.name),
              isForeignKey: fkCols.has(c.name),
              nullable: c.nullable
            }))
          }
        } else if (kind === 'triggers') {
          const r = await window.dbApi.listTriggers(connId, schema, table)
          if (r.ok) next.triggersByTable[tkey(schema, table)] = r.data
        } else if (kind === 'indexes') {
          const r = await window.dbApi.listIndexes(connId, schema, table)
          if (r.ok) next.indexesByTable[tkey(schema, table)] = r.data
        }
      }
      next.expandedCats = expandedCatsPrev.filter((k) => !/::(columns|triggers|indexes)$/.test(k) || keptChild.has(k))

      set({ treeByConn: { ...get().treeByConn, [connId]: next } })
      // Autocomplete reads the same live catalog — refresh it too.
      await get().refreshCatalog(connId)
    },

    toggleSchema: async (connId, schema) => {
      const tree = get().treeByConn[connId] ?? emptyTree()
      const isOpen = tree.expanded.includes(schema)
      const expanded = isOpen ? tree.expanded.filter((s) => s !== schema) : [...tree.expanded, schema]
      set({
        treeByConn: {
          ...get().treeByConn,
          [connId]: { ...tree, expanded }
        }
      })
    },

    openTable: async (ref) => {
      const at = get().getActiveTab()
      if (!at || !at.connectionId) return
      const connId = at.connectionId
      const pageSize = at.pageSize || PAGE_SIZE_DEFAULT
      updateTab(at.id, {
        running: true,
        resultError: null,
        gridTable: { schema: ref.schema, table: ref.name },
        gridSpec: null,
        pending: emptyPending(),
        crudMessage: null,
        page: 1,
        total: null,
        countLoading: true,
        sort: null,
        filters: [],
        builderTree: null,
        filterMode: 'quick',
        customWhere: '',
        customWhereError: null
      })
      // First page + structure — show immediately without waiting for COUNT.
      const [pageRes, specRes] = await Promise.all([
        window.dbApi.getTablePage(connId, ref.schema, ref.name, pageSize, 1, null, [], null, null),
        window.dbApi.getTableSpec(connId, ref.schema, ref.name)
      ])
      if (!pageRes.ok) {
        updateTab(at.id, { running: false, resultError: pageRes.error, result: null, countLoading: false })
        return
      }
      updateTab(at.id, {
        running: false,
        result: pageRes.data,
        resultError: null,
        gridSpec: specRes.ok ? specRes.data : null,
        sql: `SELECT * FROM ${ref.name};`,
        statusMessage: `page 1 in ${pageRes.data.durationMs} ms`
      })
      schedulePersist(get)
      // Async COUNT(*) — fills in the total when it arrives (guard vs tab reuse).
      void window.dbApi.getTableRowCount(connId, ref.schema, ref.name, [], null, null).then((cr) => {
        const cur = get().tabs.find((t) => t.id === at.id)
        if (cur?.gridTable?.schema === ref.schema && cur?.gridTable?.table === ref.name) {
          updateTab(at.id, { total: cr.ok ? cr.data : null, countLoading: false })
        }
      })
    },

    goToPage: async (page) => {
      const at = get().getActiveTab()
      if (!at?.gridTable || !at.connectionId) return
      const totalPages = at.total != null ? Math.max(1, Math.ceil(at.total / at.pageSize)) : null
      const p = Math.max(1, totalPages != null ? Math.min(page, totalPages) : page)
      updateTab(at.id, { running: true })
      const ef = effectiveFilter(at)
      const res = await window.dbApi.getTablePage(at.connectionId, at.gridTable.schema, at.gridTable.table, at.pageSize, p, at.sort, ef.filters, ef.tree, ef.customWhere)
      if (!res.ok) {
        // A bad Custom WHERE surfaces near its input and keeps the current grid;
        // other failures show in the grid error area.
        if (at.filterMode === 'custom') updateTab(at.id, { running: false, customWhereError: res.error })
        else updateTab(at.id, { running: false, resultError: res.error })
        return
      }
      updateTab(at.id, { running: false, result: res.data, resultError: null, customWhereError: null, page: p, pending: emptyPending(), crudMessage: null })
    },

    setPageSize: async (size) => {
      const at = get().getActiveTab()
      if (!at) return
      updateTab(at.id, { pageSize: size })
      await get().goToPage(1)
    },

    setSort: async (sort) => {
      const at = get().getActiveTab()
      if (!at) return
      updateTab(at.id, { sort })
      await get().goToPage(1)
    },

    refreshPage: async () => {
      const at = get().getActiveTab()
      if (!at?.gridTable || !at.connectionId) return
      const { schema, table } = at.gridTable
      const ef = effectiveFilter(at)
      updateTab(at.id, { countLoading: true })
      void window.dbApi.getTableRowCount(at.connectionId, schema, table, ef.filters, ef.tree, ef.customWhere).then((cr) => {
        const cur = get().tabs.find((t) => t.id === at.id)
        if (cur?.gridTable?.schema === schema && cur?.gridTable?.table === table) {
          updateTab(at.id, { total: cr.ok ? cr.data : null, countLoading: false })
        }
      })
      await get().goToPage(at.page)
    },

    // Recount (respecting the ACTIVE filter mode) then jump to page 1.
    reloadFiltered: async () => {
      const at = get().getActiveTab()
      if (!at?.gridTable || !at.connectionId) return
      const { schema, table } = at.gridTable
      const connId = at.connectionId
      const ef = effectiveFilter(at)
      updateTab(at.id, { countLoading: true })
      void window.dbApi.getTableRowCount(connId, schema, table, ef.filters, ef.tree, ef.customWhere).then((cr) => {
        const cur = get().tabs.find((t) => t.id === at.id)
        if (cur?.gridTable?.schema === schema && cur?.gridTable?.table === table) {
          updateTab(at.id, { total: cr.ok ? cr.data : null, countLoading: false })
        }
      })
      await get().goToPage(1)
    },

    setColumnFilter: async (column, filter) => {
      const at = get().getActiveTab()
      if (!at?.gridTable) return
      const others = at.filters.filter((f) => f.column !== column)
      const filters = filter ? [...others, filter] : others
      // Setting a column filter is a structured action; leaving Custom WHERE if
      // we were on it (the structured filter combines column + funnel tree).
      updateTab(at.id, { filters, filterMode: at.filterMode === 'custom' ? 'quick' : at.filterMode })
      await get().reloadFiltered()
    },

    clearFilters: async () => {
      const at = get().getActiveTab()
      if (!at?.gridTable) return
      updateTab(at.id, { filters: [] })
      await get().reloadFiltered()
    },

    setBuilderTree: async (tree) => {
      const at = get().getActiveTab()
      if (!at?.gridTable) return
      // The funnel's builder tree is part of the structured filter; leave Custom
      // WHERE if we were on it.
      updateTab(at.id, { builderTree: tree, filterMode: at.filterMode === 'custom' ? 'quick' : at.filterMode })
      await get().reloadFiltered()
    },

    // "Clear" clears the ACTIVE filter surface: Custom WHERE clears its text;
    // otherwise the structured filter (both per-column filters AND the funnel's
    // builder tree) is cleared together.
    clearAllFilters: async () => {
      const at = get().getActiveTab()
      if (!at?.gridTable) return
      if (at.filterMode === 'custom') updateTab(at.id, { customWhere: '', customWhereError: null })
      else updateTab(at.id, { filters: [], builderTree: null })
      await get().reloadFiltered()
    },

    // Switch active filter mode; each mode's own state is retained. Only the
    // now-active mode's filter is applied.
    setFilterMode: async (mode) => {
      const at = get().getActiveTab()
      if (!at?.gridTable) {
        if (at) updateTab(at.id, { filterMode: mode })
        return
      }
      updateTab(at.id, { filterMode: mode, customWhereError: null })
      await get().reloadFiltered()
    },

    // Apply a raw Custom WHERE predicate (retained text; activates custom mode).
    setCustomWhere: async (text) => {
      const at = get().getActiveTab()
      if (!at?.gridTable) return
      updateTab(at.id, { customWhere: text, filterMode: 'custom', customWhereError: null })
      await get().reloadFiltered()
    },

    // --- saved filters (TASK 70) ---
    savedFilterKey: () => {
      const at = get().getActiveTab()
      if (!at?.gridTable || !at.connectionId) return null
      const engine = get().engineOf(at.connectionId) ?? 'unknown'
      return `${engine}::${at.gridTable.schema}::${at.gridTable.table}`
    },

    captureCurrentFilter: () => {
      const at = get().getActiveTab()
      if (!at?.gridTable) return null
      return {
        filters: at.filters,
        builderTree: at.builderTree,
        filterMode: at.filterMode,
        customWhere: at.customWhere
      }
    },

    applySavedFilter: async (state) => {
      const at = get().getActiveTab()
      if (!at?.gridTable) return {}
      // Current column set (for the missing-column guard). gridSpec first, else catalog.
      const cols = new Set<string>()
      for (const c of at.gridSpec?.columns ?? []) cols.add(c.name)
      if (cols.size === 0) {
        const cat = at.connectionId ? get().catalogByConn[at.connectionId] : undefined
        const engine = get().engineOf(at.connectionId)
        const t = cat?.tables.find((x) => x.name === at.gridTable!.table && (engine === 'sqlite' || x.schema === at.gridTable!.schema))
        for (const c of t?.columns ?? []) cols.add(c.name)
      }
      // Prune structured conditions referencing columns that no longer exist.
      let dropped = 0
      const validFilters = cols.size === 0 ? state.filters : state.filters.filter((f) => cols.has(f.column) || (dropped++, false))
      const pruneTree = (node: FilterGroup | null): FilterGroup | null => {
        if (!node) return null
        const children = node.children
          .map((ch) => (ch.kind === 'group' ? pruneTree(ch) : cols.size === 0 || cols.has(ch.column) ? ch : (dropped++, null)))
          .filter((ch): ch is NonNullable<typeof ch> => ch != null)
        return { ...node, children }
      }
      const validTree = pruneTree(state.builderTree)
      updateTab(at.id, {
        filters: validFilters,
        builderTree: validTree,
        filterMode: state.filterMode,
        customWhere: state.customWhere,
        customWhereError: null
      })
      await get().reloadFiltered()
      return dropped > 0
        ? { warning: `${dropped} condition${dropped > 1 ? 's' : ''} referenced a column that no longer exists and ${dropped > 1 ? 'were' : 'was'} skipped.` }
        : {}
    },

    addTab: (connectionId) => {
      const at = get().getActiveTab()
      const conn = connectionId !== undefined ? connectionId : at?.connectionId ?? null
      const tab = freshTab(conn, `Query ${tabSeq}`, '')
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id })
      schedulePersist(get)
    },

    closeTab: (id) => {
      const tabs = get().tabs
      if (tabs.length <= 1) {
        // Keep at least one tab — reset it instead of removing.
        const reset = freshTab(tabs[0]?.connectionId ?? null, 'Query 1', '')
        set({ tabs: [reset], activeTabId: reset.id })
        schedulePersist(get)
        return
      }
      const idx = tabs.findIndex((t) => t.id === id)
      const remaining = tabs.filter((t) => t.id !== id)
      let activeTabId = get().activeTabId
      if (activeTabId === id) {
        const neighbor = remaining[Math.max(0, idx - 1)]
        activeTabId = neighbor?.id ?? remaining[0].id
      }
      set({ tabs: remaining, activeTabId })
      schedulePersist(get)
    },

    setActiveTab: (id) => {
      set({ activeTabId: id })
      // Ensure the tree/catalog for this tab's connection is loaded.
      const tab = get().tabs.find((t) => t.id === id)
      if (tab?.connectionId && get().connectedIds.includes(tab.connectionId)) {
        if (!get().treeByConn[tab.connectionId]?.schemas.length) void get().loadSchemas(tab.connectionId)
        if (!get().catalogByConn[tab.connectionId]) void get().refreshCatalog(tab.connectionId)
      }
      schedulePersist(get)
    },

    renameTab: (id, title) => {
      updateTab(id, { title: title.trim() || 'Query' })
      schedulePersist(get)
    },

    setTabSql: (id, sql) => {
      updateTab(id, { sql })
      schedulePersist(get)
    },

    setTabConnection: (id, connectionId) => {
      updateTab(id, {
        connectionId,
        result: null,
        resultError: null,
        gridTable: null,
        gridSpec: null,
        pending: emptyPending(),
        crudMessage: null
      })
      if (connectionId && get().connectedIds.includes(connectionId)) {
        if (!get().treeByConn[connectionId]?.schemas.length) void get().loadSchemas(connectionId)
        if (!get().catalogByConn[connectionId]) void get().refreshCatalog(connectionId)
      }
      schedulePersist(get)
    },

    runActiveTab: async () => {
      const at = get().getActiveTab()
      if (!at) return
      const connId = at.connectionId
      if (!connId) {
        updateTab(at.id, { statusMessage: 'No connection selected for this tab' })
        return
      }
      const sql = at.sql.trim()
      if (!sql) return
      // Auto-connect if the chosen connection isn't open yet.
      if (!get().connectedIds.includes(connId)) {
        await get().connect(connId)
        if (!get().connectedIds.includes(connId)) return
      }
      updateTab(at.id, { running: true, resultError: null })
      const res = await window.dbApi.runQuery(connId, sql)
      if (!res.ok) {
        updateTab(at.id, {
          running: false,
          resultError: res.error,
          result: null,
          statusMessage: 'Query failed'
        })
        void get().loadHistory()
        return
      }
      updateTab(at.id, {
        running: false,
        result: res.data,
        resultError: null,
        gridTable: null,
        gridSpec: null, // ad-hoc query result -> no CRUD
        pending: emptyPending(),
        crudMessage: null,
        statusMessage: res.data.hasResultSet
          ? `${res.data.rowCount} rows in ${res.data.durationMs} ms`
          : `OK — ${res.data.rowCount} affected in ${res.data.durationMs} ms`
      })
      void get().loadHistory()
    },

    // --- grid CRUD (staged) ---
    stageEdit: (primaryKey, column, value) => {
      const at = get().getActiveTab()
      if (!at) return
      const rowKey = JSON.stringify(Object.values(primaryKey))
      const existing = at.pending.edits[rowKey] ?? { primaryKey, changes: {} }
      const edits = { ...at.pending.edits, [rowKey]: { primaryKey, changes: { ...existing.changes, [column]: value } } }
      updateTab(at.id, { pending: { ...at.pending, edits }, crudMessage: null })
    },

    setNewRowCell: (rowIndex, column, value) => {
      const at = get().getActiveTab()
      if (!at) return
      const newRows = at.pending.newRows.slice()
      if (rowIndex >= newRows.length) newRows.push({})
      newRows[rowIndex] = { ...newRows[rowIndex], [column]: value }
      updateTab(at.id, { pending: { ...at.pending, newRows }, crudMessage: null })
    },

    toggleDeleteRows: (rows) => {
      const at = get().getActiveTab()
      if (!at || !at.gridSpec) return
      const pk = at.gridSpec.primaryKey
      if (pk.length === 0) return
      const deletes = { ...at.pending.deletes }
      for (const row of rows) {
        const pkMap: Record<string, unknown> = {}
        for (const c of pk) pkMap[c] = row[c]
        const key = JSON.stringify(Object.values(pkMap))
        if (deletes[key]) delete deletes[key]
        else deletes[key] = pkMap
      }
      updateTab(at.id, { pending: { ...at.pending, deletes }, crudMessage: null })
    },

    discardChanges: () => {
      const at = get().getActiveTab()
      if (!at) return
      updateTab(at.id, { pending: emptyPending(), crudMessage: null })
    },

    applyChanges: async () => {
      const at = get().getActiveTab()
      if (!at || !at.connectionId || !at.gridTable || !at.gridSpec) return
      const spec = at.gridSpec
      const colByName = new Map(spec.columns.map((c) => [c.name, c]))
      const columnTypes: Record<string, string> = {}
      for (const c of spec.columns) columnTypes[c.name] = c.type

      // Build inserts from new rows: keep only non-empty provided values.
      const inserts: Record<string, unknown>[] = []
      const missing: string[] = []
      for (const nr of at.pending.newRows) {
        const values: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(nr)) {
          if (v !== '' && v != null) values[k] = v
        }
        if (Object.keys(values).length === 0) continue // skip fully-empty trailing row
        // Validate NOT NULL columns without a default / auto-increment.
        for (const c of spec.columns) {
          if (!c.nullable && !c.autoIncrement && (c.default == null || c.default === '') && !(c.name in values)) {
            missing.push(c.name)
          }
        }
        inserts.push(values)
      }
      if (missing.length > 0) {
        updateTab(at.id, { crudMessage: `❌ Required (NOT NULL) value missing: ${[...new Set(missing)].join(', ')}` })
        return
      }

      const updates = Object.values(at.pending.edits).filter((e) => Object.keys(e.changes).length > 0)
      const deletes = Object.values(at.pending.deletes)

      if (inserts.length === 0 && updates.length === 0 && deletes.length === 0) {
        updateTab(at.id, { crudMessage: 'No changes to apply.' })
        return
      }
      // Unknown-column guard (defensive): drop change columns not in the table.
      for (const u of updates) {
        for (const k of Object.keys(u.changes)) if (!colByName.has(k)) delete u.changes[k]
      }

      const res = await window.dbApi.applyRowChanges({
        connectionId: at.connectionId,
        schema: at.gridTable.schema,
        table: at.gridTable.table,
        primaryKey: spec.primaryKey,
        columnTypes,
        inserts,
        updates,
        deletes
      })
      if (!res.ok) {
        updateTab(at.id, { crudMessage: `❌ ${res.error}` })
        return
      }
      const r = res.data
      if (!r.ok) {
        updateTab(at.id, {
          crudMessage: `❌ ${r.failure?.phase} #${(r.failure?.index ?? 0) + 1} failed: ${r.failure?.message} (rolled back)`
        })
        return
      }
      // Success: recount, then reload the affected page. Inserts jump to the
      // (new) last page so the freshly inserted row(s) are visible with their
      // DB-assigned ids.
      const efc = effectiveFilter(at)
      const cr = await window.dbApi.getTableRowCount(at.connectionId, at.gridTable.schema, at.gridTable.table, efc.filters, efc.tree, efc.customWhere)
      const newTotal = cr.ok ? cr.data : at.total
      updateTab(at.id, { total: newTotal, countLoading: false })
      const lastPage = newTotal != null ? Math.max(1, Math.ceil(newTotal / at.pageSize)) : at.page
      const targetPage = r.inserted > 0 ? lastPage : Math.min(at.page, lastPage)
      await get().goToPage(targetPage)
      updateTab(at.id, {
        crudMessage: `✅ ${r.inserted} inserted, ${r.updated} updated, ${r.deleted} deleted`
      })
    },

    refreshCatalog: async (connId) => {
      // force=true so MAIN re-reads the live catalog instead of returning its
      // per-connection cache — otherwise autocomplete stays stale after DDL.
      const res = await window.dbApi.getSchemaCatalog(connId, true)
      if (res.ok) set({ catalogByConn: { ...get().catalogByConn, [connId]: res.data } })
    },

    toggleHistory: () => {
      const next = !get().historyOpen
      set({ historyOpen: next })
      if (next) void get().loadHistory()
    },

    loadHistory: async () => {
      const at = get().getActiveTab()
      const connId = at?.connectionId ?? undefined
      const res = await window.dbApi.listHistory(connId, get().historySearch, 300)
      if (res.ok) set({ history: res.data })
    },

    setHistorySearch: (s) => {
      set({ historySearch: s })
      void get().loadHistory()
    },

    loadHistoryIntoActive: async (entry, run) => {
      const at = get().getActiveTab()
      if (!at) return
      updateTab(at.id, { sql: entry.sql })
      schedulePersist(get)
      if (run) await get().runActiveTab()
    },

    // --- DDL: table designer ---
    openNewTableDesigner: (connectionId, schema) => {
      const engine = get().engineOf(connectionId) ?? undefined
      const tab: Tab = {
        ...freshTab(connectionId, 'New table', ''),
        kind: 'designer',
        designer: {
          mode: 'create',
          spec: emptyTableSpec(schema, engine ?? undefined),
          original: null,
          preview: null,
          applying: false,
          message: null
        }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id })
      void get().refreshDesignerPreview(tab.id)
    },

    openEditTableDesigner: async (connectionId, schema, table) => {
      const res = await window.dbApi.getTableSpec(connectionId, schema, table)
      if (!res.ok) {
        const at = get().getActiveTab()
        if (at) updateTab(at.id, { statusMessage: `Load table failed: ${res.error}` })
        return
      }
      const original = res.data
      const spec: TableSpec = JSON.parse(JSON.stringify(original))
      const tab: Tab = {
        ...freshTab(connectionId, `Design: ${table}`, ''),
        kind: 'designer',
        designer: { mode: 'alter', spec, original, preview: null, applying: false, message: null }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id })
      void get().refreshDesignerPreview(tab.id)
    },

    setDesignerSpec: (tabId, spec) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.designer) return
      updateTab(tabId, { designer: { ...tab.designer, spec } })
      void get().refreshDesignerPreview(tabId)
    },

    refreshDesignerPreview: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.designer || !tab.connectionId) return
      const res = await window.dbApi.previewDdl({
        connectionId: tab.connectionId,
        mode: tab.designer.mode,
        spec: tab.designer.spec,
        original: tab.designer.original
      })
      const cur = get().tabs.find((t) => t.id === tabId)
      if (!cur?.designer) return
      updateTab(tabId, {
        designer: { ...cur.designer, preview: res.ok ? res.data : null, message: res.ok ? null : res.error }
      })
    },

    applyDesigner: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.designer || !tab.connectionId) return
      updateTab(tabId, { designer: { ...tab.designer, applying: true, message: null } })
      const res = await window.dbApi.applyDdl({
        connectionId: tab.connectionId,
        mode: tab.designer.mode,
        spec: tab.designer.spec,
        original: tab.designer.original
      })
      const cur = get().tabs.find((t) => t.id === tabId)
      if (!cur?.designer) return
      if (!res.ok || !res.data.ok) {
        const msg = res.ok ? `Statement ${(res.data.failedAt ?? 0) + 1} failed: ${res.data.message}` : res.error
        updateTab(tabId, { designer: { ...cur.designer, applying: false, message: `❌ ${msg}` } })
        return
      }
      // Success: refresh tree + catalog for this connection.
      if (tab.connectionId) {
        await get().loadSchemas(tab.connectionId)
        // Re-expand the schema and refresh its table list.
        const tree = get().treeByConn[tab.connectionId]
        if (tree) {
          const schema = tab.designer.spec.schema
          const tablesRes = await window.dbApi.listTables(tab.connectionId, schema)
          if (tablesRes.ok) {
            set({
              treeByConn: {
                ...get().treeByConn,
                [tab.connectionId]: {
                  ...tree,
                  expanded: tree.expanded.includes(schema) ? tree.expanded : [...tree.expanded, schema],
                  tablesBySchema: { ...tree.tablesBySchema, [schema]: tablesRes.data }
                }
              }
            })
          }
        }
        await get().refreshCatalog(tab.connectionId)
      }
      updateTab(tabId, {
        designer: {
          ...cur.designer,
          applying: false,
          message: `✅ Applied (${res.data.executed} statement(s)).`,
          // After a create, switch to alter mode against the now-existing table.
          mode: 'alter',
          original: JSON.parse(JSON.stringify(cur.designer.spec))
        },
        title: `Design: ${cur.designer.spec.name}`
      })
      void get().refreshDesignerPreview(tabId)
    },

    // --- DDL: object ops ---
    openObjectOp: async (connectionId, op) => {
      set({ objectOp: { connectionId, op, preview: null, applying: false, message: null }, contextMenu: null })
      const res = await window.dbApi.previewObjectOp({ connectionId, op })
      const cur = get().objectOp
      if (!cur) return
      set({ objectOp: { ...cur, preview: res.ok ? res.data : null, message: res.ok ? null : res.error } })
    },

    updateObjectOp: async (op) => {
      const cur = get().objectOp
      if (!cur) return
      set({ objectOp: { ...cur, op } })
      const res = await window.dbApi.previewObjectOp({ connectionId: cur.connectionId, op })
      const c2 = get().objectOp
      if (!c2) return
      set({ objectOp: { ...c2, preview: res.ok ? res.data : null, message: res.ok ? null : res.error } })
    },

    applyObjectOpNow: async () => {
      const cur = get().objectOp
      if (!cur) return
      set({ objectOp: { ...cur, applying: true, message: null } })
      const res = await window.dbApi.applyObjectOp({ connectionId: cur.connectionId, op: cur.op })
      if (!res.ok || !res.data.ok) {
        const msg = res.ok ? res.data.message : res.error
        const c2 = get().objectOp
        if (c2) set({ objectOp: { ...c2, applying: false, message: `❌ ${msg}` } })
        return
      }
      // Refresh the affected tree category (views/routines) or full schema list.
      const op = cur.op
      if (op.kind === 'dropView') {
        const vr = await window.dbApi.listViews(cur.connectionId, op.schema)
        const t = get().treeByConn[cur.connectionId]
        if (vr.ok && t) set({ treeByConn: { ...get().treeByConn, [cur.connectionId]: { ...t, viewsBySchema: { ...t.viewsBySchema, [op.schema]: vr.data } } } })
      } else if (op.kind === 'dropRoutine') {
        const rr = await window.dbApi.listRoutines(cur.connectionId, op.schema)
        const t = get().treeByConn[cur.connectionId]
        if (rr.ok && t) set({ treeByConn: { ...get().treeByConn, [cur.connectionId]: { ...t, functionsBySchema: { ...t.functionsBySchema, [op.schema]: rr.data.filter((r) => r.kind === 'function') }, proceduresBySchema: { ...t.proceduresBySchema, [op.schema]: rr.data.filter((r) => r.kind === 'procedure') } } } })
      } else if (op.kind === 'dropPackage' || op.kind === 'dropPackageBody') {
        const pr = await window.dbApi.listPackages(cur.connectionId, op.schema)
        const t = get().treeByConn[cur.connectionId]
        if (pr.ok && t) set({ treeByConn: { ...get().treeByConn, [cur.connectionId]: { ...t, packagesBySchema: { ...t.packagesBySchema, [op.schema]: pr.data } } } })
      } else if (op.kind === 'dropSequence') {
        const sr = await window.dbApi.listSequences(cur.connectionId, op.schema)
        const t = get().treeByConn[cur.connectionId]
        if (sr.ok && sr.data.supported && t) set({ treeByConn: { ...get().treeByConn, [cur.connectionId]: { ...t, sequencesBySchema: { ...t.sequencesBySchema, [op.schema]: sr.data.sequences } } } })
      } else if (op.kind === 'dropTrigger') {
        const lr = await window.dbApi.listTriggers(cur.connectionId, op.schema, op.table)
        const t = get().treeByConn[cur.connectionId]
        if (lr.ok && t) set({ treeByConn: { ...get().treeByConn, [cur.connectionId]: { ...t, triggersByTable: { ...t.triggersByTable, [`${op.schema}::${op.table}`]: lr.data } } } })
      } else if (op.kind === 'dropIndex') {
        const lr = await window.dbApi.listIndexes(cur.connectionId, op.schema, op.table)
        const t = get().treeByConn[cur.connectionId]
        if (lr.ok && t) set({ treeByConn: { ...get().treeByConn, [cur.connectionId]: { ...t, indexesByTable: { ...t.indexesByTable, [`${op.schema}::${op.table}`]: lr.data } } } })
      } else {
        // dropTable / truncate / rename / create-drop schema: cache-bust the tree
        // so the change (e.g. a dropped table) is reflected without a reconnect.
        // refreshTree also refreshes the autocomplete catalog.
        await get().refreshTree(cur.connectionId)
        set({ objectOp: null })
        return
      }
      await get().refreshCatalog(cur.connectionId)
      set({ objectOp: null })
    },

    closeObjectOp: () => set({ objectOp: null }),

    // --- tree context menu ---
    openContextMenu: (menu) => set({ contextMenu: menu }),
    closeContextMenu: () => set({ contextMenu: null }),

    // --- views + routines ---
    toggleCategory: async (connId, schema, cat) => {
      const tree = get().treeByConn[connId] ?? emptyTree()
      const key = `${schema}::${cat}`
      const isOpen = tree.expandedCats.includes(key)
      const expandedCats = isOpen ? tree.expandedCats.filter((k) => k !== key) : [...tree.expandedCats, key]
      let next: TreeState = { ...tree, expandedCats }
      if (!isOpen) {
        // Show a spinner on the category while its children load.
        set({ treeByConn: { ...get().treeByConn, [connId]: { ...tree, expandedCats, loadingKeys: [...tree.loadingKeys, key] } } })
        if (cat === 'tables' && !next.tablesBySchema[schema]) {
          const res = await window.dbApi.listTables(connId, schema)
          if (res.ok) next = { ...next, tablesBySchema: { ...next.tablesBySchema, [schema]: res.data } }
        } else if (cat === 'views' && !next.viewsBySchema[schema]) {
          const res = await window.dbApi.listViews(connId, schema)
          if (res.ok) next = { ...next, viewsBySchema: { ...next.viewsBySchema, [schema]: res.data } }
        } else if ((cat === 'functions' || cat === 'procedures') && !next.functionsBySchema[schema]) {
          const res = await window.dbApi.listRoutines(connId, schema)
          if (res.ok) {
            next = {
              ...next,
              functionsBySchema: { ...next.functionsBySchema, [schema]: res.data.filter((r) => r.kind === 'function') },
              proceduresBySchema: { ...next.proceduresBySchema, [schema]: res.data.filter((r) => r.kind === 'procedure') }
            }
          }
        } else if (cat === 'packages' && !next.packagesBySchema[schema]) {
          const res = await window.dbApi.listPackages(connId, schema)
          if (res.ok) next = { ...next, packagesBySchema: { ...next.packagesBySchema, [schema]: res.data } }
        } else if (cat === 'sequences' && !next.sequencesBySchema[schema]) {
          const res = await window.dbApi.listSequences(connId, schema)
          if (res.ok && res.data.supported) {
            next = { ...next, sequencesBySchema: { ...next.sequencesBySchema, [schema]: res.data.sequences } }
          }
        } else if (cat === 'matviews' && !next.matviewsBySchema[schema]) {
          const res = await window.dbApi.listMatViews(connId, schema)
          if (res.ok && res.data.supported) next = { ...next, matviewsBySchema: { ...next.matviewsBySchema, [schema]: res.data.matviews } }
        } else if (cat === 'types' && !next.typesBySchema[schema]) {
          const res = await window.dbApi.listTypes(connId, schema)
          if (res.ok && res.data.supported) next = { ...next, typesBySchema: { ...next.typesBySchema, [schema]: res.data.types } }
        } else if (cat === 'extensions' && !next.extensionsBySchema[schema]) {
          const res = await window.dbApi.listExtensions(connId)
          if (res.ok && res.data.supported) next = { ...next, extensionsBySchema: { ...next.extensionsBySchema, [schema]: res.data.installed } }
        }
      }
      set({ treeByConn: { ...get().treeByConn, [connId]: next } })
    },

    openNewView: (connId, schema) => {
      const tab: Tab = {
        ...freshTab(connId, 'New view', ''),
        kind: 'object',
        objectEditor: {
          objKind: 'view', mode: 'new', schema, name: 'new_view', signature: null,
          body: 'SELECT *\nFROM customers', orReplace: true, applying: false, message: null, confirmed: false
        }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    openEditView: async (connId, schema, name) => {
      const res = await window.dbApi.getObjectDefinition({ connectionId: connId, kind: 'view', schema, name })
      const body = res.ok ? res.data : '-- failed to load view definition'
      const tab: Tab = {
        ...freshTab(connId, `View: ${name}`, ''),
        kind: 'object',
        objectEditor: { objKind: 'view', mode: 'edit', schema, name, signature: null, body, orReplace: true, applying: false, message: null, confirmed: false }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    openNewRoutine: (connId, schema, kind) => {
      const engine = get().engineOf(connId) ?? 'postgres'
      const name = `new_${kind}`
      const tab: Tab = {
        ...freshTab(connId, `New ${kind}`, ''),
        kind: 'object',
        objectEditor: {
          objKind: kind, mode: 'new', schema, name, signature: null,
          body: routineTemplate(engine, kind, schema, name), orReplace: true, applying: false, message: null, confirmed: false
        }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    openEditRoutine: async (connId, ref) => {
      const res = await window.dbApi.getObjectDefinition({ connectionId: connId, kind: ref.kind, schema: ref.schema, name: ref.name, signature: ref.signature })
      const body = res.ok ? res.data : '-- failed to load routine definition'
      const tab: Tab = {
        ...freshTab(connId, `${ref.kind}: ${ref.name}`, ''),
        kind: 'object',
        objectEditor: { objKind: ref.kind, mode: 'edit', schema: ref.schema, name: ref.name, signature: ref.signature ?? null, body, orReplace: true, applying: false, message: null, confirmed: false }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    openNewPackage: (connId, schema) => {
      const name = 'new_package'
      const tab: Tab = {
        ...freshTab(connId, 'New package', ''),
        kind: 'object',
        objectEditor: {
          objKind: 'package', mode: 'new', schema, name, signature: null,
          body: packageTemplate(schema, name), orReplace: true, applying: false, message: null, confirmed: false
        }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    openEditPackagePart: async (connId, schema, name, part) => {
      const res = await window.dbApi.getObjectDefinition({ connectionId: connId, kind: part, schema, name })
      const loaded = res.ok && res.data ? res.data : null
      const body =
        loaded ??
        (part === 'packageBody'
          ? `CREATE OR REPLACE PACKAGE BODY ${qnameT('oracle', schema, name)} IS\n  -- add subprogram bodies here\nEND ${qidT('oracle', name)};`
          : `-- failed to load package spec`)
      const label = part === 'packageBody' ? 'body' : 'spec'
      const tab: Tab = {
        ...freshTab(connId, `Package ${label}: ${name}`, ''),
        kind: 'object',
        objectEditor: { objKind: part, mode: 'edit', schema, name, signature: null, body, orReplace: true, applying: false, message: null, confirmed: false }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    setObjectEditor: (tabId, patch) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.objectEditor) return
      updateTab(tabId, { objectEditor: { ...tab.objectEditor, ...patch } })
    },

    applyObjectEditor: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.objectEditor || !tab.connectionId) return
      const engine = get().engineOf(tab.connectionId) ?? 'postgres'
      const oe = tab.objectEditor
      const { statements, destructive } = buildObjectStatements(engine, oe)
      if (destructive && !oe.confirmed) {
        updateTab(tabId, { objectEditor: { ...oe, message: '⚠ This does DROP + CREATE — tick “confirm” then Apply.' } })
        return
      }
      updateTab(tabId, { objectEditor: { ...oe, applying: true, message: null } })
      const res = await window.dbApi.applyObjectSql(tab.connectionId, statements)
      const cur = get().tabs.find((t) => t.id === tabId)
      if (!cur?.objectEditor) return
      if (!res.ok || !res.data.ok) {
        const msg = res.ok ? `Statement ${(res.data.failedAt ?? 0) + 1} failed: ${res.data.message}` : res.error
        updateTab(tabId, { objectEditor: { ...cur.objectEditor, applying: false, message: `❌ ${msg}` } })
        return
      }
      // Refresh the relevant tree category + catalog.
      const connId = tab.connectionId
      const isPackage = oe.objKind === 'package' || oe.objKind === 'packageSpec' || oe.objKind === 'packageBody'
      const cat: ObjCategory =
        oe.objKind === 'view' ? 'views'
          : oe.objKind === 'matview' ? 'matviews'
            : oe.objKind === 'type' ? 'types'
              : isPackage ? 'packages'
                : oe.objKind === 'procedure' ? 'procedures'
                  : 'functions'
      const tree = get().treeByConn[connId]
      if (tree) {
        if (cat === 'matviews') {
          const mr = await window.dbApi.listMatViews(connId, oe.schema)
          if (mr.ok && mr.data.supported) { const t2 = get().treeByConn[connId]; set({ treeByConn: { ...get().treeByConn, [connId]: { ...t2, matviewsBySchema: { ...t2.matviewsBySchema, [oe.schema]: mr.data.matviews } } } }) }
        } else if (cat === 'types') {
          const tr = await window.dbApi.listTypes(connId, oe.schema)
          if (tr.ok && tr.data.supported) { const t2 = get().treeByConn[connId]; set({ treeByConn: { ...get().treeByConn, [connId]: { ...t2, typesBySchema: { ...t2.typesBySchema, [oe.schema]: tr.data.types } } } }) }
        } else if (cat === 'views') {
          const vr = await window.dbApi.listViews(connId, oe.schema)
          if (vr.ok) set({ treeByConn: { ...get().treeByConn, [connId]: { ...get().treeByConn[connId], viewsBySchema: { ...get().treeByConn[connId].viewsBySchema, [oe.schema]: vr.data } } } })
        } else if (cat === 'packages') {
          const pr = await window.dbApi.listPackages(connId, oe.schema)
          if (pr.ok) {
            const t2 = get().treeByConn[connId]
            set({ treeByConn: { ...get().treeByConn, [connId]: { ...t2, packagesBySchema: { ...t2.packagesBySchema, [oe.schema]: pr.data } } } })
          }
        } else {
          const rr = await window.dbApi.listRoutines(connId, oe.schema)
          if (rr.ok) {
            const t2 = get().treeByConn[connId]
            set({ treeByConn: { ...get().treeByConn, [connId]: { ...t2, functionsBySchema: { ...t2.functionsBySchema, [oe.schema]: rr.data.filter((r) => r.kind === 'function') }, proceduresBySchema: { ...t2.proceduresBySchema, [oe.schema]: rr.data.filter((r) => r.kind === 'procedure') } } } })
          }
        }
      }
      await get().refreshCatalog(connId)
      updateTab(tabId, {
        objectEditor: { ...cur.objectEditor, applying: false, message: `✅ Applied (${res.data.executed} statement(s)).`, mode: 'edit', confirmed: false }
      })
    },

    openViewData: async (connId, schema, name) => {
      get().addTab(connId)
      await get().openTable({ schema, name, type: 'view' })
    },

    // --- PostgreSQL advanced objects (TASK 67) ---
    openNewMatView: (connId, schema) => {
      const tab: Tab = {
        ...freshTab(connId, 'New materialized view', ''),
        kind: 'object',
        objectEditor: {
          objKind: 'matview', mode: 'new', schema, name: 'new_matview', signature: null,
          body: 'SELECT *\nFROM customers', orReplace: false, applying: false, message: null, confirmed: false
        }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    openEditMatView: async (connId, schema, name) => {
      const res = await window.dbApi.getObjectDefinition({ connectionId: connId, kind: 'matview', schema, name })
      const body = res.ok ? res.data : '-- failed to load materialized view definition'
      const tab: Tab = {
        ...freshTab(connId, `Matview: ${name}`, ''),
        kind: 'object',
        objectEditor: { objKind: 'matview', mode: 'edit', schema, name, signature: null, body, orReplace: false, applying: false, message: null, confirmed: false }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    openNewType: (connId, schema) => {
      const qn = qnameT('postgres', schema, 'new_type')
      const body =
        `-- Enum type:\nCREATE TYPE ${qn} AS ENUM ('first', 'second', 'third');\n\n` +
        `-- …or a composite type (delete the enum above and use this instead):\n-- CREATE TYPE ${qn} AS (field1 text, field2 integer);`
      const tab: Tab = {
        ...freshTab(connId, 'New type', ''),
        kind: 'object',
        objectEditor: { objKind: 'type', mode: 'new', schema, name: 'new_type', signature: null, body, orReplace: false, applying: false, message: null, confirmed: false }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    openTypeAlter: (connId, schema, name, kind) => {
      const qn = qnameT('postgres', schema, name)
      const body =
        kind === 'addValue'
          ? `-- Add an enum value. Optionally place it BEFORE/AFTER an existing one.\n` +
            `ALTER TYPE ${qn} ADD VALUE 'new_value';\n` +
            `-- e.g. ALTER TYPE ${qn} ADD VALUE 'x' AFTER 'first';\n` +
            `-- NOTE: PostgreSQL cannot DROP or reorder enum values; renaming a value\n` +
            `--       is ALTER TYPE ${qn} RENAME VALUE 'old' TO 'new'; (PG 10+).`
          : `-- Rename the type, or (enum only) rename one of its values.\n` +
            `ALTER TYPE ${qn} RENAME TO new_name;\n` +
            `-- e.g. ALTER TYPE ${qn} RENAME VALUE 'first' TO 'primary';`
      const tab: Tab = {
        ...freshTab(connId, `Alter type: ${name}`, ''),
        kind: 'object',
        objectEditor: { objKind: 'type', mode: 'new', schema, name, signature: null, body, orReplace: false, applying: false, message: null, confirmed: false }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    openExtensions: (connId) => {
      set({ extDialog: { connectionId: connId, installed: [], available: [], loading: true, message: null }, contextMenu: null })
      void get().refreshExtensions(connId)
    },
    closeExtensions: () => set({ extDialog: null }),
    refreshExtensions: async (connId) => {
      const res = await window.dbApi.listExtensions(connId)
      const cur = get().extDialog
      if (!cur || cur.connectionId !== connId) return
      if (!res.ok || !res.data.supported) {
        set({ extDialog: { ...cur, loading: false, message: res.ok ? (res.data.note ?? 'Not supported') : res.error } })
        return
      }
      set({ extDialog: { ...cur, loading: false, installed: res.data.installed, available: res.data.available, message: null } })
    },

    // --- sequences (PostgreSQL) ---
    openNewSequence: (connId, schema) => {
      const tab: Tab = {
        ...freshTab(connId, 'New sequence', ''),
        kind: 'sequence',
        sequenceEditor: {
          mode: 'new',
          spec: defaultSequenceSpec(schema),
          original: null,
          details: null,
          applying: false,
          message: null
        }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    openEditSequence: async (connId, schema, name) => {
      const res = await window.dbApi.getSequenceDetails(connId, schema, name)
      if (!res.ok) {
        const at = get().getActiveTab()
        if (at) updateTab(at.id, { statusMessage: `Load sequence failed: ${res.error}` })
        return
      }
      const info = res.data
      const spec = specFromInfo(info)
      const tab: Tab = {
        ...freshTab(connId, `Sequence: ${name}`, ''),
        kind: 'sequence',
        sequenceEditor: {
          mode: 'edit',
          spec,
          original: JSON.parse(JSON.stringify(spec)),
          details: info,
          applying: false,
          message: null
        }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    setSequenceEditor: (tabId, patch) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.sequenceEditor) return
      updateTab(tabId, { sequenceEditor: { ...tab.sequenceEditor, ...patch } })
    },

    applySequenceEditor: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.sequenceEditor || !tab.connectionId) return
      const se = tab.sequenceEditor
      const seqEngine = get().engineOf(tab.connectionId) ?? 'postgres'
      let statements: string[]
      try {
        const preview =
          se.mode === 'new'
            ? buildCreateSequence(seqEngine, se.spec)
            : buildAlterSequence(seqEngine, se.spec, se.original as SequenceSpec, {
                oracleRestartSupported: se.details?.restartSupported !== false
              })
        statements = preview.statements
      } catch (err) {
        updateTab(tabId, { sequenceEditor: { ...se, message: `❌ ${(err as Error).message}` } })
        return
      }
      if (statements.length === 0) {
        updateTab(tabId, { sequenceEditor: { ...se, message: 'No changes to apply.' } })
        return
      }
      updateTab(tabId, { sequenceEditor: { ...se, applying: true, message: null } })
      const res = await window.dbApi.applyObjectSql(tab.connectionId, statements)
      const cur = get().tabs.find((t) => t.id === tabId)
      if (!cur?.sequenceEditor) return
      if (!res.ok || !res.data.ok) {
        const msg = res.ok ? `Statement ${(res.data.failedAt ?? 0) + 1} failed: ${res.data.message}` : res.error
        updateTab(tabId, { sequenceEditor: { ...cur.sequenceEditor, applying: false, message: `❌ ${msg}` } })
        return
      }
      // Success: refresh the Sequences list + re-fetch details (new last_value etc.).
      const connId = tab.connectionId
      const schema = se.spec.schema
      const sr = await window.dbApi.listSequences(connId, schema)
      const t = get().treeByConn[connId]
      if (sr.ok && sr.data.supported && t) {
        set({ treeByConn: { ...get().treeByConn, [connId]: { ...t, sequencesBySchema: { ...t.sequencesBySchema, [schema]: sr.data.sequences } } } })
      }
      const detRes = await window.dbApi.getSequenceDetails(connId, schema, se.spec.name)
      const info = detRes.ok ? detRes.data : cur.sequenceEditor.details
      const newSpec = detRes.ok ? specFromInfo(detRes.data) : { ...se.spec, restart: null }
      updateTab(tabId, {
        title: `Sequence: ${se.spec.name}`,
        sequenceEditor: {
          ...cur.sequenceEditor,
          mode: 'edit',
          spec: newSpec,
          original: JSON.parse(JSON.stringify(newSpec)),
          details: info,
          applying: false,
          message: `✅ Applied (${res.data.executed} statement(s)).`
        }
      })
    },

    // --- triggers (all engines, per table) ---
    toggleTableExpand: (connId, schema, table) => {
      const tree = get().treeByConn[connId] ?? emptyTree()
      const key = tkey(schema, table)
      const expandedTables = tree.expandedTables.includes(key)
        ? tree.expandedTables.filter((k) => k !== key)
        : [...tree.expandedTables, key]
      set({ treeByConn: { ...get().treeByConn, [connId]: { ...tree, expandedTables } } })
    },

    toggleTableTriggers: async (connId, schema, table) => {
      const tree = get().treeByConn[connId] ?? emptyTree()
      const key = `${schema}::${table}::triggers`
      const isOpen = tree.expandedCats.includes(key)
      const expandedCats = isOpen ? tree.expandedCats.filter((k) => k !== key) : [...tree.expandedCats, key]
      let next: TreeState = { ...tree, expandedCats }
      if (!isOpen && !next.triggersByTable[tkey(schema, table)]) {
        set({ treeByConn: { ...get().treeByConn, [connId]: { ...tree, expandedCats, loadingKeys: [...tree.loadingKeys, key] } } })
        const res = await window.dbApi.listTriggers(connId, schema, table)
        if (res.ok) next = { ...next, triggersByTable: { ...next.triggersByTable, [tkey(schema, table)]: res.data } }
      }
      set({ treeByConn: { ...get().treeByConn, [connId]: next } })
    },

    toggleTableColumns: async (connId, schema, table) => {
      const tree = get().treeByConn[connId] ?? emptyTree()
      const key = `${schema}::${table}::columns`
      const isOpen = tree.expandedCats.includes(key)
      const expandedCats = isOpen ? tree.expandedCats.filter((k) => k !== key) : [...tree.expandedCats, key]
      let next: TreeState = { ...tree, expandedCats }
      if (!isOpen && !next.columnsByTable[tkey(schema, table)]) {
        set({ treeByConn: { ...get().treeByConn, [connId]: { ...tree, expandedCats, loadingKeys: [...tree.loadingKeys, key] } } })
        const res = await window.dbApi.getTableSpec(connId, schema, table)
        if (res.ok) {
          const fkCols = new Set<string>()
          for (const fk of res.data.foreignKeys) for (const c of fk.columns) fkCols.add(c)
          const pk = new Set(res.data.primaryKey)
          const cols: TreeColumn[] = res.data.columns.map((c) => ({
            name: c.name,
            type: c.type + (c.length != null ? `(${c.length}${c.scale != null ? ',' + c.scale : ''})` : ''),
            isPrimaryKey: pk.has(c.name),
            isForeignKey: fkCols.has(c.name),
            nullable: c.nullable
          }))
          next = { ...next, columnsByTable: { ...next.columnsByTable, [tkey(schema, table)]: cols } }
        }
      }
      set({ treeByConn: { ...get().treeByConn, [connId]: next } })
    },

    openNewTrigger: (connId, schema, table) => {
      const engine = get().engineOf(connId) ?? 'postgres'
      const tab: Tab = {
        ...freshTab(connId, `New trigger`, ''),
        kind: 'trigger',
        triggerEditor: { mode: 'new', spec: defaultTriggerSpec(engine, schema, table), applying: false, message: null }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    openEditTrigger: async (connId, schema, table, name) => {
      const res = await window.dbApi.getTriggerDetails(connId, schema, table, name)
      if (!res.ok) {
        const at = get().getActiveTab()
        if (at) updateTab(at.id, { statusMessage: `Load trigger failed: ${res.error}` })
        return
      }
      const d = res.data
      const spec: TriggerSpec = {
        schema: d.schema,
        table: d.table,
        name: d.name,
        originalName: d.name,
        timing: (d.timing.toUpperCase() as TriggerSpec['timing']) || 'BEFORE',
        event: (d.event.toUpperCase() as TriggerSpec['event']) || 'INSERT',
        level: (d.level.toUpperCase() as TriggerSpec['level']) || 'ROW',
        body: d.body,
        functionName: d.functionName ?? `${d.name}_fn`,
        functionBody: d.functionBody ?? '',
        whenClause: d.whenClause ?? ''
      }
      const tab: Tab = {
        ...freshTab(connId, `Trigger: ${name}`, ''),
        kind: 'trigger',
        triggerEditor: { mode: 'edit', spec, applying: false, message: null }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    setTriggerEditor: (tabId, patch) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.triggerEditor) return
      updateTab(tabId, { triggerEditor: { ...tab.triggerEditor, ...patch } })
    },

    applyTriggerEditor: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.triggerEditor || !tab.connectionId) return
      const engine = get().engineOf(tab.connectionId) ?? 'postgres'
      const te = tab.triggerEditor
      let statements: string[]
      try {
        statements = buildTriggerStatements(engine, te.spec, te.mode).statements
      } catch (err) {
        updateTab(tabId, { triggerEditor: { ...te, message: `❌ ${(err as Error).message}` } })
        return
      }
      updateTab(tabId, { triggerEditor: { ...te, applying: true, message: null } })
      const res = await window.dbApi.applyObjectSql(tab.connectionId, statements)
      const cur = get().tabs.find((t) => t.id === tabId)
      if (!cur?.triggerEditor) return
      if (!res.ok || !res.data.ok) {
        const msg = res.ok ? `Statement ${(res.data.failedAt ?? 0) + 1} failed: ${res.data.message}` : res.error
        updateTab(tabId, { triggerEditor: { ...cur.triggerEditor, applying: false, message: `❌ ${msg}` } })
        return
      }
      // Refresh the table's Triggers list.
      const connId = tab.connectionId
      const { schema, table } = te.spec
      const lr = await window.dbApi.listTriggers(connId, schema, table)
      const t = get().treeByConn[connId]
      if (lr.ok && t) {
        set({ treeByConn: { ...get().treeByConn, [connId]: { ...t, triggersByTable: { ...t.triggersByTable, [tkey(schema, table)]: lr.data } } } })
      }
      updateTab(tabId, {
        title: `Trigger: ${te.spec.name}`,
        triggerEditor: {
          ...cur.triggerEditor,
          mode: 'edit',
          spec: { ...te.spec, originalName: te.spec.name },
          applying: false,
          message: `✅ Applied (${res.data.executed} statement(s)).`
        }
      })
    },

    setTriggerEnabled: async (connId, schema, table, name, enable) => {
      const engine = get().engineOf(connId) ?? 'oracle'
      const stmt = buildSetTriggerEnabled(engine, schema, table, name, enable)
      if (!stmt) return
      const res = await window.dbApi.applyObjectSql(connId, [stmt])
      const at = get().getActiveTab()
      if (!res.ok || !res.data.ok) {
        const msg = res.ok ? res.data.message : res.error
        if (at) updateTab(at.id, { statusMessage: `${enable ? 'Enable' : 'Disable'} trigger failed: ${msg}` })
        return
      }
      // Refresh the table's Triggers list so the new status shows.
      const lr = await window.dbApi.listTriggers(connId, schema, table)
      const t = get().treeByConn[connId]
      if (lr.ok && t) {
        set({ treeByConn: { ...get().treeByConn, [connId]: { ...t, triggersByTable: { ...t.triggersByTable, [tkey(schema, table)]: lr.data } } } })
      }
      if (at) updateTab(at.id, { statusMessage: `Trigger "${name}" ${enable ? 'enabled' : 'disabled'}.` })
      set({ contextMenu: null })
    },

    // --- indexes (all engines, per table) ---
    toggleTableIndexes: async (connId, schema, table) => {
      const tree = get().treeByConn[connId] ?? emptyTree()
      const key = `${schema}::${table}::indexes`
      const isOpen = tree.expandedCats.includes(key)
      const expandedCats = isOpen ? tree.expandedCats.filter((k) => k !== key) : [...tree.expandedCats, key]
      let next: TreeState = { ...tree, expandedCats }
      if (!isOpen && !next.indexesByTable[tkey(schema, table)]) {
        set({ treeByConn: { ...get().treeByConn, [connId]: { ...tree, expandedCats, loadingKeys: [...tree.loadingKeys, key] } } })
        const res = await window.dbApi.listIndexes(connId, schema, table)
        if (res.ok) next = { ...next, indexesByTable: { ...next.indexesByTable, [tkey(schema, table)]: res.data } }
      }
      set({ treeByConn: { ...get().treeByConn, [connId]: next } })
    },

    openNewIndex: (connId, schema, table) => {
      const tab: Tab = {
        ...freshTab(connId, 'New index', ''),
        kind: 'index',
        indexEditor: {
          mode: 'new',
          spec: { schema, table, name: `_idx_${table}`, originalName: null, columns: [], unique: false, method: 'btree', where: '', expression: '' },
          original: null,
          applying: false,
          message: null
        }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    openEditIndex: (connId, schema, table, name) => {
      const tree = get().treeByConn[connId]
      const info = tree?.indexesByTable[tkey(schema, table)]?.find((i) => i.name === name)
      // Round-trip PG method/predicate/expression. An expression index (whose key
      // isn't a plain column list) is edited as an expression, not columns.
      const method = (info?.method ?? 'btree') as IndexCreateSpec['method']
      const isExprKey = !!info && info.columns.length === 1 && /[()\s]/.test(info.columns[0] ?? '')
      const spec: IndexCreateSpec = {
        schema,
        table,
        name,
        originalName: name,
        columns: isExprKey ? [] : info ? [...info.columns] : [],
        unique: info?.unique ?? false,
        method,
        where: info?.predicate ?? '',
        expression: isExprKey ? (info?.keyExpr ?? '') : ''
      }
      const tab: Tab = {
        ...freshTab(connId, `Index: ${name}`, ''),
        kind: 'index',
        indexEditor: { mode: 'edit', spec, original: JSON.parse(JSON.stringify(spec)), applying: false, message: null }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    setIndexEditor: (tabId, patch) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.indexEditor) return
      updateTab(tabId, { indexEditor: { ...tab.indexEditor, ...patch } })
    },

    applyIndexEditor: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.indexEditor || !tab.connectionId) return
      const engine = get().engineOf(tab.connectionId) ?? 'postgres'
      const ie = tab.indexEditor
      let statements: string[]
      try {
        statements =
          ie.mode === 'new'
            ? buildCreateIndex(engine, ie.spec).statements
            : buildAlterIndex(engine, ie.spec, ie.original as IndexCreateSpec).statements
      } catch (err) {
        updateTab(tabId, { indexEditor: { ...ie, message: `❌ ${(err as Error).message}` } })
        return
      }
      updateTab(tabId, { indexEditor: { ...ie, applying: true, message: null } })
      const res = await window.dbApi.applyObjectSql(tab.connectionId, statements)
      const cur = get().tabs.find((t) => t.id === tabId)
      if (!cur?.indexEditor) return
      if (!res.ok || !res.data.ok) {
        const msg = res.ok ? `Statement ${(res.data.failedAt ?? 0) + 1} failed: ${res.data.message}` : res.error
        updateTab(tabId, { indexEditor: { ...cur.indexEditor, applying: false, message: `❌ ${msg}` } })
        return
      }
      // Refresh the table's Indexes list.
      const connId = tab.connectionId
      const { schema, table } = ie.spec
      const lr = await window.dbApi.listIndexes(connId, schema, table)
      const t = get().treeByConn[connId]
      if (lr.ok && t) {
        set({ treeByConn: { ...get().treeByConn, [connId]: { ...t, indexesByTable: { ...t.indexesByTable, [tkey(schema, table)]: lr.data } } } })
      }
      const newSpec: IndexCreateSpec = { ...ie.spec, originalName: ie.spec.name }
      updateTab(tabId, {
        title: `Index: ${ie.spec.name}`,
        indexEditor: {
          ...cur.indexEditor,
          mode: 'edit',
          spec: newSpec,
          original: JSON.parse(JSON.stringify(newSpec)),
          applying: false,
          message: `✅ Applied (${res.data.executed} statement(s)).`
        }
      })
    },

    // --- visual view builder ---
    openViewBuilder: (connId, schema) => {
      const tab: Tab = {
        ...freshTab(connId, 'View builder', ''),
        kind: 'viewbuilder',
        vbSchema: schema,
        viewModel: { tables: [], joins: [], outputs: [], distinct: false, where: null, groupBy: [], having: null, orderBy: [] }
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    // --- ER diagram ---
    openErDiagram: (connId, schema) => {
      const tab: Tab = {
        ...freshTab(connId, `ER: ${schema}`, ''),
        kind: 'erdiagram',
        erSchema: schema
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    // --- import / export ---
    openExport: (connId, schema, table, useActiveFilter, presetFormat) => {
      let filter: IoExportCtx['filter'] = null
      if (useActiveFilter) {
        const at = get().getActiveTab()
        if (at?.gridTable?.schema === schema && at.gridTable.table === table) {
          const ef = effectiveFilter(at)
          const active =
            (ef.filters && ef.filters.length > 0) || ef.tree != null || (ef.customWhere != null && ef.customWhere !== '')
          if (active) filter = { filters: ef.filters ?? [], tree: ef.tree ?? null, customWhere: ef.customWhere ?? null }
        }
      }
      set({ ioExport: { connectionId: connId, schema, table, filter, presetFormat }, contextMenu: null })
    },
    openImport: (connId, schema, table) => set({ ioImport: { connectionId: connId, schema, table }, contextMenu: null }),
    openDbDump: (connId, schema) => set({ ioDbDump: { connectionId: connId, schema }, contextMenu: null }),
    openRestore: (connId, schema) => set({ ioRestore: { connectionId: connId, schema }, contextMenu: null }),
    openTransfer: (connId, schema, table) => set({ ioTransfer: { connectionId: connId, schema, table }, contextMenu: null }),
    closeIo: () => set({ ioExport: null, ioImport: null, ioDbDump: null, ioRestore: null, ioTransfer: null }),

    // --- layout ---
    setSidebarCollapsed: (collapsed) => {
      set({ sidebarCollapsed: collapsed })
      void window.dbApi.saveUiState({ sidebarCollapsed: collapsed, filterSqlCollapsed: get().filterSqlCollapsed, theme: get().theme })
    },
    toggleSidebar: () => get().setSidebarCollapsed(!get().sidebarCollapsed),
    toggleFilterSql: () => {
      const filterSqlCollapsed = !get().filterSqlCollapsed
      set({ filterSqlCollapsed })
      void window.dbApi.saveUiState({ sidebarCollapsed: get().sidebarCollapsed, filterSqlCollapsed, theme: get().theme })
    },
    setTheme: (theme) => {
      set({ theme })
      applyTheme(theme)
      void window.dbApi.saveUiState({ sidebarCollapsed: get().sidebarCollapsed, filterSqlCollapsed: get().filterSqlCollapsed, theme })
      // Keep the native View ▸ Theme checkmark in sync (TASK 72).
      window.dbApi.notifyThemeChanged(theme)
    },
    toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
    setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
    setAboutOpen: (open) => set({ aboutOpen: open }),
    requestNewConnection: () => set({ newConnSignal: get().newConnSignal + 1 }),
    requestSavedFilters: () => set({ savedFiltersSignal: get().savedFiltersSignal + 1 }),
    setNotice: (msg) => set({ notice: msg }),
    closeTopOverlay: () => {
      const s = get()
      if (s.aboutOpen) { set({ aboutOpen: false }); return true }
      if (s.shortcutsOpen) { set({ shortcutsOpen: false }); return true }
      if (s.extDialog) { s.closeExtensions(); return true }
      if (s.objectOp) { s.closeObjectOp(); return true }
      if (s.ioTransfer || s.ioExport || s.ioImport || s.ioDbDump || s.ioRestore) { s.closeIo(); return true }
      if (s.contextMenu) { s.closeContextMenu(); return true }
      return false
    },
    openSqlInNewTab: (connId, sql) => {
      get().addTab(connId ?? undefined)
      const id = get().activeTabId
      if (id) updateTab(id, { sql })
      schedulePersist(get)
    },

    refreshErSchema: async (connId, schema) => {
      await get().loadSchemas(connId)
      const tree = get().treeByConn[connId]
      if (tree) {
        const tablesRes = await window.dbApi.listTables(connId, schema)
        if (tablesRes.ok) {
          set({
            treeByConn: {
              ...get().treeByConn,
              [connId]: { ...tree, tablesBySchema: { ...tree.tablesBySchema, [schema]: tablesRes.data } }
            }
          })
        }
      }
      await get().refreshCatalog(connId)
    },

    openViewInBuilder: async (connId, schema, name) => {
      const engine = get().engineOf(connId) ?? 'postgres'
      const fallback = async (reason: string): Promise<void> => {
        await get().openEditView(connId, schema, name)
        const at = get().getActiveTab()
        if (at?.objectEditor) {
          get().setObjectEditor(at.id, {
            message: `ℹ Too complex for the visual builder (${reason}). Opened in the SQL editor instead.`
          })
        }
      }
      const defRes = await window.dbApi.getObjectDefinition({ connectionId: connId, kind: 'view', schema, name })
      if (!defRes.ok) return fallback('could not load the view definition')
      const parsed = await window.dbApi.parseViewToModel(engine, defRes.data)
      if (!parsed.ok) return fallback('parse error')
      if (!parsed.data.supported) return fallback(parsed.data.reason)
      // Validate + resolve schemas/columns against the catalog.
      if (!get().catalogByConn[connId]) await get().refreshCatalog(connId)
      const catalog = get().catalogByConn[connId]
      if (!catalog) return fallback('catalog unavailable')
      const resolved = resolveViewModel(parsed.data.model, catalog)
      if (!resolved.ok) return fallback(resolved.reason)
      // Open the builder pre-populated with the reconstructed model.
      const tab: Tab = {
        ...freshTab(connId, `View: ${name}`, ''),
        kind: 'viewbuilder',
        vbSchema: schema,
        vbName: name,
        viewModel: resolved.model
      }
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, contextMenu: null })
    },

    setViewModel: (tabId, model) => {
      updateTab(tabId, { viewModel: model })
    },

    previewViewBuilder: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.viewModel || !tab.connectionId) return
      const engine = get().engineOf(tab.connectionId) ?? 'postgres'
      const inline = generateViewSelect(engine, tab.viewModel, 'inline')
      const paramForm = generateViewSelect(engine, tab.viewModel, 'params')
      if (!inline.sql || tab.viewModel.tables.length === 0) return
      const connId = tab.connectionId
      // Open a fresh query tab; show the readable SQL, run the parameterized form.
      get().addTab(connId)
      const qtid = get().activeTabId as string
      updateTab(qtid, { sql: inline.sql, running: true, result: null, resultError: null, gridTable: null, gridSpec: null, statusMessage: 'Preview' })
      const res = await window.dbApi.runQuery(connId, paramForm.sql, paramForm.params)
      if (res.ok) updateTab(qtid, { running: false, result: res.data, statusMessage: `Preview: ${res.data.rowCount} rows in ${res.data.durationMs} ms` })
      else updateTab(qtid, { running: false, resultError: res.error, statusMessage: 'Preview failed' })
    },

    saveViewBuilder: async (tabId, name) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.viewModel || !tab.connectionId || !tab.vbSchema) return { ok: false, message: 'nothing to save' }
      const engine = get().engineOf(tab.connectionId) ?? 'postgres'
      const inline = generateViewSelect(engine, tab.viewModel, 'inline')
      if (!inline.sql) return { ok: false, message: 'add at least one table' }
      if (!name.trim()) return { ok: false, message: 'view name required' }
      const connId = tab.connectionId
      const schema = tab.vbSchema
      const qn = engine === 'sqlite' ? `"${name}"` : engine === 'mysql' ? `\`${schema}\`.\`${name}\`` : `"${schema}"."${name}"`
      const statements =
        engine === 'sqlite'
          ? [`DROP VIEW IF EXISTS ${qn}`, `CREATE VIEW ${qn} AS ${inline.sql}`]
          : [`CREATE OR REPLACE VIEW ${qn} AS ${inline.sql}`]
      const res = await window.dbApi.applyObjectSql(connId, statements)
      if (!res.ok || !res.data.ok) {
        const msg = res.ok ? res.data.message ?? 'apply failed' : res.error
        return { ok: false, message: msg ?? 'apply failed' }
      }
      // Refresh the tree's Views list for the schema.
      const vr = await window.dbApi.listViews(connId, schema)
      const t = get().treeByConn[connId]
      if (vr.ok && t) set({ treeByConn: { ...get().treeByConn, [connId]: { ...t, viewsBySchema: { ...t.viewsBySchema, [schema]: vr.data } } } })
      await get().refreshCatalog(connId)
      return { ok: true, message: `✅ Saved view "${name}"` }
    }
  }
})
