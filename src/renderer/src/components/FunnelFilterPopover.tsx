import { useEffect, useState } from 'react'
import { IconFunnel, IconClear, IconApply, IconClose } from '../actionIcons'
import type { ColumnSpec, Engine, FilterGroup } from '@shared/types'
import { previewWhere } from '@shared/filterCompiler'
import { FilterTreeEditor } from './FilterTreeEditor'
import { useStore } from '../store'

function emptyGroup(): FilterGroup {
  return { kind: 'group', combiner: 'AND', children: [] }
}

export interface FunnelAnchor {
  x: number
  y: number
}

/**
 * Navicat-style funnel popover — the single entry point to the nested AND/OR
 * visual builder (TASK 10 tree + compiler). It edits the `builderTree`, which is
 * one half of the STRUCTURED filter (the other half being the per-column header
 * filters); the two combine with AND. The TASK 34 bottom SQL panel reflects it.
 * Safety is identical to the column filters: Apply runs server-side through the
 * same parameterized, catalog-validated compiler.
 */
export function FunnelFilterPopover(props: {
  anchor: FunnelAnchor
  engine: Engine
  columns: ColumnSpec[]
  onClose: () => void
}): JSX.Element {
  const { anchor, engine, columns, onClose } = props
  const at = useStore((s) => s.getActiveTab())
  const setBuilderTree = useStore((s) => s.setBuilderTree)

  // Edit a private copy; commit to the shared builder state only on Apply.
  const [tree, setTree] = useState<FilterGroup>(
    () => (at?.builderTree ? (JSON.parse(JSON.stringify(at.builderTree)) as FilterGroup) : emptyGroup())
  )

  const preview = previewWhere(engine, at?.filters ?? [], tree)
  const quickCount = at?.filters.length ?? 0

  // Esc closes (matches the column-filter popover).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const apply = (): void => {
    // Empty tree -> clear the builder half of the structured filter. setBuilderTree
    // also leaves Custom WHERE if it was active (structured becomes the filter).
    void setBuilderTree(tree.children.length > 0 ? tree : null)
    onClose()
  }
  const clear = (): void => {
    void setBuilderTree(null)
    onClose()
  }

  // Enter (while typing a value) applies — the Navicat reflex.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault()
      apply()
    }
  }

  // Keep the popover on-screen (it's wider/taller than the column popover).
  const left = Math.min(anchor.x, window.innerWidth - 440)
  const top = Math.min(anchor.y, window.innerHeight - 340)

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div className="funnel-popover" style={{ left, top }} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="funnel-pop-head">
          <span className="funnel-pop-title"><IconFunnel /> Filter conditions</span>
          <span className="spacer" />
          <span className="del-x" onClick={onClose} title="Close"><IconClose size={15} /></span>
        </div>

        {columns.length === 0 ? (
          <div className="fb-empty">No columns available.</div>
        ) : (
          <FilterTreeEditor node={tree} engine={engine} columns={columns} isRoot onChange={(n) => setTree(n as FilterGroup)} />
        )}

        <div className="funnel-pop-preview">
          <span className="funnel-pop-label">WHERE</span>
          <code>{preview}</code>
        </div>
        {quickCount > 0 && (
          <div className="funnel-pop-note">
            ℹ Also AND-combined with {quickCount} active quick filter{quickCount > 1 ? 's' : ''}.
          </div>
        )}

        <div className="funnel-pop-actions">
          <button className="icon-text-btn" onClick={clear} title="Clear the builder filter"><IconClear /> Clear</button>
          <button className="icon-text-btn" onClick={onClose} title="Close without applying"><IconClose /> Close</button>
          <button className="icon-text-btn primary" onClick={apply} title="Apply the filter"><IconApply /> Apply</button>
        </div>
      </div>
    </>
  )
}
