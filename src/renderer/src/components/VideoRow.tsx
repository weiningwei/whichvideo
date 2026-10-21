import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { VideoRecord, FrameProgress } from '@shared/types'
import { formatBytes, formatDuration, shortDir } from '../lib/format'
import { blockModifierTextSelection } from '../lib/selection'

export function VideoRow({
  video, roots, focused, depth = 0, showLocation = true, onOpen, onReveal, onRemove, onViewFrames, globalSampling,
  onSamplingChange, isVideoSelected, onRowClick, onOpenContextMenu, onOpenDouble,
  menuOpen, menuPoint, onToggleMenu, onCloseMenu, onNavigateKey
}: {
  video: VideoRecord
  roots: string[]
  focused: boolean
  depth?: number
  showLocation?: boolean
  onOpen: (id: number) => void
  onReveal: (id: number) => void
  onRemove: (id: number) => void
  onViewFrames: (id: number) => void
  globalSampling: 'uniform' | 'scene'
  onSamplingChange: (id: number, mode: 'uniform' | 'scene') => void
  isVideoSelected: (videoId: number) => boolean
  onRowClick: (shiftKey: boolean, ctrlKey: boolean) => void
  onOpenContextMenu: (x: number, y: number) => void
  onOpenDouble: (id: number) => void
  menuOpen: boolean
  menuPoint: { x: number; y: number } | null
  onToggleMenu: () => void
  onCloseMenu: () => void
  onNavigateKey: (event: ReactKeyboardEvent<HTMLElement>) => void
}) {
  const [thumb, setThumb] = useState<string | null>(null)
  const [frameProgress, setFrameProgress] = useState<FrameProgress | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let alive = true
    void window.whichvideo.videos.thumbnail(video.id)
      .then((data) => { if (alive) setThumb(data) })
      .catch(() => { if (alive) setThumb(null) })
    return () => { alive = false }
  }, [video.id, video.indexedAt])

  useEffect(() => {
    if (video.status !== 'indexing') { setFrameProgress(null); return }
    let alive = true
    let inFlight = false
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try { const progress = await window.whichvideo.videos.frameProgress(video.id); if (alive) setFrameProgress(progress) } catch { /* ignore */ }
      finally { inFlight = false }
    }
    void poll()
    const timer = setInterval(poll, 500)
    return () => { alive = false; clearInterval(timer) }
  }, [video.id, video.status])

  useEffect(() => {
    if (video.status !== 'indexing') { setElapsedSeconds(0); return }
    const started = Date.now()
    setElapsedSeconds(0)
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [video.id, video.status])

  const selected = isVideoSelected(video.id)
  const rowBg = selected ? 'bg-row-selected' : focused ? 'bg-row-focus' : 'hover:bg-row-hover'
  const sampling = video.samplingOverride ?? globalSampling
  const status = {
    ready: { label: '已索引', dot: 'bg-ok', text: 'text-secondary' },
    failed: { label: '失败', dot: 'bg-bad', text: 'text-bad' },
    indexing: { label: '索引中', dot: 'bg-accent', text: 'text-accent' },
    pending: { label: '待索引', dot: 'bg-warn', text: 'text-secondary' }
  }[video.status]
  const statusLabel = video.status === 'ready'
    ? `已索引 · ${video.frameCount} 帧`
    : video.status === 'indexing' && frameProgress?.phase !== 'detecting' && frameProgress
      ? frameProgress.done > 0 ? `索引中 · ${frameProgress.done}/${frameProgress.total} 帧` : '索引中 · 解码中'
      : status.label
  const statusTitle = video.error
    ?? (video.status === 'ready' ? `已建立 ${video.frameCount} 个索引采样帧` : '')

  const progress = (() => {
    if (!frameProgress || video.status !== 'indexing') return null
    const detecting = frameProgress.phase === 'detecting'
    const waiting = frameProgress.done === 0
    const pct = frameProgress.total > 0 ? Math.min(100, Math.round(frameProgress.done / frameProgress.total * 100)) : 0
    return (
      <div className="mt-1.5 w-24" title={detecting ? '正在检测镜头切换' : `FFmpeg 已输出 ${frameProgress.done}/${frameProgress.total} 帧`}>
        <div className="mb-1 flex justify-between text-[9.5px] text-tertiary">
          <span>{waiting ? `${detecting ? '检测' : '解码'} · ${elapsedSeconds}s` : detecting ? '检测场景' : '抽取帧'}</span>
          <span>{waiting ? '进行中' : `${pct}%`}</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-line">
          {waiting ? <div className="h-full w-1/3 animate-pulse bg-accent" /> : <div className="h-full bg-accent" style={{ width: `${pct}%` }} />}
        </div>
      </div>
    )
  })()

  return (
    <tr
      data-video-id={video.id}
      data-library-entry
      tabIndex={focused ? 0 : -1}
      onMouseDown={blockModifierTextSelection}
      onClick={(e) => { e.currentTarget.focus({ preventScroll: true }); onRowClick(e.shiftKey, e.ctrlKey || e.metaKey) }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.currentTarget.focus({ preventScroll: true })
        onOpenContextMenu(e.clientX, e.clientY)
      }}
      onKeyDown={(event) => { if (event.target === event.currentTarget) onNavigateKey(event) }}
      onDoubleClick={() => onOpenDouble(video.id)}
      className="group cursor-pointer border-b border-line/40 outline-none"
    >
      <td className={`relative px-3 py-2 transition-colors ${rowBg}`}>
        {(selected || focused) && <span className={`absolute inset-y-0 left-0 w-[2px] ${selected ? 'bg-accent' : 'bg-disabled/60'}`} />}
        <div className="flex items-center gap-3">
          {depth > 0 && <span className="shrink-0" style={{ width: `${Math.max(0, depth - 1) * 22}px` }} />}
          <div className="h-11 w-[72px] shrink-0 overflow-hidden rounded-md border border-line bg-surface-inset">
            {thumb && <img src={thumb} alt="" className="h-full w-full object-cover" />}
          </div>
          <div className="min-w-0">
            <div className={`line-clamp-1 break-all text-[13.5px] font-medium ${selected ? 'text-accent' : 'text-primary'}`} title={video.path}>{video.name}</div>
            {showLocation && <div className="mt-0.5 truncate text-[11px] text-tertiary" title={video.path}>{shortDir(video.path, roots) || video.dir}</div>}
          </div>
        </div>
      </td>
      <td className={`whitespace-nowrap px-2 py-2 align-middle transition-colors ${rowBg}`}>
        <div className={`flex items-center gap-1.5 text-[12px] ${status.text}`} title={statusTitle}>
          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />{statusLabel}
        </div>
        {progress}
      </td>
      <td className={`whitespace-nowrap px-2 py-2 text-[12px] tabular-nums text-secondary transition-colors ${rowBg}`}>{video.duration == null ? '—' : formatDuration(video.duration)}</td>
      <td className={`whitespace-nowrap px-2 py-2 text-[12px] tabular-nums text-secondary transition-colors ${rowBg}`}>{formatBytes(video.size)}</td>
      <td className={`sticky right-0 border-l border-line/50 px-2 py-2 transition-colors ${rowBg}`} onClick={(e) => e.stopPropagation()}>
        <div className="relative flex items-center justify-start gap-1" data-video-menu={video.id}>
          <button className="icon-btn h-7 w-7 text-[11px]" onClick={() => onOpen(video.id)} title="播放" aria-label={`播放 ${video.name}`}>▶</button>
          <button ref={menuButtonRef} className="icon-btn h-7 w-7 text-[15px]" onClick={onToggleMenu} title="更多" aria-expanded={menuOpen} aria-label={`更多操作 ${video.name}`}>···</button>
          {menuOpen && createPortal((() => {
            const rect = menuButtonRef.current?.getBoundingClientRect()
            const menuHeight = 200
            const top = menuPoint
              ? Math.max(8, Math.min(menuPoint.y, window.innerHeight - menuHeight - 8))
              : rect ? (rect.bottom + menuHeight > window.innerHeight ? Math.max(8, rect.top - menuHeight) : rect.bottom + 4) : 0
            const left = menuPoint
              ? Math.max(8, Math.min(menuPoint.x, window.innerWidth - 184))
              : rect ? Math.max(8, Math.min(rect.right - 176, window.innerWidth - 184)) : 0
            return <div data-video-menu={video.id} className="popover fixed z-50 w-44 p-1.5 text-left" style={{ top, left }} onClick={(e) => e.stopPropagation()}>
              <RowMenu label="查看索引帧" onClick={() => { onCloseMenu(); onViewFrames(video.id) }} />
              <RowMenu label="在资源管理器中显示" onClick={() => { onCloseMenu(); onReveal(video.id) }} />
              <RowMenu label={`按${sampling === 'uniform' ? '场景' : '均匀'}模式重建`} onClick={() => { onCloseMenu(); onSamplingChange(video.id, sampling === 'uniform' ? 'scene' : 'uniform') }} />
              <RowMenu label="重新索引" onClick={() => { onCloseMenu(); onSamplingChange(video.id, sampling) }} />
              <div className="my-1 border-t border-line" />
              <RowMenu label="从视频库移除" danger onClick={() => { onCloseMenu(); onRemove(video.id) }} />
            </div>
          })(), document.body)}
        </div>
      </td>
    </tr>
  )
}

function RowMenu({ label, danger, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  return <button className={`w-full rounded-lg px-2.5 py-1.5 text-left text-[11.5px] hover:bg-surface-3 ${danger ? 'text-bad' : 'text-secondary'}`} onClick={onClick}>{label}</button>
}
