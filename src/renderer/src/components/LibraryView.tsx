import { useEffect, useMemo, useState, useRef, type ReactNode } from 'react'
import type { VideoQuery, VideoRecord, WatchedFolder } from '@shared/types'
import { formatBytes, formatDuration, shortPath } from '../lib/format'
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
        <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line/70 px-3 py-2.5">
          <input
            value={query.keyword ?? ''}
            onChange={(e) => onSetQuery({ ...query, keyword: e.target.value, offset: 0 })}
            placeholder="按文件名 / 目录筛选"
            className="w-40 rounded-lg border border-line bg-ink-900/70 px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-slate-600 focus:border-accent/60"
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
          <table className="w-full min-w-[560px] border-separate border-spacing-0 text-[12px]">
            <thead className="sticky top-0 z-10 bg-ink-900/95 text-left text-[11px] uppercase tracking-wide text-slate-500 backdrop-blur">
              <tr>
                <th className="w-10 px-3 py-2 font-medium">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={videos.length > 0 && selectedVideoIds.size === videos.length}
                    onChange={(e) => e.target.checked ? selectAll() : clearSelection()}
                    className="w-4 h-4 rounded border-line bg-ink-900/70 text-accent focus:ring-accent"
                  />
                </th>
                <th className="px-3 py-2 font-medium">视频</th>
                <th className="w-24 whitespace-nowrap px-2 py-2 font-medium">状态</th>
                <th className="w-28 px-3 py-2 text-right font-medium">操作</th>
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
                      <td colSpan={4} className="px-3 py-2">
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
                      <td className="px-3 py-2">
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
                    <td className="px-3 py-2">
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
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-16 shrink-0 overflow-hidden rounded border border-line bg-ink-950">
            {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : null}
          </div>
          <div className="min-w-0">
            <div className="truncate text-slate-100" title={video.path}>
              {video.name}
            </div>
            <div className="truncate text-[10.5px] text-muted" title={video.path}>
              {/* 位置、时长、体积、帧数、导入日期合并到一行，用 · 分隔 */}
              {[
                shortPath(video.path, roots),
                formatDuration(video.duration),
                formatBytes(video.size),
                `${video.frameCount} 帧`,
                new Date(video.addedAt).toLocaleDateString('zh-CN')
              ].join(' · ')}
            </div>
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-2 py-1.5">
        <span className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${statusCls}`} title={video.error ?? ''}>
          {statusText}
        </span>
      </td>
      <td className="px-3 py-1.5">
        <div className="flex items-center justify-end gap-1">
          <button
            className="btn px-2 py-0.5 text-[11px] hover:bg-ink-700/70"
            onClick={() => onOpen(video.id)}
            title="用系统播放器打开"
          >
            播放
          </button>
          <RowMenu
            onReveal={() => onReveal(video.id)}
            onReindex={() => onReindex(video.id)}
            onRemove={() => onRemove(video.id)}
          />
        </div>
      </td>
    </tr>
  )
}

/**
 * 行内「更多」菜单：把低频操作（定位 / 重索引 / 移除）收进一个浮层。
 *
 * 此前四个按钮平铺在操作列里，「操作」列的 min-content 约 250px，是表格里最宽
 * 的一列，也是导入首个视频后布局溢出的直接原因。折叠后只留「播放」一个主操作。
 */
function RowMenu({
  onReveal,
  onReindex,
  onRemove
}: {
  onReveal: () => void
  onReindex: () => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点击外部或按 Esc 关闭
  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const items: { label: string; hint?: string; onClick: () => void; danger?: boolean }[] = [
    { label: '定位文件', hint: '在资源管理器中选中', onClick: onReveal },
    { label: '重索引', hint: '重新抽帧建立指纹', onClick: onReindex },
    { label: '从库中移除', hint: '不会删除磁盘文件', onClick: onRemove, danger: true }
  ]

  return (
    <div ref={ref} className="relative">
      <button
        className="btn px-1.5 py-0.5 text-[11px] hover:bg-ink-700/70"
        onClick={() => setOpen((v) => !v)}
        title="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-52 overflow-hidden rounded-lg border border-line bg-ink-850 py-1 shadow-xl"
        >
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              onClick={() => {
                setOpen(false)
                it.onClick()
              }}
              className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-[12px] transition ${
                it.danger ? 'text-bad hover:bg-bad/10' : 'text-slate-200 hover:bg-ink-700/70'
              }`}
            >
              <span>{it.label}</span>
              {it.hint && <span className="text-[10px] text-slate-500">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
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