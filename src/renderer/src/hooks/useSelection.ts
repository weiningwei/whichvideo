import { useCallback, useEffect, useRef, useState } from 'react'
import { type VideoRecord } from '@shared/types'

export interface UseSelectionReturn {
  selectedVideoIds: Set<number>
  expandedFolderIds: Set<number>
  toggleVideoSelection: (videoId: number, shiftKey?: boolean, ctrlKey?: boolean) => void
  clearSelection: () => void
  selectAll: () => void
  /** 批量选中/取消一组 id（树节点复选框 / 表头全选用） */
  setSelectedIds: (ids: number[], selected: boolean) => void
  toggleFolderExpanded: (folderId: number) => void
  expandAllFolders: () => void
  collapseAllFolders: () => void
  isVideoSelected: (videoId: number) => boolean
  isFolderExpanded: (folderId: number) => boolean
  lastSelectedRef: React.MutableRefObject<number | null>
  setSelectionOrder: (ids: number[]) => void
}

export function useSelection(videos: VideoRecord[]): UseSelectionReturn {
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<number>>(new Set())
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<number>>(new Set())
  const lastSelectedRef = useRef<number | null>(null)
  const selectionOrderRef = useRef<number[] | null>(null)
  const setSelectionOrder = useCallback((ids: number[]) => { selectionOrderRef.current = ids }, [])

  useEffect(() => {
    const available = new Set(videos.map((video) => video.id))
    setSelectedVideoIds((current) => {
      const remaining = new Set([...current].filter((id) => available.has(id)))
      return remaining.size === current.size ? current : remaining
    })
    if (lastSelectedRef.current !== null && !available.has(lastSelectedRef.current)) lastSelectedRef.current = null
  }, [videos])

  const toggleVideoSelection = useCallback((videoId: number, shiftKey = false, ctrlKey = false) => {
    const anchor = lastSelectedRef.current
    setSelectedVideoIds((prev) => {
      const next = new Set(prev)
      if (shiftKey && anchor !== null) {
        const allIds = selectionOrderRef.current ?? videos.map((v) => v.id)
        const start = allIds.indexOf(anchor)
        const end = allIds.indexOf(videoId)
        if (start < 0 || end < 0) {
          next.clear()
          next.add(videoId)
        } else {
          const [min, max] = start < end ? [start, end] : [end, start]
          for (let i = min; i <= max; i++) next.add(allIds[i])
        }
      } else if (ctrlKey) {
        if (next.has(videoId)) next.delete(videoId)
        else next.add(videoId)
      } else {
        next.clear()
        next.add(videoId)
      }
      return next
    })
    lastSelectedRef.current = videoId
  }, [videos])

  const clearSelection = useCallback(() => {
    setSelectedVideoIds(new Set())
    lastSelectedRef.current = null
  }, [])

  const selectAll = useCallback(() => {
    setSelectedVideoIds(new Set(selectionOrderRef.current ?? videos.map((v) => v.id)))
  }, [videos])

  /**
   * 批量设置选中：树节点复选框勾选「该目录下全部视频」、表头全选框勾选「当前视图
   * 全部」都走这里。selected=true 增量加、false 增量减，不破坏其它已选中的行。
   * 锚点设为最后一项，使随后的 Shift 连选从这批的末尾继续。
   */
  const setSelectedIds = useCallback((ids: number[], selected: boolean) => {
    if (ids.length === 0) return
    setSelectedVideoIds((prev) => {
      const next = new Set(prev)
      if (selected) for (const id of ids) next.add(id)
      else for (const id of ids) next.delete(id)
      return next
    })
    lastSelectedRef.current = ids[ids.length - 1]
  }, [])

  const toggleFolderExpanded = useCallback((folderId: number) => {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

  const expandAllFolders = useCallback(() => {
    const allFolderIds = new Set(videos.map((v) => v.folderId ?? -1))
    setExpandedFolderIds(allFolderIds)
  }, [videos])

  const collapseAllFolders = useCallback(() => {
    setExpandedFolderIds(new Set())
  }, [])

  const isVideoSelected = useCallback((videoId: number) => selectedVideoIds.has(videoId), [selectedVideoIds])
  const isFolderExpanded = useCallback((folderId: number) => expandedFolderIds.has(folderId), [expandedFolderIds])

  return {
    selectedVideoIds,
    expandedFolderIds,
    toggleVideoSelection,
    clearSelection,
    selectAll,
    setSelectedIds,
    toggleFolderExpanded,
    expandAllFolders,
    collapseAllFolders,
    isVideoSelected,
    isFolderExpanded,
    lastSelectedRef,
    setSelectionOrder
  }
}
