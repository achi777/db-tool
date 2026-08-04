// Central, typed icon map for the object tree — one coherent set (lucide-react)
// so every node type is consistent and easy to re-map in one place. Icons use
// `currentColor`, so they inherit the theme via CSS (dark-theme friendly).
import {
  Boxes,
  Braces,
  ChevronDown,
  ChevronRight,
  Circle,
  Columns3,
  Database,
  Eye,
  Hash,
  KeyRound,
  Link2,
  ListTree,
  Loader2,
  Package,
  Layers,
  Shapes,
  Puzzle,
  Table2,
  TerminalSquare,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { CSSProperties } from 'react'
import type { Engine } from '@shared/types'

export const ICON = 14
const CAT = 13

/** Expand/collapse chevron. */
export function Chevron({ open }: { open: boolean }): JSX.Element {
  const I = open ? ChevronDown : ChevronRight
  return <I size={11} className="tree-chevron" aria-hidden />
}

/** Small spacer that keeps a leaf's label aligned with rows that have a chevron. */
export function ChevronSpacer(): JSX.Element {
  return <span className="tree-chevron tree-chevron-spacer" aria-hidden />
}

/** Spinner shown while a lazy category loads. */
export function Spinner(): JSX.Element {
  return <Loader2 size={12} className="tree-spinner" aria-hidden />
}

type IconProps = { className?: string; title?: string; style?: CSSProperties }
const mk = (I: LucideIcon, size = ICON) =>
  function TreeIcon({ className, title, style }: IconProps): JSX.Element {
    return <I size={size} className={'tree-icon ' + (className ?? '')} aria-label={title} style={style} />
  }

// --- category folders ---
export const IconTablesCat = mk(Table2, CAT)
export const IconViewsCat = mk(Eye, CAT)
export const IconFunctionsCat = mk(Braces, CAT)
export const IconProceduresCat = mk(TerminalSquare, CAT)
export const IconPackagesCat = mk(Package, CAT)
export const IconSequencesCat = mk(Hash, CAT)
export const IconTriggersCat = mk(Zap, CAT)
export const IconIndexesCat = mk(ListTree, CAT)
export const IconColumnsCat = mk(Columns3, CAT)
// PostgreSQL advanced object categories (TASK 67)
export const IconMatViewsCat = mk(Layers, CAT)
export const IconTypesCat = mk(Shapes, CAT)
export const IconExtensionsCat = mk(Puzzle, CAT)

// --- individual objects ---
export const IconSchema = mk(Boxes)
export const IconTable = mk(Table2)
export const IconView = mk(Eye)
export const IconFunction = mk(Braces)
export const IconProcedure = mk(TerminalSquare)
export const IconPackage = mk(Package)
export const IconSequence = mk(Hash)
export const IconTrigger = mk(Zap)
export const IconIndex = mk(ListTree)
export const IconIndexUnique = mk(KeyRound)
export const IconMatView = mk(Layers)
export const IconType = mk(Shapes)
export const IconExtension = mk(Puzzle)
export const IconColumn = mk(Circle, 9)
export const IconColumnPk = mk(KeyRound, 12)
export const IconColumnFk = mk(Link2, 12)
export const IconDatabase = mk(Database)

/** A subtle engine badge colour for the connection dot. */
export function engineColor(engine: Engine | null | undefined): string {
  switch (engine) {
    case 'postgres':
      return '#5b93c9'
    case 'mysql':
      return '#d9922e'
    case 'mariadb':
      return '#57a6a1'
    case 'oracle':
      return '#c74634'
    case 'mssql':
      return '#cc2927'
    case 'sqlite':
      return '#8a8f9c'
    default:
      return 'var(--text-dim)'
  }
}
