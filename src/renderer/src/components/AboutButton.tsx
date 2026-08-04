import { useEffect, useState, type MouseEvent } from 'react'
import { IconInfo, IconClose } from '../actionIcons'
import { useStore } from '../store'
import type { AppInfo } from '@shared/types'

const WEBSITE = 'https://codemake.co'
const EMAIL = 'archil.odishelidze@gmail.com'

/**
 * Unobtrusive About entry point (info icon in the status bar) + its modal.
 * Website/email open in the OS default handler via the whitelisted
 * `openExternal` preload method — the app window is never navigated to them.
 * Closes via ×, the Close button, Esc, or click-away.
 */
export function AboutButton(): JSX.Element {
  // Open state lives in the store so the native Help ▸ About menu (TASK 72) can
  // drive the same dialog the status-bar info button opens.
  const open = useStore((s) => s.aboutOpen)
  const setOpen = useStore((s) => s.setAboutOpen)
  const [info, setInfo] = useState<AppInfo | null>(null)

  // Fetch product name + version lazily the first time it's opened.
  useEffect(() => {
    if (open && !info) void window.dbApi.getAppInfo().then(setInfo)
  }, [open, info])

  // Esc closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const ext = (url: string) => (e: MouseEvent) => {
    e.preventDefault()
    void window.dbApi.openExternal(url)
  }

  const name = info?.name ?? 'DB Tool'

  return (
    <>
      <button className="about-btn" title="About" aria-label="About" onClick={() => setOpen(true)}>
        <IconInfo size={14} />
      </button>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal about-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="About">
            <div className="about-head">
              <div className="about-app">
                <IconInfo size={26} className="about-logo" />
                <div>
                  <div className="about-name">{name}</div>
                  <div className="about-version">v{info?.version ?? '…'}</div>
                </div>
              </div>
              <span className="del-x" title="Close" onClick={() => setOpen(false)}>
                <IconClose size={16} />
              </span>
            </div>

            <p className="about-freeware">{name} is freeware.</p>

            <div className="about-grid">
              <div className="about-section">
                <div className="about-label">Company</div>
                <div className="about-value">© LLC Codemake</div>
                <a className="about-link" href={WEBSITE} onClick={ext(WEBSITE)}>
                  {WEBSITE}
                </a>
              </div>

              <div className="about-section">
                <div className="about-label">Developed by</div>
                <div className="about-value">Archil Odishelidze</div>
                <a className="about-link" href={`mailto:${EMAIL}`} onClick={ext(`mailto:${EMAIL}`)}>
                  {EMAIL}
                </a>
              </div>
            </div>

            <div className="about-actions">
              <button className="icon-text-btn primary" onClick={() => setOpen(false)}>
                <IconClose /> Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
