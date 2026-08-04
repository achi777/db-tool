import { useStore } from '../store'
import { isMac } from '../useShortcuts'
import { IconClose } from '../actionIcons'

const MOD = isMac ? '⌘' : 'Ctrl'

// The single source of truth for what the reference shows — kept in lock-step
// with the bindings in useShortcuts.ts (+ the grid Delete handled in DataGrid).
const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'SQL editor',
    items: [
      ['Run query', `${MOD}+Enter  /  F5`],
      ['Toggle line comment', `${MOD}+/`],
      ['New query tab', `${MOD}+T`],
      ['Close current tab', `${MOD}+W`]
    ]
  },
  {
    title: 'Data grid',
    items: [
      ['Refresh table / re-run', `${MOD}+R  /  F5`],
      ['Apply pending row edits', `${MOD}+S`],
      ['Delete selected row(s) (staged; apply to commit)', 'Delete'],
      ['Discard staged edits', 'Esc / Discard button']
    ]
  },
  {
    title: 'General',
    items: [
      ['Toggle the sidebar', `${MOD}+B`],
      ['Close a dialog / popover / menu', 'Esc'],
      ['Show this shortcuts reference', 'F1  /  ?']
    ]
  }
]

/** A discoverable, accurate reference of the app's keyboard shortcuts (TASK 71). */
export function ShortcutsModal(): JSX.Element | null {
  const open = useStore((s) => s.shortcutsOpen)
  const setOpen = useStore((s) => s.setShortcutsOpen)
  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal sc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Keyboard shortcuts</div>
        <div className="sc-groups">
          {GROUPS.map((g) => (
            <div className="sc-group" key={g.title}>
              <div className="sc-group-title">{g.title}</div>
              {g.items.map(([label, keys]) => (
                <div className="sc-row" key={label}>
                  <span className="sc-label">{label}</span>
                  <span className="sc-keys">
                    {keys.split('  /  ').map((k, i) => (
                      <span key={i}>
                        {i > 0 && <span className="sc-or">or</span>}
                        {k.split('+').map((part, j) => (
                          <kbd key={j}>{part}</kbd>
                        ))}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="sc-note">Modifier is {isMac ? '⌘ (Command)' : 'Ctrl'} — the same keys map to ⌘ on macOS.</div>
        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="icon-text-btn" onClick={() => setOpen(false)}><IconClose /> Close</button>
        </div>
      </div>
    </div>
  )
}
