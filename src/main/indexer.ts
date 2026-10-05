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
  type VideoStatus
} from '@shared/types'
import { normalizePath } from '@shared/types'
import { makeThumbnail, planTimestamps, probeVideo, requireTools, type ToolPaths } from './media'
import { extractAndHash, scanVideoFiles, statFile, type EventEmitter } from './scan'
import { log, logError } from './logger'
import type { LibraryDatabase } from './db'
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

  constructor(
    private readonly db: LibraryDatabase,
    private readonly index: FrameSearchIndex,
    private readonly getSettings: () => AppSettings,
    private readonly emit: EventEmitter
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

  onFileUpsert(filePath: string, folderId: number | null): void {
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

  onFileRemoved(filePath: string): void {
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

  onDirectoryRemoved(dirPath: string): void {
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
      this.db.setVideoStatus(video.id, 'pending')
      this.enqueue(video.id, video.path, true)
      count++
    }
    return count
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
      this.db.upsertVideo({
        path: video.path,
        size: st.size,
        mtimeMs: st.mtimeMs,
        duration,
        width,
        height,
        videoCodec: codec,
        folderId: video.folderId
      })
    }

    const timestamps = planTimestamps(duration, settings.framesPerVideo)
    const frames = await extractAndHash(video.path, timestamps, settings, duration)
    const thumbTime = duration ? duration * 0.12 : (timestamps[0] ?? 0)
    const thumbnail = await makeThumbnail(video.path, thumbTime, t)
    this.db.replaceFrames(videoId, frames, thumbnail)
    log(`索引完成：${video.path}（${frames.length} 帧）`)

    this.scheduleIndexRebuild()
    const updated = this.db.getVideo(videoId)
    if (updated) this.emit({ type: 'video-updated', video: updated })
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
