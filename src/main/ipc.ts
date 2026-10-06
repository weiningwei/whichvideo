/**
 * IPC 层：26 个 ipcMain.handle 频道及其私有辅助函数。
 *
 * 从 index.ts 拆出（重构阶段 1）——index.ts 只保留启动引导、数据目录、
 * 单实例、窗口与崩溃兜底。这里不认识任何模块级可变量：全部状态经
 * IpcDeps 注入，对外契约只有 shared/types 的 IPC 频道。
 */
import { clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { findSeekablePlayer, sha256OfFile } from './media'
import {
  IPC,
  normalizePath,
  pathKeyOf,
  type AppSettings,
  type ImportResult,
  type SearchMatch,
  type SearchResponse,
  type VideoQuery,
  type WatchedFolder,
  type FrameProgress,
  type DuplicatePair
} from '@shared/types'
import type { ImageDataLike } from '@shared/hash'
import type { ErrorCode } from '@shared/result'
import type { EmitLibraryEvent } from './interfaces'
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
  broadcast: EmitLibraryEvent
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

/**
 * 统一的失败响应：四条检索入口共用同一形状。
 * 界面读 error 展示文案，errorCode（见 shared/result.ts）供测试断言与分支。
 * 失败一律返回而不是抛异常——用户能看懂"网页里没找到图片"比
 * "Error invoking remote method"有用得多。
 */
function failResponse(
  started: number,
  code: ErrorCode,
  message: string,
  width = 0,
  height = 0
): SearchResponse {
  return { ...emptyResponse(width, height, started), error: message, errorCode: code }
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
      return failResponse(
        started,
        'decode-failed',
        '图片无法转成位图',
        size.width,
        size.height
      )
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
    broadcast({ type: 'settings-updated', settings: updated })
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
         const updatedFolder = db.getFolder(folder.id)
         if (updatedFolder) broadcast({ type: 'folder-updated', folder: updatedFolder })
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
    const folder = db.getFolder(folderId)
    if (folder) broadcast({ type: 'folder-updated', folder })
    return folder
  })

  ipcMain.handle(IPC.videosList, (_e, query: VideoQuery) => db.listVideos(query ?? {}))
  ipcMain.handle(IPC.videosGet, (_e, videoId: number) => db.getVideo(videoId))
  ipcMain.handle(IPC.videosRemove, (_e, videoId: number) => {
    indexer.removeVideo(videoId)
    db.removeVideo(videoId)
    searchIndex.rebuild()
    broadcast({ type: 'video-removed', videoId, path: '' })
    broadcast({ type: 'stats', stats: db.stats() })
  })
  ipcMain.handle(IPC.videosReindex, async (_e, videoIds?: number[]) => indexer.reindex(videoIds))
  ipcMain.handle(IPC.videosThumbnail, (_e, videoId: number) => db.getThumbnail(videoId))
  ipcMain.handle(IPC.videosFrameProgress, (_e, videoId: number): FrameProgress | null => indexer.getFrameProgress(videoId))

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

  ipcMain.handle(IPC.videosOpen, async (_e, videoId: number, atSeconds?: number) => {
    const video = db.getVideo(videoId)
    if (!video) return
    // 带时间戳：探测 mpv/VLC 直接从命中位置起播；都没有则退化到系统默认
    // 播放器（openPath 无法传时间戳，只能打开整个视频），并如实告知用户。
    if (atSeconds != null && atSeconds > 0) {
      const player = findSeekablePlayer(video.path)
      if (player) {
        const args = player.args(video.path, atSeconds)
        // 实际命令行落日志：定位播放类问题（/seek 不生效等）先看这里拼了什么
        log(`定位播放 [${player.name}]：${player.exe} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`)
        const child = spawn(player.exe, args, {
          detached: true,
          stdio: 'ignore'
        })
        child.unref()
        return
      }
      broadcast({
        type: 'notice',
        level: 'warn',
        message: '未找到 mpv / PotPlayer / VLC，已用系统默认播放器打开（无法直接跳到命中位置）'
      })
    }
    const err = await shell.openPath(video.path)
    if (err) broadcast({ type: 'notice', level: 'error', message: `打开失败：${err}` })
  })

  /** 哈希缓存优先；未算过则流式 SHA-256 并入库。失败返回 null（调用方降级）。 */
  async function ensureFileHash(database: LibraryDatabase, videoId: number): Promise<string | null> {
    const cached = database.getFileHash(videoId)
    if (cached) return cached
    const video = database.getVideo(videoId)
    if (!video) return null
    const hash = await sha256OfFile(video.path)
    database.setFileHash(videoId, hash)
    return hash
  }

  /**
   * 库内查重，两级检测：
   *
   * 第一级（零成本）：size 与 duration 完全一致的对 —— bit 级副本的强信号，
   * 直接报 score=1 并标注 identicalFile。SQL 一次 join。
   * 第二级：代表帧跨视频互搜（原逻辑）粗筛，命中的对再做**帧覆盖率深度
   * 验证**（A 的 8 个均匀帧逐帧查 B）—— 复制对覆盖率 100% → 分数逼近 1；
   * 同剧不同集的相同场景只有零星帧像 → 覆盖率拉低分数，误报自然下沉。
   *
   * 为什么要深度验证：视频级打分是"最佳帧 75% + 次佳帧 25%"，单帧代表
   * 查询下 bit 级复制对也只能报 ~98%（次佳帧是别的时间点），无法到 100%，
   * 与用户直觉（完全相同的文件应为 100%）冲突。
   *
   * 逐视频循环 + 每 16 个让出一次事件循环（setImmediate）—— 单次 search 是
   * 毫秒级内存扫描，但 V 个视频连续跑会卡住主进程。进度经
   * duplicate-scan-progress 事件广播（UI 暂未消费，留给进度条）。
   */
  ipcMain.handle(IPC.videosFindDuplicates, async (_e, minScore?: number) => {
    const threshold = typeof minScore === 'number' && minScore > 0 ? minScore : 0.88
    const ids = searchIndex.listVideoIds()
    const pairs: DuplicatePair[] = []
    const seenPair = new Set<string>()
    const pairKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`)

    // 第一级：size + duration 一致 → **候选**对（必要非充分），逐对以 SHA-256
    // 确认。哈希一致 = bit 级副本 → score=1 + identicalFile；不一致 → 不报
    // 完全相同，也不进 seenPair，交给第二级帧覆盖率继续评估。
    // 哈希算一次缓存进 file_hash 列；流式计算天然在块间让出事件循环。
    const identical = db.findIdenticalFilePairs()
    for (const row of identical) {
      try {
        const [hashA, hashB] = await Promise.all([
          ensureFileHash(db, row.idA),
          ensureFileHash(db, row.idB)
        ])
        if (!hashA || !hashB || hashA !== hashB) continue
        seenPair.add(pairKey(row.idA, row.idB))
        const a = db.getVideo(row.idA)
        const b = db.getVideo(row.idB)
        if (a && b) {
          pairs.push({
            videoA: a,
            videoB: b,
            score: 1,
            hashScore: 1,
            colorScore: 1,
            timeSeconds: 0,
            identicalFile: true
          })
        }
      } catch (err) {
        // 单个文件哈希失败（被占用/被删）不打断整体查重
        broadcast({
          type: 'notice',
          level: 'warn',
          message: `文件指纹计算失败：${err instanceof Error ? err.message : String(err)}`
        })
      }
    }

    // 第二级：代表帧粗筛
    let done = 0
    const roughHits: { idA: number; idB: number; hashScore: number; colorScore: number; timeSeconds: number }[] = []
    for (const id of ids) {
      const vec = searchIndex.videoQueryVector(id)
      if (vec) {
        const { results } = searchIndex.search(vec, { minHashScore: threshold, maxResults: 8 })
        const cross = results.find((r) => r.videoId !== id)
        if (cross) {
          const key = pairKey(id, cross.videoId)
          if (!seenPair.has(key)) {
            seenPair.add(key)
            roughHits.push({
              idA: id,
              idB: cross.videoId,
              hashScore: cross.hashScore,
              colorScore: cross.colorScore,
              timeSeconds: cross.timeSeconds
            })
          }
        }
      }
      done++
      if (done % 16 === 0) {
        broadcast({ type: 'duplicate-scan-progress', done, total: ids.length })
        await new Promise((r) => setImmediate(r))
      }
    }
    broadcast({ type: 'duplicate-scan-progress', done, total: ids.length })

    // 深度验证：A 的 8 个均匀帧逐帧查 B。score = 平均帧分 × (0.5 + 0.5×覆盖率)
    // —— bit 级复制：帧帧 100% 命中 → 1.0；零星相似 → 覆盖率拉低。
    for (const hit of roughHits) {
      const vectors = searchIndex.videoFrameVectors(hit.idA, 8)
      let hits = 0
      let sum = 0
      for (const v of vectors) {
        const { results } = searchIndex.search(v, { minHashScore: threshold, maxResults: 50 })
        const toB = results.find((r) => r.videoId === hit.idB)
        if (toB) {
          hits++
          sum += toB.score
        }
      }
      const coverage = vectors.length > 0 ? hits / vectors.length : 0
      const avgScore = hits > 0 ? sum / hits : 0
      const a = db.getVideo(hit.idA)
      const b = db.getVideo(hit.idB)
      if (a && b) {
        pairs.push({
          videoA: a,
          videoB: b,
          score: avgScore * (0.5 + 0.5 * coverage),
          hashScore: hit.hashScore,
          colorScore: hit.colorScore,
          timeSeconds: hit.timeSeconds,
          identicalFile: false
        })
      }
    }

    pairs.sort((x, y) => y.score - x.score)
    return pairs
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
      return failResponse(started, 'decode-failed', `无法读取图片：${filePath}`)
    }
    return performSearch(image, '文件')
  })

  ipcMain.handle(IPC.searchDataUrl, (_e, dataUrl: string) => {
    const started = Date.now()
    const image = loadImageFromDataUrl(dataUrl)
    if (!image) {
      log(`检索(拖入/粘贴)失败：无法解析图片数据`)
      return failResponse(started, 'decode-failed', '无法解析拖入/粘贴的图片数据')
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
  ipcMain.handle(IPC.searchUrl, async (_e, url: string) => {
    const started = Date.now()
    const result = await fetchImageFromUrl(String(url ?? ''))
    if (!result.ok) {
      log(`检索(链接)失败：${result.message}`)
      return failResponse(started, result.code, result.message)
    }

    const image = nativeImage.createFromBuffer(result.data)
    if (image.isEmpty()) {
      const message = '图片已下载但无法解码（可能不是有效的图片格式）'
      log(`检索(链接)：${message} — ${describeUrlForLog(result)}`)
      return failResponse(started, 'decode-failed', message)
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
