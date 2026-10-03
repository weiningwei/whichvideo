import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type AppSettings,
  type DataDirInfo,
  type ImportResult,
  type IndexerStatus,
  type LibraryEvent,
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

const EMPTY_STATS: LibraryStats = {
  videos: 0,
  indexedVideos: 0,
  pendingVideos: 0,
  failedVideos: 0,
  frames: 0,
  totalBytes: 0,
  folders: 0,
  watching: 0
}

let noticeSeq = 0

export function useLibrary() {
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [status, setStatus] = useState<IndexerStatus | null>(null)
  const [folders, setFolders] = useState<WatchedFolder[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [dataDir, setDataDir] = useState<DataDirInfo | null>(null)
  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [total, setTotal] = useState(0)
  const [notices, setNotices] = useState<Notice[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [search, setSearch] = useState<SearchResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [queryImage, setQueryImage] = useState<string | null>(null)
  const [queryLabel, setQueryLabel] = useState<string | null>(null)
  const [lastSearchInput, setLastSearchInput] = useState<{ path?: string; dataUrl?: string; label?: string; dataUrlPreview?: string } | null>(null)
  const [videoQuery, setVideoQuery] = useState<VideoQuery>({ limit: 500, status: 'all', sort: 'added' })
  const [groupByFolder, setGroupByFolder] = useState(false)
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<number>>(new Set())
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<number>>(new Set())
  const [lastSelectedVideoId, setLastSelectedVideoId] = useState<number | null>(null)

  const toggleGroupByFolder = useCallback(() => {
    setGroupByFolder((v) => !v)
  }, [])

  const toggleVideoSelection = useCallback((videoId: number, shiftKey: boolean = false, ctrlKey: boolean = false) => {
    setSelectedVideoIds((prev) => {
      const next = new Set(prev)
      if (shiftKey && lastSelectedVideoId !== null) {
        // Range selection
        const allIds = videos.map(v => v.id)
        const start = allIds.indexOf(lastSelectedVideoId)
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
    setLastSelectedVideoId(videoId)
  }, [videos])

  const clearSelection = useCallback(() => {
    setSelectedVideoIds(new Set())
    setLastSelectedVideoId(null)
  }, [])

  const selectAll = useCallback(() => {
    setSelectedVideoIds(new Set(videos.map(v => v.id)))
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
    const allFolderIds = new Set(videos.map(v => v.folderId ?? -1))
    setExpandedFolderIds(allFolderIds)
  }, [videos])

  const collapseAllFolders = useCallback(() => {
    setExpandedFolderIds(new Set())
  }, [])

  const isVideoSelected = useCallback((videoId: number) => selectedVideoIds.has(videoId), [selectedVideoIds])
  const isFolderExpanded = useCallback((folderId: number) => expandedFolderIds.has(folderId), [expandedFolderIds])

  const pushNotice = useCallback((level: Notice['level'], message: string) => {
    setNotices((prev) => {
      const next: Notice = { id: ++noticeSeq, level, message, at: Date.now() }
      return [next, ...prev].slice(0, 40)
    })
  }, [])

  const refreshVideos = useCallback(async (query?: VideoQuery) => {
    const q = query ?? videoQuery
    const page = await window.whichvideo.videos.list(q)
    setVideos(page.items)
    setTotal(page.total)
  }, [videoQuery])

  const refreshFolders = useCallback(async () => {
    setFolders(await window.whichvideo.folders.list())
  }, [])

  const refreshAll = useCallback(async () => {
    const [s, st, f, cfg, dirInfo] = await Promise.all([
      window.whichvideo.library.stats(),
      window.whichvideo.library.status(),
      window.whichvideo.folders.list(),
      window.whichvideo.library.settings(),
      window.whichvideo.library.dataDir()
    ])
    setStats(s)
    setStatus(st)
    setFolders(f)
    setSettings(cfg)
    setDataDir(dirInfo)
    await refreshVideos()
  }, [refreshVideos])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  useEffect(() => {
    const unsubscribe = window.whichvideo.events.subscribe((event: LibraryEvent) => {
      switch (event.type) {
        case 'stats':
          setStats(event.stats)
          break
        case 'status':
          setStatus(event.status)
          break
        case 'folder-updated':
          setFolders((prev) => {
            const idx = prev.findIndex((f) => f.id === event.folder.id)
            if (idx < 0) return [...prev, event.folder]
            const next = [...prev]
            next[idx] = event.folder
            return next
          })
          break
        case 'folder-removed':
          setFolders((prev) => prev.filter((f) => f.id !== event.folderId))
          break
        case 'video-updated':
          setVideos((prev) => {
            const idx = prev.findIndex((v) => v.id === event.video.id)
            if (idx < 0) return prev
            const next = [...prev]
            next[idx] = event.video
            return next
          })
          break
        case 'video-removed':
          setVideos((prev) => prev.filter((v) => v.id !== event.videoId))
          break
        case 'notice':
          pushNotice(event.level, event.message)
          break
        default:
          break
      }
    })
    return unsubscribe
  }, [pushNotice])

  // 索引队列出现/结束时刷新可见列表，让“动态更新”在列表里立刻体现
  const indexerRunning = status?.running ?? false
  useEffect(() => {
    if (indexerRunning) return
    void refreshVideos()
  }, [indexerRunning, refreshVideos])

  const runSearch = useCallback(
    async (input: { path?: string; dataUrl?: string; label?: string; dataUrlPreview?: string }) => {
      setLastSearchInput(input)
      setSearching(true)
      setSearchError(null)
      try {
        // 三种来源分别处理，是为了各自拿到"查询图预览"：
        // 剪贴板那次主进程会把图片一起回传，否则左上角那格永远是空的。
        if (input.path) {
          const response = await window.whichvideo.search.byPath(input.path)
          setSearch(response)
          setQueryImage(`file://${input.path}`)
          setQueryLabel(input.label ?? input.path)
        } else if (input.dataUrl) {
          const response = await window.whichvideo.search.byDataUrl(input.dataUrl)
          setSearch(response)
          setQueryImage(input.dataUrlPreview ?? input.dataUrl)
          setQueryLabel(input.label ?? '图片')
        } else {
          const clipboard = await window.whichvideo.search.byClipboard()
          if (!clipboard) {
            setSearchError('剪贴板里没有图片，请先复制一张图片再点这个按钮')
            return
          }
          setSearch(clipboard.response)
          setQueryImage(clipboard.dataUrl)
          setQueryLabel(input.label ?? '剪贴板图片')
        }
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : String(err))
      } finally {
        setSearching(false)
      }
    },
    []
  )

  const reSearch = useCallback(async () => {
    if (lastSearchInput) {
      await runSearch(lastSearchInput)
    }
  }, [lastSearchInput, runSearch])

  const clearSearch = useCallback(() => {
    setSearch(null)
    setSearchError(null)
    setQueryImage(null)
    setQueryLabel(null)
  }, [])

  const withBusy = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
      setBusy(label)
      try {
        return await fn()
      } catch (err) {
        pushNotice('error', err instanceof Error ? err.message : String(err))
        return null
      } finally {
        setBusy(null)
      }
    },
    [pushNotice]
  )

  const actions = useMemo(
    () => ({
      async importFiles(): Promise<ImportResult | null> {
        return withBusy('正在导入视频文件…', async () => {
          const result = await window.whichvideo.videos.importFiles()
          pushNotice('info', `导入完成：新增 ${result.added}，已存在 ${result.duplicates}，跳过 ${result.skipped}`)
          await refreshAll()
          return result
        })
      },
      async importFolder(): Promise<void> {
        await withBusy('正在扫描文件夹…', async () => {
          const added = await window.whichvideo.folders.addFromDialog()
          pushNotice(
            'info',
            added.length ? `已添加 ${added.length} 个监听文件夹，后台开始建索引` : '未选择文件夹'
          )
          await refreshAll()
        })
      },
      async addFolderPath(dirPath: string): Promise<void> {
        await withBusy('正在扫描文件夹…', async () => {
          await window.whichvideo.folders.addPath(dirPath)
          pushNotice('info', `已添加监听文件夹：${dirPath}`)
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
          pushNotice('info', `重新扫描完成：新增 ${result.added}，已存在 ${result.duplicates}，跳过 ${result.skipped}`)
          await refreshAll()
        })
      },
      async toggleFolder(folderId: number, enabled: boolean): Promise<void> {
        await withBusy(enabled ? '正在恢复监听…' : '正在暂停监听…', async () => {
          await window.whichvideo.folders.setEnabled(folderId, enabled)
          await refreshFolders()
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
          pushNotice('info', `已重新排入索引队列：${count} 个视频`)
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
        setSettings(next)
      },
      async resetLibrary(): Promise<void> {
        await withBusy('正在清空索引库…', async () => {
          await window.whichvideo.library.reset()
          await refreshAll()
        })
      },
      async openDatabaseFolder(): Promise<void> {
        const dir = await window.whichvideo.library.openDatabaseFolder()
        pushNotice('info', `索引库位置：${dir}`)
      },
      setVideoQuery(next: VideoQuery): void {
        setVideoQuery(next)
        void refreshVideos(next)
      },
      toggleGroupByFolder(): void {
        setGroupByFolder((v) => !v)
      },
    }),
    [withBusy, pushNotice, refreshAll, refreshFolders, refreshVideos, videoQuery]
  )

  const state: LibraryState = {
    stats: stats ?? EMPTY_STATS,
    status,
    folders,
    settings,
    dataDir,
    videos,
    total,
    notices,
    busy,
    search,
    searching,
    searchError,
    queryImage,
    queryLabel,
    hasIndexedFrames: (stats?.frames ?? 0) > 0,
    groupByFolder,
    selectedVideoIds,
    expandedFolderIds
  }

  return {
    state,
    videoQuery,
    actions: {
      ...actions,
      reSearch,
      toggleGroupByFolder,
      toggleVideoSelection,
      clearSelection,
      selectAll,
      toggleFolderExpanded,
      expandAllFolders,
      collapseAllFolders,
      isVideoSelected,
      isFolderExpanded
    },
    runSearch,
    clearSearch,
    refreshAll,
    refreshVideos,
    dismissNotice: (id: number) => setNotices((prev) => prev.filter((n) => n.id !== id))
  }
}

export type LibraryActions = ReturnType<typeof useLibrary>['actions']
