import { useEffect } from 'react'
import type { SamplingMode, VideoRecord } from '@shared/types'
import { PAGE_JUMP } from '../constants'
import type { NavigableItem } from './useVideoCursor'

export interface LibraryShortcutsArgs {
  videos: VideoRecord[]
  navigableItems: NavigableItem[]
  focusedIndex: number
  focusedVideoId: number | null
  selectedVideoIds: Set<number>
  // 光标导航原语（来自 useVideoCursor）
  moveCursor: (delta: number, shiftKey: boolean, ctrlKey: boolean) => void
  jumpCursor: (pos: number, shiftKey: boolean) => void
  toggleFocusedSelection: (shiftKey: boolean, ctrlKey: boolean) => void
  // 选中相关
  selectAll: () => void
  clearSelection: () => void
  /** G 键：切换文件夹 / 全部视频视图 */
  onToggleTree: () => void
  // 业务动作（来自 props）
  onOpen: (videoId: number, atSeconds?: number) => void
  onReveal: (videoId: number) => void
  onReindex: (videoIds?: number[], mode?: SamplingMode) => void
  onImportFolder: () => void
  onImportFiles: () => void
  onRescan: (folderId?: number) => void
  onRemoveVideo: (videoId: number) => void
  onRemoveVideos: (videoIds: number[]) => void
  filterInputRef: React.RefObject<HTMLInputElement | null>
}

/**
 * 库视图的全局键盘快捷键。原内联在 LibraryView 的 useEffect 里，与组件渲染
 * 紧耦合 —— 现在把「键 → 行为」集中到本 hook，LibraryView 只负责布局。
 *
 * 光标移动（↑↓/Home/End/PageUp/PageDown/←→）走 useVideoCursor 的导航原语；
 * 这里只处理「落在哪一行后做什么」（打开/选中/揭示/删除等），与导航职责分离。
 */
export function useLibraryShortcuts(args: LibraryShortcutsArgs): void {
  const {
    videos, navigableItems, focusedIndex, focusedVideoId, selectedVideoIds,
    moveCursor, jumpCursor, toggleFocusedSelection,
    selectAll, clearSelection, onToggleTree,
    onOpen, onReveal, onReindex, onImportFolder, onImportFiles, onRescan,
    onRemoveVideo, onRemoveVideos, filterInputRef
  } = args

  // 「该被操作的那个视频」：有选中用第一个选中的，否则用焦点处的。
  // 选中 + 删除 = 删多个；只看一行时按 Delete = 删当前这一行。
  const getTargetVideo = (): VideoRecord | null => {
    if (selectedVideoIds.size > 0) {
      for (const v of videos) if (selectedVideoIds.has(v.id)) return v
      return null
    }
    const item = navigableItems[focusedIndex]
    return item && item.type === 'video' ? item.video ?? null : null
  }

  // 当前操作会作用到几个视频（决定要不要二次确认）
  const getTargetCount = (): number =>
    selectedVideoIds.size > 0 ? selectedVideoIds.size : focusedVideoId === null ? 0 : 1

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return
      // 焦点在按钮上时，空格与回车应触发按钮本身，否则会出现"点一下按钮没反应又改了选中态"
      const onButton = e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement
      if (onButton && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) return
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
          jumpCursor(focusedIndex + PAGE_JUMP, e.shiftKey)
          break
        case 'PageUp':
          e.preventDefault()
          jumpCursor(focusedIndex - PAGE_JUMP, e.shiftKey)
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
            jumpCursor(navigableItems.length - 1, e.shiftKey)
          }
          break

        case 'Enter': {
          if (onButton) return
          e.preventDefault()
          const target = getTargetVideo()
          if (target) onOpen(target.id)
          break
        }
        // 空格只做选中切换（不播放）—— 与文件管理器一致，空格是"选择"不是"打开"
        case ' ':
          if (onButton) return
          e.preventDefault()
          toggleFocusedSelection(e.shiftKey, mod)
          break

        case 'l':
        case 'L':
          if (!mod) return
          e.preventDefault()
          if (focusedVideoId !== null) onReveal(focusedVideoId)
          break
        case 'r':
        case 'R':
          if (!mod) return
          e.preventDefault()
          if (focusedVideoId !== null) onReindex([focusedVideoId])
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
            onReindex()
          }
          break
        case 'i':
        case 'I':
          if (mod && e.shiftKey) {
            e.preventDefault()
            onImportFolder()
          } else if (!mod) {
            e.preventDefault()
            onImportFiles()
          }
          break
        case 's':
        case 'S':
          if (!mod) {
            e.preventDefault()
            onRescan()
          }
          break
        case 'g':
        case 'G':
          e.preventDefault()
          onToggleTree()
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
            onRemoveVideos([...selectedVideoIds])
            clearSelection()
          } else {
            const target = getTargetVideo()
            if (target) onRemoveVideo(target.id)
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
  }, [
    videos, navigableItems, focusedIndex, focusedVideoId, selectedVideoIds,
    moveCursor, jumpCursor, toggleFocusedSelection,
    selectAll, clearSelection, onToggleTree,
    onOpen, onReveal, onReindex, onImportFolder, onImportFiles, onRescan,
    onRemoveVideo, onRemoveVideos, filterInputRef
  ])
}
