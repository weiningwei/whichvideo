import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { DuplicatePair, ImportResult, SamplingMode, VideoQuery, VideoRecord, WatchedFolder } from '@shared/types'
import { blockModifierTextSelection } from '../lib/selection'
import { useVideoCursor } from '../hooks/useVideoCursor'
import { useLibraryShortcuts } from '../hooks/useLibraryShortcuts'
import { useLibraryColumns, COLUMN_LABELS, ACTION_COLUMN_WIDTH } from '../hooks/useLibraryColumns'
import { buildExplorerTree, explorerPathKey, visibleExplorerRows } from '../lib/libraryExplorer'
import { ROW_CHUNK, growLimit, limitForFocus } from '../lib/tableWindow'
import { sortVideoQuery } from '../lib/videoSort'
import { SidePanel } from './SidePanel'
import { VideoRow } from './VideoRow'
import { Toolbar } from './Toolbar'
import { DuplicatesModal } from './DuplicatesModal'
import { FrameGallery } from './FrameGallery'
import { FolderCard, FolderIcon, FOLDER_STATE_STYLE } from './FolderCard'

interface Props {
  folders: WatchedFolder[]
  /** 当前可见视频（已按地址栏目录过滤） */
  videos: VideoRecord[]
  total: number
  lastImportResult: ImportResult | null
  onRetryImportFailures: () => void
  query: VideoQuery
  onSetQuery: (query: VideoQuery) => void
  onAddFolder: () => void
  onDropPaths: (paths: string[], watchFolders: boolean) => void
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
  onRemoveVideos: (videoIds: number[]) => Promise<number[]>
  onReindex: (videoIds?: number[], mode?: SamplingMode) => void
  /** 全局采样模式（视频行未设覆盖时的生效值） */
  globalSampling: 'uniform' | 'scene'
  /** 库内查重：返回相似对。耗时长（每视频一次全帧扫描），由按钮显式触发 */
  onFindDuplicates: (minScore?: number) => Promise<DuplicatePair[] | null>
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

export function LibraryView(props: Props) {
  const {
    folders, videos, total, query, onSetQuery,
    treeVisible, onToggleTree, selectedVideoIds, isVideoSelected,
    toggleVideoSelection, clearSelection, setSelectedIds
  } = props

  const [folderDrop, setFolderDrop] = useState(false)
  const [libraryDrop, setLibraryDrop] = useState(false)
  const [drawer, setDrawer] = useState<'folders' | 'settings' | null>(null)
  const [reportExpanded, setReportExpanded] = useState(false)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [closedFilteredPaths, setClosedFilteredPaths] = useState<Set<string>>(new Set())
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null)
  const [openMenuId, setOpenMenuId] = useState<number | null>(null)
  const [openMenuPoint, setOpenMenuPoint] = useState<{ x: number; y: number } | null>(null)
  /** 实际挂进 DOM 的行数：几千行的表格一次挂全会同时发几千个缩略图请求 */
  const [renderLimit, setRenderLimit] = useState(ROW_CHUNK)
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
  /** 只挂载窗口内的行；选择/全选/快捷键仍按 rows 全量计算 */
  const mountedRows = useMemo(() => rows.slice(0, renderLimit), [rows, renderLimit])
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // 切视图、换筛选后从第一屏开始，避免沿用上一个大列表的挂载上限
  useEffect(() => {
    setRenderLimit(ROW_CHUNK)
  }, [treeVisible, query.keyword, query.status, query.sort, query.order, query.folderId])
  useEffect(() => { props.setSelectionOrder(shownVideos.map((video) => video.id)) }, [props.setSelectionOrder, shownVideos])
  const toggleFolder = (path: string) => {
    const key = explorerPathKey(path)
    setOpenMenuId(null)
    setSelectedFolderPath(key)
    clearSelection()
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
  useEffect(() => { setSelectedFolderPath(null) }, [treeVisible, query.keyword, query.status, query.folderId])
  useEffect(() => { setOpenMenuId(null) }, [treeVisible, query.keyword, query.status, query.sort])
  useEffect(() => {
    if (openMenuId !== null && !selectedVideoIds.has(openMenuId)) setOpenMenuId(null)
  }, [selectedVideoIds, openMenuId])
  useEffect(() => { setOpenMenuId(null) }, [drawer, duplicates, framesVideo])
  // 本地文件/目录须用 Tauri 原生路径，浏览器 DataTransfer 不保证提供绝对路径。
  // 管理文件夹抽屉里的目录持续监视；库主区域里的目录只扫描一次。
  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    void getCurrentWindow().onDragDropEvent((event) => {
      if (!active) return
      if (event.payload.type === 'enter' || event.payload.type === 'over') {
        setFolderDrop(drawer === 'folders')
        setLibraryDrop(drawer === null)
      } else if (event.payload.type === 'leave') {
        setFolderDrop(false)
        setLibraryDrop(false)
      } else {
        setFolderDrop(false)
        setLibraryDrop(false)
        if (drawer !== 'settings' && event.payload.paths.length) {
          props.onDropPaths(event.payload.paths, drawer === 'folders')
        }
      }
    }).then((stop) => {
      if (active) unlisten = stop
      else stop()
    }).catch(() => {
      if (active) { setFolderDrop(false); setLibraryDrop(false) }
    })
    return () => {
      active = false
      unlisten?.()
    }
  }, [drawer, props.onDropPaths])
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
    moveCursor, jumpCursor, toggleFocusedSelection, handleRowClick, focusVideoWithoutSelection, scrollRef
  } = useVideoCursor({
    videos: shownVideos,
    toggleVideoSelection: (videoId, shiftKey, ctrlKey) => {
      setSelectedFolderPath(null)
      toggleVideoSelection(videoId, shiftKey, ctrlKey)
    },
    scrollSignal: renderLimit
  })
  const { displayColumnWidths, tableWidth, resizeHandle } = useLibraryColumns(scrollRef)

  // 键盘光标可以走到还没挂载的行（导航在原表上算），这时把那段补挂上，
  // 否则滚进可视区的查询找不到对应 DOM。（必须放在 useVideoCursor 之后：
  // 依赖数组在渲染期间求值，提前引用会命中 const 的 TDZ。）
  useEffect(() => {
    if (focusedVideoId === null) return
    const rowsNow = rowsRef.current
    const index = rowsNow.findIndex((row) => row.type === 'video' && row.video.id === focusedVideoId)
    if (index < 0) return
    setRenderLimit((current) => limitForFocus(current, index, rowsNow.length))
  }, [focusedVideoId])

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
    if (videoId) {
      handleRowClick(Number(videoId), event.shiftKey, event.ctrlKey || event.metaKey)
    } else {
      setSelectedFolderPath(next?.dataset.folderPath ? explorerPathKey(next.dataset.folderPath) : null)
      clearSelection()
    }
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
      {libraryDrop && <div className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-surface-1/95 text-[14px] font-medium text-accent">松开导入视频或文件夹 · 文件夹仅扫描一次</div>}
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

        {props.lastImportResult && (
          <div className="border-b border-line bg-surface-2 px-4 py-2 text-[12px] text-secondary">
            <div className="flex flex-wrap items-center gap-2">
              <span>上次导入：新增 {props.lastImportResult.added}，已存在 {props.lastImportResult.duplicates}，跳过 {props.lastImportResult.skipped}，失败 {props.lastImportResult.failed}</span>
              {props.lastImportResult.failed > 0 && <button className="btn" onClick={() => setReportExpanded((open) => !open)}>{reportExpanded ? '收起详情' : '查看失败详情'}</button>}
              {props.lastImportResult.failures.length > 0 && <button className="btn" onClick={props.onRetryImportFailures}>重试失败项</button>}
            </div>
            {reportExpanded && props.lastImportResult.failures.length > 0 && (
              <ul className="mt-2 max-h-44 space-y-1 overflow-auto" aria-label="导入失败详情">
                {props.lastImportResult.failures.map((failure, index) => (
                  <li key={`${failure.path}:${index}`} className="rounded border border-line bg-surface-1 px-2 py-1">
                    <div className="break-all text-primary">{failure.path}</div>
                    <div className="text-warn">{failure.reason}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div
          ref={scrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-auto bg-surface-1"
          onScroll={(event) => {
            if (renderLimit >= rows.length) return
            const box = event.currentTarget
            // 接近底部时再挂下一段；列表数据本身早已全部在内存里。
            if (box.scrollTop + box.clientHeight >= box.scrollHeight - 360) {
              setRenderLimit((current) => growLimit(current, rows.length))
            }
          }}
        >
          <table className="table-fixed border-separate border-spacing-0 text-[12px]" style={{ width: tableWidth }}>
            <colgroup>
              {displayColumnWidths.map((width, index) => <col key={COLUMN_LABELS[index]} style={{ width }} />)}
              <col style={{ width: ACTION_COLUMN_WIDTH }} />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-surface-1/95 text-left text-[12px] text-secondary backdrop-blur">
              <tr onMouseDown={blockModifierTextSelection}>
                <th className="relative border-r border-line p-0 font-semibold" aria-sort={query.sort === 'name' ? query.order === 'desc' ? 'descending' : 'ascending' : 'none'}>
                  <button className="block w-full px-3 py-2 text-left" onClick={() => onSetQuery(sortVideoQuery(query, 'name', true))}>视频{query.sort === 'name' ? query.order === 'desc' ? ' ↓' : ' ↑' : ''}</button>
                  {resizeHandle(0)}
                </th>
                <th className="relative border-r border-line px-2 py-2 font-semibold">状态{resizeHandle(1)}</th>
                <th className="relative border-r border-line p-0 font-semibold" aria-sort={query.sort === 'duration' ? query.order === 'asc' ? 'ascending' : 'descending' : 'none'}>
                  <button className="block w-full px-2 py-2 text-left" onClick={() => onSetQuery(sortVideoQuery(query, 'duration', true))}>时长{query.sort === 'duration' ? query.order === 'asc' ? ' ↑' : ' ↓' : ''}</button>
                  {resizeHandle(2)}
                </th>
                <th className="relative p-0 font-semibold" aria-sort={query.sort === 'size' ? query.order === 'asc' ? 'ascending' : 'descending' : 'none'}>
                  <button className="block w-full px-2 py-2 text-left" onClick={() => onSetQuery(sortVideoQuery(query, 'size', true))}>大小{query.sort === 'size' ? query.order === 'asc' ? ' ↑' : ' ↓' : ''}</button>
                  {resizeHandle(3)}
                </th>
                <th className="sticky right-0 border-l border-line bg-surface-1 px-2 py-2 text-left font-semibold">操作</th>
              </tr>
            </thead>
            <tbody>
              {mountedRows.map((row) => row.type === 'folder' ? (
                <tr key={`folder:${row.node.path}`} className="group" data-folder-path={row.node.path} aria-selected={selectedFolderPath === explorerPathKey(row.node.path)}>
                  <td colSpan={4} className={`relative border-b border-line/50 p-0 ${selectedFolderPath === explorerPathKey(row.node.path) ? 'bg-row-selected' : 'bg-surface-1'}`}>
                    {selectedFolderPath === explorerPathKey(row.node.path) && <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
                    <button
                      data-library-entry
                      data-folder-path={row.node.path}
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left focus-visible:outline-accent ${selectedFolderPath === explorerPathKey(row.node.path) ? '' : 'hover:bg-row-hover'}`}
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
                      <FolderIcon />
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[13.5px] font-medium ${selectedFolderPath === explorerPathKey(row.node.path) ? 'text-accent' : 'text-primary'}`} title={row.node.path}>{row.node.name}</span>
                        {row.depth === 0 && <span className="block truncate text-[10.5px] text-tertiary" title={row.node.path}>{row.node.path}</span>}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-tertiary">{row.node.count} 个视频</span>
                    </button>
                  </td>
                  <td className={`sticky right-0 border-b border-l border-line/50 px-2 text-left text-[10.5px] text-tertiary ${selectedFolderPath === explorerPathKey(row.node.path) ? 'bg-row-selected' : 'bg-surface-1'}`}>
                    {row.node.folder && !row.node.folder.pinned
                      ? '一次性导入'
                      : row.node.folder
                        ? row.node.folder.enabled
                          ? (FOLDER_STATE_STYLE[row.node.folder.watchState]?.text ?? '待监听')
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
                  focused={selectedFolderPath === null && focusedVideoId === row.video.id}
                  onOpen={(id) => { handleRowClick(id, false, false); props.onOpen(id) }}
                  onReveal={(id) => { handleRowClick(id, false, false); props.onReveal(id) }}
                  onRemove={props.onRemoveVideo}
                  onViewFrames={openFramesViewer}
                  globalSampling={props.globalSampling}
                  onSamplingChange={(id, mode) => props.onReindex([id], mode)}
                  isVideoSelected={isVideoSelected}
                  onRowClick={(shiftKey, ctrlKey) => { setOpenMenuId(null); handleRowClick(row.video.id, shiftKey, ctrlKey) }}
                  onOpenContextMenu={(x, y) => {
                    setSelectedFolderPath(null)
                    if (selectedVideoIds.has(row.video.id)) focusVideoWithoutSelection(row.video.id)
                    else handleRowClick(row.video.id, false, false)
                    setOpenMenuPoint({ x, y })
                    setOpenMenuId(row.video.id)
                  }}
                  onOpenDouble={(id) => props.onOpen(id)}
                  menuOpen={openMenuId === row.video.id}
                  menuPoint={openMenuId === row.video.id ? openMenuPoint : null}
                  onToggleMenu={() => {
                    if (openMenuId === row.video.id) setOpenMenuId(null)
                    else {
                      handleRowClick(row.video.id, false, false)
                      setOpenMenuPoint(null)
                      setOpenMenuId(row.video.id)
                    }
                  }}
                  onCloseMenu={() => setOpenMenuId(null)}
                  onNavigateKey={handleEntryKeyDown}
                />
              ))}
              {mountedRows.length < rows.length && (
                <tr>
                  <td colSpan={5} className="border-b border-line/40 px-4 py-3 text-[10.5px] text-tertiary">
                    已显示 {mountedRows.length} / {rows.length} 项 · 继续向下滚动加载
                  </td>
                </tr>
              )}
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
