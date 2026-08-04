// Shared operator metadata for the quick filter (TASK 09) and the visual
// filter builder (TASK 10), so both offer a consistent, type-aware operator set.
import type { ColumnSpec, Engine, FilterOperator } from '@shared/types'
import { findType } from '@shared/typeCatalog'

export const OP_LABEL: Record<FilterOperator, string> = {
  eq: '=',
  ne: '≠',
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  in: 'IN',
  notIn: 'NOT IN',
  between: 'BETWEEN',
  isNull: 'IS NULL',
  isNotNull: 'IS NOT NULL'
}

export type ColKind = 'Numeric' | 'Date' | 'Boolean' | 'String'

export function columnKind(engine: Engine, col: ColumnSpec | undefined): ColKind {
  const cat = col ? findType(engine, col.type)?.category : undefined
  if (cat === 'Numeric') return 'Numeric'
  if (cat === 'Date/Time') return 'Date'
  if (cat === 'Boolean') return 'Boolean'
  return 'String'
}

/** Operators offered for a column, given its type + nullability. */
export function opsFor(engine: Engine, col: ColumnSpec | undefined): FilterOperator[] {
  const kind = columnKind(engine, col)
  let base: FilterOperator[]
  if (kind === 'Numeric' || kind === 'Date') base = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'notIn']
  else if (kind === 'Boolean') base = ['eq', 'ne']
  else base = ['contains', 'startsWith', 'endsWith', 'eq', 'ne', 'in', 'notIn']
  return col?.nullable ? [...base, 'isNull', 'isNotNull'] : base
}

/** Engine-appropriate boolean literals for a value. */
export function boolTokens(engine: Engine): { t: string; f: string } {
  return engine === 'postgres' ? { t: 'true', f: 'false' } : { t: '1', f: '0' }
}
