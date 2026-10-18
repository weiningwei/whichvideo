import { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchMatch, SearchResponse, VideoRecord } from '@shared/types'
import { formatBytes, formatDuration, formatPercent, scoreColor, scoreLabel } from '../lib/format'

interface Props {
  search: SearchResponse | null
  searching: boolean
  error: string | null
  queryImage: string | null
  queryLabel: string | null
  hasIndexedFrames: boolean
  onPickImageFile: () => Promise<string[]>
  onSearchPath: (path: string) => void
  onSearchDataUrl: (dataUrl: string, label: string) => void
  onSearchClipboard: () => void
  onSearchUrl: (url: string) => void
  onReSearch: () => void
  onClear: () => void
  onOpen: (videoId: number, atSeconds?: number) => void
  onReveal: (videoId: number) => void
  onReindex: (videoId: number) => void
}

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif|avif)$/i

export function SearchView(props: Props) {
  const {
    search,
    searching,
    error,
    queryImage,
    queryLabel,
    hasIndexedFrames,
    onPickImageFile,
    onSearchPath,
    onSearchDataUrl,
    onSearchClipboard,
    onReSearch,
    onClear
  } = props

  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [urlInput, setUrlInput] = useState('')

  /**
   * 提交链接检索。
   *
   * 清空输入框而不是保留：URL 又长又占地方，检索完用户关心的是结果卡片；
   * 需要重搜同一张图时结果卡片与顶部"重新搜索"按钮已经够用。
   * 真要再搜同一个链接，重新粘贴更省事。
   */
  const submitUrl = () => {
    const url = urlInput.trim()
    if (!url || searching) return
    setUrlInput('')
    props.onSearchUrl(url)
  }

  // Ctrl+K 聚焦链接输入框。放在本组件而不是 App：只有搜索页有这个框，
  // App 里的全局处理拿不到 ref。
  const urlInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        urlInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (!file) continue
          event.preventDefault()
          void toDataUrl(file).then((dataUrl) => onSearchDataUrl(dataUrl, `剪贴板图片 ${file.type}`))
          return
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [onSearchDataUrl])

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = Array.from(event.dataTransfer.files ?? [])
    const image = files.find((f) => f.type.startsWith('image/') || IMAGE_EXT.test(f.name))
    if (!image) return
    const path = (image as File & { path?: string }).path
    if (path) {
      onSearchPath(path)
      return
    }
    const dataUrl = await toDataUrl(image)
    onSearchDataUrl(dataUrl, image.name)
  }

  const matches = search?.matches ?? []
  const top = matches[0]

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onDragEnter={(e) => {
        e.preventDefault()
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={handleDrop}
    >
      <div className={`mx-auto flex w-full min-w-0 flex-col gap-3 p-5 ${search ? '' : 'max-w-3xl pt-14'}`}>
        <div
          className={`relative flex min-w-0 items-center gap-5 rounded-2xl border p-5 transition ${
            dragging ? 'border-accent bg-accent/10' : 'border-line bg-surface-2'
          }`}
        >
          <div className="grid h-28 w-28 shrink-0 place-items-center overflow-hidden rounded-2xl border border-line bg-surface-inset">
            {queryImage ? (
              <img src={queryImage} alt="查询图片" className="h-full w-full object-cover" />
            ) : (
              <span className="text-3xl text-tertiary">
                {queryLabel?.startsWith('http') ? '↗' : '＋'}
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-semibold text-primary">
              {queryLabel ?? '用一张图，找到视频'}
            </div>
            <div className="mt-1 text-[11.5px] text-tertiary">
              {search
                ? `${search.matchCount} 个结果 · ${search.elapsedMs} ms`
                : '拖放图片到这里，也可以选择文件或粘贴截图'}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="btn hover:bg-ink-700/70"
                disabled={searching}
                onClick={async () => {
                  const paths = await onPickImageFile()
                  if (paths.length) onSearchPath(paths[0])
                }}
              >
                选择图片
              </button>
              <button className="btn hover:bg-ink-700/70" disabled={searching} onClick={onSearchClipboard}>
                粘贴截图
              </button>
              {queryImage && (hasIndexedFrames || error) && (
                <button
                  className="btn hover:bg-ink-700/70"
                  disabled={searching}
                  onClick={onReSearch}
                  title="用同一张图片重新搜索"
                >
                  重搜
                </button>
              )}
              {(search || error) && (
                <button className="btn hover:bg-ink-700/70" onClick={onClear}>
                  清除
                </button>
              )}
              {searching && <span className="self-center text-[12px] text-accent">比对中…</span>}
            </div>

            <div className="mt-2.5 flex items-center gap-2">
              <input
                ref={urlInputRef}
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitUrl()
                  }
                }}
                placeholder="粘贴图片或网页链接"
                spellCheck={false}
                disabled={searching}
                className="min-w-0 flex-1 rounded-lg border border-line bg-ink-900/70 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-tertiary focus:border-accent/60 disabled:opacity-50"
              />
              <button
                className="btn shrink-0 px-2.5 py-1.5 text-[12px] hover:bg-ink-700/70"
                disabled={searching || !urlInput.trim()}
                onClick={submitUrl}
                title="从链接取图并检索（支持 og:image、网页首图）"
              >
                搜索
              </button>
            </div>
            {search && search.comparedFrames === 0 && (
              <div className="mt-2 text-[11.5px] text-warn">
                索引库还没有任何帧指纹：请先在「视频库与监听」里导入视频或文件夹。
              </div>
            )}
          </div>

        </div>

        {error && (
          <div className="rounded-xl border border-bad/40 bg-bad/10 px-4 py-2.5 text-[12.5px] text-bad">
            {error}
          </div>
        )}

        {search && search.matchCount > 0 && (
          <div className="rounded-xl border border-ok/35 bg-ok/10 px-4 py-2.5 text-[13px] text-ok">
            {/* 单匹配直接说"对应的视频"；多匹配改"对应的视频（X 个匹配）"，让用户知道
                列表里还有其他候选 —— maxResults 默认 ≥ 1 但 ≥2 也常见（截图通用化 / 多个视频
                含同一帧）。top 一行始终给最佳（最高分）的位置，决策锚点。 */}
            找到了{search.matchCount > 1 ? ` ${search.matchCount} 个匹配` : ''}：{top?.video.name}
            {top && top.timeSeconds > 0 ? (
              <>
                {'（'}
                {top.video.frameCount > 0 ? `${top.frameIndex + 1}/${top.video.frameCount} · ` : ''}
                约 {formatDuration(top.timeSeconds)} 处
                {'）'}
              </>
            ) : ''}
          </div>
        )}

        {search && search.matchCount === 0 && search.comparedFrames > 0 && (
          <div className="rounded-xl border border-warn/35 bg-warn/10 px-4 py-2.5 text-[13px] text-warn">
            没有找到相似画面
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {matches.map((match) => (
            <ResultCard
              key={match.video.id}
              match={match}
              onOpen={props.onOpen}
              onReveal={props.onReveal}
              onReindex={props.onReindex}
            />
          ))}
        </div>
        {!search && searching && (
          <div className="mt-2 rounded-xl border border-line bg-ink-900/50 px-4 py-3 text-[12.5px] text-muted">
            正在读取图片并与帧指纹比对…
          </div>
        )}
        {!search && !searching && (
          <div className="mt-5 text-center text-[11px] text-tertiary">所有比对都在本机完成</div>
        )}
      </div>
    </div>
  )
}

function ResultCard({
  match,
  onOpen,
  onReveal,
  onReindex
}: {
  match: SearchMatch
  onOpen: (id: number, atSeconds?: number) => void
  onReveal: (id: number) => void
  onReindex: (id: number) => void
}) {
  const video: VideoRecord = match.video
  const [thumb, setThumb] = useState<string | null>(null)
  /**
   * 命中预览按 timeMs 现场解码：拿到用户截图附近的真实画面，验证"这张图
   * 是不是这个视频"。matchFrame 失败（文件已删/解码超时）时静默回退到
   * 视频级缩略图——后者只是兜底，不应该出现在正常命中里。
   * 切换命中时重拉（依赖 match.timeSeconds + match.videoId）。
   */
  useEffect(() => {
    let alive = true
    const timeMs = Math.round(match.timeSeconds * 1000)
    void window.whichvideo.videos
      .matchFrame(video.id, timeMs)
      .then((data) => (data ? data : window.whichvideo.videos.thumbnail(video.id)))
      .then((data) => {
        if (alive) setThumb(data)
      })
      .catch(() => { if (alive) setThumb(null) })
    return () => {
      alive = false
    }
  }, [video.id, match.timeSeconds])

  const meta = useMemo(() => {
    const bits: string[] = []
    if (video.width && video.height) bits.push(`${video.width}×${video.height}`)
    bits.push(formatDuration(video.duration))
    bits.push(formatBytes(video.size))
    if (video.videoCodec) bits.push(video.videoCodec)
    return bits.join(' · ')
  }, [video])

  const available = video.status === 'ready' && video.frameCount > 0
  return (
    <div className="card group flex gap-3 overflow-hidden p-3 transition hover:border-accent/40">
      <div className="relative h-[86px] w-[150px] shrink-0 overflow-hidden rounded-lg border border-line bg-surface-inset">
        {thumb ? (
          <img src={thumb} alt={video.name} className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full place-items-center text-[11px] text-tertiary">
            {video.status === 'ready' ? '无缩略图' : video.status === 'failed' ? '索引失败' : '索引中…'}
          </div>
        )}
        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-primary">
          {formatDuration(match.timeSeconds)}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-primary" title={video.path}>
              {video.name}
            </div>
            <div className="truncate text-[11px] text-muted" title={video.dir}>
              {video.dir}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className={`text-[15px] font-semibold ${scoreColor(match.score)}`}>
              {formatPercent(match.score)}
            </div>
            <div className="text-[10px] text-muted">{scoreLabel(match.score)}</div>
          </div>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
          <span>{meta}</span>
          <span>
            结构 {(match.hashScore * 100).toFixed(0)}% · 颜色 {(match.colorScore * 100).toFixed(0)}%
          </span>
          {/*
           * 命中点位置：`index/total · m:ss.d` —— 帧序号（1-based）+ 总帧数 +
           * 视频内时间点。一眼看清"采到了第几帧、对应视频几分几秒"。
           * 与 FrameGallery 弹层标题同源格式（5/38-0:01.50）。
           * frameCount=0（未索引完 / 索引失败）就不显示序号部分。
           */}
          <span className="font-mono tabular-nums">
            {video.frameCount > 0 ? `${match.frameIndex + 1}/${video.frameCount}` : '?'}
            {' · '}
            {formatDuration(match.timeSeconds)}
          </span>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <span
            className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${
              available
                ? 'border-ok/40 bg-ok/10 text-ok'
                : video.status === 'failed'
                  ? 'border-bad/40 bg-bad/10 text-bad'
                  : 'border-warn/40 bg-warn/10 text-warn'
            }`}
          >
            {available
              ? '已下载 · 本地库中'
              : video.status === 'failed'
                ? '索引失败'
                : video.status === 'indexing'
                  ? '索引中'
                  : '待索引'}
          </span>
          <button
            className="btn px-2 py-1 text-[11px] hover:bg-ink-700/70"
            onClick={() => onOpen(video.id, match.timeSeconds)}
            title={available ? '优先用 mpv / PotPlayer / VLC 从命中位置起播；未安装则用系统默认播放器' : '视频不在本地'}
          >
            {formatDuration(match.timeSeconds)} 处播放
          </button>
          <button className="btn px-2 py-1 text-[11px] hover:bg-ink-700/70" onClick={() => onReveal(video.id)}>
            定位文件
          </button>
          {!available && (
            <button
              className="btn px-2 py-1 text-[11px] hover:bg-ink-700/70"
              onClick={() => onReindex(video.id)}
            >
              重新索引
            </button>
          )}
          {video.error && (
            <span className="truncate text-[10.5px] text-bad" title={video.error}>
              {video.error}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
