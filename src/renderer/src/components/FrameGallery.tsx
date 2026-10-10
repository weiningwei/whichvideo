/**
 * 「查看索引帧」弹层：网格浏览某视频建索引时保留的帧图。
 *
 * 数据分两层取：打开时先拉 manifest（帧序号 + 时间 + 文件是否存在，一次 IPC），
 * 图片本体逐帧懒取（一次全量 base64 约几 MB，没必要）。开关开启前的旧索引
 * 没有帧文件 —— 显示占位并在顶部给出「重建索引可保留」的提示。
 * 弹层结构沿用 ShortcutHelp 的模式：fixed 遮罩 + card、Esc 捕获、点遮罩关闭。
 */
import { useEffect, useState } from 'react'
import type { FrameManifestEntry, VideoRecord } from '@shared/types'

interface Props {
  video: VideoRecord | null
  onClose: () => void
  /** 请求重建该视频索引（帧文件缺失时的引导动作） */
  onReindex: (videoIds: number[]) => void
}

/** 帧时间标签：m:ss.d —— 一行放得下，还能区分间隔很近的两帧 */
function frameTimeLabel(timeMs: number): string {
  const total = Math.floor(timeMs / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  const tenth = Math.floor((timeMs % 1000) / 100)
  return `${m}:${String(s).padStart(2, '0')}.${tenth}`
}

function FrameImage({
  videoId,
  frameIndex,
  hasFile
}: {
  videoId: number
  frameIndex: number
  hasFile: boolean
}) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!hasFile) return
    let alive = true
    void window.whichvideo.videos.frameImage(videoId, frameIndex).then((d) => {
      if (alive) setSrc(d)
    })
    return () => {
      alive = false
    }
  }, [videoId, frameIndex, hasFile])

  if (!hasFile) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded border border-dashed border-line bg-surface-inset text-[10.5px] text-muted">
        未保留
      </div>
    )
  }
  if (!src) {
    return (
      <div className="aspect-video w-full animate-pulse rounded bg-surface-inset" aria-label="加载中" />
    )
  }
  return <img src={src} alt={`帧 ${frameIndex}`} className="w-full rounded" loading="lazy" />
}

export function FrameGallery({ video, onClose, onReindex }: Props) {
  const [manifest, setManifest] = useState<FrameManifestEntry[] | null>(null)

  useEffect(() => {
    if (!video) {
      setManifest(null)
      return
    }
    let alive = true
    void window.whichvideo.videos.frameManifest(video.id).then((list) => {
      if (alive) setManifest(list)
    })
    return () => {
      alive = false
    }
  }, [video])

  useEffect(() => {
    if (!video) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [video, onClose])

  if (!video) return null

  const entries = manifest ?? []
  const withFile = entries.filter((e) => e.hasFile).length
  const missing = entries.length - withFile

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink-950/70 p-6 pt-[6vh] backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="查看索引帧"
    >
      <div
        className="card flex max-h-[84vh] w-full max-w-4xl flex-col overflow-hidden p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold text-primary">
              索引帧 · {video.name}
            </h2>
            <p className="mt-0.5 text-[11.5px] text-muted">
              {manifest === null
                ? '读取帧清单…'
                : `共 ${entries.length} 帧${withFile > 0 ? `，已保留 ${withFile} 张` : ''}`}
            </p>
          </div>
          <button className="btn shrink-0 px-2 py-1 text-[12px] hover:bg-ink-700/70" onClick={onClose}>
            关闭
          </button>
        </div>

        {manifest !== null && missing > 0 && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[11.5px] text-secondary">
            <span>
              有 {missing} 帧未保留图片 —— 该视频建索引时「保留帧图片」开关未开启（或中途被关闭）。
              开启开关后重建索引即可保留。
            </span>
            <button
              className="btn shrink-0 px-2 py-0.5 text-[11.5px] hover:bg-ink-700/70"
              onClick={() => {
                onClose()
                onReindex([video.id])
              }}
            >
              重新索引
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {manifest !== null && entries.length === 0 ? (
            <div className="py-10 text-center text-[12px] text-muted">该视频还没有索引帧。</div>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
              {entries.map((entry) => (
                <figure key={entry.frameIndex} className="m-0">
                  <FrameImage
                    videoId={video.id}
                    frameIndex={entry.frameIndex}
                    hasFile={entry.hasFile}
                  />
                  <figcaption className="mt-0.5 text-center font-mono text-[10px] text-tertiary">
                    {frameTimeLabel(entry.timeMs)}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
