// Ambient declaration so the renderer sees a typed window.dbApi.
import type { DbApi } from '@shared/types'

declare global {
  interface Window {
    dbApi: DbApi
  }
}

export {}
