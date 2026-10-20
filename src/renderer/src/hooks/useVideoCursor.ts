/**
 * 视频列表的光标与键盘导航。
 *
 * 从 LibraryView 拆出：光标状态、videoRowIndexes、moveCursor / jumpCursor /
 * handleRowClick 等导航原语，以及「列表变化重置光标」「焦点行滚进可视区」
 * 两个副作用。LibraryView 保留工具条、表格骨架、地址栏与键盘快捷键层。
 *
 * **光标与选中必须是同一个东西**——这是文件管理器式列表的基本模型：
 * 光标在哪，单选就在哪。此前两者是独立 state，方向键只移动灰竖条、蓝竖条
 * 留在原地，于是「按方向键切换」看起来毫无反应。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { VideoRecord } from '@shared/types'
import { PAGE_JUMP } from '../constants'

export { PAGE_JUMP }

export interface NavigableItem {
  type: 'video'
  video: VideoRecord
  index: number
}

export interface UseVideoCursorArgs {
  /** 当前可见视频（已按地址栏目录过滤） */
  videos: VideoRecord[]
  toggleVideoSelection: (videoId: number, shiftKey: boolean, ctrlKey: boolean) => void
  /**
   * 表格挂载窗口的大小。光标走出已挂载范围时 LibraryView 会先补挂那一段，
   * 补挂完成后需要重新执行「把焦点行滚进可视区」；只依赖 focusedVideoId
   * 的话，补挂属于一次纯扩容渲染，滚动副作用不会重跑，焦点行会停在屏幕外。
   */
  scrollSignal?: number
}

export function useVideoCursor({ videos, toggleVideoSelection, scrollSignal }: UseVideoCursorArgs) {
  const navigableItems = useMemo<NavigableItem[]>(
    () => videos.map((v, idx) => ({ type: 'video' as const, video: v, index: idx })),
    [videos]
  )

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
   * 移动光标（↑↓ / PageUp / PageDown / Home / End 入口），在 **navigableItems
   * 全表** 上移动。光标落到的视频同步单选（Ctrl 时只移光标）。
   */
  const moveCursor = (delta: number, shiftKey: boolean, ctrlKey: boolean) => {
    if (navigableItems.length === 0) return
    const from = focusedIndex === -1 ? (delta > 0 ? -1 : navigableItems.length) : focusedIndex
    const nextPos = Math.max(0, Math.min(navigableItems.length - 1, from + delta))
    if (nextPos === from) return
    const nextItem = navigableItems[nextPos]
    if (!nextItem) return
    setFocusedIndex(nextPos)
    if (ctrlKey) return
    if (nextItem.type === 'video' && nextItem.video) {
      toggleVideoSelection(nextItem.video.id, shiftKey, false)
    }
  }

  /** 跳到 navigableItems 的指定位置（Home / End / PageUp / PageDown 用）；同样同步单选 */
  const jumpCursor = (pos: number, shiftKey = false) => {
    if (navigableItems.length === 0) return
    const nextPos = Math.max(0, Math.min(navigableItems.length - 1, pos))
    if (nextPos === focusedIndex) return
    const nextItem = navigableItems[nextPos]
    if (!nextItem) return
    setFocusedIndex(nextPos)
    if (nextItem.type === 'video' && nextItem.video) {
      toggleVideoSelection(nextItem.video.id, shiftKey, false)
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
      toggleVideoSelection(videoId, shiftKey, ctrlKey)
      return
    }
    if (ctrlKey) toggleRowSelection(index)
    else if (shiftKey) selectRowRange(index)
    else focusRow(index)
  }

  /**
   * 在光标处切换选中（Space 专用）——与 ↑↓ 的「单选跟随」不同：不动光标、
   * 也不清掉其他已选中的行，是真正的「加选 / 取消选中」（文件管理器的空格行为）。
   *
   * @param shiftKey Shift：与上次选中的位置之间连选
   * @param ctrlKey Ctrl：只切换这一行的选中状态，其余行不动
   */
  const toggleFocusedSelection = (shiftKey: boolean, _ctrlKey: boolean) => {
    const item = navigableItems[focusedIndex]
    if (item && item.type === 'video' && item.video) {
      // 空格是切换，不是普通单选；否则已选中时再按空格无法取消。
      toggleVideoSelection(item.video.id, shiftKey, true)
    }
  }

  // 列表变化（筛选 / 切目录 / 增删）后把光标收回第一个可见项。
  useEffect(() => {
    setFocusedIndex((cur) => Math.min(cur, Math.max(0, navigableItems.length - 1)))
    // 只在结构变化时跑。navigableItems 每次重算都是新数组，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos])

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
  }, [focusedVideoId, scrollSignal])

  return {
    navigableItems,
    focusedIndex,
    focusedVideoId,
    moveCursor,
    jumpCursor,
    toggleFocusedSelection,
    handleRowClick,
    scrollRef
  }
}
