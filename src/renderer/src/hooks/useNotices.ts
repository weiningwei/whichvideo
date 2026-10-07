import { useCallback, useEffect, useRef, useState } from 'react'

export interface Notice {
  id: number
  level: 'info' | 'warn' | 'error'
  message: string
  at: number
}

/**
 * 各级别通知的自动关闭时长（毫秒）。
 * info 是进度/操作反馈，看完即弃用最短；warn/error 需要更多阅读时间，
 * error 最长。鼠标悬停在浮层条目上会暂停倒计时（移开继续），避免
 * 正读到一半被收走。
 */
export const NOTICE_TTL: Record<Notice['level'], number> = {
  info: 5000,
  warn: 8000,
  error: 12000
}

let noticeSeq = 0

interface NoticeTimer {
  timer: ReturnType<typeof setTimeout> | null
  expiresAt: number
  /** 暂停时保存的剩余毫秒，恢复倒计时用 */
  remainingMs: number
}

export interface UseNoticesReturn {
  notices: Notice[]
  pushNotice: (level: Notice['level'], message: string) => void
  dismissNotice: (id: number) => void
  /** 悬停暂停该条倒计时 */
  pauseNotice: (id: number) => void
  /** 移开恢复倒计时（按暂停时的剩余时间续） */
  resumeNotice: (id: number) => void
}

export function useNotices(): UseNoticesReturn {
  const [notices, setNotices] = useState<Notice[]>([])
  const timers = useRef(new Map<number, NoticeTimer>())

  const dismissNotice = useCallback((id: number) => {
    const s = timers.current.get(id)
    if (s?.timer) clearTimeout(s.timer)
    timers.current.delete(id)
    setNotices((prev) => prev.filter((n) => n.id !== id))
  }, [])

  const schedule = useCallback(
    (id: number, ms: number) => {
      let s = timers.current.get(id)
      if (!s) {
        s = { timer: null, expiresAt: 0, remainingMs: 0 }
        timers.current.set(id, s)
      }
      if (s.timer) clearTimeout(s.timer)
      s.remainingMs = ms
      s.expiresAt = Date.now() + ms
      s.timer = setTimeout(() => dismissNotice(id), ms)
    },
    [dismissNotice]
  )

  const pushNotice = useCallback(
    (level: Notice['level'], message: string) => {
      // notice 在 updater 外构造：React 严格模式下 updater 可能被双执行，
      // 在里面 ++ 会让 id 跳号、副作用（起定时器）重复触发
      const next: Notice = { id: ++noticeSeq, level, message, at: Date.now() }
      setNotices((prev) => [next, ...prev].slice(0, 40))
      schedule(next.id, NOTICE_TTL[level])
    },
    [schedule]
  )

  const pauseNotice = useCallback((id: number) => {
    const s = timers.current.get(id)
    if (!s?.timer) return
    clearTimeout(s.timer)
    s.timer = null
    // 冻结剩余时间：恢复时从这里续，而不是从原始 TTL 重来
    s.remainingMs = Math.max(600, s.expiresAt - Date.now())
  }, [])

  const resumeNotice = useCallback(
    (id: number) => {
      const s = timers.current.get(id)
      if (!s || s.timer) return
      schedule(id, s.remainingMs)
    },
    [schedule]
  )

  // 卸载时清掉全部待触发的定时器（渲染端重挂载/热更新时防泄漏）
  useEffect(() => {
    const map = timers.current
    return () => {
      for (const s of map.values()) {
        if (s.timer) clearTimeout(s.timer)
      }
      map.clear()
    }
  }, [])

  return {
    notices,
    pushNotice,
    dismissNotice,
    pauseNotice,
    resumeNotice
  }
}
