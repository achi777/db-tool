// Data import (CSV / JSON / Excel) — runs in MAIN. Files are parsed here, values
// coerced against the target table's catalog types, and inserted via the
// driver's PARAMETERIZED batch path (applyRowChanges) — never string-concatenated,
// so O'Brien / %-signs / injection payloads land as literals. Two modes: 'abort'
// (one transaction, rollback on first error) and 'skip' (collect per-row errors).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import Papa from 'papaparse'
import { coerceForWrite, type DbDriver } from './driver'
import type { ImportParseOptions, ImportPreview, ImportRequest, ImportResult } from '@shared/types'

// SheetJS is CommonJS — load via createRequire so it resolves in the ESM main bundle.
const XLSX = createRequire(import.meta.url)('xlsx') as typeof import('xlsx')

interface Parsed {
  columns: string[]
  rows: unknown[][]
  sheets?: string[]
  delimiter?: string
}

/** Parse the whole file into source columns + rows (arrays aligned to columns). */
function parseFile(filePath: string, parse: ImportParseOptions): Parsed {
  if (parse.format === 'csv') {
    const text = readFileSync(filePath, 'utf-8').replace(/^﻿/, '')
    const hasHeader = parse.hasHeader !== false
    const res = Papa.parse<string[]>(text, {
      delimiter: parse.delimiter || '',
      skipEmptyLines: 'greedy',
      header: false
    })
    const data = (res.data as string[][]).filter((r) => r.length > 0)
    const delimiter = res.meta.delimiter
    if (data.length === 0) return { columns: [], rows: [], delimiter }
    if (hasHeader) {
      const columns = data[0].map((c, i) => (c && c.trim() ? c : `col${i + 1}`))
      return { columns, rows: data.slice(1), delimiter }
    }
    const columns = data[0].map((_, i) => `col${i + 1}`)
    return { columns, rows: data, delimiter }
  }

  if (parse.format === 'json') {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    const arr: unknown[] = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown[] })?.data) ? (raw as { data: unknown[] }).data : []
    const colSet: string[] = []
    for (const item of arr) {
      if (item && typeof item === 'object') for (const k of Object.keys(item)) if (!colSet.includes(k)) colSet.push(k)
    }
    const rows = arr.map((item) =>
      colSet.map((k) => {
        const v = (item as Record<string, unknown>)?.[k]
        return v === undefined ? null : v
      })
    )
    return { columns: colSet, rows }
  }

  // xlsx
  const wb = XLSX.readFile(filePath, { cellDates: true })
  const sheets = wb.SheetNames
  const sheetName = parse.sheet && sheets.includes(parse.sheet) ? parse.sheet : sheets[0]
  const ws = wb.Sheets[sheetName]
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: false })
  if (aoa.length === 0) return { columns: [], rows: [], sheets }
  const header = (aoa[0] as unknown[]).map((c, i) => (c != null && String(c).trim() ? String(c) : `col${i + 1}`))
  return { columns: header, rows: aoa.slice(1) as unknown[][], sheets }
}

/** Parse a file for preview: columns + first `limit` rows + sheet list. */
export function previewImport(filePath: string, parse: ImportParseOptions, limit = 50): ImportPreview {
  try {
    const p = parseFile(filePath, parse)
    return {
      ok: true,
      columns: p.columns,
      rows: p.rows.slice(0, limit),
      totalRows: p.rows.length,
      sheets: p.sheets,
      delimiter: p.delimiter
    }
  } catch (err) {
    return { ok: false, columns: [], rows: [], totalRows: 0, error: (err as Error).message }
  }
}

/** Coerce a source value for a target column type (empty→NULL etc.). */
function coerce(value: unknown, sqlType: string | undefined): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return coerceForWrite(value, sqlType)
  return value
}

/** Execute an import: map + coerce + parameterized batched inserts. */
export async function runImport(driver: DbDriver, spec: { columnTypes: Record<string, string>; primaryKey: string[] }, req: ImportRequest): Promise<ImportResult> {
  let parsed: Parsed
  try {
    parsed = parseFile(req.filePath, req.parse)
  } catch (err) {
    return { ok: false, inserted: 0, skipped: 0, errors: [], error: (err as Error).message }
  }

  // Source column index -> target column name (skip ignored/unmapped).
  const targets: { srcIdx: number; target: string }[] = []
  parsed.columns.forEach((src, i) => {
    const t = req.mapping[src]
    if (t && t.trim()) targets.push({ srcIdx: i, target: t })
  })
  if (targets.length === 0) {
    return { ok: false, inserted: 0, skipped: 0, errors: [], error: 'No columns mapped to the target table.' }
  }

  // Build coerced insert rows (col -> value).
  const inserts: Record<string, unknown>[] = parsed.rows.map((row) => {
    const obj: Record<string, unknown> = {}
    for (const { srcIdx, target } of targets) obj[target] = coerce(row[srcIdx], spec.columnTypes[target])
    return obj
  })

  const mkReq = (batch: Record<string, unknown>[]): Parameters<DbDriver['applyRowChanges']>[0] => ({
    connectionId: req.connectionId,
    schema: req.schema,
    table: req.table,
    primaryKey: spec.primaryKey,
    columnTypes: spec.columnTypes,
    inserts: batch,
    updates: [],
    deletes: []
  })

  const errors: { row: number; message: string }[] = []

  if (req.mode === 'abort') {
    const res = await driver.applyRowChanges(mkReq(inserts))
    if (!res.ok) {
      const idx = res.failure?.index ?? 0
      return {
        ok: false,
        inserted: 0,
        skipped: inserts.length,
        errors: [{ row: idx + 1, message: res.failure?.message ?? 'insert failed (rolled back)' }],
        error: 'Aborted — transaction rolled back.'
      }
    }
    return { ok: true, inserted: res.inserted, skipped: 0, errors: [] }
  }

  // skip mode: batch, and isolate failing rows row-by-row within a bad batch.
  const batchSize = Math.max(1, Math.min(5000, req.batchSize ?? 500))
  let inserted = 0
  for (let start = 0; start < inserts.length; start += batchSize) {
    const batch = inserts.slice(start, start + batchSize)
    const res = await driver.applyRowChanges(mkReq(batch))
    if (res.ok) {
      inserted += res.inserted
      continue
    }
    // Retry one at a time to skip only the offending rows.
    for (let j = 0; j < batch.length; j++) {
      const r1 = await driver.applyRowChanges(mkReq([batch[j]]))
      if (r1.ok) inserted += r1.inserted
      else errors.push({ row: start + j + 1, message: r1.failure?.message ?? 'insert failed' })
    }
  }
  return { ok: true, inserted, skipped: errors.length, errors }
}
