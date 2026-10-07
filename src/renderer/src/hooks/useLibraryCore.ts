import { useCallback, useEffect, useState } from 'react'
import {
  type AppSettings,
  type DataDirInfo,
  type IndexerStatus,
  type LibraryEvent,
  type LibraryStats,
  type WatchedFolder
} from '@shared/types'

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
  refreshAll: () => Promise<void>
  refreshFolders: () => Promise<void>
  setSettings: (settings: AppSettings) => void
}

export interface UseLibraryCoreOptions {
  /** 主进程广播的 notice 事件消费入口（转成渲染端通知） */
  onNotice?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export function useLibraryCore(options: UseLibraryCoreOptions = {}): UseLibraryCoreReturn {
  const { onNotice } = options
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [status, setStatus] = useState<IndexerStatus | null>(null)
  const [folders, setFolders] = useState<WatchedFolder[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [dataDir, setDataDir] = useState<DataDirInfo | null>(null)

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
        case 'notice':
          // 主进程的通知（索引失败/主进程异常/文件被移除/发现新视频等）在此
          // 转成渲染端通知。此前该分支空置 —— 主进程 9 处 notice 广播全部被
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
    refreshAll,
    refreshFolders,
    setSettings: updateSettings
  }
}