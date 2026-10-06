import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type LibraryEvent, type WhichVideoApi } from '@shared/types'

const api: WhichVideoApi = {
  library: {
    stats: () => ipcRenderer.invoke(IPC.libraryStats),
    status: () => ipcRenderer.invoke(IPC.libraryStatus),
    settings: () => ipcRenderer.invoke(IPC.librarySettings),
    updateSettings: (patch) => ipcRenderer.invoke(IPC.libraryUpdateSettings, patch),
    dataDir: () => ipcRenderer.invoke(IPC.libraryDataDir),
    openDatabaseFolder: () => ipcRenderer.invoke(IPC.libraryOpenDb),
    reset: () => ipcRenderer.invoke(IPC.libraryReset)
  },
  folders: {
    list: () => ipcRenderer.invoke(IPC.foldersList),
    addFromDialog: () => ipcRenderer.invoke(IPC.foldersAddDialog),
    addPath: (dirPath: string) => ipcRenderer.invoke(IPC.foldersAddPath, dirPath),
    remove: (folderId: number) => ipcRenderer.invoke(IPC.foldersRemove, folderId),
    rescan: (folderId?: number) => ipcRenderer.invoke(IPC.foldersRescan, folderId),
    setEnabled: (folderId: number, enabled: boolean) =>
      ipcRenderer.invoke(IPC.foldersSetEnabled, folderId, enabled)
  },
  videos: {
    list: (query) => ipcRenderer.invoke(IPC.videosList, query),
    get: (videoId: number) => ipcRenderer.invoke(IPC.videosGet, videoId),
    remove: (videoId: number) => ipcRenderer.invoke(IPC.videosRemove, videoId),
    reindex: (videoIds?: number[]) => ipcRenderer.invoke(IPC.videosReindex, videoIds),
    findDuplicates: (minScore?: number) => ipcRenderer.invoke(IPC.videosFindDuplicates, minScore),
    importFiles: () => ipcRenderer.invoke(IPC.videosImport),
    importImages: () => ipcRenderer.invoke(IPC.videosImportImages),
    openFile: (videoId: number, atSeconds?: number) => ipcRenderer.invoke(IPC.videosOpen, videoId, atSeconds),
    revealFile: (videoId: number) => ipcRenderer.invoke(IPC.videosReveal, videoId),
    thumbnail: (videoId: number) => ipcRenderer.invoke(IPC.videosThumbnail, videoId),
    frameProgress: (videoId: number) => ipcRenderer.invoke(IPC.videosFrameProgress, videoId)
  },
  search: {
    byPath: (filePath: string) => ipcRenderer.invoke(IPC.searchPath, filePath),
    byDataUrl: (dataUrl: string) => ipcRenderer.invoke(IPC.searchDataUrl, dataUrl),
    byClipboard: () => ipcRenderer.invoke(IPC.searchClipboard),
    byUrl: (url: string) => ipcRenderer.invoke(IPC.searchUrl, url)
  },
  events: {
    subscribe: (listener: (event: LibraryEvent) => void) => {
      const handler = (_e: unknown, payload: LibraryEvent): void => listener(payload)
      ipcRenderer.on(IPC.eventChannel, handler)
      return () => {
        ipcRenderer.removeListener(IPC.eventChannel, handler)
      }
    }
  }
}

contextBridge.exposeInMainWorld('whichvideo', api)
