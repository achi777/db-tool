import type { SqlDialect } from './types'

// Split a SQL script into individual statements on top-level semicolons, while
// respecting quoted strings ('...', "...", `...`), PostgreSQL dollar-quotes
// ($$…$$ / $tag$…$tag$), and comments (-- line, /* block */).
//
// When `dialect === 'mssql'` it is additionally GO-aware: a line that is just
// `GO` (case-insensitive, optionally followed by a repeat count) is SQL Server's
// client-side BATCH separator (not T-SQL) and flushes the current batch, and a
// CREATE PROCEDURE/FUNCTION/TRIGGER body is kept as ONE batch (its many ';' are
// NOT split — T-SQL routine bodies rely on GO, not ';'). Other dialects keep the
// plain ';'-split behavior (their routine bodies are $$-quoted / single-statement
// / DELIMITER-guarded, so applying GO/proc rules there would wrongly merge them).
export function splitSqlStatements(sql: string, dialect?: SqlDialect): string[] {
  const mssql = dialect === 'mssql'
  const statements: string[] = []
  let cur = ''
  let i = 0
  const n = sql.length
  let atLineStart = true // true when i is at the first non-space char of a line

  const flush = (): void => {
    const trimmed = cur.trim()
    if (trimmed) statements.push(trimmed)
    cur = ''
  }

  while (i < n) {
    const ch = sql[i]

    // GO batch separator (SQL Server only) — recognized at the start of a line.
    if (mssql && atLineStart && (ch === 'g' || ch === 'G')) {
      const m = /^GO(?:[ \t]+\d+)?[ \t]*(?:--[^\n]*)?(?:\r?\n|$)/i.exec(sql.slice(i))
      if (m) {
        flush()
        i += m[0].length
        atLineStart = true
        continue
      }
    }
    if (ch !== ' ' && ch !== '\t') atLineStart = ch === '\n' || ch === '\r'

    // line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      cur += sql.slice(i, end)
      i = end
      continue
    }
    // block comment
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      cur += sql.slice(i, end)
      i = end
      continue
    }
    // single / double quote / backtick string
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      let j = i + 1
      cur += ch
      while (j < n) {
        if (sql[j] === q) {
          // doubled quote = escaped quote (stays inside the string)
          if (sql[j + 1] === q) {
            cur += q + q
            j += 2
            continue
          }
          cur += q
          j++
          break
        }
        if (sql[j] === '\\' && q !== '`') {
          // backslash escape (MySQL/PG non-standard) — keep next char literal
          cur += sql[j] + (sql[j + 1] ?? '')
          j += 2
          continue
        }
        cur += sql[j]
        j++
      }
      i = j
      continue
    }
    // dollar-quoted string ($$ or $tag$)
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const close = sql.indexOf(tag, i + tag.length)
        const end = close === -1 ? n : close + tag.length
        cur += sql.slice(i, end)
        i = end
        continue
      }
    }
    // statement terminator. On SQL Server a CREATE PROC/FUNCTION/TRIGGER body is
    // full of ';' and must stay ONE batch, flushed only by GO/EOF.
    const inMssqlProcBody = mssql && /^\s*CREATE\s+(?:OR\s+(?:ALTER|REPLACE)\s+)?(?:PROC|PROCEDURE|FUNCTION|TRIGGER)\b/i.test(cur)
    if (ch === ';' && !inMssqlProcBody) {
      flush()
      i++
      continue
    }
    cur += ch
    i++
  }
  flush()
  return statements
}
