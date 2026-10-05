import { useCallback, useMemo, useState } from 'react'
import { useLibraryCore } from './useLibraryCore'
import { useVideoList } from './useVideoList'
import { useSearch } from './useSearch'
import { useSelection } from './useSelection'
import { useNotices } from './useNotices'
import { useBusy } from './useBusy'
import {
  type AppSettings,
  type DataDirInfo,
  type ImportResult,
  type IndexerStatus,
  type LibraryStats,
  type SearchResponse,
  type VideoQuery,
  type VideoRecord,
  type WatchedFolder
} from '@shared/types'

export interface Notice {
  id: number
  level: 'info' | 'warn' | 'error'
  message: string
  at: number
}

export interface LibraryState {
  stats: LibraryStats
  status: IndexerStatus | null
  folders: WatchedFolder[]
  settings: AppSettings | null
  dataDir: DataDirInfo | null
  videos: VideoRecord[]
  total: number
  notices: Notice[]
  busy: string | null
  search: SearchResponse | null
  searching: boolean
  searchError: string | null
  queryImage: string | null
  queryLabel: string | null
  hasIndexedFrames: boolean
  groupByFolder: boolean
  selectedVideoIds: Set<number>
  expandedFolderIds: Set<number>
}

export function useLibrary() {
  const core = useLibraryCore()
  const videoList = useVideoList()
  const search = useSearch()
  const notices = useNotices()
  const busy = useBusy(notices.pushNotice)
  const selection = useSelection(videoList.videos)
  const [groupByFolder, setGroupByFolder] = useState(false)

  const refreshVideos = useCallback(async (query?: VideoQuery) => {
    await videoList.refreshVideos(query)
  }, [videoList])

  const refreshAll = useCallback(async () => {
    await core.refreshAll()
    await videoList.refreshVideos()
  }, [core, videoList])

  const withBusy = busy.withBusy

  const toggleGroupByFolder = useCallback(() => {
    setGroupByFolder((v) => !v)
  }, [])

  const actions = useMemo(
    () => ({
      async importFiles(): Promise<ImportResult | null> {
        return withBusy('正在导入视频文件…', async () => {
          const result = await window.whichvideo.videos.importFiles()
          notices.pushNotice('info', `导入完成：新增 ${result.added}，已存在 ${result.duplicates}，跳过 ${result.skipped}`)
          await refreshAll()
          return result
        })
      },
      async importFolder(): Promise<void> {
        await withBusy('正在扫描文件夹…', async () => {
          const added = await window.whichvideo.folders.addFromDialog()
          notices.pushNotice(
            'info',
            added.length ? `已添加 ${added.length} 个监听文件夹，后台开始建索引` : '未选择文件夹'
          )
          await refreshAll()
        })
      },
      async addFolderPath(dirPath: string): Promise<void> {
        await withBusy('正在扫描文件夹…', async () => {
          await window.whichvideo.folders.addPath(dirPath)
          notices.pushNotice('info', `已添加监听文件夹：${dirPath}`)
          await refreshAll()
        })
      },
      async removeFolder(folderId: number): Promise<void> {
        await withBusy('正在移除监听…', async () => {
          await window.whichvideo.folders.remove(folderId)
          await refreshAll()
        })
      },
      async rescan(folderId?: number): Promise<void> {
        await withBusy('正在重新扫描…', async () => {
          const result = await window.whichvideo.folders.rescan(folderId)
          notices.pushNotice('info', `重新扫描完成：新增 ${result.added}，已存在 ${result.duplicates}，跳过 ${result.skipped}`)
          await refreshAll()
        })
      },
      async toggleFolder(folderId: number, enabled: boolean): Promise<void> {
        await withBusy(enabled ? '正在恢复监听…' : '正在暂停监听…', async () => {
          await window.whichvideo.folders.setEnabled(folderId, enabled)
          await core.refreshFolders()
        })
      },
      async removeVideo(videoId: number): Promise<void> {
        await withBusy('正在从库中移除…', async () => {
          await window.whichvideo.videos.remove(videoId)
          await refreshAll()
        })
      },
      async reindex(videoIds?: number[]): Promise<void> {
        await withBusy('正在重建索引…', async () => {
          const count = await window.whichvideo.videos.reindex(videoIds)
          notices.pushNotice('info', `已重新排入索引队列：${count} 个视频`)
        })
      },
      async openVideo(videoId: number): Promise<void> {
        await window.whichvideo.videos.openFile(videoId)
      },
      async revealVideo(videoId: number): Promise<void> {
        await window.whichvideo.videos.revealFile(videoId)
      },
      async updateSettings(patch: Partial<AppSettings>): Promise<void> {
        const next = await window.whichvideo.library.updateSettings(patch)
        core.setSettings(next)
      },
      async resetLibrary(): Promise<void> {
        await withBusy('正在清空索引库…', async () => {
          await window.whichvideo.library.reset()
          await refreshAll()
        })
      },
      async openDatabaseFolder(): Promise<void> {
        const dir = await window.whichvideo.library.openDatabaseFolder()
        notices.pushNotice('info', `索引库位置：${dir}`)
      },
      setVideoQuery(next: VideoQuery): void {
        videoList.setVideoQuery(next)
      },
      toggleGroupByFolder(): void {
        setGroupByFolder((v) => !v)
      }
    }),
    [withBusy, notices, refreshAll, core, videoList]
  )

  const state: LibraryState = {
    stats: core.stats,
    status: core.status,
    folders: core.folders,
    settings: core.settings,
    dataDir: core.dataDir,
    videos: videoList.videos,
    total: videoList.total,
    notices: notices.notices,
    busy: busy.busy,
    search: search.search,
    searching: search.searching,
    searchError: search.searchError,
    queryImage: search.queryImage,
    queryLabel: search.queryLabel,
    hasIndexedFrames: (core.stats?.frames ?? 0) > 0,
    groupByFolder,
    selectedVideoIds: selection.selectedVideoIds,
    expandedFolderIds: selection.expandedFolderIds
  }

  return {
    state,
    videoQuery: videoList.videoQuery,
    actions: {
      ...actions,
      reSearch: search.reSearch,
      toggleGroupByFolder,
      toggleVideoSelection: selection.toggleVideoSelection,
      clearSelection: selection.clearSelection,
      selectAll: selection.selectAll,
      toggleFolderExpanded: selection.toggleFolderExpanded,
      expandAllFolders: selection.expandAllFolders,
      collapseAllFolders: selection.collapseAllFolders,
      isVideoSelected: selection.isVideoSelected,
      isFolderExpanded: selection.isFolderExpanded
    },
    runSearch: search.runSearch,
    clearSearch: search.clearSearch,
    refreshAll,
    refreshVideos,
    dismissNotice: notices.dismissNotice
  }
}

export type LibraryActions = ReturnType<typeof useLibrary>['actions']