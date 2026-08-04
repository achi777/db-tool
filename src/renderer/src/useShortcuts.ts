import { useEffect } from 'react'
import { useStore } from './store'

/** True on macOS — the reference modal shows ⌘ instead of Ctrl there. */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '')

/** Focus is in a text-entry surface (input/textarea/select/contenteditable/CodeMirror). */
function inTextEntry(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if ((el as HTMLElement).isContentEditable) return true
  return !!el.closest?.('.cm-editor')
}

/** Any pending grid edit (staged insert/update/delete) on the active tab? */
function hasPendingEdits(): boolean {
  const at = useStore.getState().getActiveTab()
  const p = at?.pending
  if (!p) return false
  return (
    Object.keys(p.edits).length > 0 ||
    Object.keys(p.deletes).length > 0 ||
    p.newRows.some((r) => Object.values(r).some((v) => v !== '' && v != null))
  )
}

/**
 * Central, cross-platform keyboard-shortcut registry (TASK 71). Binds keys to
 * EXISTING store actions only; uses `mod` = Ctrl (Win/Linux) / Cmd (Mac); runs in
 * the capture phase and preventDefault()s the keys it owns so Chromium/Electron
 * defaults (reload on Ctrl+R, close on Ctrl+W, print on Ctrl+P) never fire.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      const mod = e.ctrlKey || e.metaKey
      const key = e.key
      const active = document.activeElement
      const inText = inTextEntry(active)
      const inEditor = !!active?.closest?.('.cm-editor')

      // Esc — close the topmost open overlay (only swallow the key if one closed,
      // so Esc still works inside editors/inputs when nothing is open).
      if (key === 'Escape') {
        if (s.closeTopOverlay()) e.preventDefault()
        return
      }

      // Shortcuts reference: F1, or Shift+? when not typing.
      if (key === 'F1' || (key === '?' && !inText)) {
        e.preventDefault()
        s.setShortcutsOpen(true)
        return
      }

      // F5 — smart refresh/run: refresh a table browse, else run the query. Always
      // preventDefault so the window never hard-reloads.
      if (key === 'F5') {
        e.preventDefault()
        const at = s.getActiveTab()
        if (at?.gridTable) void s.refreshPage()
        else void s.runActiveTab()
        return
      }

      if (!mod) return
      switch (key.toLowerCase()) {
        case 'enter':
          // The CodeMirror editor binds Mod-Enter itself; only handle it here when
          // focus is elsewhere (e.g. the grid) so a query still runs.
          if (!inEditor) { e.preventDefault(); void s.runActiveTab() }
          break
        case 'r':
          e.preventDefault() // never reload the whole Electron window
          void s.refreshPage()
          break
        case 't':
          e.preventDefault()
          s.addTab()
          break
        case 'w':
          e.preventDefault() // never close the window; close the active editor tab
          if (s.activeTabId) s.closeTab(s.activeTabId)
          break
        case 's':
          e.preventDefault() // never open the browser save dialog
          if (s.getActiveTab()?.gridTable && hasPendingEdits()) void s.applyChanges()
          break
        case 'b':
          e.preventDefault()
          s.toggleSidebar()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
