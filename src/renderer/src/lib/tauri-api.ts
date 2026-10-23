import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { IPC } from '@shared/types'
import type { WhichVideoApi } from '@shared/types'
import { decodeEvent, decodeResponse, responses } from './ipc-contract'

async function invokeChecked<K extends keyof typeof responses>(command: K, args?: Record<string, unknown>) {
  return decodeResponse(command, await invoke<unknown>(command, args))
}

/**
 * Tauri 版桥接：用 @tauri-apps/api 的 invoke / listen 实现 WhichVideoApi。
 *
 * 实现 WhichVideoApi 契约，集中管理命令参数和后端事件订阅。
 */
export const tauriApi: WhichVideoApi = {
  library: {
    stats: () => invokeChecked(IPC.libraryStats),
    status: () => invokeChecked(IPC.libraryStatus),
    settings: () => invokeChecked(IPC.librarySettings),
    updateSettings: (patch) => invokeChecked(IPC.libraryUpdateSettings, { patch }),
    dataDir: () => invokeChecked(IPC.libraryDataDir),
    mediaTools: () => invokeChecked(IPC.libraryMediaTools),
    refreshMediaTools: () => invokeChecked(IPC.libraryRefreshMediaTools),
    selectMediaToolsDir: () => invokeChecked(IPC.librarySelectMediaToolsDir),
    clearMediaToolsDir: () => invokeChecked(IPC.libraryClearMediaToolsDir),
    openDatabaseFolder: () => invokeChecked(IPC.libraryOpenDb),
    exportDiagnostics: () => invokeChecked(IPC.libraryExportDiagnostics),
    reset: () => invokeChecked(IPC.libraryReset),
  },
  folders: {
    list: () => invokeChecked(IPC.foldersList),
    addFromDialog: () => invokeChecked(IPC.foldersAddDialog),
    addPath: (dirPath) => invokeChecked(IPC.foldersAddPath, { dirPath }),
    remove: (folderId) => invokeChecked(IPC.foldersRemove, { folderId }),
    rescan: (folderId) => invokeChecked(IPC.foldersRescan, { folderId }),
    setEnabled: (folderId, enabled) =>
      invokeChecked(IPC.foldersSetEnabled, { folderId, enabled }),
  },
  videos: {
    list: (query) => invokeChecked(IPC.videosList, { query: query ?? {} }),
    get: (videoId) => invokeChecked(IPC.videosGet, { videoId }),
    remove: (videoId) => invokeChecked(IPC.videosRemove, { videoId }),
    removeMany: (videoIds) => invokeChecked(IPC.videosRemoveMany, { videoIds }),
    reindex: (videoIds, mode) => invokeChecked(IPC.videosReindex, { videoIds, mode }),
    findDuplicates: (minScore) =>
      invokeChecked(IPC.videosFindDuplicates, { minScore }),
    importFiles: () => invokeChecked(IPC.videosImport),
    importPaths: (paths, watchFolders) => invokeChecked(IPC.videosImportPaths, { paths, watchFolders }),
    importFolderOnce: () => invokeChecked(IPC.videosImportFolderOnce),
    importImages: () => invokeChecked(IPC.videosImportImages),
    openFile: (videoId, atSeconds) => invokeChecked(IPC.videosOpen, { videoId, atSeconds }),
    revealFile: (videoId) => invokeChecked(IPC.videosReveal, { videoId }),
    thumbnail: (videoId) => invokeChecked(IPC.videosThumbnail, { videoId }),
    frameProgress: (videoId) => invokeChecked(IPC.videosFrameProgress, { videoId }),
    frameManifest: (videoId) => invokeChecked(IPC.videosFrameManifest, { videoId }),
    matchFrame: (videoId, timeMs) => invokeChecked(IPC.videosMatchFrame, { videoId, timeMs }),
  },
  search: {
    byPath: (filePath: string) => invokeChecked(IPC.searchPath, { filePath }),
    byDataUrl: (dataUrl: string) => invokeChecked(IPC.searchDataUrl, { dataUrl }),
    byClipboard: () => invokeChecked(IPC.searchClipboard),
    byUrl: (url: string) => invokeChecked(IPC.searchUrl, { url }),
  },
  events: {
    subscribe: (listener): (() => void) => {
      let unlisten: UnlistenFn | null = null
      let closed = false
      let reportedInvalidEvent = false
      listen<unknown>(IPC.eventChannel, (event) => {
        let decoded
        try { decoded = decodeEvent(event.payload) }
        catch (error) {
          console.error(error)
          if (!reportedInvalidEvent) {
            reportedInvalidEvent = true
            listener({ type: 'notice', level: 'error', message: '收到格式不正确的后台事件，请查看日志' })
          }
          return
        }
        listener(decoded)
      })
        .then((fn) => {
          if (closed) fn()
          else unlisten = fn
        })
        .catch((error) => console.error('无法订阅资料库事件', error))
      return () => {
        closed = true
        if (unlisten) unlisten()
      }
    },
  },
}
