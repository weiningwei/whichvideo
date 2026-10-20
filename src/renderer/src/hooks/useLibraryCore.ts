import { useCallback, useEffect, useState } from 'react'
import {
  type AppSettings,
  type DataDirInfo,
  type IndexerStatus,
  type LibraryEvent,
  type LibraryStats,
  type MediaToolsStatus,
  type WatchedFolder
} from '@shared/types'
import { applyImportProgress, type ImportProgressEvent } from '../lib/importProgress'

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

export interface UseLibraryCoreReturn {
  stats: LibraryStats
  status: IndexerStatus | null
  folders: WatchedFolder[]
  settings: AppSettings | null
  dataDir: DataDirInfo | null
  mediaTools: MediaToolsStatus | null
  /** 正在进行的批量导入进度；空闲时为 null */
  importProgress: ImportProgressEvent | null
  refreshAll: () => Promise<void>
  refreshFolders: () => Promise<void>
  setSettings: (settings: AppSettings) => void
  setMediaTools: (status: MediaToolsStatus) => void
}

export interface UseLibraryCoreOptions {
  /** 后端广播的 notice 事件消费入口（转成渲染端通知） */
  onNotice?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export function useLibraryCore(options: UseLibraryCoreOptions = {}): UseLibraryCoreReturn {
  const { onNotice } = options
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [status, setStatus] = useState<IndexerStatus | null>(null)
  const [folders, setFolders] = useState<WatchedFolder[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [dataDir, setDataDir] = useState<DataDirInfo | null>(null)
  const [mediaTools, setMediaTools] = useState<MediaToolsStatus | null>(null)
  const [importProgress, setImportProgress] = useState<ImportProgressEvent | null>(null)

  const refreshFolders = useCallback(async () => {
    setFolders(await window.whichvideo.folders.list())
  }, [])

  const refreshAll = useCallback(async () => {
    const [s, st, f, cfg, dirInfo, tools] = await Promise.all([
      window.whichvideo.library.stats(),
      window.whichvideo.library.status(),
      window.whichvideo.folders.list(),
      window.whichvideo.library.settings(),
      window.whichvideo.library.dataDir(),
      window.whichvideo.library.mediaTools()
    ])
    setStats(s)
    setStatus(st)
    setFolders(f)
    setSettings(cfg)
    setDataDir(dirInfo)
    setMediaTools(tools)
  }, [])

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
        case 'video-removed':
          // video-updated / video-removed 由 useVideoList 消费（videos state 在那里），
          // 这里没有对应 state 可更新，别在这里加逻辑。
          // 曾因该分支为空导致"索引完成后列表仍显示索引中/0 帧"——修复在 useVideoList。
          break
        case 'import-progress':
          // 批量导入的逐批进度：扫描阶段 total 为 0（显示已发现数），
          // 遍历完成后变成确定总数。finished 到来自动清空。
          setImportProgress((prev) => applyImportProgress(prev, event))
          break
        case 'notice':
          // 后端通知（索引失败/后端异常/文件被移除/发现新视频等）在此
          // 转成渲染端通知。此前该分支空置 —— 后端 notice 广播全部被
          // 丢弃，用户看不到"索引失败"这类关键信息。
          onNotice?.(event.level, event.message)
          break
        default:
          break
      }
    })
    return unsubscribe
    // onNotice 必须是稳定引用（useNotices.pushNotice 是 useCallback），
    // 否则会反复重订阅事件通道
  }, [onNotice])

  const updateSettings = useCallback((next: AppSettings) => {
    setSettings(next)
  }, [])

  return {
    stats: stats ?? EMPTY_STATS,
    status,
    folders,
    settings,
    dataDir,
    mediaTools,
    importProgress,
    refreshAll,
    refreshFolders,
    setSettings: updateSettings,
    setMediaTools
  }
}
