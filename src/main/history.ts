// Query history store (MAIN process). Persists query metadata — NOT result
// rows — to a local SQLite file in userData, reusing better-sqlite3. Capped
// per connection to avoid unbounded growth.
import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import {
  HISTORY_CAP_PER_CONNECTION,
  type Engine,
  type HistoryEntry
} from '@shared/types'

let db: Database.Database | null = null

function conn(): Database.Database {
  if (db) return db
  const path = join(app.getPath('userData'), 'history.sqlite')
  db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS query_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id  TEXT    NOT NULL,
      connection_name TEXT   NOT NULL,
      engine         TEXT    NOT NULL,
      sql            TEXT    NOT NULL,
      ok             INTEGER NOT NULL,
      row_count      INTEGER NOT NULL DEFAULT 0,
      duration_ms    REAL    NOT NULL DEFAULT 0,
      error          TEXT,
      ts             INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_conn_ts
      ON query_history(connection_id, ts DESC);
  `)
  return db
}

export interface RecordHistoryInput {
  connectionId: string
  connectionName: string
  engine: Engine
  sql: string
  ok: boolean
  rowCount: number
  durationMs: number
  error?: string | null
  ts: number
}

export function recordHistory(input: RecordHistoryInput): void {
  const c = conn()
  c.prepare(
    `INSERT INTO query_history
       (connection_id, connection_name, engine, sql, ok, row_count, duration_ms, error, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.connectionId,
    input.connectionName,
    input.engine,
    input.sql,
    input.ok ? 1 : 0,
    input.rowCount,
    input.durationMs,
    input.error ?? null,
    input.ts
  )
  // Enforce the per-connection cap: keep the newest N ids, delete the rest.
  c.prepare(
    `DELETE FROM query_history
     WHERE connection_id = ?
       AND id NOT IN (
         SELECT id FROM query_history
         WHERE connection_id = ?
         ORDER BY id DESC
         LIMIT ?
       )`
  ).run(input.connectionId, input.connectionId, HISTORY_CAP_PER_CONNECTION)
}

export function listHistory(
  connectionId?: string,
  search?: string,
  limit = 200
): HistoryEntry[] {
  const c = conn()
  const where: string[] = []
  const params: unknown[] = []
  if (connectionId) {
    where.push('connection_id = ?')
    params.push(connectionId)
  }
  if (search && search.trim()) {
    where.push('sql LIKE ?')
    params.push(`%${search.trim()}%`)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  params.push(Math.max(1, Math.min(1000, limit)))
  const rows = c
    .prepare(
      `SELECT id, connection_id, connection_name, engine, sql, ok, row_count,
              duration_ms, error, ts
       FROM query_history
       ${whereSql}
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(...params) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as number,
    connectionId: r.connection_id as string,
    connectionName: r.connection_name as string,
    engine: r.engine as Engine,
    sql: r.sql as string,
    ok: (r.ok as number) === 1,
    rowCount: r.row_count as number,
    durationMs: r.duration_ms as number,
    error: (r.error as string | null) ?? null,
    ts: r.ts as number
  }))
}

export function clearHistory(connectionId?: string): void {
  const c = conn()
  if (connectionId) {
    c.prepare('DELETE FROM query_history WHERE connection_id = ?').run(connectionId)
  } else {
    c.prepare('DELETE FROM query_history').run()
  }
}

export function closeHistory(): void {
  if (db) {
    db.close()
    db = null
  }
}
