import { errorMessage } from '../lib/errors'
import { useCallback, useRef, useState } from 'react'

export interface UseBusyReturn {
  busy: string | null
  withBusy: <T,>(label: string, fn: () => Promise<T>) => Promise<T | null>
}

export function useBusy(pushNotice: (level: 'info' | 'warn' | 'error', message: string) => void): UseBusyReturn {
  const [busy, setBusy] = useState<string | null>(null)
  const operationSeq = useRef(0)
  const operations = useRef(new Map<number, string>())

  const withBusy = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
      const operationId = ++operationSeq.current
      operations.current.set(operationId, label)
      setBusy(label)
      try {
        return await fn()
      } catch (err) {
        pushNotice('error', errorMessage(err))
        return null
      } finally {
        operations.current.delete(operationId)
        const remaining = [...operations.current.values()]
        setBusy(remaining.at(-1) ?? null)
      }
    },
    [pushNotice]
  )

  return {
    busy,
    withBusy
  }
}
