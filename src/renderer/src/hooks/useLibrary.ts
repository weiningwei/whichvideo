import { useCallback, useEffect, useMemo, useState } from 'react'
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
  type DuplicatePair,
  type SamplingMode,
  type IndexerStatus,
  type LibraryStats,
  type MediaToolsStatus,
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

/**
 * 文件夹 / 全部视频视图选择。使用新键，避免旧导航窗格的“隐藏”设置
 * 让升级后的默认视图意外变成平铺。
 */
const TREE_VISIBLE_KEY = 'wv-library-folder-view'

function readTreeVisible(): boolean {
  try {
    const v = localStorage.getItem(TREE_VISIBLE_KEY)
    // 默认是文件夹视图，导入目录初始折叠。
    if (v === '0') return false
  } catch {
    /* 隐私模式 localStorage 抛错，用默认 */
  }
  return true
}

function writeTreeVisible(value: boolean): void {
  try {
    localStorage.setItem(TREE_VISIBLE_KEY, value ? '1' : '0')
  } catch {
    /* 存不下不影响本次会话 */
  }
}

export interface LibraryState {
  stats: LibraryStats
  status: IndexerStatus | null
  folders: WatchedFolder[]
  settings: AppSettings | null
  dataDir: DataDirInfo | null
  mediaTools: MediaToolsStatus | null
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
  /** true = 文件夹视图，false = 全部视频平铺视图 */
  treeVisible: boolean
  selectedVideoIds: Set<number>
  expandedFolderIds: Set<number>
}

export function useLibrary() {
  // notices 先于 core：core 订阅的事件通道里有后端 notice（索引失败/
  // 后端异常等），需要消费入口转成渲染端通知
  const notices = useNotices()
  const core = useLibraryCore({ onNotice: notices.pushNotice })
  const videoList = useVideoList()
  const search = useSearch()
  const busy = useBusy(notices.pushNotice)

  // 文件夹 / 全部视频视图。默认显示文件夹。
  const [treeVisible, setTreeVisible] = useState<boolean>(readTreeVisible)
  useEffect(() => {
    writeTreeVisible(treeVisible)
  }, [treeVisible])

  const selection = useSelection(videoList.videos)

  const refreshVideos = useCallback(async (query?: VideoQuery) => {
    await videoList.refreshVideos(query)
  }, [videoList])

  const refreshAll = useCallback(async () => {
    await core.refreshAll()
    await videoList.refreshVideos()
  }, [core, videoList])

  const withBusy = busy.withBusy

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
      async importFolderOnce(): Promise<ImportResult | null> {
        return withBusy('正在一次性导入文件夹…', async () => {
          const result = await window.whichvideo.videos.importFolderOnce()
          notices.pushNotice(
            'info',
            `导入完成（未监视）：新增 ${result.added}，已存在 ${result.duplicates}，跳过 ${result.skipped}`
          )
          await refreshAll()
          return result
        })
      },
      async watchFolder(): Promise<void> {
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
      /**
       * 批量移除：一次 busy、一次全量刷新。
       *
       * 此前 UI 层对选中集合循环调 removeVideo —— 每个 id 各自 withBusy +
       * refreshAll，删 N 个就闪 N 次busy 文案、跑 N 遍全量刷新，且循环里
       * 没 await，N 个请求并发交错。这里串行逐条调 IPC，最后统一刷新一次；
       * 后端广播的 video-removed 事件会由 useVideoList 逐条就地删行。
       */
      async removeVideos(videoIds: number[]): Promise<number[]> {
        const removedIds: number[] = []
        await withBusy(`正在从库中移除 ${videoIds.length} 个视频…`, async () => {
          try {
            for (const id of videoIds) {
              await window.whichvideo.videos.remove(id)
              removedIds.push(id)
            }
          } finally {
            // 中途失败也要刷新已成功移除的记录，不能留下陈旧计数。
            if (removedIds.length > 0) await refreshAll()
          }
        })
        return removedIds
      },
      async reindex(videoIds?: number[], mode?: SamplingMode): Promise<void> {
        await withBusy('正在重建索引…', async () => {
          // 重建永远是 force —— 即便采样方式未变也照样重建（AGENTS.md 注释
          // 的设计意图）。代价是用户多按一次会重抽，但采样计划稳定时重建代价低，
          // 不该用"采样方式未变"的警告挡用户。
          const res = await window.whichvideo.videos.reindex(videoIds, mode)
          notices.pushNotice(
            'info',
            mode === 'scene'
              ? `已对 ${res.count} 个视频应用场景检测采样并重新排入队列（仅对这些视频生效）`
              : `已重新排入索引队列：${res.count} 个视频`
          )
        })
      },
      /** 库内查重：代表帧跨视频互搜。耗时随库增大（每视频一次内存扫描）。 */
      async findDuplicates(minScore?: number): Promise<DuplicatePair[] | null> {
        return withBusy('正在查找相似视频…', () => window.whichvideo.videos.findDuplicates(minScore))
      },
      async openVideo(videoId: number, atSeconds?: number): Promise<void> {
        await window.whichvideo.videos.openFile(videoId, atSeconds)
      },
      async revealVideo(videoId: number): Promise<void> {
        await window.whichvideo.videos.revealFile(videoId)
      },
      async updateSettings(patch: Partial<AppSettings>): Promise<void> {
        const prev = core.settings
        const next = await window.whichvideo.library.updateSettings(patch)
        core.setSettings(next)
        // 采样模式改变只影响**之后**抽帧的视频 —— 每个已索引视频在自己的
        // 记录里固化了实际使用的采样方式，全局切换不会改变它们。
        if (prev && next && prev.samplingMode !== next.samplingMode) {
          notices.pushNotice(
            'info',
            next.samplingMode === 'scene'
              ? '已切换到场景检测采样：对新导入的视频生效；已索引视频用「重建索引」应用新采样'
              : '已切换到均匀采样：对新导入的视频生效；已索引视频用「重建索引」应用新采样'
          )
        }
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
      async exportDiagnostics(): Promise<void> {
        await withBusy('正在导出诊断包…', async () => {
          const path = await window.whichvideo.library.exportDiagnostics()
          if (path) notices.pushNotice('info', '诊断包已导出，可在反馈问题时附上该文件。')
        })
      },
      async selectMediaToolsDir(): Promise<void> {
        await withBusy('正在检测 FFmpeg…', async () => {
          const status = await window.whichvideo.library.selectMediaToolsDir()
          core.setMediaTools(status)
          await core.refreshAll()
          notices.pushNotice(status.ready ? 'info' : 'warn', status.message)
        })
      },
      async clearMediaToolsDir(): Promise<void> {
        const status = await window.whichvideo.library.clearMediaToolsDir()
        core.setMediaTools(status)
        await core.refreshAll()
        notices.pushNotice(status.ready ? 'info' : 'warn', status.message)
      },
      setVideoQuery(next: VideoQuery): void {
        videoList.setVideoQuery(next)
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
    mediaTools: core.mediaTools,
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
    treeVisible,
    selectedVideoIds: selection.selectedVideoIds,
    expandedFolderIds: selection.expandedFolderIds
  }

  return {
    state,
    videoQuery: videoList.videoQuery,
    actions: {
      ...actions,
      reSearch: search.reSearch,
      toggleTreeVisible: () => setTreeVisible((v) => !v),
      toggleVideoSelection: selection.toggleVideoSelection,
      clearSelection: selection.clearSelection,
      selectAll: selection.selectAll,
      setSelectedIds: selection.setSelectedIds,
      toggleFolderExpanded: selection.toggleFolderExpanded,
      expandAllFolders: selection.expandAllFolders,
      collapseAllFolders: selection.collapseAllFolders,
      isVideoSelected: selection.isVideoSelected,
      setSelectionOrder: selection.setSelectionOrder,
      isFolderExpanded: selection.isFolderExpanded
    },
    runSearch: search.runSearch,
    clearSearch: search.clearSearch,
    refreshAll,
    refreshVideos,
    dismissNotice: notices.dismissNotice,
    pauseNotice: notices.pauseNotice,
    resumeNotice: notices.resumeNotice
  }
}

export type LibraryActions = ReturnType<typeof useLibrary>['actions']
