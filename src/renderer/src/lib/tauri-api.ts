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
} from '@shared/types'

/**
 * Tauri 版桥接：用 @tauri-apps/api 的 invoke / listen 实现 WhichVideoApi。
 *
 * 骨架阶段仅 library.stats / folders.list 真实打通 Rust 后端（src-tauri/src/commands.rs），
 * 其余命令返回「未实现」以满足类型编译；后续阶段逐个补齐。
 * 渲染端其余 36 处 `window.whichvideo.*` 调用完全不变。
 */
const notImpl =
  (name: string) =>
  (..._args: unknown[]): Promise<never> =>
    Promise.reject(new Error(`[tauri-skeleton] ${name} 尚未实现`))

export const tauriApi: WhichVideoApi = {
  library: {
    stats: () => invoke<LibraryStats>(IPC.libraryStats),
    status: notImpl('library.status'),
    settings: () => invoke<AppSettings>(IPC.librarySettings),
    updateSettings: notImpl('library.updateSettings'),
    dataDir: notImpl('library.dataDir'),
    openDatabaseFolder: notImpl('library.openDatabaseFolder'),
    reset: notImpl('library.reset'),
  },
  folders: {
    list: () => invoke<WatchedFolder[]>(IPC.foldersList),
    addFromDialog: notImpl('folders.addFromDialog'),
    addPath: (dirPath) => invoke<WatchedFolder>(IPC.foldersAddPath, { dirPath }),
    remove: (folderId) => invoke<void>(IPC.foldersRemove, { folderId }),
    rescan: notImpl('folders.rescan'),
    setEnabled: (folderId, enabled) =>
      invoke<WatchedFolder>(IPC.foldersSetEnabled, { folderId, enabled }),
  },
  videos: {
    list: (query) => invoke<VideoPage>(IPC.videosList, { query: query ?? {} }),
    get: (videoId) => invoke<VideoRecord | null>(IPC.videosGet, { videoId }),
    remove: notImpl('videos.remove'),
    reindex: notImpl('videos.reindex'),
    findDuplicates: notImpl('videos.findDuplicates'),
    importFiles: notImpl('videos.importFiles'),
    importImages: notImpl('videos.importImages'),
    openFile: notImpl('videos.openFile'),
    revealFile: notImpl('videos.revealFile'),
    thumbnail: (videoId) => invoke<string | null>(IPC.videosThumbnail, { videoId }),
    frameProgress: notImpl('videos.frameProgress'),
    frameManifest: (videoId) => invoke<FrameManifestEntry[]>(IPC.videosFrameManifest, { videoId }),
    matchFrame: notImpl('videos.matchFrame'),
  },
  search: {
    byPath: notImpl('search.byPath'),
    byDataUrl: notImpl('search.byDataUrl'),
    byClipboard: notImpl('search.byClipboard'),
    byUrl: notImpl('search.byUrl'),
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
