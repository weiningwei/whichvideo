/**
 * 「查看索引帧」弹层：每帧一张卡片，标题 `index/total-时间点`，
 * 点击卡片区域按需从视频动态解码该时间点的画面（matchFrame 走 ffmpeg
 * 单点 seek，跟搜索命中预览共用一条链路）。
 *
 * 不再依赖 `keepFrameImages` 落盘的帧图：
 *   · 老行为：解码时把每帧 JPEG 写到 `frames/<videoId>/<timeMs>.jpg`，弹层
 *     懒取。开关未开 → "未保留"占位；用户得手动开开关 + 重建索引才能看图
 *   · 新行为：每张卡片默认只显示标题 + 「点击解析」占位，点击触发解码
 *   · 收益：开关无用、磁盘不再膨胀（每视频几百 KB~MB）、首次打开瞬时显示
 *
 * 「▶ 播放」按钮独立于解码点击 —— 解码是"看图"，播放是"从该时间起播"，
 * 两件事不能挤在同一个手势里。
 *
 * 弹层结构沿用 ShortcutHelp 的模式：fixed 遮罩 + card、Esc 捕获、点遮罩关闭。
 */
import { useEffect, useState } from 'react'
import type { FrameManifestEntry, VideoRecord } from '@shared/types'
import { useModalFocus } from '../hooks/useModalFocus'

interface Props {
  video: VideoRecord | null
  onClose: () => void
  /**
   * 点击单帧：从该时间起播（atSeconds 单位：秒）。
   * 由 LibraryView 从 onOpen 派生：弹层选中 → 关闭弹层 → 唤起播放器。
   */
  onOpenFrame: (videoId: number, atSeconds: number) => void
}

/** 帧时间标签：m:ss.d —— 一行放得下，还能区分间隔很近的两帧 */
function frameTimeLabel(timeMs: number): string {
  const total = Math.floor(timeMs / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  const tenth = Math.floor((timeMs % 1000) / 100)
  return `${m}:${String(s).padStart(2, '0')}.${tenth}`
}

function FrameCard({
  videoId,
  frameIndex,
  total,
  timeMs,
  onPlayAt
}: {
  videoId: number
  frameIndex: number
  total: number
  timeMs: number
  onPlayAt: () => void
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [errored, setErrored] = useState(false)

  /**
   * 按需解码：仅在用户主动点击后才发 matchFrame，避免一打开弹层就并发起 N
   * 个 ffmpeg 进程（N 可达 240）。FFmpeg 进程同开多了调度开销远高于顺序解码，
   * 实测对 60 帧的弹层会顿 1~2 秒。点击触发后即用即取，体验反而更顺。
   */
  const decode = () => {
    if (src || loading) return
    setLoading(true)
    setErrored(false)
    void window.whichvideo.videos
      .matchFrame(videoId, timeMs)
      .then((data) => {
        if (data) setSrc(data)
        else setErrored(true)
      })
      .catch(() => setErrored(true))
      .finally(() => setLoading(false))
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      decode()
    }
  }

  const title = `${frameIndex + 1}/${total}-${frameTimeLabel(timeMs)}`

  return (
    <figure className="m-0">
      <div className="mb-0.5 flex items-center justify-between gap-1">
        <span
          className="truncate font-mono text-[10px] text-tertiary"
          title={title}
        >
          {title}
        </span>
        <button
          onClick={onPlayAt}
          title={`从 ${frameTimeLabel(timeMs)} 起播`}
          className="shrink-0 rounded px-1 py-px text-[10px] leading-tight text-muted hover:bg-ink-700/70 hover:text-primary"
        >
          ▶
        </button>
      </div>
      <div
        role="button"
        tabIndex={0}
        onClick={decode}
        onKeyDown={handleKey}
        className="flex aspect-video w-full cursor-pointer items-center justify-center overflow-hidden rounded border border-line bg-surface-inset text-[10.5px] text-muted transition hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        title={`点击从视频解析 ${frameTimeLabel(timeMs)} 处的画面`}
      >
        {loading ? (
          <span className="animate-pulse">解析中…</span>
        ) : errored ? (
          <span className="text-bad">解析失败</span>
        ) : src ? (
          <img src={src} alt={title} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <span>点击解析</span>
        )}
      </div>
    </figure>
  )
}

export function FrameGallery({ video, onClose, onOpenFrame }: Props) {
  const dialogRef = useModalFocus<HTMLDivElement>(video !== null, onClose)
  const [manifest, setManifest] = useState<FrameManifestEntry[] | null>(null)
  const [manifestError, setManifestError] = useState(false)

  useEffect(() => {
    setManifest(null)
    setManifestError(false)
    if (!video) {
      return
    }
    let alive = true
    void window.whichvideo.videos.frameManifest(video.id)
      .then((list) => { if (alive) setManifest(list) })
      .catch(() => { if (alive) setManifestError(true) })
    return () => {
      alive = false
    }
  }, [video?.id])

  if (!video) return null

  const entries = manifest ?? []
  const total = entries.length

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink-950/70 p-6 pt-[6vh] backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="查看索引帧"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="card flex max-h-[84vh] w-full max-w-4xl flex-col overflow-hidden p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold text-primary">
              索引帧 · {video.name}
            </h2>
            <p className="mt-0.5 text-[11.5px] text-muted">
              {manifestError
                ? '读取帧清单失败，请关闭后重试'
                : manifest === null
                  ? '读取帧清单…'
                : `共 ${total} 帧 · 点击单帧从视频动态解析，▶ 从该时间播放`}
            </p>
          </div>
          <button className="btn shrink-0 px-2 py-1 text-[12px] hover:bg-ink-700/70" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {manifest !== null && entries.length === 0 ? (
            <div className="py-10 text-center text-[12px] text-muted">该视频还没有索引帧。</div>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
              {entries.map((entry) => (
                <FrameCard
                  key={`${entry.frameIndex}-${entry.timeMs}`}
                  videoId={video.id}
                  frameIndex={entry.frameIndex}
                  total={total}
                  timeMs={entry.timeMs}
                  onPlayAt={() => {
                    onClose()
                    onOpenFrame(video.id, entry.timeMs / 1000)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
