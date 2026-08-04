// Persistence for saved connections. Stored as JSON in Electron's userData dir
// — NEVER in the repo. Connection SECRETS (passwords) are encrypted with
// Electron `safeStorage` (OS keychain — DPAPI on Windows, Keychain on macOS,
// libsecret/kwallet on Linux; pure Electron, NO native module) and persisted as
// base64 under `passwordEnc`. The plaintext `password` is NEVER written to disk
// and NEVER sent to the renderer; it is decrypted in MAIN only when connecting.
import { app, safeStorage } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionConfig, ErLayout, PersistedTabs, SafeConnectionConfig, SavedFilter, UiState } from '@shared/types'

function storePath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'connections.json')
}

/** Whether OS-backed secure storage is available (DPAPI/Keychain/libsecret). */
export function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encryptSecret(plain: string): string {
  return safeStorage.encryptString(plain).toString('base64')
}

function decryptSecret(enc: string): string {
  return safeStorage.decryptString(Buffer.from(enc, 'base64'))
}

/**
 * The plaintext password for a stored config, decrypted in MAIN. Prefers the
 * encrypted `passwordEnc`; falls back to a legacy plaintext `password` (only
 * present pre-migration or for an unseeded built-in default).
 */
export function resolvePassword(config: ConnectionConfig | undefined): string | undefined {
  if (!config) return undefined
  if (config.passwordEnc && isSecureStorageAvailable()) {
    try {
      return decryptSecret(config.passwordEnc)
    } catch {
      return undefined
    }
  }
  return config.password || undefined
}

/** Strip every secret before the renderer sees a config; keep a "has secret" flag. */
export function stripSecret(c: ConnectionConfig): SafeConnectionConfig {
  const { password: _p, passwordEnc: _pe, clearPassword: _cp, ...rest } = c
  return { ...rest, hasStoredPassword: !!(c.passwordEnc || c.password) }
}

/**
 * Never persist a plaintext password: encrypt it to `passwordEnc` when secure
 * storage is available; when it is NOT, the secret is simply DROPPED (never
 * written in plaintext). `clearPassword` is a transient flag and never stored.
 */
function sanitizeForWrite(c: ConnectionConfig): ConnectionConfig {
  const out: ConnectionConfig = { ...c }
  delete out.clearPassword
  if (typeof out.password === 'string' && out.password.length > 0) {
    if (isSecureStorageAvailable()) out.passwordEnc = encryptSecret(out.password)
    // else: leave passwordEnc as-is (or absent) — never write the plaintext.
  }
  delete out.password
  return out
}

export function loadConnections(): ConnectionConfig[] {
  const p = storePath()
  if (!existsSync(p)) return []
  try {
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as ConnectionConfig[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Write the list, ALWAYS sanitizing so no plaintext secret ever hits disk. */
function saveAll(list: ConnectionConfig[]): void {
  writeFileSync(storePath(), JSON.stringify(list.map(sanitizeForWrite), null, 2), 'utf-8')
}

export function upsertConnection(config: ConnectionConfig): ConnectionConfig {
  const list = loadConnections()
  const idx = list.findIndex((c) => c.id === config.id)
  const existing = idx >= 0 ? list[idx] : undefined
  const out: ConnectionConfig = { ...config }
  if (out.clearPassword) {
    // Explicit "Clear password" — drop any stored secret.
    delete out.password
    delete out.passwordEnc
  } else if (typeof out.password === 'string' && out.password.length > 0) {
    // A freshly typed password — sanitizeForWrite (via saveAll) encrypts it.
  } else {
    // Blank on edit — keep the previously stored secret (encrypted, or a legacy
    // plaintext migrated to encrypted here).
    delete out.password
    out.passwordEnc =
      existing?.passwordEnc ?? (existing?.password && isSecureStorageAvailable() ? encryptSecret(existing.password) : out.passwordEnc)
  }
  delete out.clearPassword
  if (idx >= 0) list[idx] = out
  else list.push(out)
  saveAll(list)
  return sanitizeForWrite(out)
}

/**
 * MIGRATION: encrypt any legacy plaintext passwords on disk. Backs up the file
 * first, is idempotent (a no-op once nothing plaintext remains), and — when
 * secure storage is unavailable — leaves the plaintext file UNTOUCHED and warns.
 * Returns the count migrated (never the secrets) and the backup path.
 */
export function migratePlaintextPasswords(): { migrated: number; backedUp: string | null; secureAvailable: boolean } {
  const p = storePath()
  const secureAvailable = isSecureStorageAvailable()
  if (!existsSync(p)) return { migrated: 0, backedUp: null, secureAvailable }
  let list: ConnectionConfig[]
  try {
    list = JSON.parse(readFileSync(p, 'utf-8')) as ConnectionConfig[]
    if (!Array.isArray(list)) return { migrated: 0, backedUp: null, secureAvailable }
  } catch {
    return { migrated: 0, backedUp: null, secureAvailable }
  }
  const plainCount = list.filter((c) => typeof c.password === 'string' && c.password.length > 0).length
  if (plainCount === 0) return { migrated: 0, backedUp: null, secureAvailable } // idempotent no-op
  if (!secureAvailable) return { migrated: 0, backedUp: null, secureAvailable } // do NOT destroy plaintext; warn
  const bak = `${p}.bak-${Date.now()}`
  copyFileSync(p, bak) // back up BEFORE rewriting
  saveAll(list) // sanitizeForWrite encrypts the plaintext and drops it
  return { migrated: plainCount, backedUp: bak, secureAvailable }
}

export function deleteConnection(id: string): void {
  const list = loadConnections().filter((c) => c.id !== id)
  saveAll(list)
}

/**
 * Persist any pre-seeded default that isn't already saved, so every connection
 * in the manager is a first-class saved entry with the same actions (edit,
 * delete). Existing/edited entries are left untouched. A default the user
 * deletes will re-appear on next launch (built-ins stay "intact").
 */
export function seedMissingDefaults(defaults: ConnectionConfig[]): void {
  const list = loadConnections()
  const ids = new Set(list.map((c) => c.id))
  let changed = false
  for (const d of defaults) {
    if (!ids.has(d.id)) {
      list.push(d)
      changed = true
    }
  }
  if (changed) saveAll(list)
}

export function getConnection(id: string): ConnectionConfig | undefined {
  return loadConnections().find((c) => c.id === id)
}

// --- Editor tab persistence (SQL text + metadata only; never result rows) -----

function tabsPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'tabs.json')
}

export function loadTabs(): PersistedTabs {
  const p = tabsPath()
  if (!existsSync(p)) return { tabs: [], activeTabId: null }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as PersistedTabs
    if (!parsed || !Array.isArray(parsed.tabs)) return { tabs: [], activeTabId: null }
    return parsed
  } catch {
    return { tabs: [], activeTabId: null }
  }
}

export function saveTabs(data: PersistedTabs): void {
  writeFileSync(tabsPath(), JSON.stringify(data, null, 2), 'utf-8')
}

// --- UI/layout preferences (sidebar collapsed, …) -----------------------------

function uiPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'ui.json')
}

export function loadUiState(): UiState {
  const p = uiPath()
  const dflt: UiState = { sidebarCollapsed: false, filterSqlCollapsed: false }
  if (!existsSync(p)) return dflt
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<UiState>
    return {
      sidebarCollapsed: !!parsed?.sidebarCollapsed,
      filterSqlCollapsed: !!parsed?.filterSqlCollapsed,
      theme: parsed?.theme === 'light' ? 'light' : 'dark'
    }
  } catch {
    return dflt
  }
}

export function saveUiState(state: UiState): void {
  writeFileSync(uiPath(), JSON.stringify(state, null, 2), 'utf-8')
}

// --- Saved filters (TASK 70) --------------------------------------------------
// Stored in userData/saved-filters.json, namespaced by a table key
// (engine::schema::table) and version-tagged so the format can evolve safely.

interface SavedFiltersFile {
  version: 1
  byKey: Record<string, SavedFilter[]>
}

function savedFiltersPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'saved-filters.json')
}

function loadSavedFiltersFile(): SavedFiltersFile {
  const p = savedFiltersPath()
  if (!existsSync(p)) return { version: 1, byKey: {} }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<SavedFiltersFile>
    return { version: 1, byKey: parsed?.byKey && typeof parsed.byKey === 'object' ? parsed.byKey : {} }
  } catch {
    return { version: 1, byKey: {} }
  }
}

function writeSavedFiltersFile(file: SavedFiltersFile): void {
  writeFileSync(savedFiltersPath(), JSON.stringify(file, null, 2), 'utf-8')
}

export function listSavedFilters(key: string): SavedFilter[] {
  return loadSavedFiltersFile().byKey[key] ?? []
}

/** Upsert a saved filter by id (create or update in place); returns the list. */
export function saveSavedFilter(key: string, filter: SavedFilter): SavedFilter[] {
  const file = loadSavedFiltersFile()
  const list = file.byKey[key] ?? []
  const idx = list.findIndex((f) => f.id === filter.id)
  if (idx >= 0) list[idx] = filter
  else list.push(filter)
  file.byKey[key] = list
  writeSavedFiltersFile(file)
  return list
}

export function deleteSavedFilter(key: string, id: string): SavedFilter[] {
  const file = loadSavedFiltersFile()
  const list = (file.byKey[key] ?? []).filter((f) => f.id !== id)
  if (list.length > 0) file.byKey[key] = list
  else delete file.byKey[key]
  writeSavedFiltersFile(file)
  return list
}

// --- ER diagram layouts (per connection+schema node positions) ----------------

function erLayoutPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'er-layouts.json')
}

/** All persisted layouts, keyed by `${connectionId}::${schema}`. */
function loadErLayouts(): Record<string, ErLayout> {
  const p = erLayoutPath()
  if (!existsSync(p)) return {}
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, ErLayout>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function erKey(connectionId: string, schema: string): string {
  return `${connectionId}::${schema}`
}

export function loadErLayout(connectionId: string, schema: string): ErLayout | null {
  return loadErLayouts()[erKey(connectionId, schema)] ?? null
}

export function saveErLayout(connectionId: string, schema: string, layout: ErLayout): void {
  const all = loadErLayouts()
  all[erKey(connectionId, schema)] = layout
  writeFileSync(erLayoutPath(), JSON.stringify(all, null, 2), 'utf-8')
}
