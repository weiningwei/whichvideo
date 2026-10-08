import { useEffect, useState, useRef } from 'react'
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
  globalSampling,
  onSamplingChange,
  isVideoSelected,
  onRowClick
}: {
  video: VideoRecord
  roots: string[]
  /** 键盘焦点所在行（↑/↓ 移动），用于显示淡灰焦点条 */
  focused: boolean
  onOpen: (id: number) => void
  onReveal: (id: number) => void
  onRemove: (id: number) => void
  /** 全局采样模式（该视频无覆盖时的生效值，用于列显示） */
  globalSampling: 'uniform' | 'scene'
  /**
   * 请求按指定采样模式重建该视频。**由「索引」按钮触发** —— 下拉切换只
   * 记录选择（pending），不重建。useLibrary.reindex 里判定模式是否变化：
   * 没变会提示"无需重建"而不是重复重建。
   */
  onSamplingChange: (id: number, mode: 'uniform' | 'scene') => void
  isVideoSelected: (videoId: number) => boolean
  /**
   * 点击整行。**必须同时移动光标**——光标与选中是同一个东西，只改选中会让
   * 光标留在原地，之后按 ↑/↓ 从旧位置起算（点第三个再按 ↑ 跳回第一个）。
   * 修饰键一起传上来，是为了支持 Shift 连选与 Ctrl 点选。
   */
  onRowClick: (shiftKey: boolean, ctrlKey: boolean) => void
}) {
  const [thumb, setThumb] = useState<string | null>(null)
  // 用户在下拉里改选但尚未点「索引」的采样模式。null = 未改动（显示已固化值）。
  // 刻意放行级本地 state：跨筛选/翻页丢失"未应用的选择"是可接受的 —— 那本来
  // 就还没生效。点「索引」时才把它交给 onSamplingChange 真正应用。
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
  // 累计已用时间 = 数据库存储的跨会话耗时 + 本次会话耗时
  const sessionElapsedMs = frameProgress && video.status === 'indexing'
    ? Date.now() - (startTimeRef.current ?? Date.now())
    : 0
  const elapsedMs = (video.processedMs ?? 0) + sessionElapsedMs
  const remainingMs = (() => {
    if (!frameProgress || video.status !== 'indexing' || frameProgress.total <= 0) return 0
    const done = frameProgress.done
    if (done <= 0) return 0
    const rate = done / (sessionElapsedMs / 1000) // frames per second（基于本次会话速率）
    if (rate <= 0) return 0
    return Math.round((frameProgress.total - done) / rate * 1000)
  })()

  // 初始化/重置开始时间
  useEffect(() => {
    if (frameProgress && video.status === 'indexing') {
      if (startTimeRef.current === null || frameProgress.done < prevDoneRef.current) {
        // 首次获取到进度，或进度回退（重新开始），记录开始时间
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

  /**
   * 进度条（仅索引中显示）。两个阶段共用一条进度条，语义由 phase 决定：
   * - phase='detecting'：场景检测（一次全片低分辨率解码），done/total 是
   *   已解码秒数 / 总时长秒数 —— 这是场景采样比均匀采样多出的第一段等待，
   *   不显示的话长视频检测期间界面像卡死；时长未知时显示不定态「分析中」
   * - phase='extracting'（默认）：抽帧，done/total 是帧数
   * 算采样计划（阶段 2）是毫秒级纯计算，不单独占进度条。
   */
  const frameProgressBar = (() => {
    if (!frameProgress || video.status !== 'indexing') return null
    const detecting = frameProgress.phase === 'detecting'
    const hasTotal = frameProgress.total > 0
    if (!detecting && !hasTotal) return null
    const pct = hasTotal
      ? Math.min(100, Math.round((frameProgress.done / frameProgress.total) * 100))
      : null
    const label = detecting
      ? `场景检测${pct === null ? '中…' : ''}`
      : `已用 ${formatDuration(Math.round(elapsedMs / 1000))}`
    return (
      <div className="mt-1 space-y-0.5">
        <div className="flex items-center gap-1.5 text-[10px] text-muted">
          <span className="whitespace-nowrap flex items-center gap-1">
            <span>{label}</span>
            {!detecting && (
              <>
                <span className="text-line">·</span>
                <span>剩余 {remainingMs > 0 ? formatDuration(Math.round(remainingMs / 1000)) : '计算中...'}</span>
              </>
            )}
          </span>
          <span className="whitespace-nowrap text-primary ml-auto">
            {pct === null ? '分析中' : detecting ? `${pct}%` : `${frameProgress.done}/${frameProgress.total}`}
          </span>
        </div>
        <div
          className="h-2 bg-line rounded-full overflow-hidden relative"
          role="progressbar"
          aria-valuenow={pct ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={detecting ? `场景检测进度 ${pct ?? 0}%` : `帧进度 ${frameProgress.done}/${frameProgress.total}`}
        >
          <div
            className="h-full bg-accent transition-[width] duration-200 ease-out"
            style={{ width: `${pct ?? 0}%` }}
          />
          {pct !== null && (
            <span className="absolute inset-0 flex items-center justify-center text-[8px] text-white/90 select-none pointer-events-none whitespace-nowrap">
              {pct}%
            </span>
          )}
        </div>
      </div>
    )
  })()

  /**
   * 选中提示。**单选与多选完全一致** —— 竖条 + 淡蓝底，两样一起上。
   *
   * 曾经分过两档（多选只留竖条），又取消过（单选多选都三样），现在定为
   * **标题与按钮都不参与染色**。理由：那两处蓝色不是"选中信号"，而是噪声 ——
   *   - 标题染成 accent 蓝后，一眼扫过去分不清是"这一项被选中"还是"这几项都选中"，
   *     反而不如竖条 + 底色来得明确
   *   - 操作按钮的 btn-bg 是半透明的，淡蓝底会从底下透上来把按钮连边框一起染蓝，
   *     看着像"按钮被激活了"，实际它们只是可点
   * 于是蓝色只留给左侧竖条与行底色 —— 这两处占地最小、语义最准。
   *
   * 仍然不做 `selectedCount` 之类的分档：多选就是"多个行各自被选中"，
   * 每行的呈现与它单独被选中时没有区别。
   */
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
      className="group cursor-pointer border-b border-line/40"
    >
      <td className={`relative px-3 py-1.5 transition-colors ${rowBg}`}>
        {/* 状态提示用左侧 2px 竖条（绝对定位，不占列宽）：
            选中 = accent 蓝条；仅键盘光标 = 淡灰条。两者同时存在时以选中为准。 */}
        {selected ? (
          <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />
        ) : focused ? (
          <span className="absolute inset-y-0 left-0 w-[2px] bg-disabled/60" />
        ) : null}
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 h-9 w-16 shrink-0 overflow-hidden rounded border border-line bg-surface-inset">
            {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : null}
          </div>
          <div className="min-w-0 flex-1">
            {/* 文件名最多两行：单行 truncate 时长片名（尤其带 [1080p][x264] 那种）
                会被截到看不出是什么剧，而横向滚动才能看到全名很反直觉。
                第二行的元信息保持单行——目录路径常有重复前缀，展开反而更吵。 */}
            {/* 选中时文件名染强调色（与状态徽标同色）——单选多选走同一个
                `selected` 条件，天然一致，不分档。 */}
            <div
              className={`line-clamp-2 break-all ${selected ? 'text-accent' : 'text-primary'}`}
              title={video.path}
            >
              {video.name}
            </div>
            <div className="truncate text-[10.5px] text-muted" title={video.path}>
              {/* 目录（不含文件名，避免与上一行重复）· 时长 · 体积 · 帧数 */}
              {[
                shortDir(video.path, roots),
                formatDuration(video.duration),
                formatBytes(video.size),
                `${video.frameCount} 帧`
              ]
                .filter(Boolean)
                .join(' · ')}
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
      <td className={`whitespace-nowrap px-2 py-1.5 align-top transition-colors ${rowBg}`}>
        {(() => {
          // 两种模式各一个按钮，**单一选中态**：只有"将要生效的"高亮，另一个
          // 普通灰。曾试过"当前实际=绿 + 将应用=蓝"双色并存 —— 用户实测完全
          // 分不出哪个是哪个，弃。待应用未点「索引」时 hover 提示说明。
          const applied = video.samplingOverride ?? globalSampling
          // 索引失败时忽略未应用的 pending 选择，回退显示事实值 ——
          // 失败意味着按 pending 模式的重建没成功，显示它反而误导
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
      {/* sticky：横向滚动时这格钉在右侧，四个按钮永远看得见、点得到。

          底色要**不透明**，否则左侧滚过来的文字会透上来叠在按钮上。行状态色
          （选中蓝 / 光标灰 / hover）改由这格自己带——不能靠 tr 或绝对定位的
          覆盖层，前者会被这格的底色盖住，后者在表格布局里定位不可靠。 */}
      <td
        className={`sticky right-0 border-l border-line/70 px-3 py-1.5 align-top transition-colors ${rowBg}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 四个操作全部平铺显示，文字精简到 2 字（播放 / 定位 / 索引 / 移除）。
            按钮内边距收到 px-1.5，四项合计约 156px，比原来的「播放+⋯」73px
            多占 83px，但省掉了点开菜单这一步，操作列由 w-28 放宽到 w-[180px]。 */}
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
            onClick={() => onSamplingChange(video.id, pendingSampling ?? (video.samplingOverride ?? globalSampling))}
            title="重新抽帧并重建指纹（采样方式与上次一致时会提示无需重建）"
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
