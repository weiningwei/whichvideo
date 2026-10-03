import { useEffect, useMemo, useState, useRef } from 'react'
import type { VideoQuery, VideoRecord, WatchedFolder } from '@shared/types'
import { formatBytes, formatDuration, shortPath } from '../lib/format'

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
}

const STATE_STYLE: Record<string, { text: string; cls: string }> = {
  watching: { text: '监听中', cls: 'border-ok/40 bg-ok/10 text-ok' },
  idle: { text: '已暂停', cls: 'border-line bg-ink-700/40 text-slate-400' },
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

  const selectAllRef = useRef<HTMLInputElement>(null)
  const folderHeaderRefs = useRef<Map<number, HTMLInputElement>>(new Map())

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedVideoIds.size > 0 && selectedVideoIds.size < videos.length
    }
  }, [selectedVideoIds, videos.length])

  useEffect(() => {
    folderHeaderRefs.current.forEach((ref, folderId) => {
      const folderVideos = groupedVideos?.get(folderId) ?? []
      if (folderVideos.length > 0) {
        ref.indeterminate = folderVideos.some(v => isVideoSelected(v.id)) && !folderVideos.every(v => isVideoSelected(v.id))
      }
    })
  }, [selectedVideoIds, groupedVideos, isVideoSelected])

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

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-line/70">
        <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line/70 px-4 py-3">
          <input
            value={query.keyword ?? ''}
            onChange={(e) => onSetQuery({ ...query, keyword: e.target.value, offset: 0 })}
            placeholder="按文件名 / 目录筛选"
            className="w-56 rounded-lg border border-line bg-ink-900/70 px-3 py-1.5 text-[12.5px] outline-none placeholder:text-slate-600 focus:border-accent/60"
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

        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <table className="w-full min-w-[880px] border-separate border-spacing-0 text-[12px]">
            <thead className="sticky top-0 z-10 bg-ink-900/95 text-left text-[11px] uppercase tracking-wide text-slate-500 backdrop-blur">
              <tr>
                <th className="px-4 py-2 font-medium">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={videos.length > 0 && selectedVideoIds.size === videos.length}
                    onChange={(e) => e.target.checked ? selectAll() : clearSelection()}
                    className="w-4 h-4 rounded border-line bg-ink-900/70 text-accent focus:ring-accent"
                  />
                </th>
                <th className="px-4 py-2 font-medium">视频</th>
                <th className="whitespace-nowrap px-2 py-2 font-medium">状态</th>
                <th className="whitespace-nowrap px-2 py-2 font-medium">时长</th>
                <th className="whitespace-nowrap px-2 py-2 font-medium">体积</th>
                <th className="whitespace-nowrap px-2 py-2 font-medium">帧</th>
                <th className="whitespace-nowrap px-2 py-2 font-medium">位置</th>
                <th className="px-4 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {groupByFolder && groupedVideos ? (
                Array.from(groupedVideos.entries()).flatMap(([folderId, folderVideos]) => {
                  const folder = folderId === -1 ? null : folders.find((f) => f.id === folderId)
                  const displayName = folderId === -1 ? '未分类' : (folder?.name ?? `文件夹 #${folderId}`)
                  const expanded = expandedFolderIds.has(folderId)

                  const header = (
                    <tr key={`folder-header-${folderId}`} className="bg-ink-800/50 border-t border-line/40">
                      <td colSpan={8} className="px-4 py-2">
                        <div className="flex items-center gap-2 text-[12px] font-medium text-slate-300">
                          <span
                            className="cursor-pointer select-none transition-transform duration-150"
                            style={{ transform: `rotate(${expanded ? 0 : -90}deg)` }}
                            onClick={() => toggleFolderExpanded(folderId)}
                          >
                            ▼
                          </span>
                          <input
                            ref={(el) => { if (el) folderHeaderRefs.current.set(folderId, el) }}
                            type="checkbox"
                            checked={folderVideos.length > 0 && folderVideos.every(v => isVideoSelected(v.id))}
                            onChange={(e) => {
                              e.stopPropagation()
                              if (e.target.checked) {
                                folderVideos.forEach(v => !isVideoSelected(v.id) && toggleVideoSelection(v.id, false, false))
                              } else {
                                folderVideos.forEach(v => isVideoSelected(v.id) && toggleVideoSelection(v.id, false, false))
                              }
                            }}
                            className="w-4 h-4 rounded border-line bg-ink-900/70 text-accent focus:ring-accent"
                          />
                          <span className="font-medium">{displayName}</span>
                          <span className="ml-auto text-[11px] text-muted">
                            {folderVideos.length} 个视频
                          </span>
                        </div>
                      </td>
                    </tr>
                  )
                  const rows = expanded ? folderVideos.map((video) => (
                    <tr key={video.id} className={`border-b border-line/40 hover:bg-ink-800/50 ${isVideoSelected(video.id) ? 'bg-accent/10' : ''}`}>
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          checked={isVideoSelected(video.id)}
                          onChange={(e) => {
                            e.stopPropagation()
                            toggleVideoSelection(video.id, false, false)
                          }}
                          className="w-4 h-4 rounded border-line bg-ink-900/70 text-accent focus:ring-accent"
                        />
                      </td>
                      <VideoRow
                        key={video.id}
                        video={video}
                        roots={roots}
                        onOpen={props.onOpen}
                        onReveal={props.onReveal}
                        onRemove={props.onRemoveVideo}
                        onReindex={(id) => props.onReindex([id])}
                        isVideoSelected={isVideoSelected}
                      />
                    </tr>
                  )) : []

                  return [header, ...rows]
                })
              ) : (
                videos.map((video) => (
                  <tr key={video.id} className={`border-b border-line/40 hover:bg-ink-800/50 ${isVideoSelected(video.id) ? 'bg-accent/10' : ''}`}>
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        checked={isVideoSelected(video.id)}
                        onChange={(e) => {
                          e.stopPropagation()
                          toggleVideoSelection(video.id, false, false)
                        }}
                        className="w-4 h-4 rounded border-line bg-ink-900/70 text-accent focus:ring-accent"
                      />
                    </td>
                    <VideoRow
                      key={video.id}
                      video={video}
                      roots={roots}
                      onOpen={props.onOpen}
                      onReveal={props.onReveal}
                      onRemove={props.onRemoveVideo}
                      onReindex={(id) => props.onReindex([id])}
                      isVideoSelected={isVideoSelected}
                    />
                  </tr>
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

      <aside className="flex w-[360px] min-w-[280px] shrink-0 flex-col">
        <div className="border-b border-line/70 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-semibold text-slate-200">监听文件夹</div>
            <button className="btn text-[12px] hover:bg-ink-700/70" onClick={props.onAddFolder}>
              + 添加
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            被监听的目录里新增、覆盖或删除视频时，索引会自动更新，无需手动重新扫描。
          </p>
        </div>

        <div
          className={`min-h-0 flex-1 overflow-y-auto p-3 ${folderDrop ? 'bg-accent/5' : ''}`}
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
        >
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
        </div>
      </aside>
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
            <span className="truncate text-[12.5px] font-medium text-slate-100" title={folder.path}>
              {folder.name}
            </span>
            {folder.pinned && (
              <span className="rounded bg-ink-700/60 px-1 text-[9.5px] text-slate-400">手动</span>
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
      <div className="mt-1.5 text-[10px] text-slate-600">
        {folder.recursive ? '包含子目录' : '仅当前目录'}
        {folder.lastScanAt ? ` · 上次扫描 ${new Date(folder.lastScanAt).toLocaleString('zh-CN')}` : ''}
      </div>
    </div>
  )
}

function VideoRow({
  video,
  roots,
  onOpen,
  onReveal,
  onRemove,
  onReindex,
  isVideoSelected
}: {
  video: VideoRecord
  roots: string[]
  onOpen: (id: number) => void
  onReveal: (id: number) => void
  onRemove: (id: number) => void
  onReindex: (id: number) => void
  isVideoSelected: (videoId: number) => boolean
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

  return (
    <tr className={`border-b border-line/40 hover:bg-ink-800/50 ${isVideoSelected(video.id) ? 'bg-accent/10' : ''}`}>
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="h-9 w-16 shrink-0 overflow-hidden rounded border border-line bg-ink-950">
            {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : null}
          </div>
          <div className="min-w-0">
            <div className="truncate text-slate-100" title={video.path}>
              {video.name}
            </div>
            <div className="truncate text-[10.5px] text-muted" title={video.path}>
              {shortPath(video.path, roots)}
            </div>
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-2 py-2">
        <span className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${statusCls}`} title={video.error ?? ''}>
          {statusText}
        </span>
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-slate-300">{formatDuration(video.duration)}</td>
      <td className="whitespace-nowrap px-2 py-2 text-slate-300">{formatBytes(video.size)}</td>
      <td className="whitespace-nowrap px-2 py-2 text-slate-300">{video.frameCount}</td>
      <td className="whitespace-nowrap px-2 py-2 text-slate-400">{new Date(video.addedAt).toLocaleDateString('zh-CN')}</td>
      <td className="px-4 py-2">
        <div className="flex justify-end gap-1.5">
          <button className="btn px-2 py-0.5 text-[11px] hover:bg-ink-700/70" onClick={() => onOpen(video.id)}>
            播放
          </button>
          <button className="btn px-2 py-0.5 text-[11px] hover:bg-ink-700/70" onClick={() => onReveal(video.id)}>
            定位
          </button>
          <button
            className="btn px-2 py-0.5 text-[11px] hover:bg-ink-700/70"
            onClick={() => onReindex(video.id)}
            title="重新抽帧建立指纹"
          >
            重索引
          </button>
          <button
            className="btn btn-danger px-2 py-0.5 text-[11px] hover:bg-bad/10"
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