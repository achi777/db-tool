// Preload script. Exposes a SMALL, WHITELISTED, typed API on window.dbApi via
// contextBridge. The renderer never sees ipcRenderer or any Node primitive —
// it can only call these named methods.
import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type ConnectionConfig,
  type DbApi,
  type DdlRequest,
  type ErLayout,
  type DumpRequest,
  type ExecSqlRequest,
  type ExportRequest,
  type ImportParseOptions,
  type ImportRequest,
  type IoProgress,
  type ObjectOpRequest,
  type PersistedTabs,
  type RowChangeRequest,
  type TransferPlanRequest,
  type TransferRequest,
  type UpdateCellRequest
} from '@shared/types'

const api: DbApi = {
  listConnections: () => ipcRenderer.invoke(IPC.listConnections),
  saveConnection: (config: ConnectionConfig) => ipcRenderer.invoke(IPC.saveConnection, config),
  secureStorageAvailable: () => ipcRenderer.invoke(IPC.secureStorageAvailable),
  listSavedFilters: (key: string) => ipcRenderer.invoke(IPC.listSavedFilters, key),
  saveSavedFilter: (key: string, filter: import('@shared/types').SavedFilter) => ipcRenderer.invoke(IPC.saveSavedFilter, key, filter),
  deleteSavedFilter: (key: string, id: string) => ipcRenderer.invoke(IPC.deleteSavedFilter, key, id),
  deleteConnection: (id: string) => ipcRenderer.invoke(IPC.deleteConnection, id),
  getDefaults: () => ipcRenderer.invoke(IPC.getDefaults),

  testConnection: (config: ConnectionConfig) => ipcRenderer.invoke(IPC.testConnection, config),
  connect: (id: string) => ipcRenderer.invoke(IPC.connect, id),
  disconnect: (id: string) => ipcRenderer.invoke(IPC.disconnect, id),
  listSchemas: (id: string) => ipcRenderer.invoke(IPC.listSchemas, id),
  listTables: (id: string, schema: string) => ipcRenderer.invoke(IPC.listTables, id, schema),
  getTableStructure: (id: string, schema: string, table: string) =>
    ipcRenderer.invoke(IPC.getTableStructure, id, schema, table),
  runQuery: (id: string, sql: string, params?: unknown[]) => ipcRenderer.invoke(IPC.runQuery, id, sql, params),
  getTableRows: (id: string, schema: string, table: string, limit?: number) =>
    ipcRenderer.invoke(IPC.getTableRows, id, schema, table, limit),
  getTablePage: (id, schema, table, pageSize, page, sort, filters, tree, customWhere) =>
    ipcRenderer.invoke(IPC.getTablePage, id, schema, table, pageSize, page, sort, filters, tree, customWhere),
  getTableRowCount: (id, schema, table, filters, tree, customWhere) =>
    ipcRenderer.invoke(IPC.getTableRowCount, id, schema, table, filters, tree, customWhere),
  updateCell: (req: UpdateCellRequest) => ipcRenderer.invoke(IPC.updateCell, req),

  getSchemaCatalog: (id: string, force?: boolean) =>
    ipcRenderer.invoke(IPC.getSchemaCatalog, id, force),
  listHistory: (connectionId?: string, search?: string, limit?: number) =>
    ipcRenderer.invoke(IPC.listHistory, connectionId, search, limit),
  clearHistory: (connectionId?: string) => ipcRenderer.invoke(IPC.clearHistory, connectionId),
  loadTabs: () => ipcRenderer.invoke(IPC.loadTabs),
  saveTabs: (tabs: PersistedTabs) => ipcRenderer.invoke(IPC.saveTabs, tabs),
  loadUiState: () => ipcRenderer.invoke(IPC.loadUiState),
  saveUiState: (state: import('@shared/types').UiState) => ipcRenderer.invoke(IPC.saveUiState, state),

  getTableSpec: (id: string, schema: string, table: string) =>
    ipcRenderer.invoke(IPC.getTableSpec, id, schema, table),
  previewDdl: (req: DdlRequest) => ipcRenderer.invoke(IPC.previewDdl, req),
  applyDdl: (req: DdlRequest) => ipcRenderer.invoke(IPC.applyDdl, req),
  previewObjectOp: (req: ObjectOpRequest) => ipcRenderer.invoke(IPC.previewObjectOp, req),
  applyObjectOp: (req: ObjectOpRequest) => ipcRenderer.invoke(IPC.applyObjectOp, req),
  applyRowChanges: (req: RowChangeRequest) => ipcRenderer.invoke(IPC.applyRowChanges, req),

  listViews: (id: string, schema: string) => ipcRenderer.invoke(IPC.listViews, id, schema),
  listRoutines: (id: string, schema: string) => ipcRenderer.invoke(IPC.listRoutines, id, schema),
  listPackages: (id: string, schema: string) => ipcRenderer.invoke(IPC.listPackages, id, schema),
  getObjectDefinition: (req) => ipcRenderer.invoke(IPC.getObjectDefinition, req),
  parseViewToModel: (engine, sql: string) => ipcRenderer.invoke(IPC.parseViewToModel, engine, sql),
  applyObjectSql: (id: string, statements: string[]) => ipcRenderer.invoke(IPC.applyObjectSql, id, statements),

  listSequences: (id: string, schema: string) => ipcRenderer.invoke(IPC.listSequences, id, schema),
  getSequenceDetails: (id: string, schema: string, name: string) =>
    ipcRenderer.invoke(IPC.getSequenceDetails, id, schema, name),

  listTriggers: (id: string, schema: string, table: string) =>
    ipcRenderer.invoke(IPC.listTriggers, id, schema, table),
  getTriggerDetails: (id: string, schema: string, table: string, name: string) =>
    ipcRenderer.invoke(IPC.getTriggerDetails, id, schema, table, name),
  listIndexes: (id: string, schema: string, table: string) =>
    ipcRenderer.invoke(IPC.listIndexes, id, schema, table),
  listMatViews: (id: string, schema: string) => ipcRenderer.invoke(IPC.listMatViews, id, schema),
  listTypes: (id: string, schema: string) => ipcRenderer.invoke(IPC.listTypes, id, schema),
  listExtensions: (id: string) => ipcRenderer.invoke(IPC.listExtensions, id),

  exportData: (req: ExportRequest) => ipcRenderer.invoke(IPC.exportData, req),
  importPickFile: () => ipcRenderer.invoke(IPC.importPickFile),
  importPreview: (filePath: string, parse: ImportParseOptions, limit?: number) =>
    ipcRenderer.invoke(IPC.importPreview, filePath, parse, limit),
  importExecute: (req: ImportRequest) => ipcRenderer.invoke(IPC.importExecute, req),
  transferPlan: (req: TransferPlanRequest) => ipcRenderer.invoke(IPC.transferPlan, req),
  transferRun: (req: TransferRequest) => ipcRenderer.invoke(IPC.transferRun, req),
  onIoProgress: (cb: (p: IoProgress) => void) => {
    const listener = (_e: unknown, p: IoProgress): void => cb(p)
    ipcRenderer.on(IPC.ioProgress, listener)
    return () => ipcRenderer.removeListener(IPC.ioProgress, listener)
  },

  dumpDatabase: (req: DumpRequest) => ipcRenderer.invoke(IPC.dumpDatabase, req),
  pickSqlFile: () => ipcRenderer.invoke(IPC.pickSqlFile),
  previewSqlFile: (filePath: string) => ipcRenderer.invoke(IPC.previewSqlFile, filePath),
  executeSqlFile: (req: ExecSqlRequest) => ipcRenderer.invoke(IPC.executeSqlFile, req),

  getErModel: (id: string, schema: string) => ipcRenderer.invoke(IPC.getErModel, id, schema),
  loadErLayout: (id: string, schema: string) => ipcRenderer.invoke(IPC.loadErLayout, id, schema),
  saveErLayout: (id: string, schema: string, layout: ErLayout) =>
    ipcRenderer.invoke(IPC.saveErLayout, id, schema, layout),
  saveDiagramImage: (dataUrl: string, suggestedName: string) =>
    ipcRenderer.invoke(IPC.saveDiagramImage, dataUrl, suggestedName),

  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),

  onMenuAction: (cb: (action: import('@shared/types').MenuAction) => void) => {
    const listener = (_e: unknown, action: import('@shared/types').MenuAction): void => cb(action)
    ipcRenderer.on(IPC.menuAction, listener)
    return () => ipcRenderer.removeListener(IPC.menuAction, listener)
  },
  notifyThemeChanged: (theme: import('@shared/types').ThemeMode) => ipcRenderer.send(IPC.menuThemeChanged, theme)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('dbApi', api)
} else {
  // Fallback for the (non-default) case where contextIsolation is off.
  // @ts-expect-error assign to window in non-isolated context
  window.dbApi = api
}
