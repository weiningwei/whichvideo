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
import { PAGE_JUMP } from '../constants'

export { PAGE_JUMP }

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
  const navigableItems = useMemo<NavigableItem[]>(() => {
    if (!groupByFolder || !groupedVideos) {
      return videos.map((v, idx) => ({ type: 'video' as const, video: v, index: idx }))
    }
    const items: NavigableItem[] = []
    let idx = 0
    // **所有视频都进 navigableItems**，不再判 expandedFolderIds —— 快捷键
    // （↑↓/Home/End/PageUp/PageDown/Enter/Space/Ctrl+A/X/R/Delete/右键菜单）
    // 必须能跨过任何未展开分组跳到任一视频。落到未展开分组的视频时由
    // `expandFolderOfFocused` 自动展开，避免视觉丢失（用户既然用快捷键
    // 显式导航到那里就说明要看）。
    for (const [folderId, folderVideos] of groupedVideos) {
      items.push({ type: 'folder', folderId, index: idx++ })
      for (const v of folderVideos) {
        items.push({ type: 'video', folderId, video: v, index: idx++ })
      }
    }
    return items
  }, [groupByFolder, groupedVideos])

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

  /**
   * 若 nextItem 是 video 且所属 folder 未展开则展开 —— 移到未展开分组的视频
   * 时让用户能看见。与"用户主动 ← 收起"是不同的语义：导航是"我要看"，← 是
   * "我要折叠"。folder 标题项不动（用户可能正想"扫过"未展开组）。
   *
   * 调用方通常刚 setFocusedIndex(nextPos)。focusedFolderId 是从 focusedIndex
   * 派生的 memo，要等下一轮渲染才更新。直接读 nextItem 不依赖 state。
   */
  const expandFolderIfVideo = (nextItem: NavigableItem | undefined) => {
    if (!nextItem || nextItem.type !== 'video') return
    if (nextItem.folderId === null || nextItem.folderId === undefined) return
    if (!expandedFolderIds.has(nextItem.folderId)) toggleFolderExpanded(nextItem.folderId)
  }

  /**
   * 移动光标（↑↓ / PageUp / PageDown / Home / End 入口），在 **navigableItems
   * 全表** 上移动 —— folder 标题也是合法可停靠点，与 macOS Finder 一致：
   *
   *   - 在视频上按 ↓/End → 跨过所在组的标题，跳到下一组的第一项
   *     （视频若所属组未折叠则 auto-expand 让用户能看见）
   *   - 在 folder 标题上按 ↑↓ → 移向邻接的标题或视频
   *   - 在某组最后一个视频上按 ↓ → 跳到下一组的标题（不是直接跳到第一个
   *     视频 —— 跨过标题这条线让用户能用 Enter 决定是否进入该组）
   */
  const moveCursor = (delta: number, rangeKey: boolean, ctrlKey: boolean) => {
    if (navigableItems.length === 0) return
    const from = focusedIndex === -1 ? (delta > 0 ? -1 : navigableItems.length) : focusedIndex
    const nextPos = Math.max(0, Math.min(navigableItems.length - 1, from + delta))
    if (nextPos === from) return
    const nextItem = navigableItems[nextPos]
    if (!nextItem) return
    setFocusedIndex(nextPos)
    expandFolderIfVideo(nextItem)
    if (ctrlKey) return
    if (nextItem.type === 'video' && nextItem.video) {
      toggleVideoSelection(nextItem.video.id, rangeKey, false)
    }
  }

  /** 跳到 navigableItems 的指定位置（Home / End / PageUp / PageDown 用）；同样同步单选 */
  const jumpCursor = (pos: number, rangeKey = false) => {
    if (navigableItems.length === 0) return
    const nextPos = Math.max(0, Math.min(navigableItems.length - 1, pos))
    if (nextPos === focusedIndex) return
    const nextItem = navigableItems[nextPos]
    if (!nextItem) return
    setFocusedIndex(nextPos)
    expandFolderIfVideo(nextItem)
    if (rangeKey) return
    if (nextItem.type === 'video' && nextItem.video) {
      toggleVideoSelection(nextItem.video.id, false, false)
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
    expandFolderIfVideo(navigableItems[index])
    const item = navigableItems[index]
    if (item?.type === 'video' && item.video) {
      toggleVideoSelection(item.video.id, false, false)
    }
  }

  /** Shift+点击：与上次选中的位置之间连选，光标跟着走到目标行 */
  const selectRowRange = (index: number) => {
    setFocusedIndex(index)
    expandFolderIfVideo(navigableItems[index])
    const item = navigableItems[index]
    if (item?.type === 'video' && item.video) {
      toggleVideoSelection(item.video.id, true, false)
    }
  }

  /** Ctrl+点击：只切换这一行的选中，其余不动，光标也走到该行 */
  const toggleRowSelection = (index: number) => {
    setFocusedIndex(index)
    expandFolderIfVideo(navigableItems[index])
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
   * ←→ 作用于**光标所在分组**。
   *
   * ↑↓ 在 navigableItems 全表上移动 —— folder 标题是合法可停靠点。
   * ←→ 仍以光标所在 folder 为操作目标：
   *   - → 展开该分组（无论光标在标题还是视频上 —— 在视频上时所属组已展开，no-op）
   *   - ← 在视频上：收起 + 跳回该组标题（Finder/Explorer 风格）
   *   - ← 在标题上：单纯切换展开状态
   *
   * 平铺视图的项不带 folderId（没有分组概念），此时 ←→ 无从谈起。
   */
  const focusedFolderId = useMemo(() => {
    const item = navigableItems[focusedIndex]
    if (!item) return null
    return item.folderId ?? null
  }, [navigableItems, focusedIndex])

  /**
   * → 在 folder 标题上：展开该分组；在 video 上：展开所属分组（一般已经展开，
   * 调用此 API 是无操作；保留对称）。
   */
  const expandFocusedFolder = () => {
    if (focusedFolderId === null) return
    if (!expandedFolderIds.has(focusedFolderId)) toggleFolderExpanded(focusedFolderId)
  }

  /**
   * ← 在 folder 标题上：收起该分组（若已展开）；在 video 上：收起所属分组，
   * 然后光标跳回该 folder 标题（与 Finder/Explorer 一致——光标在文件上按 ←
   * 收起所在目录）。平铺视图（folderId 全为 null）无视 ←。
   */
  const collapseFocusedFolder = () => {
    if (focusedFolderId === null) return
    const item = navigableItems[focusedIndex]
    if (item?.type === 'video') {
      // 收起 + 跳到 folder 标题
      if (expandedFolderIds.has(focusedFolderId)) toggleFolderExpanded(focusedFolderId)
      const titleIndex = navigableItems.findIndex(
        (it) => it.type === 'folder' && it.folderId === focusedFolderId
      )
      if (titleIndex !== -1) setFocusedIndex(titleIndex)
    } else {
      // 已经在 folder 标题上：单纯切换收起状态
      if (expandedFolderIds.has(focusedFolderId)) toggleFolderExpanded(focusedFolderId)
    }
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

  // 列表变化（切分组模式、增删、筛选、折叠）后把光标收回第一个可见项。
  // 不写 0 是因为某些极端情况下 navigableItems 可能为空（还没渲染好）。
  useEffect(() => {
    setFocusedIndex((cur) => Math.min(cur, Math.max(0, navigableItems.length - 1)))
    // 只在结构变化时跑。navigableItems 每次重算都是新数组，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupByFolder, videos])

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
    focusedIndex,
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
