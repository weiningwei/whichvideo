import { useEffect, useMemo, useState, useRef, type ReactNode } from 'react'
import type { VideoQuery, VideoRecord, WatchedFolder } from '@shared/types'
import { formatBytes, formatDuration, shortDir } from '../lib/format'
import { SidePanel } from './SidePanel'

interface Props {
  folders: WatchedFolder[]
  videos: VideoRecord[]
  total: number
  query: VideoQuery
  onSetQuery: (query: VideoQuery) => void
  onAddFolder: () => void
  onAddFolderPath: (dirPath: string) => void
  onRemoveFolder: (folderId: number) => void
  onRescan: (folderId?: number) => void
  onToggleFolder: (folderId: number, enabled: boolean) => void
  onOpen: (videoId: number) => void
  onReveal: (videoId: number) => void
  onRemoveVideo: (videoId: number) => void
  onReindex: (videoIds?: number[]) => void
  groupByFolder: boolean
  onToggleGroupByFolder: () => void
  selectedVideoIds: Set<number>
  expandedFolderIds: Set<number>
  isVideoSelected: (videoId: number) => boolean
  isFolderExpanded: (folderId: number) => boolean
  toggleVideoSelection: (videoId: number, shiftKey: boolean, ctrlKey: boolean) => void
  clearSelection: () => void
  selectAll: () => void
  toggleFolderExpanded: (folderId: number) => void
  expandAllFolders: () => void
  collapseAllFolders: () => void
  /** 右侧「索引设置」页的内容（由 App 传入，合并到同一栏切换） */
  sideSettings: ReactNode
}

const STATE_STYLE: Record<string, { text: string; cls: string }> = {
  watching: { text: '监听中', cls: 'border-ok/40 bg-ok/10 text-ok' },
  idle: { text: '已暂停', cls: 'border-line bg-ink-700/40 text-secondary' },
  missing: { text: '目录不存在', cls: 'border-bad/40 bg-bad/10 text-bad' },
  error: { text: '监听异常', cls: 'border-bad/40 bg-bad/10 text-bad' },
}

export function LibraryView(props: Props) {
  const {
    folders, videos, total, query, onSetQuery, groupByFolder, onToggleGroupByFolder,
    selectedVideoIds, expandedFolderIds, isVideoSelected,
    toggleVideoSelection, clearSelection, selectAll, toggleFolderExpanded
  } = props

  const [folderDrop, setFolderDrop] = useState(false)
  const roots = useMemo(() => folders.map((f) => f.path), [folders])

  // 分组视图：按 folderId 聚合，null folderId 归为"未分类"
  const groupedVideos = useMemo(() => {
    if (!groupByFolder) return null
    const groups = new Map<number, VideoRecord[]>()
    for (const v of videos) {
      const key = v.folderId ?? -1
      const arr = groups.get(key) ?? []
      arr.push(v)
      groups.set(key, arr)
    }
    return groups
  }, [videos, folders, groupByFolder])

  // 注：原先这里有两个 useEffect 用来同步表头/分组复选框的 indeterminate 态。
  // 复选框已全部移除（选中改为竖条提示 + 整行点击），故不再需要这两个 ref。

  // 键盘导航
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          moveSelection(1)
          break
        case 'ArrowUp':
          e.preventDefault()
          moveSelection(-1)
          break
        case 'ArrowRight':
          if (groupByFolder) {
            e.preventDefault()
            expandFocusedFolder()
          }
          break
        case 'ArrowLeft':
          if (groupByFolder) {
            e.preventDefault()
            collapseFocusedFolder()
          }
          break
        case ' ':
        case 'Enter':
          if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) return
          e.preventDefault()
          toggleFocusedSelection(e.shiftKey, e.ctrlKey || e.metaKey)
          break
        case 'a':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            selectAll()
          }
          break
        case 'Escape':
          clearSelection()
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [groupByFolder, videos, groupedVideos, folders, expandedFolderIds, selectedVideoIds])

  const navigableItems = useMemo(() => {
    if (!groupByFolder || !groupedVideos) {
      return videos.map((v, idx) => ({ type: 'video' as const, video: v, index: idx }))
    }
    const items: { type: 'folder' | 'video'; folderId: number; video?: VideoRecord; index: number }[] = []
    let idx = 0
    for (const [folderId, folderVideos] of groupedVideos) {
      items.push({ type: 'folder', folderId, index: idx++ })
      for (const v of folderVideos) {
        if (expandedFolderIds.has(folderId)) {
          items.push({ type: 'video', folderId, video: v, index: idx++ })
        }
      }
    }
    return items
  }, [groupByFolder, groupedVideos, expandedFolderIds])

  const [focusedIndex, setFocusedIndex] = useState(0)

  /**
   * 焦点所在行的 videoId。
   *
   * 之前焦点只存下标，渲染时再 `focusedIndex === idx` 反查，分组视图下要写
   * `navigableItems.findIndex(...)` 那种绕的匹配，既难读又容易错。改为直接从
   * navigableItems 派生 video.id，渲染时只需 `focusedVideoId === video.id`。
   */
  const focusedVideoId = useMemo(() => {
    const item = navigableItems[focusedIndex]
    return item && item.type === 'video' ? item.video?.id ?? null : null
  }, [navigableItems, focusedIndex])

  const moveSelection = (delta: number) => {
    if (navigableItems.length === 0) return
    const next = Math.max(0, Math.min(navigableItems.length - 1, focusedIndex + delta))
    setFocusedIndex(next)
  }

  const expandFocusedFolder = () => {
    const item = navigableItems[focusedIndex]
    if (item && item.type === 'folder') {
      toggleFolderExpanded(item.folderId)
    }
  }

  const collapseFocusedFolder = () => {
    const item = navigableItems[focusedIndex]
    if (item && item.type === 'folder') {
      toggleFolderExpanded(item.folderId)
    }
  }

  const toggleFocusedSelection = (shiftKey: boolean, _ctrlKey: boolean) => {
    const item = navigableItems[focusedIndex]
    if (item && item.type === 'video' && item.video) {
      toggleVideoSelection(item.video.id, shiftKey, false)
    }
  }

  useEffect(() => {
    setFocusedIndex(0)
  }, [groupByFolder, groupedVideos, videos])

  // 滚动容器：↑/↓ 移动焦点时要把焦点行滚进可视区，否则焦点移出屏幕就看不见了
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusedVideoId === null || !scrollRef.current) return
    const box = scrollRef.current
    const row = box.querySelector<HTMLElement>(`[data-video-id="${focusedVideoId}"]`)
    if (!row) return
    const rowTop = row.offsetTop
    const rowBottom = rowTop + row.offsetHeight
    const viewTop = box.scrollTop
    const viewBottom = viewTop + box.clientHeight
    const margin = 28 // 留点余量，别让行贴着上下边缘
    if (rowTop < viewTop + margin) {
      box.scrollTop = Math.max(0, rowTop - margin)
    } else if (rowBottom > viewBottom - margin) {
      box.scrollTop = rowBottom - box.clientHeight + margin
    }
  }, [focusedVideoId])

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-line/70">
        <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line/70 px-3 py-2.5">
          <input
            value={query.keyword ?? ''}
            onChange={(e) => onSetQuery({ ...query, keyword: e.target.value, offset: 0 })}
            placeholder="按文件名 / 目录筛选"
            className="w-40 rounded-lg border border-line bg-ink-900/70 px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-tertiary focus:border-accent/60"
          />
          <select
            value={String(query.folderId ?? '')}
            onChange={(e) =>
              onSetQuery({
                ...query,
                folderId: e.target.value === '' ? null : Number(e.target.value),
                offset: 0
              })
            }
            className="rounded-lg border border-line bg-ink-900/70 px-2 py-1.5 text-[12.5px] outline-none focus:border-accent/60"
          >
            <option value="">全部监听目录</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <select
            value={query.status ?? 'all'}
            onChange={(e) => onSetQuery({ ...query, status: e.target.value as VideoQuery['status'], offset: 0 })}
            className="rounded-lg border border-line bg-ink-900/70 px-2 py-1.5 text-[12.5px] outline-none focus:border-accent/60"
          >
            <option value="all">全部状态</option>
            <option value="ready">已索引</option>
            <option value="pending">待索引</option>
            <option value="indexing">索引中</option>
            <option value="failed">索引失败</option>
          </select>
          <select
            value={query.sort ?? 'added'}
            onChange={(e) => onSetQuery({ ...query, sort: e.target.value as VideoQuery['sort'] })}
            className="rounded-lg border border-line bg-ink-900/70 px-2 py-1.5 text-[12.5px] outline-none focus:border-accent/60"
          >
            <option value="added">按导入时间</option>
            <option value="name">按文件名</option>
            <option value="size">按体积</option>
            <option value="duration">按时长</option>
          </select>
          <span className="text-[11.5px] text-muted">
            显示 {videos.length} / {total}
          </span>
          <span
            className="hidden text-[11px] text-tertiary lg:inline"
            title="↑/↓ 移动焦点 · Enter/Space 选中 · Ctrl+A 全选 · Esc 取消 · G 切换分组"
          >
            ↑↓ 移动 · Enter 选中
          </span>
          <div className="ml-auto flex gap-2">
            <button
              className={`btn text-[12px] hover:bg-ink-700/70 ${groupByFolder ? 'bg-accent/20 border-accent/40' : ''}`}
              onClick={onToggleGroupByFolder}
              title="按文件夹分组/平铺 (G)"
            >
              {groupByFolder ? '📁 分组' : '📋 平铺'}
            </button>
            <button className="btn text-[12px] hover:bg-ink-700/70" onClick={() => props.onReindex()}>
              重建全部索引
            </button>
            <button className="btn text-[12px] hover:bg-ink-700/70" onClick={() => props.onRescan()}>
              重新扫描目录
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto">
          {/* min-w 覆盖三列的下限：视频列至少 220 + 状态 96 + 操作 180 */}
          <table className="w-full min-w-[540px] border-separate border-spacing-0 text-[12px]">
            <thead className="sticky top-0 z-10 bg-ink-900/95 text-left text-[11px] uppercase tracking-wide text-tertiary backdrop-blur">
              <tr>
                <th className="px-3 py-2 font-medium">视频</th>
                <th className="w-24 whitespace-nowrap px-2 py-2 font-medium">状态</th>
                <th className="w-[180px] px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {groupByFolder && groupedVideos ? (
                Array.from(groupedVideos.entries()).flatMap(([folderId, folderVideos]) => {
                  const folder = folderId === -1 ? null : folders.find((f) => f.id === folderId)
                  const displayName = folderId === -1 ? '未分类' : (folder?.name ?? `文件夹 #${folderId}`)
                  const expanded = expandedFolderIds.has(folderId)

                  const groupSelected = folderVideos.length > 0 && folderVideos.every((v) => isVideoSelected(v.id))
                  const groupPartial =
                    !groupSelected && folderVideos.some((v) => isVideoSelected(v.id))

                  const header = (
                    <tr key={`folder-header-${folderId}`} className="bg-ink-800/50 border-t border-line/40">
                      <td colSpan={3} className="px-3 py-2">
                        <div className="flex items-center gap-2 text-[12px] font-medium text-secondary">
                          <span
                            className="cursor-pointer select-none transition-transform duration-150"
                            style={{ transform: `rotate(${expanded ? 0 : -90}deg)` }}
                            onClick={() => toggleFolderExpanded(folderId)}
                          >
                            ▼
                          </span>
                          {/* 分组选中态用竖条提示，不再放复选框 */}
                          <span
                            className={`h-3.5 w-[2px] shrink-0 rounded-full ${
                              groupSelected ? 'bg-accent' : groupPartial ? 'bg-accent/45' : 'bg-transparent'
                            }`}
                            title={groupSelected ? '已全选该组' : groupPartial ? '部分选中' : ''}
                          />
                          {/* 点击分组名即全选 / 取消该组 */}
                          <span
                            className="cursor-pointer truncate font-medium hover:text-primary"
                            onClick={() => {
                              const target = !groupSelected
                              folderVideos.forEach((v) => {
                                if (target !== isVideoSelected(v.id)) toggleVideoSelection(v.id, false, false)
                              })
                            }}
                            title="点击全选 / 取消该组"
                          >
                            {displayName}
                          </span>
                          <span className="ml-auto text-[11px] text-muted">
                            {folderVideos.length} 个视频
                          </span>
                        </div>
                      </td>
                    </tr>
                  )
                  const rows = expanded ? folderVideos.map((video) => (
                    <VideoRow
                      key={video.id}
                      video={video}
                      roots={roots}
                      focused={focusedVideoId === video.id}
                      onOpen={props.onOpen}
                      onReveal={props.onReveal}
                      onRemove={props.onRemoveVideo}
                      onReindex={(id) => props.onReindex([id])}
                      isVideoSelected={isVideoSelected}
                      onToggleSelect={() => toggleVideoSelection(video.id, false, false)}
                    />
                  )) : []

                  return [header, ...rows]
                })
              ) : (
                videos.map((video) => (
                  <VideoRow
                    key={video.id}
                    video={video}
                    roots={roots}
                    focused={focusedVideoId === video.id}
                    onOpen={props.onOpen}
                    onReveal={props.onReveal}
                    onRemove={props.onRemoveVideo}
                    onReindex={(id) => props.onReindex([id])}
                    isVideoSelected={isVideoSelected}
                    onToggleSelect={() => toggleVideoSelection(video.id, false, false)}
                  />
                ))
              )}
            </tbody>
          </table>
          {videos.length === 0 && (
            <div className="p-8 text-center text-[12.5px] text-muted">
              还没有视频。点击右上角「导入视频」选择文件，或「导入文件夹」递归导入整个目录。
            </div>
          )}
        </div>
      </section>

      <SidePanel
        onAddFolder={props.onAddFolder}
        folderCount={folders.length}
        folderDrop={folderDrop}
        onDragOver={(e) => {
          e.preventDefault()
          setFolderDrop(true)
        }}
        onDragLeave={() => setFolderDrop(false)}
        onDrop={(e) => {
          e.preventDefault()
          setFolderDrop(false)
          const dir = extractDroppedDir(e.dataTransfer)
          if (dir) props.onAddFolderPath(dir)
        }}
        folders={
          <>
            {folders.length === 0 && (
              <div className="rounded-xl border border-dashed border-line/80 p-4 text-center text-[11.5px] text-muted">
                还没有监听目录。
                <br />
                可以点「+ 添加」，也可以把文件夹直接拖到这里。
              </div>
            )}
            <div className="flex flex-col gap-2">
              {folders.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  onRemove={props.onRemoveFolder}
                  onRescan={props.onRescan}
                  onToggle={props.onToggleFolder}
                />
              ))}
            </div>
          </>
        }
        settings={props.sideSettings}
      />
    </div>
  )
}

function FolderCard({
  folder,
  onRemove,
  onRescan,
  onToggle
}: {
  folder: WatchedFolder
  onRemove: (id: number) => void
  onRescan: (id?: number) => void
  onToggle: (id: number, enabled: boolean) => void
}) {
  const style = STATE_STYLE[folder.watchState] ?? STATE_STYLE.idle
  return (
    <div className="card p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium text-primary" title={folder.path}>
              {folder.name}
            </span>
            {folder.pinned && (
              <span className="rounded bg-ink-700/60 px-1 text-[9.5px] text-secondary">手动</span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-muted" title={folder.path}>
            {folder.path}
          </div>
        </div>
        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] ${style.cls}`}>
          {style.text}
        </span>
      </div>

      {folder.message && (
        <div className="mt-1.5 truncate text-[10.5px] text-bad" title={folder.message}>
          {folder.message}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <button
          className="btn px-2 py-1 text-[11px] hover:bg-ink-700/70"
          onClick={() => onToggle(folder.id, !folder.enabled)}
        >
          {folder.enabled ? '暂停监听' : '恢复监听'}
        </button>
        <button className="btn px-2 py-1 text-[11px] hover:bg-ink-700/70" onClick={() => onRescan(folder.id)}>
          重新扫描
        </button>
        <button
          className="btn btn-danger ml-auto px-2 py-1 text-[11px] hover:bg-bad/10"
          onClick={() => onRemove(folder.id)}
          title="只停止监听该目录，已入库的视频记录保留"
        >
          停止监听
        </button>
      </div>
      <div className="mt-1.5 text-[10px] text-tertiary">
        {folder.recursive ? '包含子目录' : '仅当前目录'}
        {folder.lastScanAt ? ` · 上次扫描 ${new Date(folder.lastScanAt).toLocaleString('zh-CN')}` : ''}
      </div>
    </div>
  )
}

function VideoRow({
  video,
  roots,
  focused,
  onOpen,
  onReveal,
  onRemove,
  onReindex,
  isVideoSelected,
  onToggleSelect
}: {
  video: VideoRecord
  roots: string[]
  /** 键盘焦点所在行（↑/↓ 移动），用于显示淡灰焦点条 */
  focused: boolean
  onOpen: (id: number) => void
  onReveal: (id: number) => void
  onRemove: (id: number) => void
  onReindex: (id: number) => void
  isVideoSelected: (videoId: number) => boolean
  /** 点击整行切换选中（复选框已移除） */
  onToggleSelect: () => void
}) {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void window.whichvideo.videos.thumbnail(video.id).then((d) => {
      if (alive) setThumb(d)
    })
    return () => {
      alive = false
    }
  }, [video.id, video.indexedAt])

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

  return (
    <tr
      data-video-id={video.id}
      onClick={onToggleSelect}
      className={`cursor-pointer border-b border-line/40 transition-colors ${
        selected
          ? 'bg-accent/12'
          : focused
            ? 'bg-ink-800/70'
            : 'hover:bg-ink-800/40'
      }`}
    >
      <td className="relative px-3 py-1.5">
        {/* 状态提示用左侧 2px 竖条（绝对定位，不占列宽）：
            选中 = accent 蓝条；仅键盘焦点 = 淡灰条。两者同时存在时以选中为准。 */}
        {selected ? (
          <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />
        ) : focused ? (
          <span className="absolute inset-y-0 left-0 w-[2px] bg-disabled/60" />
        ) : null}
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-16 shrink-0 overflow-hidden rounded border border-line bg-surface-inset">
            {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : null}
          </div>
          <div className="min-w-0">
            <div
              className={`truncate ${selected ? 'text-accent' : 'text-primary'}`}
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
      <td className="whitespace-nowrap px-2 py-1.5">
        <span className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${statusCls}`} title={video.error ?? ''}>
          {statusText}
        </span>
      </td>
      <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
        {/* 四个操作全部平铺显示，文字精简到 2 字（播放 / 定位 / 索引 / 移除）。
            按钮内边距收到 px-1.5，四项合计约 156px，比原来的「播放+⋯」73px
            多占 83px，但省掉了点开菜单这一步，操作列由 w-28 放宽到 w-[180px]。 */}
        <div className="flex items-center justify-end gap-1">
          <button
            className="btn px-1.5 py-0.5 text-[11px] hover:bg-ink-700/70"
            onClick={() => onOpen(video.id)}
            title="用系统播放器打开"
          >
            播放
          </button>
          <button
            className="btn px-1.5 py-0.5 text-[11px] hover:bg-ink-700/70"
            onClick={() => onReveal(video.id)}
            title="在资源管理器中定位该文件"
          >
            定位
          </button>
          <button
            className="btn px-1.5 py-0.5 text-[11px] hover:bg-ink-700/70"
            onClick={() => onReindex(video.id)}
            title="重新抽帧并重建指纹"
          >
            索引
          </button>
          <button
            className="btn btn-danger px-1.5 py-0.5 text-[11px] hover:bg-bad/10"
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

/** 从拖拽内容里尽力提取目录绝对路径（Electron 下 File.path 可用） */
function extractDroppedDir(dataTransfer: DataTransfer): string | null {
  const files = Array.from(dataTransfer.files ?? [])
  for (const file of files) {
    const path = (file as File & { path?: string }).path
    if (!path) continue
    return /[\\/][^\\/]+$/.test(path) ? path.replace(/[\\/][^\\/]+$/, '') : path
  }
  const uri = dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain')
  if (uri) {
    const cleaned = uri.replace(/^file:\/\/\//, '').replace(/\//g, '\\')
    return decodeURIComponent(cleaned)
  }
  return null
}