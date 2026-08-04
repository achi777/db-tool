// Guard for the "Custom WHERE" filter mode. The user types a raw predicate that
// we splice into the WHERE position of a READ-ONLY browse SELECT/COUNT:
//     SELECT ... FROM <table> WHERE (<userText>) ORDER BY <pk> LIMIT .. OFFSET ..
// Because it can't be parameterized, we contain the risk with a light lexer that
// ignores quoted content and refuses statement terminators, comments, and
// obvious DDL/DML keywords at the top level. This is DEFENSE-IN-DEPTH for a local
// dev tool — NOT a claim of perfect SQL sandboxing (the user already has full DB
// access via the SQL editor). The main protection is that browsing only ever
// runs a single read-only SELECT and never feeds this text to INSERT/UPDATE/
// DELETE paths; blocking ';'/multi-statement is the belt, keyword-blocking the
// suspenders.

export type RawWhereResult = { ok: true; where: string } | { ok: false; reason: string }

// Statement keywords that must never appear at the top level of a predicate.
const BLOCKED = new Set([
  'insert',
  'update',
  'delete',
  'drop',
  'alter',
  'truncate',
  'grant',
  'revoke',
  'create',
  'merge',
  'replace',
  'attach',
  'detach',
  'pragma',
  'vacuum',
  'call',
  'exec',
  'execute',
  'copy',
  'into',
  'commit',
  'rollback'
])

/**
 * Validate + normalize a raw WHERE predicate. Strips a leading `WHERE`, then
 * scans outside quotes (`'`, `"`, backtick — each with doubled-quote escaping)
 * for `;`, `--`/`/*` comments, and blocked DDL/DML keywords. Returns the bare
 * predicate to wrap in `(...)`, or a clear reason to refuse.
 */
export function guardRawWhere(input: string): RawWhereResult {
  let text = (input ?? '').trim()
  if (!text) return { ok: false, reason: 'Enter a WHERE condition.' }
  text = text.replace(/^\s*where\s+/i, '').trim()
  if (!text) return { ok: false, reason: 'Enter a WHERE condition.' }

  const n = text.length
  let word = ''
  const wordBad = (): string | null => {
    const w = word
    word = ''
    return w && BLOCKED.has(w.toLowerCase()) ? w : null
  }

  for (let i = 0; i < n; i++) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const bad = wordBad()
      if (bad) return refuse(bad)
      // consume the quoted run, honoring doubled-quote escapes
      const quote = ch
      i++
      while (i < n) {
        if (text[i] === quote) {
          if (text[i + 1] === quote) {
            i++
          } else {
            break
          }
        }
        i++
      }
      continue
    }
    if (ch === ';') return { ok: false, reason: 'Semicolons (multiple statements) are not allowed here.' }
    if (ch === '-' && text[i + 1] === '-') return { ok: false, reason: 'SQL line comments (--) are not allowed here.' }
    if (ch === '/' && text[i + 1] === '*') return { ok: false, reason: 'Block comments (/* */) are not allowed here.' }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      word += ch
    } else {
      const bad = wordBad()
      if (bad) return refuse(bad)
    }
  }
  const tail = wordBad()
  if (tail) return refuse(tail)

  return { ok: true, where: text }
}

function refuse(keyword: string): RawWhereResult {
  return { ok: false, reason: `“${keyword}” is not allowed in a filter — this box only filters the current table view.` }
}
