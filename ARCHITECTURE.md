# DB Tool — Architecture

## Overview

DB Tool is a cross-platform Electron desktop application — a Navicat-style GUI for six database engines: **PostgreSQL, MySQL, MariaDB, SQLite, Oracle, and Microsoft SQL Server**. The architecture enforces a strict process boundary: all database drivers, credentials, and native modules run in the Electron **main** process; the **renderer** is a sandboxed React SPA that communicates exclusively through a typed IPC bridge.

```mermaid
graph TB
    subgraph Renderer["Renderer Process (sandboxed)"]
        React["React 18 + Zustand"]
        CM["CodeMirror 6 (SQL editor)"]
        Grid["Glide Data Grid (canvas)"]
        RF["React Flow (ER / View Builder)"]
    end

    subgraph Preload["Preload (contextBridge)"]
        Bridge["window.dbApi — typed, whitelisted API"]
    end

    subgraph Main["Main Process (Node.js)"]
        IPC["ipc.ts — IPC handlers"]
        Drivers["DbDriver interface"]
        PG["postgres.ts (pg)"]
        MY["mysql.ts (mysql2)"]
        MA["mariadb.ts (extends mysql)"]
        SL["sqlite.ts (better-sqlite3)"]
        OR["oracle.ts (oracledb)"]
        MS["mssql.ts (mssql)"]
        DDL["ddl.ts — DDL generator"]
        Transfer["transfer.ts — cross-engine copy"]
        Store["store.ts — persistence (userData)"]
        History["history.ts — query history (SQLite)"]
        Menu["menu.ts — native app menu"]
    end

    React -->|"window.dbApi.*"| Bridge
    Bridge -->|"ipcRenderer.invoke"| IPC
    IPC --> Drivers
    Drivers --> PG
    Drivers --> MY
    Drivers --> MA
    Drivers --> SL
    Drivers --> OR
    Drivers --> MS
    IPC --> DDL
    IPC --> Transfer
    IPC --> Store
    IPC --> History
    Main -.-> Menu
```

## Process Model

```mermaid
flowchart LR
    subgraph MAIN["Main Process"]
        D[("DB Drivers\n(pg, mysql2, better-sqlite3,\noracledb, mssql)")]
        H[("IPC Handlers")]
        S[("Store\n(JSON + SQLite in userData)")]
    end

    subgraph PRE["Preload"]
        B["contextBridge\nwindow.dbApi"]
    end

    subgraph REND["Renderer Process"]
        UI["React UI\n(Zustand store)"]
    end

    UI -- "invoke(channel, args)" --> B
    B -- "ipcMain.handle" --> H
    H -- "DbDriver.*" --> D
    H -- "read/write" --> S
    H -- "IpcResult<T>" --> B
    B -- "resolved promise" --> UI
```

### Security Posture

- `BrowserWindow`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- The renderer **never** imports `pg`, `mysql2`, `better-sqlite3`, `oracledb`, or `mssql`
- All communication goes through the whitelisted `window.dbApi` (typed `DbApi` interface)
- Passwords are encrypted at rest via Electron `safeStorage` (OS keychain) and **never** sent to the renderer
- All SQL writes use parameterized queries — never string concatenation of user values

## Directory Structure

```
db-tool/
├── build/                      # Icons, entitlements (macOS)
├── src/
│   ├── main/                   # Electron main process
│   │   ├── index.ts            # App entry: window creation, lifecycle
│   │   ├── ipc.ts              # All ipcMain.handle() registrations
│   │   ├── driver.ts           # DbDriver interface + factory
│   │   ├── drivers/
│   │   │   ├── postgres.ts     # PostgreSQL (pg)
│   │   │   ├── mysql.ts        # MySQL (mysql2)
│   │   │   ├── mariadb.ts      # MariaDB (extends MySQL)
│   │   │   ├── sqlite.ts       # SQLite (better-sqlite3)
│   │   │   ├── oracle.ts       # Oracle (oracledb thin/thick)
│   │   │   └── mssql.ts        # SQL Server (mssql/tedious)
│   │   ├── ddl.ts              # DDL generation (CREATE/ALTER TABLE)
│   │   ├── transfer.ts         # Cross-engine data transfer
│   │   ├── exporter.ts         # CSV/JSON/XLSX/SQL export
│   │   ├── importer.ts         # CSV/JSON/XLSX import
│   │   ├── dumper.ts           # Database dump/restore (.sql)
│   │   ├── history.ts          # Query history (SQLite in userData)
│   │   ├── store.ts            # Connection/UI persistence
│   │   ├── menu.ts             # Native application menu
│   │   ├── viewReverse.ts      # SQL → ViewModel parser
│   │   └── smoke.ts            # Headless smoke test
│   ├── preload/
│   │   ├── index.ts            # contextBridge (window.dbApi)
│   │   └── index.d.ts          # Type declarations
│   ├── renderer/
│   │   └── src/
│   │       ├── App.tsx          # Root component
│   │       ├── main.tsx         # React entry
│   │       ├── store.ts         # Zustand store (all UI state)
│   │       ├── styles.css       # Global styles
│   │       ├── useShortcuts.ts  # Keyboard shortcuts hook
│   │       ├── useMenuActions.ts# Native menu → store bridge
│   │       ├── sqlAutocomplete.ts # Schema-aware autocomplete
│   │       ├── treeIcons.tsx    # Tree icon components
│   │       └── components/      # 30+ React components
│   └── shared/                  # Imported by BOTH main & renderer
│       ├── types.ts             # All types, IPC channels, DbApi
│       ├── filterCompiler.ts    # WHERE clause compiler
│       ├── typeCatalog.ts       # Column type catalog per engine
│       ├── sqlSplit.ts          # SQL script splitter
│       ├── viewBuilder.ts       # Visual SELECT generator
│       ├── sequenceDdl.ts       # Sequence DDL
│       ├── triggerDdl.ts        # Trigger DDL
│       ├── indexDdl.ts          # Index DDL
│       └── rawWhere.ts          # Custom WHERE guard
├── electron.vite.config.ts      # Vite config (main/preload/renderer)
├── electron-builder.yml         # Packaging config (Win/Mac/Linux)
└── package.json
```

## Database Driver Architecture

```mermaid
classDiagram
    class DbDriver {
        <<interface>>
        +connect()
        +disconnect()
        +testConnection()
        +listSchemas()
        +listTables(schema)
        +getTableStructure(schema, table)
        +runQuery(sql, params)
        +getTablePage(schema, table, page, sort, filters)
        +getTableRowCount(schema, table, filters)
        +updateCell(schema, table, column, value, pk)
        +applyRowChanges(req)
        +getTableSpec(schema, table)
        +execStatements(statements)
        +transferInsert(schema, table, cols, rows)
        +getSchemaCatalog()
        +listViews(schema)
        +listRoutines(schema)
        +listSequences(schema)
        +listTriggers(schema, table)
        +listIndexes(schema, table)
    }

    class PostgresDriver {
        +listMatViews(schema)
        +listTypes(schema)
        +listExtensions(schema)
    }

    class MysqlDriver
    class MariadbDriver
    class SqliteDriver
    class OracleDriver {
        +listPackages(schema)
    }
    class MssqlDriver

    DbDriver <|.. PostgresDriver
    DbDriver <|.. MysqlDriver
    DbDriver <|.. SqliteDriver
    DbDriver <|.. OracleDriver
    DbDriver <|.. MssqlDriver
    MysqlDriver <|-- MariadbDriver
```

### Driver Details

| Driver | Package | Identifier Quoting | Bind Params | Notes |
|---|---|---|---|---|
| PostgreSQL | `pg` (Pool) | `"double quotes"` | `$1, $2, ...` | Full PG-specific objects: matviews, types, extensions |
| MySQL | `mysql2/promise` (Pool) | `` `backticks` `` | `?, ?, ...` | No standalone sequences |
| MariaDB | extends MySQL | `` `backticks` `` | `?, ?, ...` | Adds standalone sequence support (10.3+) |
| SQLite | `better-sqlite3` (sync) | `"double quotes"` | `?, ?, ...` | Single file, `['main']` schema |
| Oracle | `oracledb` (thin/thick) | `"DOUBLE QUOTES"` | `:1, :2, ...` | Thin = pure JS; packages, IDENTITY sequences |
| MS SQL | `mssql/tedious` | `[brackets]` | `@p1, @p2, ...` | SQL Auth + Windows Auth; IDENTITY handling |

## IPC Flow

```mermaid
sequenceDiagram
    participant R as Renderer (React)
    participant P as Preload (contextBridge)
    participant M as Main (ipcMain)
    participant D as DbDriver

    R->>P: window.dbApi.getTablePage(id, schema, table, ...)
    P->>M: ipcRenderer.invoke('db:getTablePage', ...)
    M->>D: requireDriver(id).getTablePage(...)
    D-->>M: QueryResult
    M-->>P: { ok: true, data: QueryResult }
    P-->>R: IpcResult<QueryResult>
```

Every IPC call returns `IpcResult<T>`:
```typescript
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
```

The renderer **never** receives a rejected promise — errors are always in the `error` string field.

## Renderer Component Tree

```mermaid
graph TD
    App["App.tsx"]
    App --> CM["ConnectionManager"]
    App --> OT["ObjectTree"]
    App --> ET["EditorTabs"]
    App --> QW["QueryWorkspace"]
    App --> TD["TableDesigner"]
    App --> OE["ObjectEditor"]
    App --> VB["ViewBuilder"]
    App --> ER["ErDiagram"]
    App --> SE["SequenceEditor"]
    App --> TE["TriggerEditor"]
    App --> IE["IndexEditor"]

    QW --> SQL["SqlEditor (CodeMirror 6)"]
    QW --> DG["DataGrid (Glide)"]
    QW --> PB["PaginationBar"]
    QW --> CF["ColumnFilterPopover"]
    QW --> FB["FilterTreeEditor"]
    QW --> CW["CustomWhereBar"]
    QW --> SF["SavedFiltersPopover"]

    VB --> VTN["ViewTableNode"]
    ER --> ETN["ErTableNode"]

    App --> HP["HistoryPanel"]
    App --> TCM["TreeContextMenu"]
    App --> OOD["ObjectOpDialog"]
    App --> EXP["ExportDialog"]
    App --> IMP["ImportWizard"]
    App --> DMP["DbDumpDialog"]
    App --> RST["RestoreDialog"]
    App --> TW["TransferWizard"]
    App --> EXT["ExtensionsDialog"]
    App --> SKM["ShortcutsModal"]
```

## Data Flow: Table Browsing with Pagination

```mermaid
sequenceDiagram
    participant User
    participant Grid as DataGrid
    participant Store as Zustand Store
    participant API as window.dbApi
    participant Main as Main Process
    participant DB as Database

    User->>Grid: Click table in tree
    Grid->>Store: openTable(ref)
    Store->>API: getTablePage(id, schema, table, pageSize, 1)
    API->>Main: ipcMain.handle
    Main->>DB: SELECT * ... ORDER BY pk OFFSET 0 FETCH 100
    DB-->>Main: rows
    Main-->>API: IpcResult<QueryResult>
    API-->>Store: update tab result
    Store-->>Grid: re-render with rows

    Store->>API: getTableRowCount(id, schema, table)
    API->>Main: ipcMain.handle
    Main->>DB: SELECT COUNT(*)
    DB-->>Main: count
    Main-->>Store: update total (async)
```

## Cross-Engine Data Transfer

```mermaid
flowchart TD
    A["1. Plan Phase"] --> B["Introspect source tables"]
    B --> C["Map column types to target engine"]
    C --> D["Generate transfer plan with warnings"]
    D --> E["2. Create Phase"]
    E --> F["CREATE TABLE on target\n(topology-ordered by FKs)"]
    F --> G["Create indexes (non-fatal on clash)"]
    G --> H["3. Copy Phase"]
    H --> I["Read source in batches of 1000"]
    I --> J["Coerce values\n(bool→0/1, Date→ISO, Buffer→hex)"]
    J --> K["transferInsert() on target driver"]
    K --> L{More batches?}
    L -->|Yes| I
    L -->|No| M["4. FK Phase"]
    M --> N["ALTER TABLE ADD FOREIGN KEY\n(both endpoints now exist)"]
```

## Build System

```mermaid
flowchart LR
    subgraph "electron-vite build"
        M["main bundle\n(src/main → out/main)"]
        P["preload bundle\n(src/preload → out/preload/index.cjs)"]
        R["renderer bundle\n(src/renderer → out/renderer)"]
    end

    subgraph "electron-builder"
        MAC["macOS: DMG + ZIP\n(signed + notarized)"]
        WIN["Windows: NSIS + Portable"]
        LIN["Linux: AppImage"]
    end

    M --> MAC
    M --> WIN
    M --> LIN
    P --> MAC
    P --> WIN
    P --> LIN
    R --> MAC
    R --> WIN
    R --> LIN
```

### Build Commands

| Command | Description |
|---|---|
| `npm run dev` | Development with hot-reload |
| `npm run build` | Production build to `out/` |
| `npm run package` | Windows installer + portable |
| `npm run package:mac` | macOS DMG (signed + notarized) |
| `npm run package:linux` | Linux AppImage |
| `npm run typecheck` | TypeScript check (both tsconfigs) |
| `npm run rebuild` | Rebuild better-sqlite3 for Electron ABI |

### Native Module Handling

`better-sqlite3` is a native C++ addon. During packaging:
- `npmRebuild: true` — electron-builder recompiles it for the target Electron ABI
- `asarUnpack: ["**/*.node", "node_modules/better-sqlite3/**"]` — native binaries are extracted outside the asar archive
- macOS: separately rebuilt for arm64 and x64; both architectures are signed and notarized
- Linux: cross-compiled from macOS using prebuild binaries

## Tech Stack

| Layer | Technology |
|---|---|
| Shell | Electron 33 + electron-vite |
| Language | TypeScript (strict) |
| UI Framework | React 18 |
| State | Zustand 5 |
| SQL Editor | CodeMirror 6 (`@codemirror/lang-sql`) |
| Data Grid | `@glideapps/glide-data-grid` (canvas, virtualized) |
| Diagrams | `@xyflow/react` + `@dagrejs/dagre` |
| Icons | `lucide-react` |
| PostgreSQL | `pg` |
| MySQL/MariaDB | `mysql2` |
| SQLite | `better-sqlite3` (native) |
| Oracle | `oracledb` (thin/thick) |
| MS SQL | `mssql` (tedious) |
| Import/Export | `papaparse` (CSV), `xlsx` (Excel), `node-sql-parser` |
| Packaging | `electron-builder` |
