import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { IconNew } from '../actionIcons'

/** The tab strip across the top of the main panel (query + designer tabs). */
export function EditorTabs(): JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const addTab = useStore((s) => s.addTab)
  const closeTab = useStore((s) => s.closeTab)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const renameTab = useStore((s) => s.renameTab)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')

  // Ctrl+T new tab, Ctrl+W close tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
        e.preventDefault()
        addTab()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        if (activeTabId) closeTab(activeTabId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addTab, closeTab, activeTabId])

  function commitRename(id: string): void {
    renameTab(id, draftTitle)
    setEditingId(null)
  }

  return (
    <div className="tab-strip">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={'tab' + (t.id === activeTabId ? ' active' : '') + (t.kind !== 'query' ? ' designer' : '')}
          onClick={() => setActiveTab(t.id)}
          onDoubleClick={() => {
            if (t.kind !== 'query') return
            setEditingId(t.id)
            setDraftTitle(t.title)
          }}
          title={
            t.kind === 'query'
              ? 'Double-click to rename'
              : t.kind === 'designer'
                ? 'Table designer'
                : t.kind === 'viewbuilder'
                  ? 'View builder'
                  : t.kind === 'erdiagram'
                    ? 'ER diagram'
                    : t.kind === 'sequence'
                      ? 'Sequence'
                      : t.kind === 'trigger'
                        ? 'Trigger'
                        : t.kind === 'index'
                          ? 'Index'
                          : 'Object editor'
          }
        >
          {t.kind === 'designer' && <span className="tab-icon">▤</span>}
          {t.kind === 'object' && <span className="tab-icon">ƒ</span>}
          {t.kind === 'erdiagram' && <span className="tab-icon">⧉</span>}
          {t.kind === 'sequence' && <span className="tab-icon">⑆</span>}
          {t.kind === 'trigger' && <span className="tab-icon">⚡</span>}
          {t.kind === 'index' && <span className="tab-icon">⊟</span>}
          {editingId === t.id ? (
            <input
              className="tab-rename"
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={() => commitRename(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(t.id)
                if (e.key === 'Escape') setEditingId(null)
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="tab-title">{t.title}</span>
          )}
          <span
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation()
              closeTab(t.id)
            }}
            title="Close tab (Ctrl+W)"
          >
            ×
          </span>
        </div>
      ))}
      <button className="tab-add" onClick={() => addTab()} title="New tab (Ctrl+T)">
        <IconNew />
      </button>
    </div>
  )
}
