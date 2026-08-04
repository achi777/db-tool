import { useState } from 'react'
import { PAGE_SIZES } from '@shared/types'
import { useStore } from '../store'
import { IconFirst, IconPrev, IconNext, IconLast, IconJump, IconRefresh } from '../actionIcons'

/** Windowed page numbers: 1 … 4 5 [6] 7 8 … 120 */
function pageWindow(current: number, totalPages: number): (number | '…')[] {
  const out: (number | '…')[] = []
  const push = (n: number | '…'): void => {
    out.push(n)
  }
  const first = 1
  const last = totalPages
  const lo = Math.max(first + 1, current - 2)
  const hi = Math.min(last - 1, current + 2)
  push(first)
  if (lo > first + 1) push('…')
  for (let p = lo; p <= hi; p++) push(p)
  if (hi < last - 1) push('…')
  if (last > first) push(last)
  return out
}

export function PaginationBar(): JSX.Element | null {
  const at = useStore((s) => s.getActiveTab())
  const goToPage = useStore((s) => s.goToPage)
  const setPageSize = useStore((s) => s.setPageSize)
  const refreshPage = useStore((s) => s.refreshPage)
  const [jump, setJump] = useState('')

  // Only for table browsing (a table is open), not ad-hoc query results.
  if (!at || !at.gridTable || !at.gridSpec) return null

  const { page, pageSize, total, countLoading } = at
  const totalPages = total != null ? Math.max(1, Math.ceil(total / pageSize)) : null
  const rows = at.result?.rows.length ?? 0
  const startRow = total === 0 ? 0 : (page - 1) * pageSize + 1
  const endRow = (page - 1) * pageSize + rows

  const go = (p: number): void => void goToPage(p)
  const doJump = (): void => {
    const n = parseInt(jump, 10)
    if (Number.isFinite(n)) go(n)
    setJump('')
  }

  const win = totalPages != null ? pageWindow(page, totalPages) : [page]

  return (
    <div className="pager">
      <button className="pg-btn" disabled={page <= 1} onClick={() => go(1)} title="First">
        <IconFirst />
      </button>
      <button className="pg-btn" disabled={page <= 1} onClick={() => go(page - 1)} title="Previous">
        <IconPrev />
      </button>

      {win.map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} className="pg-ellipsis">
            …
          </span>
        ) : (
          <button
            key={p}
            className={'pg-btn' + (p === page ? ' active' : '')}
            onClick={() => go(p)}
          >
            {p}
          </button>
        )
      )}

      <button
        className="pg-btn"
        disabled={totalPages != null && page >= totalPages}
        onClick={() => go(page + 1)}
        title="Next"
      >
        <IconNext />
      </button>
      <button
        className="pg-btn"
        disabled={totalPages == null || page >= totalPages}
        onClick={() => totalPages && go(totalPages)}
        title="Last"
      >
        <IconLast />
      </button>

      <span className="pg-info">
        Rows {startRow}–{endRow} of {countLoading || total == null ? '…' : total}
      </span>

      <span className="spacer" />

      <label className="pg-size">
        Page size
        <select value={pageSize} onChange={(e) => void setPageSize(Number(e.target.value))}>
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <span className="pg-goto">
        Go to
        <input
          value={jump}
          placeholder={String(page)}
          onChange={(e) => setJump(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && doJump()}
        />
        <button className="pg-btn" onClick={doJump} disabled={!jump} title="Go to page">
          <IconJump />
        </button>
      </span>

      <button className="pg-btn" onClick={() => void refreshPage()} title="Refresh">
        <IconRefresh />
      </button>
    </div>
  )
}
