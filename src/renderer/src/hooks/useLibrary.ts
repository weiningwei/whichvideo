import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  /**
   * 连选锚点。**用 ref 而不是 state**。
   *
   * 连选的实现写在 setState 的 updater 里，而 updater 是**同步执行**的 ——
   * 此刻读 state 拿到的仍是本轮 setLast 之前的旧值，React 不会因为我们刚调过
   * setLast 就重跑一次 callback。
   *
   * 曾经的写法是 `useCallback([videos])` + 闭包里直接读 state。而**选中并不改变
   * videos**（videos 只在扫描/导入时 set），所以依赖永远不变、callback 永不重建，
   * 闭包里那个值永远是初始的 null —— 于是 Shift 连选每次都走 else 分支退化成
   * 单选，界面表现为「已选 1」。typecheck 与静态断言都抓不到，只有真去连选才暴露。
   */
  const lastSelectedRef = useRef<number | null>(null)

  const toggleGroupByFolder = useCallback(() => {
    setGroupByFolder((v) => !v)
  }, [])

  const toggleVideoSelection = useCallback((videoId: number, shiftKey: boolean = false, ctrlKey: boolean = false) => {
    // 读 ref 而非 state：updater 同步执行，读 state 会拿到本轮 setLast 之前的旧值
    const anchor = lastSelectedRef.current
    setSelectedVideoIds((prev) => {
      const next = new Set(prev)
      if (shiftKey && anchor !== null) {
        // Range selection
        const allIds = videos.map(v => v.id)
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
    // 同步更新 ref：本次选中的行就是下一次 Shift 的扩展起点
    lastSelectedRef.current = videoId
  }, [videos])

  const clearSelection = useCallback(() => {
    setSelectedVideoIds(new Set())
    // 锚点也要清：否则取消选择后再按 Shift，会从上一次的位置开始扩展
    lastSelectedRef.current = null
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
    async (input: {
      path?: string
      dataUrl?: string
      url?: string
      label?: string
      dataUrlPreview?: string
    }) => {
      setLastSearchInput(input)
      setSearching(true)
      setSearchError(null)
      try {
        // 各来源分别处理，是为了各自拿到"查询图预览"：
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
        } else if (input.url) {
          const response = await window.whichvideo.search.byUrl(input.url)
          setSearch(response)
          // 链接输入拿不到图片预览（主进程只回文本结果，不回字节，避免
          // 10MB 的图再 base64 一遍过 IPC）。左上角那格显示链接占位。
          setQueryImage(null)
          // queryImageUrl 可能是重定向后或网页里解析出的真实图片地址，
          // 优先用它，界面上更便于核对到底搜的是哪张图。
          setQueryLabel(response.queryImageUrl ?? input.label ?? input.url)
          // 失败原因由主进程给出（协议不支持 / 超时 / 网页里没图等），原样透出
          if (response.error) setSearchError(response.error)
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
