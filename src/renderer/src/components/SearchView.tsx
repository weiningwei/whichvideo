import { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchMatch, SearchResponse, VideoRecord } from '@shared/types'
import { formatBytes, formatDuration, formatPercent, scoreColor, scoreLabel, shortPath } from '../lib/format'

interface Props {
  search: SearchResponse | null
  searching: boolean
  error: string | null
  queryImage: string | null
  queryLabel: string | null
  hasIndexedFrames: boolean
  roots: string[]
  onPickImageFile: () => Promise<string[]>
  onSearchPath: (path: string) => void
  onSearchDataUrl: (dataUrl: string, label: string) => void
  onSearchClipboard: () => void
  onSearchUrl: (url: string) => void
  onReSearch: () => void
  onClear: () => void
  onOpen: (videoId: number) => void
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
    roots,
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
      <div className="flex min-w-0 flex-col gap-3 p-4">
        <div
          className={`card relative flex min-w-0 items-center gap-4 p-4 transition ${
            dragging ? 'border-accent/70 bg-accent/10' : ''
          }`}
        >
          <div className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-ink-900">
            {queryImage ? (
              <img src={queryImage} alt="查询图片" className="h-full w-full object-cover" />
            ) : (
              <span className="px-2 text-center text-[11px] text-tertiary">
                {queryLabel?.startsWith('http') ? '来自链接' : '拖入 / 粘贴图片'}
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-primary">
              {queryLabel ?? '把截图、海报或任意图片拖到这里'}
            </div>
            <div className="mt-1 text-[11.5px] text-muted">
              {search
                ? `已比对 ${search.comparedFrames.toLocaleString('zh-CN')} 个帧指纹 · 命中 ${search.matchCount} 个视频 · 耗时 ${search.elapsedMs} ms`
                : '支持拖拽、Ctrl+V 粘贴、或点击按钮选择图片文件'}
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
                选择图片文件
              </button>
              <button className="btn hover:bg-ink-700/70" disabled={searching} onClick={onSearchClipboard}>
                使用剪贴板图片
              </button>
              {queryImage && (hasIndexedFrames || error) && (
                <button
                  className="btn hover:bg-ink-700/70"
                  disabled={searching}
                  onClick={onReSearch}
                  title="用同一张图片重新搜索"
                >
                  重新搜索
                </button>
              )}
              {(search || error) && (
                <button className="btn hover:bg-ink-700/70" onClick={onClear}>
                  清除结果
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
                placeholder="粘贴图片链接或网页地址，回车检索（Ctrl+K 聚焦）"
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
                链接检索
              </button>
            </div>
            {search && search.comparedFrames === 0 && (
              <div className="mt-2 text-[11.5px] text-warn">
                索引库还没有任何帧指纹：请先在「视频库与监听」里导入视频或文件夹。
              </div>
            )}
          </div>

          {top && (
            <div className="hidden shrink-0 rounded-xl border border-line bg-ink-900/70 px-4 py-3 text-center md:block">
              <div className={`text-2xl font-bold ${scoreColor(top.score)}`}>
                {formatPercent(top.score)}
              </div>
              <div className="text-[11px] text-muted">{scoreLabel(top.score)}</div>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-xl border border-bad/40 bg-bad/10 px-4 py-2.5 text-[12.5px] text-bad">
            {error}
          </div>
        )}

        {search && search.matchCount > 0 && (
          <div className="rounded-xl border border-ok/35 bg-ok/10 px-4 py-2.5 text-[13px] text-ok">
            ✅ 已在本地库中找到这张图对应的视频：{top?.video.name}
            {top && top.timeSeconds > 0 ? `（约 ${formatDuration(top.timeSeconds)} 处）` : ''}
          </div>
        )}

        {search && search.matchCount === 0 && search.comparedFrames > 0 && (
          <div className="rounded-xl border border-warn/35 bg-warn/10 px-4 py-2.5 text-[13px] text-warn">
            没有视频与这张图相似 —— 这张图对应的视频大概率还没下载到已导入的目录里。
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {matches.map((match) => (
            <ResultCard
              key={match.video.id}
              match={match}
              roots={roots}
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
        {!search && !searching && <EmptyHint />}
      </div>
    </div>
  )
}

function EmptyHint() {
  return (
    <div className="mt-2 grid gap-3 text-[12.5px] text-secondary sm:grid-cols-3">
      <Hint title="1 · 建立索引" body="在「视频库与监听」里导入单个视频或整个文件夹，程序会抽帧建立指纹索引。" />
      <Hint title="2 · 丢一张图进来" body="把图片拖进窗口、Ctrl+V 粘贴，或点击「选择图片文件」。" />
      <Hint title="3 · 看结果" body="命中即说明该视频已在本地；未命中说明这张图对应的视频还没下载。" />
    </div>
  )
}

function Hint({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-3">
      <div className="text-[12px] font-semibold text-primary">{title}</div>
      <div className="mt-1 leading-relaxed text-muted">{body}</div>
    </div>
  )
}

function ResultCard({
  match,
  roots,
  onOpen,
  onReveal,
  onReindex
}: {
  match: SearchMatch
  roots: string[]
  onOpen: (id: number) => void
  onReveal: (id: number) => void
  onReindex: (id: number) => void
}) {
  const video: VideoRecord = match.video
  const [thumb, setThumb] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.whichvideo.videos.thumbnail(video.id).then((data) => {
      if (alive) setThumb(data)
    })
    return () => {
      alive = false
    }
  }, [video.id, video.indexedAt])

  const meta = useMemo(() => {
    const bits: string[] = []
    if (video.width && video.height) bits.push(`${video.width}×${video.height}`)
    bits.push(formatDuration(video.duration))
    bits.push(formatBytes(video.size))
    if (video.videoCodec) bits.push(video.videoCodec)
    return bits.join(' · ')
  }, [video])

  const available = video.status === 'ready' && video.frameCount > 0
  const localPath = useMemo(() => {
    const dir = shortPath(video.path, roots)
    return dir
  }, [video.path, roots])

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
            <div className="truncate text-[11px] text-muted" title={video.path}>
              {localPath}
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
          <button className="btn px-2 py-1 text-[11px] hover:bg-ink-700/70" onClick={() => onOpen(video.id)}>
            播放
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
