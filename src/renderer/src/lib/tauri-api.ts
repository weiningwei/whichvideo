import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { IPC } from '@shared/types'
import type {
  WhichVideoApi,
  LibraryEvent,
  LibraryStats,
  WatchedFolder,
  VideoRecord,
  VideoPage,
  FrameManifestEntry,
  AppSettings,
  DataDirInfo,
  IndexerStatus,
  ImportResult,
  FrameProgress,
  SearchResponse,
  ClipboardSearchResult,
  DuplicatePair,
} from '@shared/types'

/**
 * Tauri 版桥接：用 @tauri-apps/api 的 invoke / listen 实现 WhichVideoApi。
 *
 * 实现 WhichVideoApi 契约，集中管理命令参数和后端事件订阅。
 */
export const tauriApi: WhichVideoApi = {
  library: {
    stats: () => invoke<LibraryStats>(IPC.libraryStats),
    status: () => invoke<IndexerStatus>(IPC.libraryStatus),
    settings: () => invoke<AppSettings>(IPC.librarySettings),
    updateSettings: (patch) => invoke<AppSettings>(IPC.libraryUpdateSettings, { patch }),
    dataDir: () => invoke<DataDirInfo>(IPC.libraryDataDir),
    openDatabaseFolder: () => invoke<string>(IPC.libraryOpenDb),
    reset: () => invoke<void>(IPC.libraryReset),
  },
  folders: {
    list: () => invoke<WatchedFolder[]>(IPC.foldersList),
    addFromDialog: () => invoke<WatchedFolder[]>(IPC.foldersAddDialog),
    addPath: (dirPath) => invoke<WatchedFolder>(IPC.foldersAddPath, { dirPath }),
    remove: (folderId) => invoke<void>(IPC.foldersRemove, { folderId }),
    rescan: (folderId) => invoke<ImportResult>(IPC.foldersRescan, { folderId }),
    setEnabled: (folderId, enabled) =>
      invoke<WatchedFolder>(IPC.foldersSetEnabled, { folderId, enabled }),
  },
  videos: {
    list: (query) => invoke<VideoPage>(IPC.videosList, { query: query ?? {} }),
    get: (videoId) => invoke<VideoRecord | null>(IPC.videosGet, { videoId }),
    remove: (videoId) => invoke<void>(IPC.videosRemove, { videoId }),
    reindex: (videoIds, mode) => invoke<{ count: number }>(IPC.videosReindex, { videoIds, mode }),
    findDuplicates: (minScore) =>
      invoke<DuplicatePair[]>(IPC.videosFindDuplicates, { minScore }),
    importFiles: () => invoke<ImportResult>(IPC.videosImport),
    importImages: () => invoke<string[]>(IPC.videosImportImages),
    openFile: (videoId, atSeconds) => invoke<void>(IPC.videosOpen, { videoId, atSeconds }),
    revealFile: (videoId) => invoke<void>(IPC.videosReveal, { videoId }),
    thumbnail: (videoId) => invoke<string | null>(IPC.videosThumbnail, { videoId }),
    frameProgress: (videoId) => invoke<FrameProgress | null>(IPC.videosFrameProgress, { videoId }),
    frameManifest: (videoId) => invoke<FrameManifestEntry[]>(IPC.videosFrameManifest, { videoId }),
    matchFrame: (videoId, timeMs) => invoke<string | null>(IPC.videosMatchFrame, { videoId, timeMs }),
  },
  search: {
    byPath: (filePath: string) => invoke<SearchResponse>(IPC.searchPath, { filePath }),
    byDataUrl: (dataUrl: string) => invoke<SearchResponse>(IPC.searchDataUrl, { dataUrl }),
    byClipboard: () => invoke<ClipboardSearchResult | null>(IPC.searchClipboard),
    byUrl: (url: string) => invoke<SearchResponse>(IPC.searchUrl, { url }),
  },
  events: {
    subscribe: (listener: (event: LibraryEvent) => void): (() => void) => {
      let unlisten: UnlistenFn | null = null
      listen<LibraryEvent>(IPC.eventChannel, (event) => listener(event.payload))
        .then((fn) => {
          unlisten = fn
        })
        .catch(() => {})
      return () => {
        if (unlisten) unlisten()
      }
    },
  },
}
