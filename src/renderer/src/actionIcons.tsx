// Central, typed action->icon map (lucide-react) so the SAME action uses the
// SAME glyph everywhere in the app — every Delete is the same trash, every
// Refresh the same, etc. Complements the tree icon map (treeIcons.tsx) and the
// filter icons (TASK 38). Icons use `currentColor`, inheriting the theme.
//
// Usage: <button className="icon-text-btn" title="…"><IconSave /> Save</button>
// For icon-only buttons always keep a `title` on the button for a tooltip.
import type { LucideIcon } from 'lucide-react'
import {
  Braces,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  CornerDownLeft,
  Download,
  Eye,
  FileDown,
  FileUp,
  ExternalLink,
  Filter,
  FilterX,
  FolderOpen,
  History,
  ImageDown,
  Info,
  LayoutGrid,
  ListFilter,
  Maximize,
  Pencil,
  Play,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
  Unplug,
  Upload,
  X
} from 'lucide-react'

/** Default action-icon size — matches the filter icons from TASK 38. */
export const AICON = 14

type IconProps = { size?: number; className?: string; title?: string }
const mk = (I: LucideIcon) =>
  function ActionIcon({ size = AICON, className, title }: IconProps): JSX.Element {
    return <I size={size} className={'act-ico ' + (className ?? '')} aria-label={title} />
  }

// --- CRUD / lifecycle ---
export const IconNew = mk(Plus) // New / Add / Create
export const IconEdit = mk(Pencil)
export const IconDelete = mk(Trash2) // Delete / Drop / Remove-destructive
export const IconSave = mk(Save)
export const IconApply = mk(Check) // Apply / commit / confirm
export const IconClose = mk(X) // Close / dismiss
export const IconRemove = mk(X) // remove a row/item (non-destructive ×)
export const IconClear = mk(FilterX) // Clear / reset a filter
export const IconDiscard = mk(Undo2) // Discard staged changes
export const IconCopy = mk(Copy)
export const IconRefresh = mk(RefreshCw) // Refresh / re-parse / reload
export const IconReset = mk(RotateCcw) // Reset to default / discard manual state
export const IconRun = mk(Play) // Run / Execute

// --- connections ---
export const IconConnect = mk(Plug)
export const IconDisconnect = mk(Unplug)
export const IconTest = mk(PlugZap)

// --- data movement ---
export const IconImport = mk(Download) // pull data INTO the table
export const IconExport = mk(Upload) // push data OUT to a file
export const IconExportImage = mk(ImageDown) // export a diagram as an image
export const IconDump = mk(FileDown) // dump DB to a .sql file
export const IconRestore = mk(FileUp) // execute / restore a .sql file
export const IconChooseFile = mk(FolderOpen)

// --- filters (shared with the TASK 38 filter toolbar/popovers) ---
export const IconFunnel = mk(Filter) // visual filter builder (funnel)
export const IconCustomWhere = mk(Braces) // raw SQL WHERE
export const IconColumnFilter = mk(ListFilter) // per-column header filter
export const IconOpenExternal = mk(ExternalLink) // send to a new editor tab

// --- diagram / misc ---
export const IconLayout = mk(LayoutGrid) // auto-arrange
export const IconFit = mk(Maximize) // fit to view
export const IconSearchGo = mk(ChevronRight) // jump to search match
export const IconHistory = mk(History)
export const IconPreview = mk(Eye) // preview DDL / SQL
export const IconInfo = mk(Info) // About / info

// --- reorder / navigation ---
export const IconMoveUp = mk(ChevronUp)
export const IconMoveDown = mk(ChevronDown)
export const IconExpand = mk(ChevronDown)
export const IconCollapse = mk(ChevronRight)

// --- pagination (compact, icon-only; buttons carry the tooltip) ---
export const IconFirst = mk(ChevronsLeft)
export const IconPrev = mk(ChevronLeft)
export const IconNext = mk(ChevronRight)
export const IconLast = mk(ChevronsRight)
export const IconJump = mk(CornerDownLeft)
