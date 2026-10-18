import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { DuplicatePair, SamplingMode, VideoQuery, VideoRecord, WatchedFolder } from '@shared/types'
import { blockModifierTextSelection } from '../lib/selection'
import { useVideoCursor } from '../hooks/useVideoCursor'
import { useLibraryShortcuts } from '../hooks/useLibraryShortcuts'
import { buildExplorerTree, explorerPathKey, visibleExplorerRows } from '../lib/libraryExplorer'
import { SidePanel } from './SidePanel'
import { VideoRow } from './VideoRow'
import { Toolbar } from './Toolbar'
import { DuplicatesModal } from './DuplicatesModal'
import { FrameGallery } from './FrameGallery'

interface Props {
  folders: WatchedFolder[]
  /** 当前可见视频（已按地址栏目录过滤） */
  videos: VideoRecord[]
  total: number
  query: VideoQuery
  onSetQuery: (query: VideoQuery) => void
  onAddFolder: () => void
  onAddFolderPath: (dirPath: string) => void
  /** 一次性递归导入目录，不建立监听。 */
  onImportFolder: () => void
  /** 快捷键 I：导入视频文件（与顶栏「+ 导入视频」同一个动作） */
  onImportFiles: () => void
  onRemoveFolder: (folderId: number) => void
  onRescan: (folderId?: number) => void
  onToggleFolder: (folderId: number, enabled: boolean) => void
  onOpen: (videoId: number, atSeconds?: number) => void
  onReveal: (videoId: number) => void
  onRemoveVideo: (videoId: number) => void
  onRemoveVideos: (videoIds: number[]) => void
  onReindex: (videoIds?: number[], mode?: SamplingMode) => void
  /** 全局采样模式（视频行未设覆盖时的生效值） */
  globalSampling: 'uniform' | 'scene'
  /** 库内查重：返回相似对。耗时长（每视频一次全帧扫描），由按钮显式触发 */
  onFindDuplicates: (minScore?: number) => Promise<DuplicatePair[]>
  // 文件夹视图 / 平铺视图
  treeVisible: boolean
  onToggleTree: () => void
  // 选中
  selectedVideoIds: Set<number>
  isVideoSelected: (videoId: number) => boolean
  toggleVideoSelection: (videoId: number, shiftKey: boolean, ctrlKey: boolean) => void
  clearSelection: () => void
  setSelectedIds: (ids: number[], selected: boolean) => void
  setSelectionOrder: (ids: number[]) => void
  /** 右侧「索引设置」页的内容（由 App 传入，合并到同一栏切换） */
  sideSettings: ReactNode
}

const STATE_STYLE: Record<string, { text: string; cls: string }> = {
  watching: { text: '监听中', cls: 'border-ok/40 bg-ok/10 text-ok' },
  idle: { text: '已暂停', cls: 'border-line bg-ink-700/40 text-secondary' },
  missing: { text: '目录不存在', cls: 'border-bad/40 bg-bad/10 text-bad' },
  error: { text: '监听异常', cls: 'border-bad/40 bg-bad/10 text-bad' }
}

export function LibraryView(props: Props) {
  const {
    folders, videos, total, query, onSetQuery,
    treeVisible, onToggleTree, selectedVideoIds, isVideoSelected,
    toggleVideoSelection, clearSelection, setSelectedIds
  } = props

  const [folderDrop, setFolderDrop] = useState(false)
  const [drawer, setDrawer] = useState<'folders' | 'settings' | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [closedFilteredPaths, setClosedFilteredPaths] = useState<Set<string>>(new Set())
  const [openMenuId, setOpenMenuId] = useState<number | null>(null)
  // 库内查重的结果与进行中标记。结果在模态里列出，关闭即弃 —— 库内容随时变化，
  // 缓存旧结果反而误导（刚删掉的视频还会出现在列表里）。
  const [duplicates, setDuplicates] = useState<DuplicatePair[] | null>(null)
  // 「查看索引帧」弹层的目标视频；null = 关闭。只存 id 对应的行对象，
  // 行被移除时弹层里的清单查询会自然失败/为空，无僵尸引用。
  const [framesVideo, setFramesVideo] = useState<VideoRecord | null>(null)
  /** 快捷键 / 会聚焦到这里 */
  const filterInputRef = useRef<HTMLInputElement>(null)

  /** 打开「查看索引帧」弹层。VideoRow 上来的是 id，按当前列表反查行对象 */
  const openFramesViewer = (videoId: number): void => {
    setFramesVideo(videos.find((v) => v.id === videoId) ?? null)
  }

  const roots = useMemo(() => folders.map((f) => f.path), [folders])
  const explorerTree = useMemo(() => buildExplorerTree(folders, videos), [folders, videos])
  const filtering = Boolean(query.keyword?.trim()) || (query.status != null && query.status !== 'all')
  const noMatches = filtering || total > 0
  const rows = useMemo(
    () => treeVisible ? visibleExplorerRows(filtering ? { ...explorerTree, folders: explorerTree.folders.filter((root) => root.count > 0) } : explorerTree, expandedPaths, filtering, closedFilteredPaths) : videos.map((video) => ({ type: 'video' as const, video, depth: 0 })),
    [treeVisible, explorerTree, expandedPaths, filtering, closedFilteredPaths, videos]
  )
  const shownVideos = useMemo(() => rows.flatMap((row) => row.type === 'video' ? [row.video] : []), [rows])
  useEffect(() => { props.setSelectionOrder(shownVideos.map((video) => video.id)) }, [props.setSelectionOrder, shownVideos])
  const toggleFolder = (path: string) => {
    const key = explorerPathKey(path)
    const wasOpen = filtering ? !closedFilteredPaths.has(key) : expandedPaths.has(key)
    setOpenMenuId(null)
    if (wasOpen) clearSelection()
    const setter = filtering ? setClosedFilteredPaths : setExpandedPaths
    setter((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  useEffect(() => { setClosedFilteredPaths(new Set()) }, [query.keyword, query.status])
  useEffect(() => { clearSelection() }, [query.keyword, query.status, clearSelection])
  useEffect(() => { setOpenMenuId(null) }, [treeVisible, query.keyword, query.status, query.sort])
  useEffect(() => {
    if (openMenuId !== null && !selectedVideoIds.has(openMenuId)) setOpenMenuId(null)
  }, [selectedVideoIds, openMenuId])
  useEffect(() => { setOpenMenuId(null) }, [drawer, duplicates, framesVideo])
  useEffect(() => {
    if (openMenuId === null) return
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(`[data-video-menu="${openMenuId}"]`)) setOpenMenuId(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopImmediatePropagation(); setOpenMenuId(null) }
    }
    const scroll = () => setOpenMenuId(null)
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [openMenuId])

  // 全选仅作用于当前可见的视频，不包含收起文件夹中的视频。
  const visibleIds = useMemo(() => shownVideos.map((v) => v.id), [shownVideos])

  // 键盘导航与快捷操作（光标状态与导航原语在 useVideoCursor 里）
  const {
    navigableItems, focusedIndex, focusedVideoId,
    moveCursor, jumpCursor, toggleFocusedSelection, handleRowClick, scrollRef
  } = useVideoCursor({ videos: shownVideos, toggleVideoSelection })

  const handleEntryKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const box = scrollRef.current
    if (!box || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const entries = Array.from(box.querySelectorAll<HTMLElement>('[data-library-entry]'))
    const current = entries.indexOf(event.currentTarget)
    if (current < 0) return
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? entries.length - 1
        : Math.max(0, Math.min(entries.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    event.stopPropagation()
    const next = entries[nextIndex]
    next?.focus()
    const videoId = next?.dataset.videoId
    if (videoId) handleRowClick(Number(videoId), event.shiftKey, event.ctrlKey || event.metaKey)
    else clearSelection()
    setOpenMenuId(null)
  }

  /**
   * 全局键盘快捷键（光标移动 + 操作键）。「键 → 行为」集中在 useLibraryShortcuts，
   * 这里只负责把当前状态/动作喂给它。
   */
  useLibraryShortcuts({
    videos: shownVideos, navigableItems, focusedIndex, focusedVideoId, selectedVideoIds,
    moveCursor, jumpCursor, toggleFocusedSelection,
    selectAll: () => setSelectedIds(visibleIds, true), clearSelection,
    onToggleTree: () => { clearSelection(); setOpenMenuId(null); onToggleTree() },
    onOpen: props.onOpen, onReveal: props.onReveal, onReindex: props.onReindex,
    onImportFolder: props.onImportFolder, onImportFiles: props.onImportFiles, onRescan: props.onRescan,
    onRemoveVideo: props.onRemoveVideo, onRemoveVideos: props.onRemoveVideos, filterInputRef
  })

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Toolbar
          query={query}
          onSetQuery={onSetQuery}
          videos={shownVideos}
          total={total}
          selectedVideoIds={selectedVideoIds}
          onSelectAll={() => setSelectedIds(visibleIds, true)}
          treeVisible={treeVisible}
          onToggleTree={() => { clearSelection(); setOpenMenuId(null); onToggleTree() }}
          onImportFiles={props.onImportFiles}
          onImportFolder={props.onImportFolder}
          onWatchFolder={props.onAddFolder}
          onManageFolders={() => setDrawer('folders')}
          onOpenSettings={() => setDrawer('settings')}
          onFindDuplicates={props.onFindDuplicates}
          onDuplicatesResolved={(pairs) => setDuplicates(pairs)}
          onReindex={props.onReindex}
          onRescan={props.onRescan}
          onRemoveVideos={props.onRemoveVideos}
          clearSelection={clearSelection}
          filterInputRef={filterInputRef}
        />

        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto bg-surface-1">
          <table className="w-full min-w-[650px] border-separate border-spacing-0 text-[12px]">
            <thead className="sticky top-0 z-10 bg-surface-1/95 text-left text-[10.5px] text-tertiary backdrop-blur">
              <tr onMouseDown={blockModifierTextSelection}>
                <th className="px-3 py-2 font-medium">视频</th>
                <th className="w-32 whitespace-nowrap px-2 py-2 font-medium">状态</th>
                <th className="w-16 whitespace-nowrap px-2 py-2 font-medium">时长</th>
                <th className="w-[72px] whitespace-nowrap px-2 py-2 font-medium">大小</th>
                <th className="sticky right-0 w-20 bg-surface-1 px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => row.type === 'folder' ? (
                <tr key={`folder:${row.node.path}`} className="group" data-folder-path={row.node.path}>
                  <td colSpan={4} className="border-b border-line/50 bg-surface-1 p-0">
                    <button
                      data-library-entry
                      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-row-hover focus-visible:outline-accent"
                      style={{ paddingLeft: `${16 + row.depth * 22}px` }}
                      onClick={() => toggleFolder(row.node.path)}
                      onKeyDown={(event) => {
                        if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                          handleEntryKeyDown(event)
                          return
                        }
                        const open = filtering ? !closedFilteredPaths.has(explorerPathKey(row.node.path)) : expandedPaths.has(explorerPathKey(row.node.path))
                        if ((event.key === 'ArrowRight' && !open) || (event.key === 'ArrowLeft' && open)) {
                          event.preventDefault()
                          event.stopPropagation()
                          toggleFolder(row.node.path)
                        }
                      }}
                      aria-expanded={filtering ? !closedFilteredPaths.has(explorerPathKey(row.node.path)) : expandedPaths.has(explorerPathKey(row.node.path))}
                      aria-label={`${row.node.name}，${row.node.count} 个视频`}
                    >
                      <span className="w-3 text-[11px] text-tertiary">{(filtering ? !closedFilteredPaths.has(explorerPathKey(row.node.path)) : expandedPaths.has(explorerPathKey(row.node.path))) ? '⌄' : '›'}</span>
                      <span className="text-[17px] text-accent" aria-hidden="true">▣</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-primary" title={row.node.path}>{row.node.name}</span>
                        {row.depth === 0 && <span className="block truncate text-[10.5px] text-tertiary" title={row.node.path}>{row.node.path}</span>}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-tertiary">{row.node.count} 个视频</span>
                    </button>
                  </td>
                  <td className="sticky right-0 border-b border-line/50 bg-surface-1 px-3 text-right text-[10.5px] text-tertiary">
                    {row.node.folder && !row.node.folder.pinned
                      ? '一次性导入'
                      : row.node.folder
                        ? row.node.folder.enabled
                          ? (STATE_STYLE[row.node.folder.watchState]?.text ?? '待监听')
                          : '已暂停'
                        : ''}
                  </td>
                </tr>
              ) : row.type === 'empty' ? (
                <tr key={`empty:${row.path}`}>
                  <td colSpan={5} className="border-b border-line/40 bg-surface-1 py-3 text-[11.5px] text-tertiary" style={{ paddingLeft: `${36 + row.depth * 22}px` }}>
                    暂无已入库视频
                  </td>
                </tr>
              ) : (
                <VideoRow
                  key={row.video.id}
                  video={row.video}
                  depth={row.depth}
                  showLocation={!treeVisible || row.depth === 0}
                  roots={roots}
                  focused={focusedVideoId === row.video.id}
                  onOpen={(id) => { handleRowClick(id, false, false); props.onOpen(id) }}
                  onReveal={(id) => { handleRowClick(id, false, false); props.onReveal(id) }}
                  onRemove={props.onRemoveVideo}
                  onViewFrames={openFramesViewer}
                  globalSampling={props.globalSampling}
                  onSamplingChange={(id, mode) => props.onReindex([id], mode)}
                  isVideoSelected={isVideoSelected}
                  onRowClick={(shiftKey, ctrlKey) => { setOpenMenuId(null); handleRowClick(row.video.id, shiftKey, ctrlKey) }}
                  onOpenDouble={(id) => props.onOpen(id)}
                  menuOpen={openMenuId === row.video.id}
                  onToggleMenu={() => {
                    if (openMenuId === row.video.id) setOpenMenuId(null)
                    else {
                      handleRowClick(row.video.id, false, false)
                      setOpenMenuId(row.video.id)
                    }
                  }}
                  onCloseMenu={() => setOpenMenuId(null)}
                  onNavigateKey={handleEntryKeyDown}
                />
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-20 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-3 text-xl text-tertiary">▶</div>
              <div className="mt-4 text-[14px] font-medium text-primary">{noMatches ? '没有符合条件的视频' : '开始建立你的视频库'}</div>
              <div className="mt-1 text-[11.5px] text-tertiary">{noMatches ? '试试清除搜索或更换筛选条件' : '添加视频或文件夹即可开始索引'}</div>
              {filtering && <button className="btn mt-4" onClick={() => onSetQuery({ ...query, keyword: '', status: 'all', offset: 0 })}>清除筛选</button>}
              {!noMatches && <div className="mt-4 flex items-center gap-2">
                <button className="btn border-accent-strong bg-accent text-surface-0" onClick={props.onImportFiles}>导入视频</button>
                <button className="btn" onClick={props.onImportFolder}>导入文件夹</button>
              </div>}
            </div>
          )}
        </div>
      </section>

      <SidePanel
        mode={drawer}
        onClose={() => setDrawer(null)}
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
              <div className="rounded-xl border border-dashed border-line p-6 text-center text-[11.5px] text-tertiary">
                拖入文件夹将自动监视后续变化
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

      {duplicates !== null && (
        <DuplicatesModal
          duplicates={duplicates}
          onClose={() => setDuplicates(null)}
          onRemoveVideos={props.onRemoveVideos}
          onPrune={(removedIds) =>
            setDuplicates((prev) =>
              prev
                ? prev.filter(
                    (x) => !removedIds.includes(x.videoA.id) && !removedIds.includes(x.videoB.id)
                  )
                : prev
            )
          }
        />
      )}

      <FrameGallery
        video={framesVideo}
        onClose={() => setFramesVideo(null)}
        onOpenFrame={(id, atSeconds) => {
          props.onOpen(id, atSeconds)
        }}
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
    <div className="rounded-xl border border-line bg-surface-1 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium text-primary" title={folder.path}>
              {folder.name}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-muted" title={folder.path}>
            {folder.path}
          </div>
        </div>
        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] ${folder.pinned ? style.cls : 'border-line bg-surface-2 text-secondary'}`}>
          {folder.pinned ? style.text : '一次性导入'}
        </span>
      </div>

      {folder.message && (
        <div className="mt-1.5 truncate text-[10.5px] text-bad" title={folder.message}>
          {folder.message}
        </div>
      )}

      <div className="mt-2 flex items-center gap-1">
        {folder.pinned && <button
          className="btn px-2 py-1 text-[11px]"
          onClick={() => onToggle(folder.id, !folder.enabled)}
        >
          {folder.enabled ? '暂停监听' : '恢复监听'}
        </button>}
        <button className="btn px-2 py-1 text-[11px]" onClick={() => onRescan(folder.id)}>
          扫描
        </button>
        <button
          className="ml-auto rounded-lg px-2 py-1 text-[11px] text-bad hover:bg-bad/10"
          onClick={() => {
            if (window.confirm(`从视频库移除「${folder.name}」及其关联视频？\n不会删除磁盘上的文件。`)) onRemove(folder.id)
          }}
          title="从索引库移除文件夹及其视频，不删除磁盘文件"
        >
          从库中移除
        </button>
      </div>
    </div>
  )
}

/** 从拖拽内容里尽力提取目录绝对路径（桌面 WebView 的 File.path 扩展可用时优先）。 */
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
