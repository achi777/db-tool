# DB Tool — Developer Guide

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **Git**
- **macOS**: Xcode Command Line Tools (`xcode-select --install`) — required for `better-sqlite3` native compilation
- **Windows**: Visual Studio Build Tools with C++ workload (for `better-sqlite3`), or use prebuilt binaries
- **Linux**: `build-essential`, `python3` (for node-gyp)

## Quick Start

```bash
git clone https://github.com/achi777/sqlTools.git
cd sqlTools/db-tool
npm install
npm run dev
```

This starts electron-vite in dev mode with hot-reload. The app window opens automatically.

## Project Structure

```
db-tool/
├── src/
│   ├── main/           # Electron main process (Node.js)
│   ├── preload/        # Context bridge (window.dbApi)
│   ├── renderer/       # React UI (sandboxed browser)
│   └── shared/         # Types & utils (imported by both sides)
├── build/              # Icons, macOS entitlements
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json       # Base config
├── tsconfig.node.json  # Main + preload
└── tsconfig.web.json   # Renderer
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed module descriptions and diagrams.

## Development Workflow

### Running in Dev Mode

```bash
npm run dev
```

- electron-vite builds `main` and `preload` bundles, starts a Vite dev server for the renderer (HMR), and launches the Electron window
- Changes to renderer files hot-reload instantly
- Changes to main/preload require a restart (electron-vite watches and rebuilds automatically)

### Type Checking

```bash
npm run typecheck          # Both main + renderer
npm run typecheck:node     # Main + preload only
npm run typecheck:web      # Renderer only
```

### Building for Production

```bash
npm run build              # Production bundles → out/
```

## Adding a New Database Engine

1. **Create a driver** in `src/main/drivers/yourengine.ts` implementing the `DbDriver` interface from `src/main/driver.ts`

2. **Register the factory** in `src/main/driver.ts`:
   ```typescript
   case 'yourengine': {
     const { YourDriver } = await import('./drivers/yourengine')
     return new YourDriver(config)
   }
   ```

3. **Add the engine type** to `src/shared/types.ts`:
   ```typescript
   export type Engine = 'postgres' | 'mysql' | ... | 'yourengine'
   ```

4. **Add SQL dialect mapping** in `src/shared/types.ts`:
   ```typescript
   export function sqlDialect(engine: Engine): SqlDialect { ... }
   ```

5. **Add type catalog entries** in `src/shared/typeCatalog.ts` for the column type picker

6. **Update the connection form** in `src/renderer/src/components/ConnectionManager.tsx`

7. **Add identifier quoting** in `src/shared/filterCompiler.ts` if the engine uses a non-standard quote character

### Driver Interface (Key Methods)

Every driver must implement these core methods:

```typescript
interface DbDriver {
  connect(): Promise<void>
  disconnect(): Promise<void>
  testConnection(): Promise<TestConnectionResult>
  listSchemas(): Promise<string[]>
  listTables(schema: string): Promise<TableRef[]>
  getTableStructure(schema: string, table: string): Promise<ColumnDef[]>
  runQuery(sql: string, params?: unknown[]): Promise<QueryResult>
  getTablePage(schema, table, pageSize, page, sort?, filters?, tree?, customWhere?): Promise<QueryResult>
  getTableRowCount(schema, table, filters?, tree?, customWhere?): Promise<number>
  applyRowChanges(req: RowChangeRequest): Promise<RowChangeResult>
  getTableSpec(schema: string, table: string): Promise<TableSpec>
  execStatements(statements: string[]): Promise<DdlApplyResult>
  transferInsert(schema, table, columns, rows, columnTypes, identityCols): Promise<number>
  getSchemaCatalog(): Promise<SchemaCatalog>
}
```

### Important Rules for Drivers

- **All values must be parameterized** — never concatenate user values into SQL strings
- **Normalize return values** — `Date` → ISO string, `Buffer` → hex string, objects → JSON
- Use `coerceForWrite()` from `driver.ts` to convert grid values (empty string → NULL for non-text columns)
- Use `orderByClause()` from `driver.ts` for deterministic pagination order
- Each driver handles its own identifier quoting (double-quotes, backticks, or brackets)

## Adding a New UI Component

1. Create the component in `src/renderer/src/components/`
2. Add any needed state to the Zustand store in `src/renderer/src/store.ts`
3. Wire it into `App.tsx` (either as a tab kind or an overlay)
4. If it needs IPC, add the channel to `src/shared/types.ts` (`IPC` object + `DbApi` interface), implement the handler in `src/main/ipc.ts`, and add the bridge in `src/preload/index.ts`

### State Management Pattern

The renderer uses a single Zustand store. Actions are defined as methods on the store:

```typescript
// In store.ts
const useStore = create<AppState>((set, get) => ({
  // State
  tabs: [],
  activeTabId: null,

  // Actions
  addTab: () => { ... },
  closeTab: (id) => { ... },
  runActiveTab: async () => {
    const tab = get().getActiveTab()
    const result = await window.dbApi.runQuery(tab.connectionId, tab.sql)
    set({ ... })
  }
}))
```

Components consume state with selectors:

```typescript
function MyComponent() {
  const tabs = useStore((s) => s.tabs)
  const addTab = useStore((s) => s.addTab)
  return <button onClick={addTab}>+</button>
}
```

## Adding a New IPC Channel

When you need new main↔renderer communication:

### 1. Define types in `src/shared/types.ts`

```typescript
// Add to the IPC constant object
export const IPC = {
  ...existing,
  myNewChannel: 'db:myNewChannel'
} as const

// Add to the DbApi interface
export interface DbApi {
  ...existing
  myNewMethod(arg: string): Promise<IpcResult<MyResult>>
}
```

### 2. Implement the handler in `src/main/ipc.ts`

```typescript
ipcMain.handle(IPC.myNewChannel, async (_e, arg: string) => {
  try {
    const driver = requireDriver(arg)
    const result = await driver.someMethod()
    return ok(result)
  } catch (err) {
    return fail(err)
  }
})
```

### 3. Add the bridge in `src/preload/index.ts`

```typescript
myNewMethod: (arg: string) => ipcRenderer.invoke(IPC.myNewChannel, arg)
```

## Shared Modules

Files in `src/shared/` are imported by both main and renderer. They must:

- **Never** import Node.js built-ins (`fs`, `path`, `child_process`, etc.)
- **Never** import database drivers
- Only contain types, pure functions, and constants

| Module | Purpose |
|---|---|
| `types.ts` | All interfaces, IPC channels, DbApi |
| `filterCompiler.ts` | Compile quick filters + tree → WHERE clause |
| `typeCatalog.ts` | Column type definitions per engine |
| `sqlSplit.ts` | Split SQL scripts on statement boundaries |
| `viewBuilder.ts` | Generate SELECT from visual model |
| `sequenceDdl.ts` | Sequence CREATE/ALTER/DROP DDL |
| `triggerDdl.ts` | Trigger DDL + definition parsers |
| `indexDdl.ts` | Index CREATE/DROP DDL |
| `rawWhere.ts` | Validate custom WHERE predicates |

## Packaging

### macOS (Signed + Notarized)

Requires an Apple Developer Program membership ($99/year) and a Developer ID Application certificate.

```bash
export APPLE_ID="your@email.com"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
npm run package:mac
```

After building, staple the notarization ticket to the DMGs:

```bash
xcrun notarytool submit release/DBTool-*.dmg --keychain-profile "profile-name" --wait
xcrun stapler staple release/DBTool-*.dmg
```

### Windows

```bash
npm run package
```

Produces `DBTool-Setup-<version>.exe` (NSIS installer) and `DBTool-<version>-portable.exe`.

### Linux

```bash
npm run package:linux
```

Produces `DBTool-<version>-x86_64-linux.AppImage`.

## Native Module Notes

`better-sqlite3` is a native C++ addon that must match the Electron ABI version.

- **After updating Electron**: run `npm run rebuild` to recompile
- **macOS**: Xcode CLT provides the compiler; `npmRebuild: true` in electron-builder handles it automatically during packaging
- **Windows without C++ toolchain**: set `npmRebuild: false` in electron-builder.yml and use prebuilt binaries
- **Cross-compilation**: macOS → Linux works via prebuild binaries; macOS → Windows requires Wine or a Windows CI

## Testing

### Smoke Test

A headless end-to-end test runs inside the Electron main process:

```bash
export SMOKE=1
export SMOKE_SQLITE_SQL_DIR="/path/to/db-infra/db/sqlite"
export SMOKE_SQLITE_PATH="/tmp/smoke-test.sqlite"
npx electron .
```

The smoke test exercises all six engines through the `DbDriver` interface: connect → list schemas → list tables → get structure → count → fetch rows → edit a cell → restore.

### Manual Testing Checklist

- [ ] Connect to each engine (PG, MySQL, MariaDB, SQLite, Oracle, MSSQL)
- [ ] Browse tables with pagination
- [ ] Edit cells (INSERT, UPDATE, DELETE) and Apply
- [ ] Run SQL in the editor
- [ ] Quick filters and filter builder
- [ ] Table designer (CREATE + ALTER)
- [ ] View builder (visual drag-and-drop)
- [ ] ER diagram generation and export
- [ ] Import/Export (CSV, JSON, XLSX, SQL)
- [ ] Cross-engine data transfer
- [ ] Dark/light theme toggle
- [ ] Keyboard shortcuts (F1 for reference)

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + Enter` | Run query |
| `F5` | Refresh page / Run query |
| `Ctrl/Cmd + T` | New tab |
| `Ctrl/Cmd + W` | Close tab |
| `Ctrl/Cmd + S` | Apply pending changes |
| `Ctrl/Cmd + R` | Refresh schema tree |
| `Ctrl/Cmd + B` | Toggle sidebar |
| `Escape` | Close topmost overlay |
| `F1` | Keyboard shortcuts reference |

## Code Style

- TypeScript strict mode everywhere
- No `any` — use `unknown` and narrow
- Prefer `async/await` over raw promises
- All IPC handlers wrap results in `ok(data)` / `fail(err)` — never throw across the bridge
- SQL identifiers are always quoted per engine (`qid()` function in each driver)
- All user values are bound as parameters, never interpolated

## SPDX Header

Add this to the top of every source file:

```typescript
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Archil Odishelidze / CodeMake
```

## License

DBTool is dual-licensed under [AGPL-3.0](LICENSE) and a commercial license. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) for details.
