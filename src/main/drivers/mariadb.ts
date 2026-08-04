// MariaDB driver (MAIN process only). MariaDB is wire- and SQL-compatible with
// MySQL, so it EXTENDS MysqlDriver (same mysql2 connection, same introspection,
// CRUD, DDL, import/export, dump/restore, ER, triggers, indexes, views,
// routines) and OVERRIDES only where MariaDB genuinely differs:
//
//   - SEQUENCES: MariaDB (10.3+) has standalone CREATE SEQUENCE objects (MySQL
//     does not). They surface in information_schema.tables as table_type
//     'SEQUENCE', and each sequence's properties live in its own one-row table.
//
// Everything else is inherited unchanged. The SQL dialect for codegen is still
// 'mysql' (see sqlDialect()), so backtick quoting / LIMIT / types all match.
import type { SequenceInfo, SequenceRef } from '@shared/types'
import { MysqlDriver } from './mysql'

function qid(id: string): string {
  return '`' + id.replace(/`/g, '``') + '`'
}

export class MariadbDriver extends MysqlDriver {
  /** MariaDB standalone sequences (table_type = 'SEQUENCE'). */
  async listSequences(schema: string): Promise<SequenceRef[]> {
    const db = this.schemaName(schema)
    const res = await this.runQuery(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = ? AND table_type = 'SEQUENCE'`,
      [db]
    )
    return (res.rows as Record<string, unknown>[])
      .map((r) => ({ schema: db, name: String(r.name ?? r.NAME ?? r.TABLE_NAME) }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }

  /**
   * A MariaDB sequence stores its metadata in its own one-row table:
   * start_value / minimum_value / maximum_value / increment / cache_size /
   * cycle_option / next_not_cached_value. MariaDB sequences are always BIGINT
   * and are never OWNED BY a column.
   */
  async getSequenceDetails(schema: string, name: string): Promise<SequenceInfo> {
    const db = this.schemaName(schema)
    const res = await this.runQuery(
      `SELECT start_value, minimum_value, maximum_value, increment,
              cache_size, cycle_option, next_not_cached_value
       FROM ${qid(db)}.${qid(name)}`
    )
    const r = res.rows[0] as Record<string, unknown> | undefined
    if (!r) throw new Error(`Sequence ${db}.${name} not found`)
    const s = (v: unknown): string => (v == null ? '' : String(v))
    return {
      schema: db,
      name,
      dataType: 'bigint',
      start: s(r.start_value),
      increment: s(r.increment),
      minValue: s(r.minimum_value),
      maxValue: s(r.maximum_value),
      cache: s(r.cache_size),
      cycle: String(r.cycle_option) === '1',
      ownedBy: null,
      lastValue: r.next_not_cached_value == null ? null : String(r.next_not_cached_value)
    }
  }
}
