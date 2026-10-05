import { useCallback, useState } from 'react'

export interface UseBusyReturn {
  busy: string | null
  withBusy: <T,>(label: string, fn: () => Promise<T>) => Promise<T | null>
}

export function useBusy(pushNotice: (level: 'info' | 'warn' | 'error', message: string) => void): UseBusyReturn {
  const [busy, setBusy] = useState<string | null>(null)

  const withBusy = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
      setBusy(label)
      try {
        return await fn()
      } catch (err) {
        pushNotice('error', err instanceof Error ? err.message : String(err))
        return null
      } finally {
        setBusy(null)
      }
    },
    [pushNotice]
  )

  return {
    busy,
    withBusy
  }
}