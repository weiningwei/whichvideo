/**
 * 视频列表的光标与键盘导航。
 *
 * 从 LibraryView 拆出：光标状态、videoRowIndexes、moveCursor / jumpCursor /
 * handleRowClick 等导航原语，以及「列表变化重置光标」「焦点行滚进可视区」
 * 两个副作用。LibraryView 保留工具条、表格骨架、分组标题与键盘快捷键层。
 *
 * **光标与选中必须是同一个东西**——这是文件管理器式列表的基本模型：
 * 光标在哪，单选就在哪。此前两者是独立 state，方向键只移动灰竖条、蓝竖条
 * 留在原地，于是「按方向键切换」看起来毫无反应。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { VideoRecord } from '@shared/types'

/** PageUp / PageDown 一次跳多少行。按"一屏大约能看 15 行"取整。 */
export const PAGE_JUMP = 15

export type NavigableItem =
  | { type: 'folder'; folderId: number; index: number }
  | { type: 'video'; folderId?: number; video: VideoRecord; index: number }

export interface UseVideoCursorArgs {
  videos: VideoRecord[]
  groupByFolder: boolean
  groupedVideos: Map<number, VideoRecord[]> | null
  expandedFolderIds: Set<number>
  toggleVideoSelection: (videoId: number, shiftKey: boolean, ctrlKey: boolean) => void
  toggleFolderExpanded: (folderId: number) => void
}

export function useVideoCursor({
  videos,
  groupByFolder,
  groupedVideos,
  expandedFolderIds,
  toggleVideoSelection,
  toggleFolderExpanded
}: UseVideoCursorArgs) {
  // 分组视图：标题 + 展开的视频行；平铺视图：纯视频列表
  const navigableItems = useMemo<NavigableItem[]>(() => {
    if (!groupByFolder || !groupedVideos) {
      return videos.map((v, idx) => ({ type: 'video' as const, video: v, index: idx }))
    }
    const items: NavigableItem[] = []
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
   * 鼠标点到某一行时用：**光标移到该行**，再按修饰键决定选区怎么变。
   *
   * 上一版只把方向键与光标打通了，忘了点击这条路 —— 于是光标一直停在初始
   * 位置（第一个视频），点第 3 个再按 ↑ 就从第一个开始算，直接跳回第一个。
   * 光标与选中既然是同一个东西，**两条入口必须都改它**。
   */
  const focusRow = (index: number) => {
    setFocusedIndex(index)
    const item = navigableItems[index]
    if (item?.type === 'video' && item.video) {
      toggleVideoSelection(item.video.id, false, false)
    }
  }

  /** Shift+点击：与上次选中的位置之间连选，光标跟着走到目标行 */
  const selectRowRange = (index: number) => {
    setFocusedIndex(index)
    const item = navigableItems[index]
    if (item?.type === 'video' && item.video) {
      toggleVideoSelection(item.video.id, true, false)
    }
  }

  /** Ctrl+点击：只切换这一行的选中，其余不动，光标也走到该行 */
  const toggleRowSelection = (index: number) => {
    setFocusedIndex(index)
    const item = navigableItems[index]
    if (item?.type === 'video' && item.video) {
      toggleVideoSelection(item.video.id, false, true)
    }
  }

  /**
   * 点整行的统一入口。**按 video.id 反查行下标**，而不是靠 map 回调里的位置参数
   * 去算偏移 —— 分组视图下每个分组前面都插了一个标题，偏移量很容易算错，
   * 而算错的症状恰好是"点到第三个却把光标放到第一个"这种，极难从界面上看出来。
   */
  const handleRowClick = (videoId: number, shiftKey: boolean, ctrlKey: boolean) => {
    const index = navigableItems.findIndex((it) => it.type === 'video' && it.video?.id === videoId)
    if (index === -1) {
      // 理论上到不了（行都是从 navigableItems 渲染的）；真发生了至少别动光标
      toggleVideoSelection(videoId, shiftKey, ctrlKey)
      return
    }
    if (ctrlKey) toggleRowSelection(index)
    else if (shiftKey) selectRowRange(index)
    else focusRow(index)
  }

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
    if (!item || item.type !== 'video') return null
    return item.folderId ?? null
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

  return {
    navigableItems,
    videoRowIndexes,
    focusedIndex,
    focusedRowPos,
    focusedVideoId,
    moveCursor,
    jumpCursor,
    toggleFocusedSelection,
    handleRowClick,
    expandFocusedFolder,
    collapseFocusedFolder,
    scrollRef
  }
}
