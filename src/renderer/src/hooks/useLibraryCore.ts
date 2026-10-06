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

export function useLibraryCore(): UseLibraryCoreReturn {
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
        case 'notice':
          // video-updated / video-removed 由 useVideoList 消费（videos state 在那里），
          // 这里没有对应 state 可更新，别在这里加逻辑。
          // 曾因该分支为空导致"索引完成后列表仍显示索引中/0 帧"——修复在 useVideoList。
          break
        default:
          break
      }
    })
    return unsubscribe
  }, [])

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