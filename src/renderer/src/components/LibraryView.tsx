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
  /** 快捷键 I：导入视频文件（与顶栏「+ 导入视频」同一个动作） */
  onImportFiles: () => void
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

/** PageUp / PageDown 一次跳多少行。按"一屏大约能看 15 行"取整。 */
const PAGE_JUMP = 15

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
  /** 快捷键 / 会聚焦到这里 */
  const filterInputRef = useRef<HTMLInputElement>(null)

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

  // 键盘导航与快捷操作

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
   * 只有视频行的下标（跳过分组标题）。
   *
   * 方向键在这份列表上移动，因此 ↑↓ 永远不会停在分组标题上——标题不是视频，
   * 「选中」无从谈起。分组标题的展开/收起靠 ←→ 与点击标题。
   */
  const videoRowIndexes = useMemo(
    () =>
      navigableItems.reduce<number[]>((acc, item, i) => {
        if (item.type === 'video') acc.push(i)
        return acc
      }, []),
    [navigableItems]
  )

  /** 当前光标在 videoRowIndexes 里的位置（-1 = 尚未落在任何视频行上） */
  const focusedRowPos = videoRowIndexes.indexOf(focusedIndex)

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

  /**
   * 移动光标，并按修饰键决定要不要动选中区。
   *
   * **光标与选中必须是同一个东西**——这是文件管理器式列表的基本模型：
   * 光标在哪，单选就在哪。此前两者是独立 state，方向键只移动灰竖条、蓝竖条
   * 留在原地，于是「按方向键切换」看起来毫无反应。
   *
   * - 无修饰：单选跟随（清掉旧选中，选中新的一行）
   * - Shift：从上一次选中的位置连选一段
   * - Ctrl：只移动光标，已选中的视频保持不动（用于「先框选一批再逐个看过」）
   */
  const moveCursor = (delta: number, rangeKey: boolean, ctrlKey: boolean) => {
    if (videoRowIndexes.length === 0) return
    // 光标未落在视频行上时（首次进入时可能是 index 0 的分组标题），
    // 按向下从首行起步、按向上从末行起步——from 取 -1 / length，
    // 加上 delta 后正好落在两端。
    const from = focusedRowPos === -1 ? (delta > 0 ? -1 : videoRowIndexes.length) : focusedRowPos
    const nextPos = Math.max(0, Math.min(videoRowIndexes.length - 1, from + delta))
    const nextIndex = videoRowIndexes[nextPos]
    if (nextIndex === undefined) return
    setFocusedIndex(nextIndex)
    if (ctrlKey) return
    const item = navigableItems[nextIndex]
    if (item?.type === 'video' && item.video) {
      toggleVideoSelection(item.video.id, rangeKey, false)
    }
  }

  /** 跳到 videoRowIndexes 的指定位置（Home / End / PageUp / PageDown 用）；同样同步单选 */
  const jumpCursor = (pos: number, rangeKey = false) => {
    if (videoRowIndexes.length === 0) return
    const nextPos = Math.max(0, Math.min(videoRowIndexes.length - 1, pos))
    const nextIndex = videoRowIndexes[nextPos]
    if (nextIndex === undefined) return
    setFocusedIndex(nextIndex)
    if (rangeKey) return
    const item = navigableItems[nextIndex]
    if (item?.type === 'video' && item.video) {
      toggleVideoSelection(item.video.id, false, false)
    }
  }

  /**
   * 拿到"该被操作的那个视频"：有选中就用第一个选中的，否则用焦点处的。
   *
   * 这样 Delete / 播放这类操作在"多选"和"只看一行"两种心智下都自然：
   * 先选中再按 Delete 是删多个，什么都不选直接按是删当前这一行。
   */
  const getTargetVideo = (): VideoRecord | null => {
    if (selectedVideoIds.size > 0) {
      for (const v of videos) if (selectedVideoIds.has(v.id)) return v
      return null
    }
    return navigableItems[focusedIndex]?.video ?? null
  }

  /** 当前操作会作用到几个视频（用于决定要不要二次确认） */
  const getTargetCount = (): number =>
    selectedVideoIds.size > 0 ? selectedVideoIds.size : focusedVideoId === null ? 0 : 1


  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return
      // 焦点在按钮上时，空格与回车应触发按钮本身，否则会出现"点一下按钮没反应又改了选中态"
      const onButton = e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement
      const mod = e.ctrlKey || e.metaKey

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          moveCursor(1, e.shiftKey, mod)
          break
        case 'ArrowUp':
          e.preventDefault()
          moveCursor(-1, e.shiftKey, mod)
          break
        case 'PageDown':
          e.preventDefault()
          jumpCursor(focusedRowPos + PAGE_JUMP, e.shiftKey)
          break
        case 'PageUp':
          e.preventDefault()
          jumpCursor(focusedRowPos - PAGE_JUMP, e.shiftKey)
          break
        case 'Home':
          if (!mod) {
            e.preventDefault()
            jumpCursor(0, e.shiftKey)
          }
          break
        case 'End':
          if (!mod) {
            e.preventDefault()
            jumpCursor(videoRowIndexes.length - 1, e.shiftKey)
          }
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

        // Enter：有选中就播放第一个选中的；否则播放焦点处的
        case 'Enter': {
          if (onButton) return
          e.preventDefault()
          const target = getTargetVideo()
          if (target) props.onOpen(target.id)
          break
        }
        // 空格只做选中切换（不播放）—— 与文件管理器一致，空格是"选择"不是"打开"
        case ' ':
          if (onButton) return
          e.preventDefault()
          toggleFocusedSelection(e.shiftKey, mod)
          break

        // Ctrl+L 定位文件 / Ctrl+R 重建索引
        case 'l':
        case 'L':
          if (!mod) return
          e.preventDefault()
          if (focusedVideoId !== null) props.onReveal(focusedVideoId)
          break
        case 'r':
        case 'R':
          if (!mod) return
          e.preventDefault()
          if (focusedVideoId !== null) props.onReindex([focusedVideoId])
          break

        case 'a':
        case 'A':
          if (mod) {
            e.preventDefault()
            selectAll()
          }
          break
        case 'b':
        case 'B':
          // 重建全部索引。耗时较长（整库重新抽帧），但不涉及破坏性操作，不需要确认
          if (!mod) {
            e.preventDefault()
            props.onReindex()
          }
          break
        case 'i':
        case 'I':
          if (mod && e.shiftKey) {
            e.preventDefault()
            props.onAddFolder()
          } else if (!mod) {
            e.preventDefault()
            props.onImportFiles()
          }
          break
        case 's':
        case 'S':
          if (!mod) {
            e.preventDefault()
            props.onRescan()
          }
          break
        case 'g':
        case 'G':
          e.preventDefault()
          onToggleGroupByFolder()
          break

        case 'Delete':
        case 'Backspace': {
          e.preventDefault()
          const count = getTargetCount()
          if (count === 0) return
          // 一次删多个时先确认，避免误按丢掉一大片索引记录
          if (count > 1 && !window.confirm(`从索引库移除选中的 ${count} 个视频？\n（不会删除磁盘文件，可随时重新导入）`)) {
            return
          }
          if (selectedVideoIds.size > 0) {
            for (const id of selectedVideoIds) props.onRemoveVideo(id)
            clearSelection()
          } else {
            const target = getTargetVideo()
            if (target) props.onRemoveVideo(target.id)
          }
          break
        }
        case '/':
          e.preventDefault()
          filterInputRef.current?.focus()
          filterInputRef.current?.select()
          break
        case 'Escape':
          clearSelection()
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [groupByFolder, videos, groupedVideos, folders, expandedFolderIds, selectedVideoIds, focusedIndex, focusedRowPos, navigableItems, videoRowIndexes, focusedVideoId, onToggleGroupByFolder])

  /**
   * ←→ 作用于**光标所在视频所属的分组**。
   *
   * ↑↓ 只在视频行间移动（跳过分组标题），光标因此永远不会停在标题上——←→ 若还在
   * 等「光标位于 folder 项」就永远触发不了。改为从光标视频反查其分组：
   * → 展开该分组，← 收起。与文件管理器一致（光标在文件上，← 收起所在目录）。
   *
   * 平铺视图的项不带 folderId（没有分组概念），此时 ←→ 无从谈起。
   */
  const focusedFolderId = useMemo(() => {
    const item = navigableItems[focusedIndex]
    return item && item.type === 'video' && 'folderId' in item ? item.folderId : null
  }, [navigableItems, focusedIndex])

  const expandFocusedFolder = () => {
    if (focusedFolderId === null) return
    if (!expandedFolderIds.has(focusedFolderId)) toggleFolderExpanded(focusedFolderId)
  }

  const collapseFocusedFolder = () => {
    if (focusedFolderId === null) return
    if (expandedFolderIds.has(focusedFolderId)) toggleFolderExpanded(focusedFolderId)
  }

  /**
   * 在光标处切换选中（Space 专用）——与 ↑↓ 的「单选跟随」不同：不动光标、
   * 也不清掉其他已选中的行，是真正的「加选 / 取消选中」（文件管理器的空格行为）。
   *
   * @param rangeKey Shift：与上次选中的位置之间连选
   * @param toggleKey Ctrl：只切换这一行的选中状态，其余行不动
   */
  const toggleFocusedSelection = (rangeKey: boolean, toggleKey: boolean) => {
    const item = navigableItems[focusedIndex]
    if (item && item.type === 'video' && item.video) {
      toggleVideoSelection(item.video.id, rangeKey, toggleKey)
    }
  }

  // 列表变化（切分组模式、增删、筛选、折叠）后把光标收回第一个**视频行**。
  // 不能简单写 0：分组视图里 index 0 是分组标题，光标停在那既没有灰条提示，
  // 方向键也只能「从旁边起步」，手感上像是坏的。
  useEffect(() => {
    setFocusedIndex(videoRowIndexes[0] ?? 0)
    // 只在列表结构变化时重置；videoRowIndexes 每次重算都是新数组，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupByFolder, videos, expandedFolderIds])

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
            ref={filterInputRef}
            value={query.keyword ?? ''}
            onChange={(e) => onSetQuery({ ...query, keyword: e.target.value, offset: 0 })}
            placeholder="按文件名 / 目录筛选（/ 聚焦）"
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

        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto bg-ink-900">
          {/* min-w 是"低于这个宽度才允许横向滚动"的阈值，取三列的下限之和：
              视频列 200（够一行缩略图+几个字）+ 状态 96 + 操作 180。
              别设更高——文件名已改成两行显示，内容并不需要那么宽，
              阈值定高反而会凭空造出横向滚动条。 */}
          <table className="w-full min-w-[480px] border-separate border-spacing-0 text-[12px]">
            <thead className="sticky top-0 z-10 bg-ink-900/95 text-left text-[11px] uppercase tracking-wide text-tertiary backdrop-blur">
              <tr>
                <th className="px-3 py-2 font-medium">视频</th>
                <th className="w-24 whitespace-nowrap px-2 py-2 font-medium">状态</th>
                {/* 操作列吸附右侧：窗口窄到表格要横向滚动时，四个按钮仍贴在视野内。
                    左侧那条线标示"这里是浮在内容之上的固定区"。 */}
                <th className="sticky right-0 w-[180px] border-l border-line/70 bg-ink-900 px-3 py-2 text-right font-medium">
                  操作
                </th>
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

                  const toggleGroup = () => {
                    const target = !groupSelected
                    folderVideos.forEach((v) => {
                      if (target !== isVideoSelected(v.id)) toggleVideoSelection(v.id, false, false)
                    })
                  }

                  // 分组标题不再有「键盘焦点」态：↑↓ 只在视频行间移动，光标不会停在标题上。
                  // 之前用 focusedIndex === groupIdx 判断，但那条件在光标与选中合一后
                  // 永远不成立，留着只会误导后来人以为标题能被键盘选中。
                  // 标题行拆成两格而不是一个 colSpan=3：跨三列的 td 会把操作列一起盖住，
                  // 右侧的吸附格与分隔线就断了。第二格留空，只为延续那条竖线。
                  const header = (
                    <tr key={`folder-header-${folderId}`} className="border-t border-line/40">
                      <td colSpan={2} className="bg-row-group px-3 py-2">
                        <div className="flex items-center gap-2 text-[12px] font-medium text-secondary">
                          {/* 全选该组：点竖条。热区做到 12px 宽（视觉仍是 2px），
                              否则这个 2px 的细条根本点不中。 */}
                          <span
                            className="-m-1 flex h-5 w-3 shrink-0 cursor-pointer items-center justify-center"
                            onClick={toggleGroup}
                            title={groupSelected ? '取消全选该组' : '全选该组'}
                            role="checkbox"
                            aria-checked={groupSelected}
                            aria-label="全选该组"
                          >
                            <span
                              className={`h-3.5 w-[2px] rounded-full transition ${
                                groupSelected ? 'bg-accent' : groupPartial ? 'bg-accent/45' : 'bg-transparent'
                              }`}
                            />
                          </span>
                          {/* 展开/收起：整块（竖条右侧到视频数）都可点。
                              此前文件夹名字被"全选该组"占用了，只能点小三角 ——
                              那不符合直觉，名字就该是展开收起的主热区。 */}
                          <span
                            className="-my-2 flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 hover:text-primary"
                            onClick={() => toggleFolderExpanded(folderId)}
                            title={expanded ? '收起该目录' : '展开该目录'}
                          >
                            <span
                              className="select-none transition-transform duration-150"
                              style={{ transform: `rotate(${expanded ? 0 : -90}deg)` }}
                            >
                              ▼
                            </span>
                            <span className="truncate font-medium">{displayName}</span>
                            <span className="ml-auto shrink-0 text-[11px] font-normal text-muted">
                              {folderVideos.length} 个视频
                            </span>
                          </span>
                        </div>
                      </td>
                      {/* 空的操作格：只为让吸附列的左侧分隔线在标题行也连续 */}
                      <td className="sticky right-0 w-[180px] border-l border-line/70 bg-row-group" />
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

  /**
   * 行底色。用 `--color-row-*` 这几个**不透明**的实色，不是 bg-accent/12 那种
   * 半透明叠色 —— 操作列是 sticky 的，会浮在左侧单元格之上，半透明底色会让
   * 滚过来的文字透上来叠在按钮上（这几个色值已在 index.css 里预先混好）。
   *
   * 只给 td、不给 tr：tr 若也有背景，与吸附格叠加后同一行会出现两种色块。
   */
  const rowBg = selected
    ? 'bg-row-selected'
    : focused
      ? 'bg-row-focus'
      : 'hover:bg-row-hover'

  return (
    <tr
      data-video-id={video.id}
      onClick={onToggleSelect}
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