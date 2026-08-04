// Builds a schema-aware CodeMirror 6 SQL extension from a fetched catalog.
// The catalog is produced in MAIN (per driver) and passed here via IPC — the
// renderer never queries the database directly.
//
// @codemirror/lang-sql's SQLConfig gives us, from a { table -> columns } map:
//   - table-name completion after FROM / JOIN / UPDATE / INTO
//   - column completion after `table.` / `alias.` (aliases resolved from FROM)
//   - SQL keyword completion (dialect-aware) as a fallback
// We attach the column TYPE as `detail` so it shows in the completion popup.
//
// Three behaviours are added on top of the raw sql() extension so suggestions
// are actually useful (see TASK 23 — the observed break was NOT the catalog):
//   1. UNQUALIFIED column completion in column positions (after SELECT / WHERE /
//      ON / AND / …) — lang-sql only completes columns after `table.`, so bare
//      `WHERE ema…` never surfaced `email`. We add a source that offers columns
//      from the statement's FROM/JOIN tables.
//   2. Table/column completions are BOOSTED above keywords.
//   3. Completion auto-opens right after `FROM `/`JOIN `/`WHERE `/… + space and
//      after commas — CodeMirror's activateOnTyping only fires on word chars, so
//      without this nothing appears until you type the first letter (the
//      user-visible "no tables/columns are suggested" symptom).
import { sql, PostgreSQL, MySQL, SQLite, MSSQL, StandardSQL, type SQLConfig } from '@codemirror/lang-sql'
import {
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import type { Engine, SchemaCatalog } from '@shared/types'

function dialectFor(engine: Engine | null): SQLConfig['dialect'] {
  switch (engine) {
    case 'postgres':
      return PostgreSQL
    case 'mysql':
    case 'mariadb': // MariaDB is wire/SQL-compatible with MySQL
      return MySQL
    case 'sqlite':
      return SQLite
    case 'oracle': // no dedicated Oracle grammar in lang-sql — ANSI keywords
      return StandardSQL
    case 'mssql':
      return MSSQL
    default:
      return StandardSQL
  }
}

// Keywords after which (once a space is typed) a table or column is expected —
// so the completion popup should open on its own.
const OPEN_AFTER = /(?:^|[\s(,])(?:from|join|into|update|table|where|on|and|or|select|by|having|set|as|using)\s+$/i

/**
 * Opens the completion popup right after the user types a space following a
 * clause keyword (FROM/JOIN/WHERE/…) or a comma — positions where a table or
 * column name is expected but there's no word yet to activate on-typing.
 */
const autoOpenCompletion = EditorView.updateListener.of((u) => {
  if (!u.docChanged || u.view.composing) return
  const tr = u.transactions[u.transactions.length - 1]
  if (!tr || !tr.isUserEvent('input.type')) return

  let typed = ''
  u.changes.iterChanges((_fa, _ta, _fb, _tb, ins) => {
    typed += ins.toString()
  })
  if (typed !== ' ' && typed !== ',') return

  const pos = u.state.selection.main.head
  const line = u.state.doc.lineAt(pos)
  const before = line.text.slice(0, pos - line.from)
  if (typed === ',' || /,\s*$/.test(before) || OPEN_AFTER.test(before)) {
    // Deferred: dispatching a transaction synchronously from an update listener
    // is not allowed; startCompletion dispatches internally.
    setTimeout(() => startCompletion(u.view), 0)
  }
})

type Col = { name: string; type: string }

/**
 * A completion source that offers UNQUALIFIED column names in column positions
 * (`SELECT … |`, `WHERE …`, `AND/OR …`, after operators, etc.). Skips qualified
 * positions (`t.` — handled by lang-sql) and table positions (after FROM/JOIN).
 *
 * Column pool is either:
 *   - `explicitColumns` — a fixed set (the Custom WHERE filter: a predicate over
 *     ONE known table, with no FROM clause to infer from); or
 *   - the tables referenced in the document's FROM/JOIN clauses (main editor).
 */
function unqualifiedColumnSource(catalog: SchemaCatalog | null, explicitColumns?: Col[]): CompletionSource {
  const byTable = new Map<string, Col[]>()
  if (catalog) for (const t of catalog.tables) byTable.set(t.name.toLowerCase(), t.columns)
  const predicateOnly = !!explicitColumns

  return (context: CompletionContext): CompletionResult | null => {
    if (!predicateOnly && !catalog) return null
    const word = context.matchBefore(/[\w]*/)
    if (!word) return null

    // Text before the word (trimmed) tells us the syntactic position.
    const upto = context.state.sliceDoc(0, word.from)
    const before = upto.slice(-1)
    if (before === '.') return null // qualified — lang-sql handles it

    const trimmed = upto.replace(/\s+$/, '')
    const lastWord = (trimmed.match(/[A-Za-z_]+$/) ?? [''])[0].toLowerCase()
    const lastChar = trimmed.slice(-1)

    // Right after a table-introducing keyword → tables are expected, not columns.
    if (/^(from|join|into|update|table|as|using)$/.test(lastWord)) return null

    const columnCtx =
      // Start of a predicate-only input (Custom WHERE) is a column position.
      (predicateOnly && trimmed === '') ||
      /^(select|where|on|and|or|having|set|by|distinct|when|then|else)$/.test(lastWord) ||
      ',(=<>+-*/%|~'.includes(lastChar)
    if (!columnCtx && !context.explicit) return null

    const options: Completion[] = []
    const seen = new Set<string>()
    const add = (cols: Col[]): void => {
      for (const c of cols) {
        if (seen.has(c.name)) continue
        seen.add(c.name)
        options.push({ label: c.name, type: 'property', detail: c.type, boost: 2 })
      }
    }

    if (explicitColumns) {
      add(explicitColumns)
    } else {
      // Collect columns from every FROM/JOIN table in the whole document.
      const doc = context.state.doc.toString()
      const re = /\b(?:from|join)\s+[`"[]?(\w+)[`"\]]?/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(doc)) !== null) {
        const cols = byTable.get(m[1].toLowerCase())
        if (cols) add(cols)
      }
    }
    if (options.length === 0) return null
    return { from: word.from, options, validFor: /^\w*$/ }
  }
}

/**
 * Options for the shared SQL completion factory.
 * - `columns`: when set, this input is a WHERE-PREDICATE over ONE known table
 *   (the Custom WHERE filter) with no FROM clause — offer these columns directly
 *   at predicate positions instead of inferring tables from a FROM.
 */
export interface SqlExtensionOptions {
  columns?: { name: string; type: string }[]
}

export function buildSqlExtension(
  catalog: SchemaCatalog | null,
  engine: Engine | null,
  opts: SqlExtensionOptions = {}
): Extension {
  const schema: Record<string, Completion[]> = {}
  const tables: Completion[] = []

  // Predicate mode (Custom WHERE): a filter over ONE table with no FROM — offer
  // only that table's columns (via the source below) + keywords, NOT table names.
  const predicateMode = !!opts.columns

  if (catalog && !predicateMode) {
    for (const t of catalog.tables) {
      const cols: Completion[] = t.columns.map((c) => ({
        label: c.name,
        type: 'property',
        detail: c.type,
        // Rank real columns above SQL keywords in shared contexts.
        boost: 2
      }))
      // Bare name enables alias resolution (`FROM customers c` -> `c.`),
      // qualified name enables `public.customers.` style access.
      schema[t.name] = cols
      schema[`${t.schema}.${t.name}`] = cols
      tables.push({ label: t.name, type: 'table', detail: t.schema, boost: 1 })
    }
  }

  const config: SQLConfig = {
    dialect: dialectFor(engine),
    upperCaseKeywords: false,
    schema,
    tables
  }
  const langSupport = sql(config)
  // Add the unqualified-column source ALONGSIDE lang-sql's own schema/keyword
  // sources (via language data — CM merges all sources, it doesn't replace).
  const columnSource = langSupport.language.data.of({
    autocomplete: unqualifiedColumnSource(catalog, opts.columns)
  })
  return [langSupport, columnSource, autoOpenCompletion]
}
