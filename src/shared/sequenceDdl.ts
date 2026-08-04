// Pure DDL generators for sequences (CREATE / ALTER / DROP / RESTART / RENAME).
// Shared by renderer (preview) and main (execute). No DB access here. All
// numeric inputs are validated (bigint-safe strings) and all identifiers are
// quoted, so the generated SQL is safe to execute.
//
// Three engines have standalone sequences, with dialect differences:
//   - PostgreSQL: AS <type>, OWNED BY, NO MINVALUE/NO CYCLE, ALTER … RENAME TO,
//     ALTER … RESTART WITH n.
//   - MariaDB (10.3+): sequences are TABLES → no AS/OWNED BY, NOCYCLE, RENAME
//     TABLE, ALTER … RESTART WITH n.
//   - Oracle: no AS/OWNED BY, NOMINVALUE/NOMAXVALUE/NOCACHE/NOCYCLE, CACHE must
//     be ≥2 (else NOCACHE), START WITH is NOT alterable → RESTART is
//     `ALTER … RESTART START WITH n` (12.2+) or a DROP+CREATE fallback; RENAME
//     uses the bare `RENAME old TO new` statement.
import type { DdlPreview, Engine, SequenceSpec } from './types'
import { isMysqlFamily } from './types'

function quoter(engine: Engine): (id: string) => string {
  return isMysqlFamily(engine)
    ? (id: string) => '`' + id.replace(/`/g, '``') + '`'
    : (id: string) => '"' + id.replace(/"/g, '""') + '"'
}

/** Quote a possibly-qualified identifier path like `schema.table.column`. */
function qpath(engine: Engine, path: string): string {
  const q = quoter(engine)
  return path
    .split('.')
    .map((p) => q(p.trim()))
    .join('.')
}

function num(label: string, v: string): string {
  const s = String(v).trim()
  if (!/^-?\d+$/.test(s)) throw new Error(`Invalid ${label}: "${v}" (must be an integer)`)
  return s
}

const VALID_TYPES = new Set(['smallint', 'integer', 'bigint'])
function dataType(t: string): string {
  const s = (t || 'bigint').toLowerCase()
  if (!VALID_TYPES.has(s)) throw new Error(`Invalid sequence data type: "${t}"`)
  return s
}

function qualified(engine: Engine, spec: { schema: string; name: string }): string {
  const q = quoter(engine)
  return `${q(spec.schema)}.${q(spec.name)}`
}

/** Cache clause per engine — Oracle needs CACHE ≥ 2, else NOCACHE. */
function cacheClause(engine: Engine, cache: string): string {
  const n = num('cache', cache)
  if (engine === 'oracle' && Number(n) <= 1) return 'NOCACHE'
  return `CACHE ${n}`
}

function noMin(engine: Engine): string {
  return engine === 'oracle' ? 'NOMINVALUE' : 'NO MINVALUE'
}
function noMax(engine: Engine): string {
  return engine === 'oracle' ? 'NOMAXVALUE' : 'NO MAXVALUE'
}
function noCycle(engine: Engine): string {
  return engine === 'postgres' ? 'NO CYCLE' : 'NOCYCLE' // MariaDB + Oracle use NOCYCLE
}

/** CREATE SEQUENCE from a spec. */
export function buildCreateSequence(engine: Engine, spec: SequenceSpec): DdlPreview {
  const maria = isMysqlFamily(engine)
  const oracle = engine === 'oracle'
  const lines: string[] = [`CREATE SEQUENCE ${qualified(engine, spec)}`]
  // Only PostgreSQL takes an `AS <type>` clause.
  if (!maria && !oracle) lines.push(`  AS ${dataType(spec.dataType)}`)
  lines.push(`  INCREMENT BY ${num('increment', spec.increment)}`)
  lines.push(spec.minValue != null && spec.minValue !== '' ? `  MINVALUE ${num('minvalue', spec.minValue)}` : `  ${noMin(engine)}`)
  lines.push(spec.maxValue != null && spec.maxValue !== '' ? `  MAXVALUE ${num('maxvalue', spec.maxValue)}` : `  ${noMax(engine)}`)
  lines.push(`  START WITH ${num('start', spec.start)}`)
  lines.push(`  ${cacheClause(engine, spec.cache)}`)
  lines.push(`  ${spec.cycle ? 'CYCLE' : noCycle(engine)}`)
  // OWNED BY is PostgreSQL-only.
  if (!maria && !oracle && spec.ownedBy && spec.ownedBy.trim()) lines.push(`  OWNED BY ${qpath(engine, spec.ownedBy)}`)
  const sql = lines.join('\n') + ';'
  return { sql, statements: [sql], destructive: false, destructiveReasons: [], notes: [] }
}

/**
 * ALTER SEQUENCE — emits only changed properties, plus RESTART and RENAME.
 * `opts.oracleRestartSupported === false` → an Oracle RESTART is generated as a
 * destructive DROP + CREATE (for Oracle < 12.2 that lacks ALTER … RESTART).
 */
export function buildAlterSequence(
  engine: Engine,
  spec: SequenceSpec,
  original: SequenceSpec,
  opts?: { oracleRestartSupported?: boolean }
): DdlPreview {
  const q = quoter(engine)
  const maria = isMysqlFamily(engine)
  const oracle = engine === 'oracle'
  const statements: string[] = []
  const destructiveReasons: string[] = []
  const notes: string[] = []
  const cur = `${q(spec.schema)}.${q(original.name)}`

  const props: string[] = []
  if (!maria && !oracle && dataType(spec.dataType) !== dataType(original.dataType)) props.push(`AS ${dataType(spec.dataType)}`)
  if (num('increment', spec.increment) !== num('increment', original.increment)) {
    props.push(`INCREMENT BY ${num('increment', spec.increment)}`)
  }
  const minNow = spec.minValue != null && spec.minValue !== '' ? num('minvalue', spec.minValue) : null
  const minOrig = original.minValue != null && original.minValue !== '' ? original.minValue : null
  if (minNow !== minOrig) props.push(minNow != null ? `MINVALUE ${minNow}` : noMin(engine))
  const maxNow = spec.maxValue != null && spec.maxValue !== '' ? num('maxvalue', spec.maxValue) : null
  const maxOrig = original.maxValue != null && original.maxValue !== '' ? original.maxValue : null
  if (maxNow !== maxOrig) props.push(maxNow != null ? `MAXVALUE ${maxNow}` : noMax(engine))
  // Oracle cannot ALTER START WITH (only RESTART, handled below).
  if (!oracle && num('start', spec.start) !== num('start', original.start)) props.push(`START WITH ${num('start', spec.start)}`)
  if (num('cache', spec.cache) !== num('cache', original.cache)) props.push(cacheClause(engine, spec.cache))
  if (spec.cycle !== original.cycle) props.push(spec.cycle ? 'CYCLE' : noCycle(engine))
  if (!maria && !oracle) {
    const ownNow = spec.ownedBy && spec.ownedBy.trim() ? spec.ownedBy.trim() : null
    const ownOrig = original.ownedBy && original.ownedBy.trim() ? original.ownedBy.trim() : null
    if (ownNow !== ownOrig) props.push(ownNow ? `OWNED BY ${qpath(engine, ownNow)}` : 'OWNED BY NONE')
  }

  const restart = spec.restart != null && String(spec.restart).trim() !== '' ? num('restart', spec.restart) : null

  // PostgreSQL / MariaDB: RESTART is just another ALTER property.
  if (restart != null && !oracle) props.push(`RESTART WITH ${restart}`)

  if (props.length > 0) statements.push(`ALTER SEQUENCE ${cur}\n  ${props.join('\n  ')};`)

  // Oracle RESTART: ALTER … RESTART START WITH n (12.2+) or DROP+CREATE fallback.
  if (restart != null && oracle) {
    if (opts?.oracleRestartSupported === false) {
      const recreated = buildCreateSequence(engine, { ...spec, start: restart })
      statements.push(`DROP SEQUENCE ${qualified(engine, { schema: spec.schema, name: spec.name })};`)
      statements.push(recreated.statements[0])
      destructiveReasons.push(`restarting "${spec.name}" on this Oracle version requires DROP + CREATE (dependent defaults/triggers may be affected)`)
    } else {
      statements.push(`ALTER SEQUENCE ${q(spec.schema)}.${q(spec.name)} RESTART START WITH ${restart};`)
    }
  }

  const renamed = spec.originalName && spec.name !== spec.originalName
  if (renamed) {
    if (maria) {
      statements.push(`RENAME TABLE ${cur} TO ${q(spec.schema)}.${q(spec.name)};`) // sequences are tables
    } else if (oracle) {
      statements.push(`RENAME ${q(original.name)} TO ${q(spec.name)};`) // Oracle RENAME (current schema, bare names)
    } else {
      statements.push(`ALTER SEQUENCE ${cur} RENAME TO ${q(spec.name)};`)
    }
  }

  if (statements.length === 0) notes.push('No changes to apply.')
  return { sql: statements.join('\n'), statements, destructive: destructiveReasons.length > 0, destructiveReasons, notes }
}

/** DROP SEQUENCE (destructive; warns if owned by a column). */
export function buildDropSequence(engine: Engine, schema: string, name: string, ownedBy?: string | null): DdlPreview {
  const sql = `DROP SEQUENCE ${qualified(engine, { schema, name })};`
  const reasons = [`drops sequence "${name}" permanently`]
  if (ownedBy) reasons.push(`sequence is OWNED BY ${ownedBy} — dropping may break that column's default`)
  return { sql, statements: [sql], destructive: true, destructiveReasons: reasons, notes: [] }
}
