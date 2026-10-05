/**
 * IPC 层：26 个 ipcMain.handle 频道及其私有辅助函数。
 *
 * 从 index.ts 拆出（重构阶段 1）——index.ts 只保留启动引导、数据目录、
 * 单实例、窗口与崩溃兜底。这里不认识任何模块级可变量：全部状态经
 * IpcDeps 注入，对外契约只有 shared/types 的 IPC 频道。
 */
import { clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  IPC,
  normalizePath,
  pathKeyOf,
  type AppSettings,
  type ImportResult,
  type LibraryEvent,
  type SearchMatch,
  type SearchResponse,
  type VideoQuery,
  type WatchedFolder
} from '@shared/types'
import type { ImageDataLike } from '@shared/hash'
import { log, logError } from './logger'
import { readClipboardImageBytes } from './clipboard'
import { describeUrlForLog, fetchImageFromUrl } from './url-image'
import type { LibraryDatabase } from './db'
import type { FrameSearchIndex } from './search'
import type { Indexer } from './indexer'
import type { FolderWatcher } from './watcher'

/** bootstrap 在 registerIpc 调用点构造；实例在调用前都已创建完毕 */
export interface IpcDeps {
  db: LibraryDatabase
  searchIndex: FrameSearchIndex
  indexer: Indexer
  watcher: FolderWatcher
  dataDir: { dir: string; portable: boolean; source: string }
  toolsReady: boolean
  dbPath: () => string
  broadcast: (event: LibraryEvent) => void
  getMainWindow: () => BrowserWindow | null
  queryVectorFromImage: typeof import('./search').queryVectorFromImage
}

/* ------------------------------------------------------------------ *
 * 纯函数辅助（不依赖任何状态）
 * ------------------------------------------------------------------ */

function nativeImageToImageData(image: Electron.NativeImage): ImageDataLike | null {
  const size = image.getSize()
  if (!size.width || !size.height) return null
  const bitmap = image.toBitmap() // BGRA
  return {
    width: size.width,
    height: size.height,
    channels: 4,
    order: 'bgr',
    data: bitmap
  }
}

function loadImageFromPath(filePath: string): Electron.NativeImage | null {
  const image = nativeImage.createFromPath(filePath)
  return image.isEmpty() ? null : image
}

function loadImageFromDataUrl(dataUrl: string): Electron.NativeImage | null {
  const image = nativeImage.createFromDataURL(dataUrl)
  return image.isEmpty() ? null : image
}

function emptyResponse(width: number, height: number, started: number): SearchResponse {
  return {
    query: { width, height, colorScoreHint: 0 },
    matchCount: 0,
    comparedFrames: 0,
    elapsedMs: Date.now() - started,
    found: false,
    matches: []
  }
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

export function registerIpc(deps: IpcDeps): void {
  const {
    db,
    searchIndex,
    indexer,
    watcher,
    dataDir,
    toolsReady,
    dbPath,
    broadcast,
    getMainWindow,
    queryVectorFromImage
  } = deps

  function showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
    const win = getMainWindow()
    return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
  }

  /**
   * 读取系统剪贴板里的图片。
   * 挑选逻辑（扫所有 image/*、不设 PNG 白名单、失败只记日志）在 src/main/clipboard.ts。
   */
  async function readClipboardImage(): Promise<Electron.NativeImage | null> {
    try {
      const found = await readClipboardImageBytes(clipboard, { log, logError })
      if (!found) return null
      const image = nativeImage.createFromBuffer(found.buffer)
      if (image.isEmpty()) {
        log(`剪贴板图片 ${found.type} 解析后为空（${found.buffer.length} 字节）`)
        return null
      }
      const size = image.getSize()
      log(`剪贴板图片：${found.type} → ${size.width}x${size.height}`)
      return image
    } catch (err) {
      logError('读取剪贴板失败', err)
      return null
    }
  }

  function performSearch(image: Electron.NativeImage, source: string): SearchResponse {
    const settings = db.getSettings()
    const started = Date.now()
    const size = image.getSize()
    const imageData = nativeImageToImageData(image)
    if (!imageData) {
      log(`检索(${source})：图片无法转成位图 ${size.width}x${size.height}`)
      return emptyResponse(size.width, size.height, started)
    }

    const vector = queryVectorFromImage(imageData)
    const { results, comparedFrames } = searchIndex.search(vector, {
      minHashScore: settings.minHashScore,
      maxResults: settings.maxResults
    })

    const matches: SearchMatch[] = []
    for (const hit of results) {
      const video = db.getVideo(hit.videoId)
      if (!video) continue
      matches.push({
        video,
        score: Number(hit.score.toFixed(4)),
        hashScore: Number(hit.hashScore.toFixed(4)),
        colorScore: Number(hit.colorScore.toFixed(4)),
        timeSeconds: Number(hit.timeSeconds.toFixed(2)),
        frameIndex: hit.frameIndex,
        hashDistance: hit.hashDistance
      })
    }

    const response: SearchResponse = {
      query: {
        width: size.width,
        height: size.height,
        colorScoreHint: matches.length ? matches[0].colorScore : 0
      },
      matchCount: matches.length,
      comparedFrames,
      elapsedMs: Date.now() - started,
      found: matches.length > 0,
      matches
    }
    // 落日志：排查"点了没反应/没结果"时，日志能直接回答比了多少帧、命中几个。
    log(
      `检索(${source}) ${size.width}x${size.height}：比对 ${response.comparedFrames} 帧 → 命中 ${response.matchCount}，${response.elapsedMs}ms`
    )
    return response
  }

  /** 单文件导入后，把它所在目录登记为被监听目录（保持动态更新） */
  async function registerFoldersForFiles(files: string[]): Promise<void> {
    const dirs = new Set(files.map((f) => normalizePath(dirname(f))))
    let changed = false
    const known = db.listFolders()
    for (const dir of dirs) {
      const key = pathKeyOf(dir)
      const covered = known.some((f) => f.pathKey === key || key.startsWith(f.pathKey + '\\'))
      if (covered) continue
      db.upsertFolder(dir, { pinned: false, recursive: true })
      changed = true
    }
    if (changed) {
      await watcher.syncAll()
      for (const folder of db.listFolders()) broadcast({ type: 'folder-updated', folder })
    }
  }

  ipcMain.handle(IPC.libraryStats, () => db.stats())
  ipcMain.handle(IPC.libraryStatus, () => indexer.status())
  ipcMain.handle(IPC.librarySettings, () => db.getSettings())
  ipcMain.handle(IPC.libraryDataDir, () => ({
    dir: dataDir.dir,
    portable: dataDir.portable,
    source: dataDir.source,
    toolsReady
  }))
  ipcMain.handle(IPC.libraryUpdateSettings, (_e, patch: Partial<AppSettings>) => {
    const updated = db.updateSettings(patch)
    void watcher.syncAll()
    return updated
  })
  ipcMain.handle(IPC.libraryOpenDb, () => {
    const dir = dirname(dbPath())
    void shell.openPath(dir)
    return dir
  })
  ipcMain.handle(IPC.libraryReset, () => {
    db.db.exec('DELETE FROM frames; DELETE FROM videos; DELETE FROM image_folders;')
    searchIndex.rebuild()
    broadcast({ type: 'stats', stats: db.stats() })
    broadcast({ type: 'notice', level: 'info', message: '索引库已清空' })
  })

  ipcMain.handle(IPC.foldersList, () => db.listFolders())

  ipcMain.handle(IPC.foldersAddDialog, async () => {
    const picked = await showOpenDialog({
      title: '选择要导入并持续监听的文件夹',
      properties: ['openDirectory', 'multiSelections']
    })
    if (picked.canceled) return []
    const folders: WatchedFolder[] = []
    for (const dir of picked.filePaths) {
      const result = await indexer.importFolder(dir, { pinned: true, recursive: true })
      const folder = db.getFolder(result.folderId)
      if (folder) folders.push(folder)
    }
    await watcher.syncAll()
    searchIndex.rebuild()
    broadcast({ type: 'stats', stats: db.stats() })
    return folders
  })

  ipcMain.handle(IPC.foldersAddPath, async (_e, dirPath: string) => {
    const result = await indexer.importFolder(normalizePath(dirPath), {
      pinned: true,
      recursive: true
    })
    await watcher.syncAll()
    searchIndex.rebuild()
    broadcast({ type: 'stats', stats: db.stats() })
    return db.getFolder(result.folderId)
  })

  ipcMain.handle(IPC.foldersRemove, async (_e, folderId: number) => {
    await watcher.stop(folderId)
    db.removeFolder(folderId)
    broadcast({ type: 'folder-removed', folderId })
    broadcast({ type: 'stats', stats: db.stats() })
  })

  ipcMain.handle(IPC.foldersRescan, async (_e, folderId?: number) => {
    const targets = (folderId != null ? [db.getFolder(folderId)] : db.listFolders()).filter(
      (f): f is WatchedFolder => !!f
    )
    const total: ImportResult = { added: 0, duplicates: 0, skipped: 0, scanned: 0, folders: 0 }
    for (const folder of targets) {
      if (!existsSync(folder.path)) {
        db.updateFolderState(folder.id, 'missing', '目录不存在')
        continue
      }
      const result = await indexer.importFolder(folder.path, {
        pinned: folder.pinned,
        recursive: folder.recursive
      })
      total.added += result.added
      total.duplicates += result.duplicates
      total.skipped += result.skipped
      total.scanned += result.scanned
      total.folders += 1
    }
    await watcher.syncAll()
    broadcast({ type: 'stats', stats: db.stats() })
    return total
  })

  ipcMain.handle(IPC.foldersSetEnabled, async (_e, folderId: number, enabled: boolean) => {
    db.setFolderEnabled(folderId, enabled)
    await watcher.syncAll()
    return db.getFolder(folderId)
  })

  ipcMain.handle(IPC.videosList, (_e, query: VideoQuery) => db.listVideos(query ?? {}))
  ipcMain.handle(IPC.videosGet, (_e, videoId: number) => db.getVideo(videoId))
  ipcMain.handle(IPC.videosRemove, (_e, videoId: number) => {
    db.removeVideo(videoId)
    searchIndex.rebuild()
    broadcast({ type: 'video-removed', videoId, path: '' })
    broadcast({ type: 'stats', stats: db.stats() })
  })
  ipcMain.handle(IPC.videosReindex, async (_e, videoIds?: number[]) => indexer.reindex(videoIds))
  ipcMain.handle(IPC.videosThumbnail, (_e, videoId: number) => db.getThumbnail(videoId))

  ipcMain.handle(IPC.videosImport, async () => {
    const picked = await showOpenDialog({
      title: '选择视频文件（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '视频',
          extensions: [
            'mp4',
            'mkv',
            'avi',
            'mov',
            'wmv',
            'flv',
            'webm',
            'm4v',
            'ts',
            'mpg',
            'mpeg',
            'rmvb',
            '3gp'
          ]
        },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (picked.canceled) return { added: 0, duplicates: 0, skipped: 0, scanned: 0, folders: 0 }
    const result = await indexer.importFiles(picked.filePaths)
    // 单个文件导入后，把它所在目录也纳入监听，保证后续“动态更新”
    await registerFoldersForFiles(picked.filePaths)
    broadcast({ type: 'stats', stats: db.stats() })
    return result
  })

  ipcMain.handle(IPC.videosImportImages, async () => {
    const picked = await showOpenDialog({
      title: '选择要搜索的图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'avif'] }]
    })
    if (picked.canceled) return []
    return picked.filePaths.map((p) => normalizePath(p))
  })

  ipcMain.handle(IPC.videosOpen, async (_e, videoId: number) => {
    const video = db.getVideo(videoId)
    if (!video) return
    const err = await shell.openPath(video.path)
    if (err) broadcast({ type: 'notice', level: 'error', message: `打开失败：${err}` })
  })

  ipcMain.handle(IPC.videosReveal, (_e, videoId: number) => {
    const video = db.getVideo(videoId)
    if (!video) return
    shell.showItemInFolder(video.path)
  })

  ipcMain.handle(IPC.searchPath, (_e, filePath: string) => {
    const started = Date.now()
    const image = loadImageFromPath(filePath)
    if (!image) {
      log(`检索(文件)失败：无法读取图片 ${filePath}`)
      return { ...emptyResponse(0, 0, started), error: `无法读取图片：${filePath}` }
    }
    return performSearch(image, '文件')
  })

  ipcMain.handle(IPC.searchDataUrl, (_e, dataUrl: string) => {
    const started = Date.now()
    const image = loadImageFromDataUrl(dataUrl)
    if (!image) {
      log(`检索(拖入/粘贴)失败：无法解析图片数据`)
      return { ...emptyResponse(0, 0, started), error: '无法解析拖入/粘贴的图片数据' }
    }
    return performSearch(image, '拖入/粘贴')
  })

  ipcMain.handle(IPC.searchClipboard, async () => {
    const image = await readClipboardImage()
    if (!image) return null
    // 必须把图片一起回传：渲染端左上角那格要显示"刚才是哪张图"，
    // 只回结果的话界面那一格会一直空着（用户以为根本没读到剪贴板）。
    return { dataUrl: image.toDataURL(), response: performSearch(image, '剪贴板') }
  })

  // 链接输入：URL → 字节 → NativeImage，之后与其它三条输入完全同一条链路。
  // 失败时把原因作为 error 返回（界面直接显示），而不是抛异常——用户能看懂
  // "网页里没找到图片"比"Error invoking remote method"有用得多。
  ipcMain.handle(IPC.searchUrl, async (_e, url: string) => {
    const started = Date.now()
    const result = await fetchImageFromUrl(String(url ?? ''))
    if (!result.ok || !result.data) {
      log(`检索(链接)失败：${result.message}`)
      const size = { width: 0, height: 0 }
      return { ...emptyResponse(size.width, size.height, started), error: result.message }
    }

    const image = nativeImage.createFromBuffer(result.data)
    if (image.isEmpty()) {
      const message = '图片已下载但无法解码（可能不是有效的图片格式）'
      log(`检索(链接)：${message} — ${describeUrlForLog(result)}`)
      return { ...emptyResponse(0, 0, started), error: message }
    }

    const size = image.getSize()
    log(`检索(链接)：${describeUrlForLog(result)} → ${size.width}x${size.height}`)
    // 把来源链接写进 queryLabel，界面顶部能显示"正在搜：https://…"
    const response = performSearch(image, '链接')
    return {
      ...response,
      queryImageUrl: result.finalUrl ?? String(url)
    }
  })
}
