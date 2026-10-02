/**
 * Electron 主进程入口：窗口、IPC、库与索引器的生命周期。
 */
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
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
import { LibraryDatabase } from './db'
import { DATABASE_FILES, portableMarkerPath, resolveDataDir, type DataDirResolution } from './datadir'
import { FrameSearchIndex, queryVectorFromImage } from './search'
import { Indexer } from './indexer'
import { FolderWatcher } from './watcher'
import { resolveTools } from './media'

let mainWindow: BrowserWindow | null = null
let db: LibraryDatabase
let searchIndex: FrameSearchIndex
let indexer: Indexer
let watcher: FolderWatcher
let toolsReady = false

/* ------------------------------------------------------------------ *
 * 数据目录：绿色/便携模式
 *
 * 便携模式下数据（索引库、缓存）全部落在 exe 同级的 data/ 里，
 * 换机器时整个目录拷走即可，不会在系统盘留下任何东西。
 * 判定逻辑见 ./datadir.ts，这里只负责与 Electron 对接。
 * ------------------------------------------------------------------ */

/** 判断目录能否写入（不存在时尝试创建） */
function isWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, '.whichvideo-write-probe')
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/** 首次进入便携模式时，把系统盘里的旧索引库搬过来，避免用户白建一次索引 */
function migrateLegacyDatabase(targetDir: string, legacyDir: string): void {
  if (!legacyDir || resolve(legacyDir) === resolve(targetDir)) return
  for (const name of DATABASE_FILES) {
    const from = join(legacyDir, name)
    const to = join(targetDir, name)
    if (!existsSync(from)) continue
    try {
      copyFileSync(from, to)
    } catch {
      /* 迁移失败就让用户重新索引，不影响启动 */
    }
  }
}

/** 计算并应用数据目录（必须在 app ready 之前调用） */
function setupDataDirectory(): DataDirResolution {
  const legacyDir = app.getPath('userData')
  const resolution = resolveDataDir({
    legacyDir,
    envDir: process.env.WHICHVIDEO_DATA_DIR,
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    exeDir: dirname(app.getPath('exe')),
    isPackaged: app.isPackaged,
    isWritable: isWritableDir
  })

  if (resolution.portable) {
    mkdirSync(resolution.dir, { recursive: true })
    try {
      writeFileSync(
        portableMarkerPath(resolution.dir),
        `portable data directory\r\nbase: ${process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(app.getPath('exe'))}\r\n`
      )
    } catch {
      /* 标记文件写不了也不影响使用 */
    }
    if (!existsSync(join(resolution.dir, 'whichvideo.db'))) {
      migrateLegacyDatabase(resolution.dir, legacyDir)
    }
    // 便携版启动器会把应用解压到临时目录，缓存必须挪出 temp
    app.setPath('userData', resolution.dir)
    app.setPath('sessionData', join(resolution.dir, 'session'))
    app.commandLine.appendSwitch('disable-http-cache')
  } else {
    app.setPath('userData', legacyDir)
  }

  return resolution
}

const dataDir = setupDataDirectory()

/* ------------------------------------------------------------------ *
 * 事件广播
 * ------------------------------------------------------------------ */

function broadcast(event: LibraryEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.eventChannel, event)
  }
}

/* ------------------------------------------------------------------ *
 * Electron 图像 → 通用位图
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

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

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

function performSearch(image: Electron.NativeImage): SearchResponse {
  const settings = db.getSettings()
  const started = Date.now()
  const size = image.getSize()
  const imageData = nativeImageToImageData(image)
  if (!imageData) return emptyResponse(size.width, size.height, started)

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

  return {
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
}

/* ------------------------------------------------------------------ *
 * IPC 注册
 * ------------------------------------------------------------------ */

function registerIpc(): void {
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
    const image = loadImageFromPath(filePath)
    if (!image) throw new Error(`无法读取图片：${filePath}`)
    return performSearch(image)
  })

  ipcMain.handle(IPC.searchDataUrl, (_e, dataUrl: string) => {
    const image = loadImageFromDataUrl(dataUrl)
    if (!image) throw new Error('无法解析拖入/粘贴的图片数据')
    return performSearch(image)
  })

  ipcMain.handle(IPC.searchClipboard, async () => {
    const image = await readClipboardImage()
    if (!image) return null
    return performSearch(image)
  })
}

/** 读取系统剪贴板里的图片（Electron 44 的 clipboard 是无障碍风格的异步 API） */
async function readClipboardImage(): Promise<Electron.NativeImage | null> {
  try {
    if (!(await clipboard.has('image/png'))) return null
    const items = await clipboard.read()
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (!type) continue
      const blob = (await item.getType(type)) as Blob
      if (typeof blob === 'string' || typeof blob.arrayBuffer !== 'function') continue
      const buffer = Buffer.from(await blob.arrayBuffer())
      const image = nativeImage.createFromBuffer(buffer)
      if (!image.isEmpty()) return image
    }
  } catch {
    return null
  }
  return null
}

function showOpenDialog(
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options)
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

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

function dbPath(): string {
  return join(dataDir.dir, 'whichvideo.db')
}

/**
 * ffmpeg 二进制目录。
 * 便携模式额外支持把 ffmpeg.exe / ffprobe.exe 放在 exe 同级或 data/bin 里，
 * 这样绿色版可以完全自包含。
 */
function resourceBinDir(): string | undefined {
  const exeDir = dirname(app.getPath('exe'))
  const candidates = [
    process.env.WHICHVIDEO_BIN_DIR,
    join(dataDir.dir, 'bin'),
    app.isPackaged ? exeDir : undefined,
    process.resourcesPath ? join(process.resourcesPath, 'bin') : undefined,
    resolve(app.getAppPath(), 'resources', 'bin'),
    resolve(process.cwd(), 'resources', 'bin')
  ].filter((p): p is string => !!p)
  return candidates.find((dir) => existsSync(dir))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0f17',
    title: 'WhichVideo · 以图搜视频',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function bootstrap(): Promise<void> {
  db = new LibraryDatabase(dbPath())
  searchIndex = new FrameSearchIndex(db)
  indexer = new Indexer(db, searchIndex, () => db.getSettings(), broadcast)
  watcher = new FolderWatcher(db, indexer, broadcast, () => db.getSettings().awaitWriteMs)

  toolsReady = !!resolveTools(resourceBinDir())

  registerIpc()
  await watcher.syncAll()
  indexer.resumePending()

  if (app.isPackaged) {
    // 自动更新是可选能力：未安装 electron-updater 时静默跳过
    void import('electron-updater')
      .then((mod) => mod.autoUpdater.checkForUpdatesAndNotify())
      .catch(() => undefined)
  }
}

app.whenReady().then(async () => {
  createWindow()
  await bootstrap()
  broadcast({ type: 'stats', stats: db.stats() })
  broadcast({ type: 'status', status: indexer.status() })
  broadcast({
    type: 'notice',
    level: toolsReady ? 'info' : 'warn',
    message: toolsReady
      ? `索引服务已就绪（数据目录：${dataDir.dir}${dataDir.portable ? ' · 便携模式' : ''}）`
      : '未找到 ffmpeg / ffprobe：可以浏览与管理视频，但无法建立索引。请参考 README 安装。'
  })
  if (dataDir.portable) {
    broadcast({
      type: 'notice',
      level: 'info',
      message: `便携模式：索引库与缓存都写在 ${dataDir.dir}，拷贝整个文件夹即可迁移`
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void watcher.stopAll().finally(() => {
    db?.close()
    if (process.platform !== 'darwin') app.quit()
  })
})

process.on('uncaughtException', (err) => {
  broadcast({ type: 'notice', level: 'error', message: `主进程异常：${err.message}` })
})
