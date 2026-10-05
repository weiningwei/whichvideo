import { useCallback, useState } from 'react'

export interface Notice {
  id: number
  level: 'info' | 'warn' | 'error'
  message: string
  at: number
}

let noticeSeq = 0

export interface UseNoticesReturn {
  notices: Notice[]
  pushNotice: (level: Notice['level'], message: string) => void
  dismissNotice: (id: number) => void
}

export function useNotices(): UseNoticesReturn {
  const [notices, setNotices] = useState<Notice[]>([])

  const pushNotice = useCallback((level: Notice['level'], message: string) => {
    setNotices((prev) => {
      const next: Notice = { id: ++noticeSeq, level, message, at: Date.now() }
      return [next, ...prev].slice(0, 40)
    })
  }, [])

  const dismissNotice = useCallback((id: number) => {
    setNotices((prev) => prev.filter((n) => n.id !== id))
  }, [])

  return {
    notices,
    pushNotice,
    dismissNotice
  }
}