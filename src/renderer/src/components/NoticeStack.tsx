import type { Notice } from '../hooks/useNotices'

interface Props {
  notices: Notice[]
  onDismiss: (id: number) => void
  onPause: (id: number) => void
  onResume: (id: number) => void
}

export function NoticeStack({ notices, onDismiss, onPause, onResume }: Props) {
  if (notices.length === 0) return null
  return (
    <div className="pointer-events-auto absolute bottom-12 right-4 flex w-[360px] flex-col-reverse gap-2" aria-live="polite" aria-label="操作通知">
      {notices.map((notice) => (
        <button
          key={notice.id}
          role={notice.level === 'error' ? 'alert' : 'status'}
          onClick={() => onDismiss(notice.id)}
          onMouseEnter={() => onPause(notice.id)}
          onMouseLeave={() => onResume(notice.id)}
          title="悬停暂停自动关闭；点击立即关闭"
          className={`rounded-xl border px-3 py-2 text-left text-[11.5px] shadow-lg backdrop-blur ${
            notice.level === 'error'
              ? 'border-bad/50 bg-bad/15 text-bad'
              : notice.level === 'warn'
                ? 'border-warn/50 bg-warn/15 text-warn'
                : 'border-line bg-surface-2/95 text-secondary'
          }`}
        >
          {notice.message}
        </button>
      ))}
    </div>
  )
}
