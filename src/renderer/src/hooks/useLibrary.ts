import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLibraryCore } from './useLibraryCore'
import { useVideoList } from './useVideoList'
import { useSearch } from './useSearch'
import { useSelection } from './useSelection'
import { useNotices } from './useNotices'
import { useBusy } from './useBusy'
import { videosUnderDir } from '../lib/libraryTree'
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
 * 左侧文件夹树的显隐与当前选中目录的持久化键（wv- 前缀，与 useTheme 同款）。
 * `treeVisible` 取代旧的「分组/平铺」视图切换（wv-library-group-by-folder）；
 * `selectedDir` 记录地址栏当前所在目录（null = 整库）。
 */
const TREE_VISIBLE_KEY = 'wv-tree-visible'
const SELECTED_DIR_KEY = 'wv-selected-dir'

function readTreeVisible(): boolean {
  try {
    const v = localStorage.getItem(TREE_VISIBLE_KEY)
    // 缺省视为 true：默认展示导航树（资源管理器默认就有导航窗格）
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

function readSelectedDir(): string | null {
  try {
    const v = localStorage.getItem(SELECTED_DIR_KEY)
    return v && v.length > 0 ? v : null
  } catch {
    /* 隐私模式，当作整库 */
  }
  return null
}

function writeSelectedDir(value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(SELECTED_DIR_KEY)
    else localStorage.setItem(SELECTED_DIR_KEY, value)
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
  /** 左侧文件夹树是否可见（取代旧的「分组」视图切换） */
  treeVisible: boolean
  /** 地址栏当前选中目录（null = 整库） */
  selectedDir: string | null
  /** 当前可见视频（按 selectedDir 过滤后的列表，供右栏与导航用） */
  visibleVideos: VideoRecord[]
  /** 当前可见视频数（与 visibleVideos 同步，供工具栏计数） */
  visibleTotal: number
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

  // 左侧文件夹树显隐（取代旧的「分组」视图切换）。默认显示。
  const [treeVisible, setTreeVisible] = useState<boolean>(readTreeVisible)
  useEffect(() => {
    writeTreeVisible(treeVisible)
  }, [treeVisible])

  // 地址栏当前选中目录（null = 整库）。切换后右侧只显示该目录下的视频。
  const [selectedDir, setSelectedDirState] = useState<string | null>(readSelectedDir)
  useEffect(() => {
    writeSelectedDir(selectedDir)
  }, [selectedDir])

  // 当前可见视频：整库视频按 selectedDir 递归过滤。selectedDir 为 null 时即整库。
  // 选中操作（单选跟随、Shift 连选、全选）都作用在这一子集上，与资源管理器
  // 「在过滤后的视图里选」一致。
  const visibleVideos = useMemo(
    () => videosUnderDir(videoList.videos, selectedDir, true),
    [videoList.videos, selectedDir]
  )
  const selection = useSelection(visibleVideos)

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
      async removeVideos(videoIds: number[]): Promise<void> {
        await withBusy(`正在从库中移除 ${videoIds.length} 个视频…`, async () => {
          for (const id of videoIds) await window.whichvideo.videos.remove(id)
          await refreshAll()
        })
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
      async findDuplicates(minScore?: number): Promise<DuplicatePair[]> {
        return window.whichvideo.videos.findDuplicates(minScore)
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
      },
      /** 切换左侧文件夹树显隐（资源管理器「导航窗格」开关，G 键同效） */
      toggleTreeVisible(): void {
        setTreeVisible((v) => !v)
      },
      /** 地址栏定位到某目录（null = 整库） */
      setSelectedDir(dir: string | null): void {
        setSelectedDirState(dir)
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
    selectedDir,
    visibleVideos,
    visibleTotal: visibleVideos.length,
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
      setSelectedDir: (dir: string | null) => setSelectedDirState(dir),
      toggleVideoSelection: selection.toggleVideoSelection,
      clearSelection: selection.clearSelection,
      selectAll: selection.selectAll,
      setSelectedIds: selection.setSelectedIds,
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
    dismissNotice: notices.dismissNotice,
    pauseNotice: notices.pauseNotice,
    resumeNotice: notices.resumeNotice
  }
}

export type LibraryActions = ReturnType<typeof useLibrary>['actions']
