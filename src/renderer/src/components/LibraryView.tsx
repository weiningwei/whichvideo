import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { DuplicatePair, SamplingMode, VideoQuery, VideoRecord, WatchedFolder } from '@shared/types'
import { blockModifierTextSelection } from '../lib/selection'
import { useVideoCursor } from '../hooks/useVideoCursor'
import { useLibraryShortcuts } from '../hooks/useLibraryShortcuts'
import { buildExplorerTree, explorerPathKey, visibleExplorerRows } from '../lib/libraryExplorer'
import { ROW_CHUNK, growLimit, limitForFocus } from '../lib/tableWindow'
import { sortVideoQuery } from '../lib/videoSort'
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

const STATE_STYLE: Record<string, { text: string; cls: string }> = {
  watching: { text: '监听中', cls: 'border-ok/40 bg-ok/10 text-ok' },
  idle: { text: '已暂停', cls: 'border-line bg-ink-700/40 text-secondary' },
  missing: { text: '目录不存在', cls: 'border-bad/40 bg-bad/10 text-bad' },
  error: { text: '监听异常', cls: 'border-bad/40 bg-bad/10 text-bad' }
}

const COLUMN_WIDTHS_KEY = 'wv-library-column-widths'
const DEFAULT_COLUMN_WIDTHS = [360, 128, 96, 96] as const
const MIN_COLUMN_WIDTHS = [240, 112, 88, 88] as const
const COLUMN_LABELS = ['视频', '状态', '时长', '大小'] as const
const ACTION_COLUMN_WIDTH = 88

function loadColumnWidths(): { widths: number[]; firstFixed: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) ?? 'null')
    if (typeof saved?.firstFixed === 'boolean' && Array.isArray(saved.widths) && saved.widths.length === DEFAULT_COLUMN_WIDTHS.length &&
      saved.widths.every((width: number, index: number) => Number.isFinite(width) && width >= MIN_COLUMN_WIDTHS[index] && width <= 2000)) {
      return saved
    }
  } catch { /* localStorage 不可用时使用默认列宽 */ }
  return { widths: [...DEFAULT_COLUMN_WIDTHS], firstFixed: false }
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
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null)
  const [initialColumnLayout] = useState(loadColumnWidths)
  const [columnWidths, setColumnWidths] = useState(initialColumnLayout.widths)
  const [firstColumnFixed, setFirstColumnFixed] = useState(initialColumnLayout.firstFixed)
  const [tableViewportWidth, setTableViewportWidth] = useState(0)
  const resizeRef = useRef<{ index: number; pointerId: number; startX: number; startWidth: number } | null>(null)
  const columnWidthsRef = useRef(columnWidths)
  const firstColumnFixedRef = useRef(firstColumnFixed)
  columnWidthsRef.current = columnWidths
  firstColumnFixedRef.current = firstColumnFixed
  const [openMenuId, setOpenMenuId] = useState<number | null>(null)
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

  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const observer = new ResizeObserver(() => setTableViewportWidth(box.clientWidth))
    observer.observe(box)
    setTableViewportWidth(box.clientWidth)
    return () => observer.disconnect()
  }, [])

  const maxColumnWidth = (index: number): number => {
    const otherWidths = columnWidths.reduce((sum, width, column) => {
      if (column === index) return sum
      return sum + (column === 0 && !firstColumnFixed ? MIN_COLUMN_WIDTHS[0] : width)
    }, ACTION_COLUMN_WIDTH)
    return Math.max(MIN_COLUMN_WIDTHS[index], Math.min(2000, tableViewportWidth - otherWidths))
  }

  const resizeHandle = (index: number) => (
    <span
      role="separator"
      aria-label={`调整${COLUMN_LABELS[index]}列宽`}
      aria-orientation="vertical"
      aria-valuemin={MIN_COLUMN_WIDTHS[index]}
      aria-valuemax={maxColumnWidth(index)}
      aria-valuenow={displayColumnWidths[index]}
      tabIndex={0}
      title={`拖动调整${COLUMN_LABELS[index]}列宽`}
      className="group/resize absolute -right-1 top-0 z-20 flex h-full w-2 cursor-col-resize touch-none items-center justify-center focus-visible:outline-accent"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        event.stopPropagation()
        const change = event.key === 'ArrowRight' ? 10 : -10
        const next = columnWidths.map((value, column) => column === index
          ? Math.min(maxColumnWidth(index), Math.max(MIN_COLUMN_WIDTHS[index], displayColumnWidths[index] + change)) : value)
        if (index === 0) { firstColumnFixedRef.current = true; setFirstColumnFixed(true) }
        columnWidthsRef.current = next
        setColumnWidths(next)
        try { localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify({ widths: next, firstFixed: firstColumnFixedRef.current })) } catch { /* 无持久化权限时本次调整仍有效 */ }
      }}
      onPointerDown={(event: ReactPointerEvent<HTMLSpanElement>) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        if (index === 0) { firstColumnFixedRef.current = true; setFirstColumnFixed(true) }
        event.currentTarget.setPointerCapture(event.pointerId)
        resizeRef.current = {
          index, pointerId: event.pointerId, startX: event.clientX,
          startWidth: event.currentTarget.parentElement?.getBoundingClientRect().width ?? columnWidths[index]
        }
      }}
      onPointerMove={(event: ReactPointerEvent<HTMLSpanElement>) => {
        const resize = resizeRef.current
        if (!resize || resize.pointerId !== event.pointerId) return
        const width = Math.min(maxColumnWidth(resize.index), Math.max(MIN_COLUMN_WIDTHS[resize.index], Math.round(resize.startWidth + event.clientX - resize.startX)))
        setColumnWidths((current) => current.map((value, column) => column === resize.index ? width : value))
      }}
      onPointerUp={(event: ReactPointerEvent<HTMLSpanElement>) => {
        const resize = resizeRef.current
        if (!resize || resize.pointerId !== event.pointerId) return
        const width = Math.min(maxColumnWidth(resize.index), Math.max(MIN_COLUMN_WIDTHS[resize.index], Math.round(resize.startWidth + event.clientX - resize.startX)))
        const next = columnWidthsRef.current.map((value, column) => column === resize.index ? width : value)
        columnWidthsRef.current = next
        setColumnWidths(next)
        resizeRef.current = null
        try { localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify({ widths: next, firstFixed: firstColumnFixedRef.current })) } catch { /* 无持久化权限时本次调整仍有效 */ }
      }}
      onPointerCancel={() => { resizeRef.current = null }}
    >
      <span className="h-5 w-px bg-line group-hover/resize:w-0.5 group-hover/resize:bg-accent" />
    </span>
  )

  const displayColumnWidths = [
    firstColumnFixed ? columnWidths[0] : Math.min(2000, Math.max(columnWidths[0], tableViewportWidth - columnWidths.slice(1).reduce((sum, width) => sum + width, ACTION_COLUMN_WIDTH))),
    ...columnWidths.slice(1)
  ]
  const tableWidth = displayColumnWidths.reduce((sum, width) => sum + width, ACTION_COLUMN_WIDTH)
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
  // 浏览器 DataTransfer 不保证暴露本地绝对路径，且旧实现把所有 / 强转成 \\，
  // 会让 macOS/Linux 拖入目录失效。Tauri 原生事件提供真实路径，文件路径也不会
  // 被悄悄截成父目录（后端会明确拒绝非目录）。
  useEffect(() => {
    if (drawer !== 'folders') return
    let active = true
    let unlisten: (() => void) | undefined
    void getCurrentWindow().onDragDropEvent((event) => {
      if (!active) return
      if (event.payload.type === 'enter' || event.payload.type === 'over') {
        setFolderDrop(true)
      } else if (event.payload.type === 'leave') {
        setFolderDrop(false)
      } else {
        setFolderDrop(false)
        const [path] = event.payload.paths
        if (path) props.onAddFolderPath(path)
      }
    }).then((stop) => {
      if (active) unlisten = stop
      else stop()
    }).catch(() => {
      if (active) setFolderDrop(false)
    })
    return () => {
      active = false
      unlisten?.()
    }
  }, [drawer, props.onAddFolderPath])
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
  } = useVideoCursor({
    videos: shownVideos,
    toggleVideoSelection: (videoId, shiftKey, ctrlKey) => {
      setSelectedFolderPath(null)
      toggleVideoSelection(videoId, shiftKey, ctrlKey)
    },
    scrollSignal: renderLimit
  })

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
                <th className="relative border-r border-line px-3 py-2 font-semibold" aria-sort={query.sort === 'name' ? query.order === 'desc' ? 'descending' : 'ascending' : 'none'}>
                  <button onClick={() => onSetQuery(sortVideoQuery(query, 'name', true))}>视频{query.sort === 'name' ? query.order === 'desc' ? ' ↓' : ' ↑' : ''}</button>
                  {resizeHandle(0)}
                </th>
                <th className="relative border-r border-line px-2 py-2 font-semibold">状态{resizeHandle(1)}</th>
                <th className="relative border-r border-line px-2 py-2 font-semibold" aria-sort={query.sort === 'duration' ? query.order === 'asc' ? 'ascending' : 'descending' : 'none'}>
                  <button onClick={() => onSetQuery(sortVideoQuery(query, 'duration', true))}>时长{query.sort === 'duration' ? query.order === 'asc' ? ' ↑' : ' ↓' : ''}</button>
                  {resizeHandle(2)}
                </th>
                <th className="relative px-2 py-2 font-semibold" aria-sort={query.sort === 'size' ? query.order === 'asc' ? 'ascending' : 'descending' : 'none'}>
                  <button onClick={() => onSetQuery(sortVideoQuery(query, 'size', true))}>大小{query.sort === 'size' ? query.order === 'asc' ? ' ↑' : ' ↓' : ''}</button>
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
                  focused={selectedFolderPath === null && focusedVideoId === row.video.id}
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

/** 资源树节点标识：描边文件夹避免被误读成复选框或半选状态。 */
function FolderIcon() {
  return (
    <svg
      data-folder-icon
      className="h-4 w-4 shrink-0 text-accent"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.75 5.5h5l1.7 2H17.25v7.25a1.5 1.5 0 0 1-1.5 1.5h-11.5a1.5 1.5 0 0 1-1.5-1.5V5.5Z" />
      <path d="M2.75 7.5h14.5" />
    </svg>
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
