import { useCallback, useRef, useState } from 'react'
import { type VideoRecord } from '@shared/types'

export interface UseSelectionReturn {
  selectedVideoIds: Set<number>
  expandedFolderIds: Set<number>
  toggleVideoSelection: (videoId: number, shiftKey?: boolean, ctrlKey?: boolean) => void
  clearSelection: () => void
  selectAll: () => void
  toggleFolderExpanded: (folderId: number) => void
  expandAllFolders: () => void
  collapseAllFolders: () => void
  isVideoSelected: (videoId: number) => boolean
  isFolderExpanded: (folderId: number) => boolean
  lastSelectedRef: React.MutableRefObject<number | null>
}

export function useSelection(videos: VideoRecord[]): UseSelectionReturn {
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<number>>(new Set())
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<number>>(new Set())
  const lastSelectedRef = useRef<number | null>(null)

  const toggleVideoSelection = useCallback((videoId: number, shiftKey = false, ctrlKey = false) => {
    const anchor = lastSelectedRef.current
    setSelectedVideoIds((prev) => {
      const next = new Set(prev)
      if (shiftKey && anchor !== null) {
        const allIds = videos.map((v) => v.id)
        const start = allIds.indexOf(anchor)
        const end = allIds.indexOf(videoId)
        const [min, max] = start < end ? [start, end] : [end, start]
        for (let i = min; i <= max; i++) next.add(allIds[i])
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
    setSelectedVideoIds(new Set(videos.map((v) => v.id)))
  }, [videos])

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
    toggleFolderExpanded,
    expandAllFolders,
    collapseAllFolders,
    isVideoSelected,
    isFolderExpanded,
    lastSelectedRef
  }
}