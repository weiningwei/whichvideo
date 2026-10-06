/**
 * 索引队列：把待处理的视频抽帧、算指纹、写库，并对外播报进度。
 *
 * 单次 ffmpeg 调用内对若干时间点 seek，输出 rgb24 到 pipe，边收边算哈希，
 * 因此不需要在磁盘上落任何临时图片。
 */
import { existsSync, statSync } from 'node:fs'
import {
  type AppSettings,
  type ImportResult,
  type IndexerStatus,
  type VideoRecord,
  type VideoStatus,
  type FrameProgress
} from '@shared/types'
import { normalizePath } from '@shared/types'
import { makeThumbnail, planTimestamps, probeVideo, requireTools, type ToolPaths } from './media'
import { extractAndHash, scanVideoFiles, statFile } from './scan'
import type { EmitLibraryEvent, LibraryFileEvent } from './interfaces'
import { log, logError } from './logger'
import type { LibraryDatabase } from './db'
import type { NewFrame } from './db'
import type { FrameSearchIndex } from './search'

export interface ImportOptions {
  recursive?: boolean
  /** 已存在的文件也重新抽帧 */
  force?: boolean
  signal?: { cancelled: boolean }
}

export class Indexer {
  private queue: number[] = []
  private queued = new Set<number>()
  private active = 0
  private done = 0
  private failed = 0
  private currentPath: string | null = null
  private startedAt: number | null = null
  private finishedAt: number | null = null
  private lastError: string | null = null
  private toolsInstance: ToolPaths | null = null
  private rebuildTimer: NodeJS.Timeout | null = null
  /** 单视频帧进度：videoId -> {done, total} */
  private frameProgress = new Map<number, { done: number; total: number }>()

  constructor(
    private readonly db: LibraryDatabase,
    private readonly index: FrameSearchIndex,
    private readonly getSettings: () => AppSettings,
    private readonly emit: EmitLibraryEvent
  ) {}

  /* ------------------------------ 状态 ------------------------------ */

  get tools(): ToolPaths | null {
    if (!this.toolsInstance) {
      try {
        this.toolsInstance = requireTools()
      } catch {
        return null
      }
    }
    return this.toolsInstance
  }

  status(): IndexerStatus {
    return {
      running: this.active > 0 || this.queue.length > 0,
      active: this.active,
      queued: this.queue.length,
      total: this.done + this.failed + this.queue.length + this.active,
      done: this.done,
      failed: this.failed,
      currentPath: this.currentPath,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      lastError: this.lastError
    }
  }

  private broadcastStatus(): void {
    this.emit({ type: 'status', status: this.status() })
  }

  private broadcastStats(): void {
    this.emit({ type: 'stats', stats: this.db.stats() })
  }

  /** 索引内容变化后防抖重建内存索引，避免批量导入时反复重建 */
  private scheduleIndexRebuild(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer)
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null
      this.index.rebuild()
      this.broadcastStats()
    }, 500)
  }

  /* ------------------------------ 登记 ------------------------------ */

  private registerFile(
    filePath: string,
    folderId: number | null,
    probe: { duration: number | null; width: number | null; height: number | null; videoCodec: string | null }
  ): { video: VideoRecord; changed: boolean; created: boolean } {
    const st = statFile(filePath)
    if (!st) throw new Error(`文件不可读：${filePath}`)
    return this.db.upsertVideo({
      path: filePath,
      size: st.size,
      mtimeMs: st.mtimeMs,
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      videoCodec: probe.videoCodec,
      folderId
    })
  }

  enqueue(taskId: number, filePath: string, force = false): void {
    void filePath
    if (this.queued.has(taskId) && !force) return
    this.queued.add(taskId)
    this.queue.push(taskId)
    if (!this.startedAt) this.startedAt = Date.now()
    this.finishedAt = null
    this.db.setVideoStatus(taskId, 'pending')
    // 入队即广播：所有入队路径（导入/watcher 重入队/reindex）统一在此发
    // video-updated —— 改库不配套 emit 是"UI 停留旧状态"系列 bug 的根源。
    const queued = this.db.getVideo(taskId)
    if (queued) this.emit({ type: 'video-updated', video: queued })
    this.broadcastStatus()
    void this.pump()
  }

  /* ------------------------------ 导入 ------------------------------ */

  async importFiles(files: string[], folderId: number | null = null, options: ImportOptions = {}): Promise<ImportResult> {
    const result: ImportResult = { added: 0, duplicates: 0, skipped: 0, scanned: 0, folders: 0 }
    const t = this.tools
    if (!t) throw new Error('未找到 ffmpeg / ffprobe，无法建立索引。请先安装 ffmpeg（见 README）。')

    for (const raw of files) {
      const filePath = normalizePath(raw)
      result.scanned++
      if (!existsSync(filePath)) {
        result.skipped++
        continue
      }
      const existing = this.db.findByPath(filePath)
      let probe = {
        duration: existing?.duration ?? null,
        width: existing?.width ?? null,
        height: existing?.height ?? null,
        videoCodec: existing?.videoCodec ?? null
      }
      if (probe.duration == null) {
        try {
          probe = { ...(await probeVideo(filePath, t)) }
        } catch (err) {
          result.skipped++
          this.lastError = err instanceof Error ? err.message : String(err)
          continue
        }
      }
      const { video, changed, created } = this.registerFile(filePath, folderId, probe)
      if (created) result.added++
      else if (changed) result.added++
      else if (existing?.status === 'ready' && !options.force) {
        result.duplicates++
        continue
      }
      this.emit({ type: 'video-updated', video })
      this.enqueue(video.id, video.path, options.force || changed)
    }
    this.broadcastStats()
    return result
  }

  /** 递归导入文件夹（也会把该目录登记为被监听的文件夹） */
  async importFolder(
    dirPath: string,
    options: ImportOptions & { pinned?: boolean } = {}
  ): Promise<ImportResult & { folderId: number }> {
    const t = this.tools
    if (!t) throw new Error('未找到 ffmpeg / ffprobe，无法建立索引。请先安装 ffmpeg（见 README）。')

    const root = normalizePath(dirPath)
    const folder = this.db.upsertFolder(root, {
      pinned: options.pinned !== false,
      recursive: options.recursive !== false
    })
    const result: ImportResult & { folderId: number } = {
      added: 0,
      duplicates: 0,
      skipped: 0,
      scanned: 0,
      folders: 1,
      folderId: folder.id
    }

    await scanVideoFiles(root, { recursive: options.recursive !== false, signal: options.signal }, async (filePath) => {
      result.scanned++
      const existing = this.db.findByPath(filePath)
      if (existing && existing.status === 'ready' && !options.force) {
        const st = statFile(filePath)
        if (st && st.size === existing.size && Math.abs(st.mtimeMs - existing.mtimeMs) < 1) {
          result.duplicates++
          if (existing.folderId == null) {
            this.db.upsertVideo({
              path: filePath,
              size: existing.size,
              mtimeMs: existing.mtimeMs,
              duration: existing.duration,
              width: existing.width,
              height: existing.height,
              videoCodec: existing.videoCodec,
              folderId: folder.id
            })
          }
          return
        }
      }

      let probe = {
        duration: existing?.duration ?? null,
        width: existing?.width ?? null,
        height: existing?.height ?? null,
        videoCodec: existing?.videoCodec ?? null
      }
      if (probe.duration == null) {
        try {
          probe = { ...(await probeVideo(filePath, t)) }
        } catch {
          result.skipped++
          return
        }
      }
      const { video, changed, created } = this.registerFile(filePath, folder.id, probe)
      if (created || changed) result.added++
      this.emit({ type: 'video-updated', video })
      this.enqueue(video.id, video.path, options.force || changed)
    })

    this.db.markFolderScanned(folder.id)
    this.db.updateFolderState(folder.id, 'watching', null)
    const refreshed = this.db.getFolder(folder.id)
    if (refreshed) this.emit({ type: 'folder-updated', folder: refreshed })
    this.broadcastStats()
    return result
  }

  /* --------------------------- 外部文件变更 --------------------------- */

  /** 文件事件总线的唯一入口（订阅点见 index.ts 的 bootstrap） */
  handleFileEvent(event: LibraryFileEvent): void {
    switch (event.type) {
      case 'file-upsert':
        this.onFileUpsert(event.path, event.folderId)
        break
      case 'file-removed':
        this.onFileRemoved(event.path)
        break
      case 'directory-removed':
        this.onDirectoryRemoved(event.path)
        break
    }
  }

  private onFileUpsert(filePath: string, folderId: number | null): void {
    try {
      const normalized = normalizePath(filePath)
      const existing = this.db.findByPath(normalized)
      const st = statFile(normalized)
      if (!st) return
      if (
        existing &&
        existing.status === 'ready' &&
        existing.size === st.size &&
        Math.abs(existing.mtimeMs - st.mtimeMs) < 1
      ) {
        return
      }
      const { video, changed, created } = this.db.upsertVideo({
        path: normalized,
        size: st.size,
        mtimeMs: st.mtimeMs,
        duration: existing?.duration ?? null,
        width: existing?.width ?? null,
        height: existing?.height ?? null,
        videoCodec: existing?.videoCodec ?? null,
        folderId: folderId ?? existing?.folderId ?? null
      })
      if (created || changed) {
        this.emit({ type: 'video-updated', video })
        this.enqueue(video.id, video.path, true)
        this.broadcastStats()
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
    }
  }

  private onFileRemoved(filePath: string): void {
    const video = this.db.findByPath(filePath)
    if (!video) return
    this.db.removeVideo(video.id)
    this.queued.delete(video.id)
    this.queue = this.queue.filter((id) => id !== video.id)
    this.emit({ type: 'video-removed', videoId: video.id, path: video.path })
    this.scheduleIndexRebuild()
    this.broadcastStatus()
    this.broadcastStats()
  }

  private onDirectoryRemoved(dirPath: string): void {
    const ids = this.db.removeVideosUnder(dirPath)
    for (const id of ids) {
      this.queued.delete(id)
    }
    this.queue = this.queue.filter((id) => !ids.includes(id))
    for (const id of ids) {
      this.emit({ type: 'video-removed', videoId: id, path: '' })
    }
    if (ids.length) {
      this.scheduleIndexRebuild()
      this.broadcastStats()
    }
  }

  /* ------------------------------ 队列 ------------------------------ */

  resumePending(): void {
    let stale = 0
    for (const video of this.db.listPendingVideos()) {
      if (video.status === 'indexing') {
        // 上次进程没走完（崩溃/断电/强杀）留下的假"索引中"，改回 pending 重新排队
        stale++
        this.db.setVideoStatus(video.id, 'pending')
        // 不 emit video-updated：此处是启动早期，渲染端尚未订阅事件；
        // 挂载后的 refreshAll 全量拉取天然兜底
      }
      this.queued.add(video.id)
      this.queue.push(video.id)
    }
    if (this.queue.length) {
      log(`恢复索引队列：${this.queue.length} 个待处理${stale ? `（含 ${stale} 个崩溃残留的索引中）` : ''}`)
      this.startedAt = Date.now()
      this.broadcastStatus()
      void this.pump()
    }
  }

  async reindex(videoIds?: number[]): Promise<number> {
    const targets = videoIds?.length
      ? videoIds.map((id) => this.db.getVideo(id)).filter((v): v is VideoRecord => !!v)
      : this.db.listVideos({ limit: 2000 }).items
    let count = 0
    for (const video of targets) {
      if (!existsSync(video.path)) continue
      // 强制重建索引时清空已处理进度
      this.db.updateProcessedTimestamps(video.id, [])
      this.db.setVideoStatus(video.id, 'pending')
      // 广播由 enqueue 统一负责（入队即发 video-updated，含 pending 状态）
      this.enqueue(video.id, video.path, true)
      count++
    }
    return count
  }

  /** 手动/文件监听移除视频时同步清理 Indexer 内部状态 */
  removeVideo(videoId: number): void {
    // 从队列移除
    this.queued.delete(videoId)
    this.queue = this.queue.filter((id) => id !== videoId)
    // 若正在处理，active 计数会在 process 的 finally 里自然递减
    // 这里仅标记数据库状态，process 完成后会检查视频是否仍存在
    this.broadcastStatus()
    this.broadcastStats()
  }

  private async pump(): Promise<void> {
    const settings = this.getSettings()
    while (this.active < Math.max(1, settings.concurrency) && this.queue.length > 0) {
      const videoId = this.queue.shift()!
      this.queued.delete(videoId)
      this.active++
      this.broadcastStatus()
      void this.process(videoId, settings)
        .then(() => {
          this.done++
        })
        .catch((err: unknown) => {
          this.failed++
          this.lastError = err instanceof Error ? err.message : String(err)
          logError('索引失败', err)
          this.db.setVideoStatus(videoId, 'failed', this.lastError)
          const video = this.db.getVideo(videoId)
          if (video) this.emit({ type: 'video-updated', video })
          this.emit({ type: 'notice', level: 'error', message: `索引失败：${this.lastError}` })
        })
        .finally(() => {
          this.active--
          if (this.queue.length === 0 && this.active === 0) {
            this.finishedAt = Date.now()
            this.currentPath = null
          }
          this.broadcastStatus()
          this.broadcastStats()
          void this.pump()
        })
    }
    if (this.queue.length === 0 && this.active === 0) {
      if (!this.finishedAt) log('索引队列已全部完成')
      this.finishedAt = this.finishedAt ?? Date.now()
      this.scheduleIndexRebuild()
      this.broadcastStatus()
    }
  }

  private async process(videoId: number, settings: AppSettings): Promise<void> {
    const video = this.db.getVideo(videoId)
    if (!video) return
    const t = this.tools
    if (!t) throw new Error('未找到 ffmpeg / ffprobe')

    this.currentPath = video.path
    this.db.setVideoStatus(videoId, 'indexing')
    log(`索引开始：${video.path}`)
    this.emit({ type: 'video-updated', video: { ...video, status: 'indexing' as VideoStatus } })
    this.broadcastStatus()

    if (!existsSync(video.path)) {
      throw new Error('文件已不存在')
    }

    let duration = video.duration
    let width = video.width
    let height = video.height
    let codec = video.videoCodec
    if (duration == null) {
      const probe = await probeVideo(video.path, t)
      duration = probe.duration
      width = probe.width
      height = probe.height
      codec = probe.videoCodec
      const st = statSync(video.path)
      const probed = this.db.upsertVideo({
        path: video.path,
        size: st.size,
        mtimeMs: st.mtimeMs,
        duration,
        width,
        height,
        videoCodec: codec,
        folderId: video.folderId
      })
      // 补探测到的元数据（时长/分辨率/编码）立即广播，抽帧期间行上信息保持新鲜
      if (probed.video) this.emit({ type: 'video-updated', video: probed.video })
    }

    const timestamps = planTimestamps(duration, settings.framesPerVideo)
    // 断点续传：只处理未完成的时间点
    const processed = video.processedTimestamps ?? []
    const startIndex = processed.length
    if (startIndex >= timestamps.length) {
      log(`索引已完成，跳过：${video.path}`)
      this.db.setVideoStatus(videoId, 'ready')
      const updatedVideo = this.db.getVideo(videoId)
      if (updatedVideo) {
        this.emit({ type: 'video-updated', video: updatedVideo })
      }
      this.broadcastStatus()
      this.scheduleIndexRebuild()
      return
    }

    // 初始化帧进度
    this.frameProgress.set(videoId, { done: startIndex, total: timestamps.length })
    this.broadcastStatus()

    // 增量处理：每处理一批就落库、更新进度
    const batchSize = 32 // 每批处理的帧数
    let allNewFrames: NewFrame[] = []
    let currentProcessed = [...processed]

    for (let batchStart = startIndex; batchStart < timestamps.length; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize, timestamps.length)
      const batchStartTime = Date.now()
      const batchFrames = await extractAndHash(video.path, timestamps, settings, duration, {
        startIndex: batchStart,
        onFrame: (done, total) => {
          this.frameProgress.set(videoId, { done, total })
        },
        width: video.width,
        height: video.height
      })
      const batchElapsedMs = Date.now() - batchStartTime

      if (batchFrames.length > 0) {
        // 增量写入数据库
        this.db.upsertFramesIncremental(videoId, batchFrames)
        allNewFrames.push(...batchFrames)
        currentProcessed.push(...timestamps.slice(batchStart, batchEnd))
        this.db.updateProcessedTimestamps(videoId, currentProcessed)
        // 累加处理耗时
        this.db.addProcessedMs(videoId, batchElapsedMs)

        // 更新视频记录的 frameCount
        this.db.setVideoStatus(videoId, 'indexing')
        this.emit({ type: 'video-updated', video: { ...video, status: 'indexing' as VideoStatus, frameCount: currentProcessed.length } })
      }
    }

    this.frameProgress.set(videoId, { done: currentProcessed.length, total: timestamps.length })
    this.broadcastStatus()

    // 生成缩略图并更新最终状态（兜底：即使缩略图失败也要标记完成）
    let thumbnail: Buffer | null = null
    try {
      const thumbTime = duration ? duration * 0.12 : (timestamps[0] ?? 0)
      thumbnail = await makeThumbnail(video.path, thumbTime, t)
    } catch (err) {
      logError('生成缩略图失败', err)
    }
    // 更新最终状态（包含帧数、状态、缩略图）
    this.db.setReadyWithThumbnail(videoId, thumbnail)
    log(`索引完成：${video.path}（${allNewFrames.length} 新增帧，总计 ${currentProcessed.length} 帧）`)

    this.scheduleIndexRebuild()
    const updated = this.db.getVideo(videoId)
    // 确保 frameProgress 在发出最终事件后再清理
    this.frameProgress.delete(videoId)
    this.broadcastStatus()
    if (updated) this.emit({ type: 'video-updated', video: updated })
  }

  /** 获取单视频帧进度（供 IPC 查询） */
  getFrameProgress(videoId: number): FrameProgress | null {
    const p = this.frameProgress.get(videoId)
    return p ? { videoId, done: p.done, total: p.total } : null
  }
}

/** 导入结果文案（供 UI / 日志复用） */
export function describeImport(result: ImportResult): string {
  const parts = [`新增 ${result.added}`]
  if (result.duplicates) parts.push(`已存在 ${result.duplicates}`)
  if (result.skipped) parts.push(`跳过 ${result.skipped}`)
  parts.push(`扫描 ${result.scanned}`)
  return parts.join('，')
}
