import type { WhichVideoApi } from '@shared/types'

declare global {
  interface Window {
    whichvideo: WhichVideoApi
  }
}

export {}
