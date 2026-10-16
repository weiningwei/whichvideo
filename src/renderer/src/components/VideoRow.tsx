import { useEffect, useRef, useState } from 'react'
import type { VideoRecord, FrameProgress } from '@shared/types'
import { formatBytes, formatDuration, shortDir } from '../lib/format'
import { blockModifierTextSelection } from '../lib/selection'

export function VideoRow({
  video,
  roots,
  focused,
  onOpen,
  onReveal,
  onRemove,
  onViewFrames,
  globalSampling,
  onSamplingChange,
  isVideoSelected,
  onRowClick,
  onToggleCheck,
  onOpenDouble
}: {
  video: VideoRecord
  roots: string[]
  /** 键盘焦点所在行（↑/↓ 移动），用于显示淡灰焦点条 */
  focused: boolean
  onOpen: (id: number) => void
  onReveal: (id: number) => void
  onRemove: (id: number) => void
  /** 打开「查看索引帧」弹层 */
  onViewFrames: (id: number) => void
  /** 全局采样模式（该视频无覆盖时的生效值，用于列显示） */
  globalSampling: 'uniform' | 'scene'
  /**
   * 请求按指定采样模式重建该视频。**由「索引」按钮触发** —— 即使点选的
   * 采样模式与已固化值一致也照样重建（reindex 永远是 force），不再用
   * "采样方式未变"挡用户。下拉切换只记录选择（pending），不重建。
   */
  onSamplingChange: (id: number, mode: 'uniform' | 'scene') => void
  isVideoSelected: (videoId: number) => boolean
  /**
   * 点击整行（非复选框）。**必须同时移动光标**——光标与选中是同一个东西，
   * 只改选中会让光标留在原地，之后按 ↑/↓ 从旧位置起算（点第三个再按 ↑ 跳回第一个）。
   * 修饰键一起传上来，支持 Shift 连选与 Ctrl 点选。
   */
  onRowClick: (shiftKey: boolean, ctrlKey: boolean) => void
  /** 单击首列复选框：独立切换选中，不移动视频光标 */
  onToggleCheck: (id: number) => void
  /** 双击整行：用系统播放器打开（与资源管理器一致） */
  onOpenDouble: (id: number) => void
}) {
  const [thumb, setThumb] = useState<string | null>(null)
  // 用户在下拉里改选但尚未点「索引」的采样模式。null = 未改动（显示已固化值）。
  const [pendingSampling, setPendingSampling] = useState<'uniform' | 'scene' | null>(null)
  useEffect(() => {
    let alive = true
    void window.whichvideo.videos.thumbnail(video.id).then((d) => {
      if (alive) setThumb(d)
    })
    return () => {
      alive = false
    }
  }, [video.id, video.indexedAt])

  // 帧进度轮询（仅索引中时）
  const [frameProgress, setFrameProgress] = useState<FrameProgress | null>(null)
  useEffect(() => {
    if (video.status !== 'indexing') {
      setFrameProgress(null)
      return
    }
    let timer: ReturnType<typeof setInterval> | null = null
    let alive = true
    const poll = async () => {
      try {
        const p = await window.whichvideo.videos.frameProgress(video.id)
        if (alive) setFrameProgress(p)
      } catch {
        // 忽略
      }
    }
    poll()
    timer = setInterval(poll, 500)
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [video.id, video.status])

  // 计算已用时间与预估剩余时间
  const startTimeRef = useRef<number | null>(null)
  const prevDoneRef = useRef<number>(0)
  const sessionElapsedMs = frameProgress && video.status === 'indexing'
    ? Date.now() - (startTimeRef.current ?? Date.now())
    : 0
  const elapsedMs = (video.processedMs ?? 0) + sessionElapsedMs
  const remainingMs = (() => {
    if (!frameProgress || video.status !== 'indexing' || frameProgress.total <= 0) return 0
    const done = frameProgress.done
    if (done <= 0) return 0
    const rate = done / (sessionElapsedMs / 1000)
    if (rate <= 0) return 0
    return Math.round((frameProgress.total - done) / rate * 1000)
  })()

  useEffect(() => {
    if (frameProgress && video.status === 'indexing') {
      if (startTimeRef.current === null || frameProgress.done < prevDoneRef.current) {
        startTimeRef.current = Date.now()
      }
      prevDoneRef.current = frameProgress.done
    } else {
      startTimeRef.current = null
      prevDoneRef.current = 0
    }
  }, [frameProgress, video.status])

  const statusCls =
    video.status === 'ready'
      ? 'border-ok/40 bg-ok/10 text-ok'
      : video.status === 'failed'
        ? 'border-bad/40 bg-bad/10 text-bad'
        : video.status === 'indexing'
          ? 'border-accent/40 bg-accent/10 text-accent'
          : 'border-warn/40 bg-warn/10 text-warn'
  const statusText =
    video.status === 'ready'
      ? '已索引'
      : video.status === 'failed'
        ? '索引失败'
        : video.status === 'indexing'
          ? '索引中'
          : '待索引'

  const selected = isVideoSelected(video.id)

  const frameProgressBar = (() => {
    if (!frameProgress || video.status !== 'indexing') return null
    const detecting = frameProgress.phase === 'detecting'
    const twoPhase = (video.samplingOverride ?? globalSampling) === 'scene'
    const hasTotal = frameProgress.total > 0
    if (!detecting && !hasTotal) return null
    const pct = hasTotal ? Math.min(100, Math.round((frameProgress.done / frameProgress.total) * 100)) : null
    const countText =
      pct === null ? '分析中' : detecting ? `${pct}%` : `${frameProgress.done}/${frameProgress.total}`
    const hint = detecting
      ? hasTotal
        ? `场景检测：已分析 ${Math.round(frameProgress.done)}/${Math.round(frameProgress.total)} 秒`
        : '场景检测：正在分析镜头切换点'
      : `抽帧：已用 ${formatDuration(Math.round(elapsedMs / 1000))} · 剩余 ${
          remainingMs > 0 ? formatDuration(Math.round(remainingMs / 1000)) : '计算中'
        }`
    return (
      <div className="mt-1 space-y-1" title={hint}>
        <div className="flex items-center gap-1.5">
          <span
            className={`shrink-0 rounded px-1 py-px text-[9.5px] leading-tight ${
              detecting ? 'bg-warn/15 text-warn' : 'bg-accent/15 text-accent'
            }`}
          >
            {detecting ? '场景检测 1/2' : twoPhase ? '抽帧 2/2' : '抽帧'}
          </span>
          <span className="ml-auto text-[10px] leading-tight text-primary">{countText}</span>
        </div>
        <div
          className="h-2 rounded-full overflow-hidden bg-line"
          role="progressbar"
          aria-valuenow={pct ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={detecting ? `场景检测进度 ${pct ?? 0}%` : `帧进度 ${frameProgress.done}/${frameProgress.total}`}
        >
          <div
            className={`h-full transition-[width] duration-200 ease-out ${detecting ? 'bg-warn' : 'bg-accent'}`}
            style={{ width: `${pct ?? 0}%` }}
          />
        </div>
      </div>
    )
  })()

  const rowBg = selected
    ? 'bg-row-selected'
    : focused
      ? 'bg-row-focus'
      : 'hover:bg-row-hover'

  return (
    <tr
      data-video-id={video.id}
      onMouseDown={blockModifierTextSelection}
      onClick={(e) => onRowClick(e.shiftKey, e.ctrlKey || e.metaKey)}
      onDoubleClick={() => onOpenDouble(video.id)}
      className="group cursor-pointer border-b border-line/40"
    >
      {/* 首列复选框：独立切换选中，不移动视频光标（资源管理器式） */}
      <td className={`relative w-9 px-0 py-1.5 text-center transition-colors ${rowBg}`}>
        {selected ? (
          <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />
        ) : focused ? (
          <span className="absolute inset-y-0 left-0 w-[2px] bg-disabled/60" />
        ) : null}
        <input
          type="checkbox"
          checked={selected}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggleCheck(video.id)}
          aria-label={`选择 ${video.name}`}
          className="h-3.5 w-3.5 cursor-pointer accent-accent"
        />
      </td>
      <td className={`px-3 py-1.5 transition-colors ${rowBg}`}>
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 h-9 w-16 shrink-0 overflow-hidden rounded border border-line bg-surface-inset">
            {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : null}
          </div>
          <div className="min-w-0 flex-1">
            <div
              className={`line-clamp-2 break-all ${selected ? 'text-accent' : 'text-primary'}`}
              title={video.path}
            >
              {video.name}
            </div>
            <div className="truncate text-[10.5px] text-muted" title={video.path}>
              {[shortDir(video.path, roots), `${video.frameCount} 帧`].filter(Boolean).join(' · ')}
            </div>
          </div>
        </div>
      </td>
      <td className={`whitespace-nowrap px-2 py-1.5 align-top transition-colors ${rowBg}`}>
        <span className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${statusCls}`} title={video.error ?? ''}>
          {statusText}
        </span>
        {frameProgressBar}
      </td>
      {/* 时长 / 大小：Details 视图独立列（不再挤进元信息行） */}
      <td className={`whitespace-nowrap px-2 py-1.5 align-top tabular-nums text-secondary transition-colors ${rowBg}`}>
        {video.duration != null ? formatDuration(video.duration) : '—'}
      </td>
      <td className={`whitespace-nowrap px-2 py-1.5 align-top tabular-nums text-secondary transition-colors ${rowBg}`}>
        {formatBytes(video.size)}
      </td>
      <td className={`whitespace-nowrap px-2 py-1.5 align-top transition-colors ${rowBg}`}>
        {(() => {
          const applied = video.samplingOverride ?? globalSampling
          const pending = video.status === 'failed' ? null : pendingSampling
          const next = pending ?? applied
          return (
            <div className="flex flex-col gap-0.5" onClick={(e) => e.stopPropagation()}>
              {(['uniform', 'scene'] as const).map((m) => {
                const isNext = next === m
                const label = m === 'uniform' ? '均匀' : '场景'
                return (
                  <button
                    key={m}
                    className={`rounded border px-1 py-0.5 text-[10.5px] leading-tight ${
                      isNext
                        ? 'border-accent/60 bg-accent/10 text-accent'
                        : 'border-line text-muted hover:bg-ink-700/70'
                    }`}
                    title={
                      isNext && pending && pending !== applied
                        ? `${label}采样已选择，点「索引」生效`
                        : `${label}采样`
                    }
                    onClick={() => setPendingSampling(m)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          )
        })()}
      </td>
      {/* sticky：横向滚动时这格钉在右侧，五个按钮永远看得见、点得到 */}
      <td
        className={`sticky right-0 border-l border-line/70 px-3 py-1.5 align-top transition-colors ${rowBg}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-end gap-1">
          <button
            className={`btn px-1.5 py-0.5 text-[11px] hover:bg-ink-700/70 ${selected ? 'bg-surface-2 text-white' : ''}`}
            onClick={() => onOpen(video.id)}
            title="用系统播放器打开"
          >
            播放
          </button>
          <button
            className={`btn px-1.5 py-0.5 text-[11px] hover:bg-ink-700/70 ${selected ? 'bg-surface-2 text-white' : ''}`}
            onClick={() => onReveal(video.id)}
            title="在资源管理器中定位该文件"
          >
            定位
          </button>
          <button
            className={`btn px-1.5 py-0.5 text-[11px] hover:bg-ink-700/70 ${selected ? 'bg-surface-2 text-white' : ''}`}
            onClick={() => onViewFrames(video.id)}
            title="查看索引时间点（点击单帧动态解码）"
          >
            帧
          </button>
          <button
            className={`btn px-1.5 py-0.5 text-[11px] hover:bg-ink-700/70 ${selected ? 'bg-surface-2 text-white' : ''}`}
            onClick={() => onSamplingChange(video.id, pendingSampling ?? (video.samplingOverride ?? globalSampling))}
            title="重新抽帧并重建指纹（force：即使采样方式未变也照样重建）"
          >
            索引
          </button>
          <button
            className={`btn btn-danger px-1.5 py-0.5 text-[11px] hover:bg-bad/10 ${selected ? 'bg-surface-2 text-white' : ''}`}
            onClick={() => onRemove(video.id)}
            title="只从索引库移除记录，不会删除磁盘文件"
          >
            移除
          </button>
        </div>
      </td>
    </tr>
  )
}
