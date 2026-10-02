import type { IndexerStatus } from '@shared/types'
import { formatClock } from '../lib/format'

interface Props {
  status: IndexerStatus | null
  busy: string | null
  notice?: { level: 'info' | 'warn' | 'error'; message: string; at: number } | null
}

export function StatusBar({ status, busy, notice }: Props) {
  const running = status?.running ?? false
  const total = status?.total ?? 0
  const done = (status?.done ?? 0) + (status?.failed ?? 0)
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

  return (
    <footer className="flex items-center gap-3 border-t border-line/80 bg-ink-900/80 px-5 py-2 text-[11.5px] text-muted">
      <span className={`flex items-center gap-1.5 ${running ? 'text-accent' : 'text-slate-500'}`}>
        <span
          className={`h-1.5 w-1.5 rounded-full ${running ? 'animate-pulse bg-accent' : 'bg-slate-600'}`}
        />
        {running ? '索引进行中' : status?.finishedAt ? '索引空闲' : '待机'}
      </span>

      {running && (
        <>
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-gradient-to-r from-accent to-accent-strong transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span>
            {done}/{total} · 并发 {status?.active} · 队列 {status?.queued}
          </span>
        </>
      )}

      {status?.currentPath && (
        <span className="max-w-[38ch] truncate text-slate-400" title={status.currentPath}>
          正在处理 {status.currentPath}
        </span>
      )}

      {!running && status?.finishedAt && <span>完成于 {formatClock(status.finishedAt)}</span>}
      {status?.lastError && (
        <span className="max-w-[32ch] truncate text-bad" title={status.lastError}>
          {status.lastError}
        </span>
      )}

      <span className="ml-auto truncate">
        {busy ? (
          <span className="text-accent">{busy}</span>
        ) : notice ? (
          <span
            className={
              notice.level === 'error'
                ? 'text-bad'
                : notice.level === 'warn'
                  ? 'text-warn'
                  : 'text-slate-400'
            }
          >
            {notice.message}
          </span>
        ) : (
          <span className="text-slate-600">
            拖入图片 / Ctrl+V 粘贴 / 选择图片文件，即可查询视频是否已在库中
          </span>
        )}
      </span>
    </footer>
  )
}
