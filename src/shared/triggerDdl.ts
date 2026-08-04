// Pure trigger DDL generation + definition parsing, shared by renderer (preview)
// and main (execute / round-trip). Engine-aware:
//   - PostgreSQL: a trigger is a FUNCTION (RETURNS trigger) + a CREATE TRIGGER
//     that EXECUTE FUNCTIONs it. Editing has no CREATE OR REPLACE TRIGGER, so
//     we DROP + CREATE the trigger (function uses CREATE OR REPLACE).
//   - MySQL / SQLite: a single CREATE TRIGGER whose body may contain ';'
//     (executed as ONE statement — no DELIMITER needed via the driver). Editing
//     is DROP + CREATE.
//   - Oracle: a single CREATE OR REPLACE TRIGGER whose PL/SQL body ends in
//     'END;' (executed as ONE statement; refs use :NEW/:OLD). Editing reuses
//     CREATE OR REPLACE (no DROP needed). Row/statement level + optional WHEN.
import type { DdlPreview, Engine, TriggerSpec } from './types'
import { sqlDialect } from './types'

function q(engine: Engine, id: string): string {
  if (engine === 'mysql') return '`' + id.replace(/`/g, '``') + '`'
  if (engine === 'mssql') return '[' + id.replace(/]/g, ']]') + ']'
  return '"' + id.replace(/"/g, '""') + '"'
}

/** Qualified table name (schema.table for PG/MySQL; bare for SQLite). */
function qtable(engine: Engine, schema: string, table: string): string {
  return engine === 'sqlite' ? q(engine, table) : `${q(engine, schema)}.${q(engine, table)}`
}

/** Build the executable statements for creating/altering a trigger. */
export function buildTriggerStatements(engine: Engine, spec: TriggerSpec, mode: 'new' | 'edit'): DdlPreview {
  engine = sqlDialect(engine)
  const statements: string[] = []
  const notes: string[] = []
  const destructiveReasons: string[] = []
  const tbl = qtable(engine, spec.schema, spec.table)
  const origName = spec.originalName ?? spec.name

  if (engine === 'postgres') {
    const fn = spec.functionName?.trim() || `${spec.name}_fn`
    const fnQn = `${q('postgres', spec.schema)}.${q('postgres', fn)}`
    // Function (CREATE OR REPLACE — safe to re-run).
    statements.push(
      `CREATE OR REPLACE FUNCTION ${fnQn}()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $$\n${spec.functionBody.trim()}\n$$;`
    )
    if (mode === 'edit') {
      statements.push(`DROP TRIGGER IF EXISTS ${q('postgres', origName)} ON ${tbl};`)
      destructiveReasons.push(`re-creates trigger "${origName}" (DROP + CREATE)`)
    }
    statements.push(
      `CREATE TRIGGER ${q('postgres', spec.name)} ${spec.timing} ${spec.event} ON ${tbl}\nFOR EACH ${spec.level} EXECUTE FUNCTION ${fnQn}();`
    )
  } else if (engine === 'mysql') {
    const trgName = `${q('mysql', spec.schema)}.${q('mysql', spec.name)}`
    if (mode === 'edit') {
      statements.push(`DROP TRIGGER IF EXISTS ${q('mysql', spec.schema)}.${q('mysql', origName)};`)
      destructiveReasons.push(`re-creates trigger "${origName}" (DROP + CREATE)`)
    }
    statements.push(
      `CREATE TRIGGER ${trgName} ${spec.timing} ${spec.event} ON ${tbl}\nFOR EACH ROW ${spec.body.trim()}`
    )
  } else if (engine === 'oracle') {
    // Oracle: ONE CREATE OR REPLACE TRIGGER. No AS, no function; PL/SQL body
    // ends in END;. Statement-level omits FOR EACH ROW; WHEN is row-level only.
    // A rename (edit with a new name) leaves the old trigger behind, so drop it.
    if (mode === 'edit' && spec.name !== origName) {
      statements.push(`DROP TRIGGER ${q('oracle', spec.schema)}.${q('oracle', origName)};`)
      destructiveReasons.push(`drops the old trigger "${origName}" (renamed)`)
    }
    const forEach = spec.level === 'ROW' ? '\n  FOR EACH ROW' : ''
    const when =
      spec.level === 'ROW' && spec.whenClause && spec.whenClause.trim()
        ? `\n  WHEN (${spec.whenClause.trim()})`
        : ''
    const header = `CREATE OR REPLACE TRIGGER ${q('oracle', spec.schema)}.${q('oracle', spec.name)}\n  ${spec.timing} ${spec.event} ON ${tbl}${forEach}${when}`
    statements.push(`${header}\n${spec.body.trim()}`)
    notes.push('Applied as CREATE OR REPLACE (Oracle re-creates the trigger in place).')
    notes.push('Oracle compiles the trigger even if its PL/SQL has errors — the app reports any compile errors after applying.')
  } else if (engine === 'mssql') {
    // SQL Server: ONE CREATE OR ALTER TRIGGER. No BEFORE, no FOR EACH ROW —
    // triggers are statement-level and use the `inserted`/`deleted` pseudo-tables.
    // A rename (edit with a new name) leaves the old trigger behind, so drop it.
    if (mode === 'edit' && spec.name !== origName) {
      statements.push(`DROP TRIGGER ${q('mssql', spec.schema)}.${q('mssql', origName)};`)
      destructiveReasons.push(`drops the old trigger "${origName}" (renamed)`)
    }
    const timing = spec.timing === 'INSTEAD OF' ? 'INSTEAD OF' : 'AFTER' // no BEFORE on SQL Server
    const header = `CREATE OR ALTER TRIGGER ${q('mssql', spec.schema)}.${q('mssql', spec.name)}\n  ON ${tbl}\n  ${timing} ${spec.event}`
    statements.push(`${header}\nAS\n${spec.body.trim()}`)
    notes.push('Applied as CREATE OR ALTER (SQL Server 2016 SP1+). Reference the inserted/deleted pseudo-tables, not NEW/OLD.')
  } else {
    // sqlite
    if (mode === 'edit') {
      statements.push(`DROP TRIGGER IF EXISTS ${q('sqlite', spec.name)};`)
      statements.push(`DROP TRIGGER IF EXISTS ${q('sqlite', origName)};`)
      destructiveReasons.push(`re-creates trigger "${origName}" (DROP + CREATE)`)
    }
    statements.push(
      `CREATE TRIGGER ${q('sqlite', spec.name)} ${spec.timing} ${spec.event} ON ${q('sqlite', spec.table)}\nFOR EACH ROW ${spec.body.trim()}`
    )
  }

  return {
    sql: statements.join('\n\n'),
    statements,
    destructive: destructiveReasons.length > 0,
    destructiveReasons,
    notes
  }
}

/**
 * Enable/disable a trigger where the engine supports it (Oracle + SQL Server).
 * Other engines have no equivalent (a trigger is simply present or dropped) —
 * returns null there. SQL Server needs the table; Oracle ignores it.
 */
export function buildSetTriggerEnabled(
  engine: Engine,
  schema: string,
  table: string,
  name: string,
  enable: boolean
): string | null {
  const d = sqlDialect(engine)
  if (d === 'oracle') return `ALTER TRIGGER ${q('oracle', schema)}.${q('oracle', name)} ${enable ? 'ENABLE' : 'DISABLE'}`
  if (d === 'mssql')
    return `${enable ? 'ENABLE' : 'DISABLE'} TRIGGER ${q('mssql', schema)}.${q('mssql', name)} ON ${q('mssql', schema)}.${q('mssql', table)}`
  return null
}

// --- Definition parsing (for the edit round-trip) ----------------------------

/** Extract BEFORE/AFTER/INSTEAD OF from a CREATE TRIGGER string. */
export function parseTiming(def: string): string {
  const m = def.match(/\b(BEFORE|AFTER|INSTEAD\s+OF)\b/i)
  return m ? m[1].toUpperCase().replace(/\s+/g, ' ') : 'BEFORE'
}

/** Extract the first of INSERT/UPDATE/DELETE (may appear as "UPDATE OF ..."). */
export function parseEvent(def: string): string {
  const m = def.match(/\b(INSERT|UPDATE|DELETE)\b/i)
  return m ? m[1].toUpperCase() : 'INSERT'
}

/** Extract FOR EACH ROW|STATEMENT (defaults ROW). */
export function parseLevel(def: string): string {
  const m = def.match(/FOR\s+EACH\s+(ROW|STATEMENT)/i)
  return m ? m[1].toUpperCase() : 'ROW'
}

/** Extract the plpgsql body between the outer $tag$ … $tag$ of a function def. */
export function parseFunctionBody(fnDef: string): string {
  const m = fnDef.match(/AS\s+\$([A-Za-z0-9_]*)\$([\s\S]*?)\$\1\$/)
  return m ? m[2].trim() : ''
}

/**
 * Extract the action body of a MySQL/SQLite CREATE TRIGGER (everything after
 * `FOR EACH ROW` — the BEGIN…END or single statement, incl. any WHEN clause).
 */
export function parseTriggerBody(def: string): string {
  const m = def.match(/FOR\s+EACH\s+ROW\s+([\s\S]+?)\s*;?\s*$/i)
  if (m) return m[1].trim()
  // SQLite may omit FOR EACH ROW: take everything from WHEN/BEGIN onward.
  const m2 = def.match(/\bON\b\s+\S+\s+([\s\S]+)$/i)
  return m2 ? m2[1].trim() : def.trim()
}
