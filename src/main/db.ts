/**
 * SQLite 索引层。设计目标：上万视频 / 数十万帧仍然秒开。
 *
 * - videos 表只存元数据（单行 1KB 以内）
 * - frames 表把每帧指纹打包成 80 字节 BLOB，一次全量读入内存即可完成检索
 * - settings / image_folders 保存用户配置与被监听的文件夹
 */
import { mkdirSync } from 'node:fs'
import { dirname, basename, extname } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import {
  DEFAULT_SETTINGS,
  normalizePath,
  pathKeyOf,
  type AppSettings,
  type FolderWatchState,
  type LibraryStats,
  type VideoQuery,
  type VideoRecord,
  type VideoStatus,
  type WatchedFolder
} from '@shared/types'
import {
  COLOR_BYTES,
  COLOR_OFFSET,
  DHASH_BYTES,
  DHASH_OFFSET,
  FRAME_STRIDE,
  META_OFFSET,
  STRUCT_BYTES,
  STRUCT_OFFSET,
  dequantizeColor
} from '@shared/framepack'

export interface NewFrame {
  /** 64bit dHash */
  dhash: number
  /** 64 字节结构指纹 */
  struct: Uint8Array
  /** 64 字节量化颜色直方图 */
  color: Uint8Array
  frameIndex: number
  timeMs: number
}

export interface NewVideo {
  path: string
  size: number
  mtimeMs: number
  duration: number | null
  width: number | null
  height: number | null
  videoCodec: string | null
  folderId: number | null
}

interface VideoRow {
  id: number
  path: string
  path_key: string
  name: string
  dir: string
  ext: string
  size: number
  mtime_ms: number
  duration: number | null
  width: number | null
  height: number | null
  video_codec: string | null
  frame_count: number
  status: string
  error: string | null
  added_at: number
  indexed_at: number | null
  folder_id: number | null
  processed_timestamps: string
  processed_ms: number
}

interface FolderRow {
  id: number
  path: string
  path_key: string
  name: string
  pinned: number
  enabled: number
  recursive: number
  watch_state: string
  message: string | null
  added_at: number
  last_scan_at: number | null
}

function rowToVideo(r: VideoRow): VideoRecord {
  let processedTimestamps: number[] = []
  try {
    processedTimestamps = r.processed_timestamps ? JSON.parse(r.processed_timestamps) : []
  } catch {
    processedTimestamps = []
  }
  return {
    id: r.id,
    path: r.path,
    pathKey: r.path_key,
    name: r.name,
    dir: r.dir,
    ext: r.ext,
    size: r.size,
    mtimeMs: r.mtime_ms,
    duration: r.duration,
    width: r.width,
    height: r.height,
    videoCodec: r.video_codec,
    frameCount: r.frame_count,
    status: r.status as VideoStatus,
    error: r.error,
    addedAt: r.added_at,
    indexedAt: r.indexed_at,
    folderId: r.folder_id,
    processedTimestamps,
    processedMs: r.processed_ms
  }
}

function rowToFolder(r: FolderRow): WatchedFolder {
  return {
    id: r.id,
    path: r.path,
    pathKey: r.path_key,
    name: r.name,
    pinned: !!r.pinned,
    enabled: !!r.enabled,
    recursive: !!r.recursive,
    watchState: r.watch_state as FolderWatchState,
    message: r.message,
    addedAt: r.added_at,
    lastScanAt: r.last_scan_at
  }
}

export class LibraryDatabase {
  readonly db: SqliteDatabase
  private readonly insertFrameStmt: BetterSqlite3.Statement

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new BetterSqlite3(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
    this.insertFrameStmt = this.db.prepare(
      `INSERT OR REPLACE INTO frames (video_id, frame_index, time_ms, dhash, struct, color)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM videos WHERE id = ?)`
    )
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        path_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        dir TEXT NOT NULL,
        ext TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        duration REAL,
        width INTEGER,
        height INTEGER,
        video_codec TEXT,
        frame_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        added_at INTEGER NOT NULL,
        indexed_at INTEGER,
        folder_id INTEGER REFERENCES image_folders(id) ON DELETE SET NULL,
        thumbnail BLOB,
        processed_timestamps TEXT NOT NULL DEFAULT '[]',
        processed_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
      CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(folder_id);
      CREATE INDEX IF NOT EXISTS idx_videos_name ON videos(name);
      CREATE INDEX IF NOT EXISTS idx_videos_dir ON videos(dir);

      CREATE TABLE IF NOT EXISTS frames (
        video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        frame_index INTEGER NOT NULL,
        time_ms INTEGER NOT NULL,
        dhash BLOB NOT NULL,
        struct BLOB NOT NULL,
        color BLOB NOT NULL,
        PRIMARY KEY (video_id, frame_index)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS image_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        path_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        recursive INTEGER NOT NULL DEFAULT 1,
        watch_state TEXT NOT NULL DEFAULT 'idle',
        message TEXT,
        added_at INTEGER NOT NULL,
        last_scan_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    // 迁移：旧库没有 processed_timestamps 列
    try {
      this.db.exec(`ALTER TABLE videos ADD COLUMN processed_timestamps TEXT NOT NULL DEFAULT '[]'`)
    } catch {
      /* 列已存在 */
    }
    // 迁移：旧库没有 processed_ms 列
    try {
      this.db.exec(`ALTER TABLE videos ADD COLUMN processed_ms INTEGER NOT NULL DEFAULT 0`)
    } catch {
      /* 列已存在 */
    }
  }

  close(): void {
    this.db.close()
  }

  /* ---------------------------- 设置 ---------------------------- */

  getSettings(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as {
      key: string
      value: string
    }[]
    const merged: AppSettings = { ...DEFAULT_SETTINGS }
    for (const row of rows) {
      if (!(row.key in merged)) continue
      try {
        const parsed = JSON.parse(row.value)
        if (typeof parsed === typeof merged[row.key as keyof AppSettings]) {
          ;(merged as unknown as Record<string, unknown>)[row.key] = parsed
        }
      } catch {
        /* 忽略损坏的配置项 */
      }
    }
    return merged
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    const tx = this.db.transaction((entries: [string, unknown][]) => {
      for (const [key, value] of entries) stmt.run(key, JSON.stringify(value))
    })
    tx(Object.entries(patch))
    return this.getSettings()
  }

  /* ---------------------------- 文件夹 ---------------------------- */

  listFolders(): WatchedFolder[] {
    const rows = this.db
      .prepare('SELECT * FROM image_folders ORDER BY pinned DESC, added_at ASC')
      .all() as FolderRow[]
    return rows.map(rowToFolder)
  }

  findFolderByPath(dirPath: string): WatchedFolder | null {
    const row = this.db
      .prepare('SELECT * FROM image_folders WHERE path_key = ?')
      .get(pathKeyOf(dirPath)) as FolderRow | undefined
    return row ? rowToFolder(row) : null
  }

  upsertFolder(
    dirPath: string,
    options: { pinned?: boolean; recursive?: boolean; enabled?: boolean } = {}
  ): WatchedFolder {
    const normalized = normalizePath(dirPath)
    const existing = this.findFolderByPath(normalized)
    if (existing) {
      if (options.pinned) {
        this.db.prepare('UPDATE image_folders SET pinned = 1 WHERE id = ?').run(existing.id)
      }
      return this.getFolder(existing.id)!
    }
    const info = this.db
      .prepare(
        `INSERT INTO image_folders (path, path_key, name, pinned, enabled, recursive, watch_state, added_at)
         VALUES (?, ?, ?, ?, ?, ?, 'idle', ?)`
      )
      .run(
        normalized,
        pathKeyOf(normalized),
        basename(normalized) || normalized,
        options.pinned ? 1 : 0,
        options.enabled === false ? 0 : 1,
        options.recursive === false ? 0 : 1,
        Date.now()
      )
    return this.getFolder(Number(info.lastInsertRowid))!
  }

  getFolder(id: number): WatchedFolder | null {
    const row = this.db.prepare('SELECT * FROM image_folders WHERE id = ?').get(id) as
      | FolderRow
      | undefined
    return row ? rowToFolder(row) : null
  }

  updateFolderState(id: number, state: FolderWatchState, message: string | null = null): void {
    this.db
      .prepare('UPDATE image_folders SET watch_state = ?, message = ? WHERE id = ?')
      .run(state, message, id)
  }

  setFolderEnabled(id: number, enabled: boolean): void {
    this.db.prepare('UPDATE image_folders SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  markFolderScanned(id: number): void {
    this.db.prepare('UPDATE image_folders SET last_scan_at = ? WHERE id = ?').run(Date.now(), id)
  }

  /** 删除文件夹记录；pinned 的目录默认保留，避免误删用户手动添加的目录 */
  removeFolder(id: number, includePinned = true): boolean {
    const folder = this.getFolder(id)
    if (!folder) return false
    if (folder.pinned && !includePinned) return false
    this.db.prepare('DELETE FROM image_folders WHERE id = ?').run(id)
    return true
  }

  /** 清理没有任何视频、且非用户固定的文件夹记录 */
  pruneEmptyFolders(): number {
    const info = this.db
      .prepare(
        `DELETE FROM image_folders
         WHERE pinned = 0
           AND id NOT IN (SELECT DISTINCT folder_id FROM videos WHERE folder_id IS NOT NULL)`
      )
      .run()
    return info.changes
  }

  /** 找出所有等于/位于 rootPath 之下的文件夹记录 */
  foldersUnder(rootPath: string): WatchedFolder[] {
    const key = pathKeyOf(rootPath)
    const rows = this.db.prepare('SELECT * FROM image_folders').all() as FolderRow[]
    return rows
      .filter((r) => r.path_key === key || r.path_key.startsWith(key + '\\'))
      .map(rowToFolder)
  }

  /* ---------------------------- 视频 ---------------------------- */

  findByPath(filePath: string): VideoRecord | null {
    const row = this.db.prepare('SELECT * FROM videos WHERE path_key = ?').get(pathKeyOf(filePath)) as
      | VideoRow
      | undefined
    return row ? rowToVideo(row) : null
  }

  getVideo(id: number): VideoRecord | null {
    const row = this.db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as VideoRow | undefined
    return row ? rowToVideo(row) : null
  }

  /** 返回 null 表示已存在且无需重建（size/mtime 未变） */
  upsertVideo(input: NewVideo): { video: VideoRecord; changed: boolean; created: boolean } {
    const normalized = normalizePath(input.path)
    const key = pathKeyOf(normalized)
    const existing = this.db.prepare('SELECT * FROM videos WHERE path_key = ?').get(key) as
      | VideoRow
      | undefined
    const now = Date.now()

    if (!existing) {
      const info = this.db
        .prepare(
          `INSERT INTO videos (path, path_key, name, dir, ext, size, mtime_ms, duration, width, height,
                               video_codec, status, added_at, folder_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          normalized,
          key,
          basename(normalized),
          dirname(normalized),
          extname(normalized).toLowerCase(),
          input.size,
          input.mtimeMs,
          input.duration,
          input.width,
          input.height,
          input.videoCodec,
          now,
          input.folderId
        )
      return { video: this.getVideo(Number(info.lastInsertRowid))!, changed: true, created: true }
    }

    const changed = existing.size !== input.size || existing.mtime_ms !== input.mtimeMs
    this.db
      .prepare(
        `UPDATE videos SET path = ?, name = ?, dir = ?, ext = ?, size = ?, mtime_ms = ?,
                           duration = COALESCE(?, duration), width = COALESCE(?, width),
                           height = COALESCE(?, height), video_codec = COALESCE(?, video_codec),
                           folder_id = COALESCE(?, folder_id),
                           status = CASE WHEN ? = 1 THEN 'pending' ELSE status END,
                           frame_count = CASE WHEN ? = 1 THEN 0 ELSE frame_count END
         WHERE id = ?`
      )
      .run(
        normalized,
        basename(normalized),
        dirname(normalized),
        extname(normalized).toLowerCase(),
        input.size,
        input.mtimeMs,
        input.duration,
        input.width,
        input.height,
        input.videoCodec,
        input.folderId,
        changed ? 1 : 0,
        changed ? 1 : 0,
        existing.id
      )
    if (changed) this.db.prepare('DELETE FROM frames WHERE video_id = ?').run(existing.id)
    return { video: this.getVideo(existing.id)!, changed, created: false }
  }

  setVideoStatus(id: number, status: VideoStatus, error: string | null = null): void {
    this.db
      .prepare('UPDATE videos SET status = ?, error = ? WHERE id = ?')
      .run(status, error, id)
  }

  replaceFrames(videoId: number, frames: NewFrame[], thumbnail: Buffer | null): void {
    const insertMany = this.db.transaction((rows: NewFrame[]) => {
      this.db.prepare('DELETE FROM frames WHERE video_id = ?').run(videoId)
      for (const f of rows) {
        this.insertFrameStmt.run(
          videoId,
          f.frameIndex,
          Math.max(0, Math.round(f.timeMs)),
          Buffer.from(u64ToLe(f.dhash)),
          Buffer.from(f.struct.subarray(0, STRUCT_BYTES)),
          Buffer.from(f.color.subarray(0, COLOR_BYTES)),
          videoId
        )
      }
      this.db
        .prepare(
          `UPDATE videos SET frame_count = ?, status = 'ready', error = NULL, indexed_at = ?,
                             thumbnail = COALESCE(?, thumbnail)
           WHERE id = ?`
        )
        .run(rows.length, Date.now(), thumbnail, videoId)
    })
    insertMany(frames)
  }

  removeVideo(id: number): boolean {
    const info = this.db.prepare('DELETE FROM videos WHERE id = ?').run(id)
    return info.changes > 0
  }

  /** 增量插入帧（不删除已有帧），用于断点续传 */
  upsertFramesIncremental(videoId: number, frames: NewFrame[]): void {
    const insertMany = this.db.transaction((rows: NewFrame[]) => {
      for (const f of rows) {
        this.insertFrameStmt.run(
          videoId,
          f.frameIndex,
          Math.max(0, Math.round(f.timeMs)),
          Buffer.from(u64ToLe(f.dhash)),
          Buffer.from(f.struct.subarray(0, STRUCT_BYTES)),
          Buffer.from(f.color.subarray(0, COLOR_BYTES)),
          videoId
        )
      }
      this.db
        .prepare(
          `UPDATE videos SET frame_count = (SELECT COUNT(*) FROM frames WHERE video_id = ?) WHERE id = ?`
        )
        .run(videoId, videoId)
    })
    insertMany(frames)
  }

  /** 更新已处理的时间点索引（断点续传进度） */
  updateProcessedTimestamps(videoId: number, processedIndices: number[]): void {
    this.db
      .prepare('UPDATE videos SET processed_timestamps = ? WHERE id = ?')
      .run(JSON.stringify(processedIndices), videoId)
  }

  /** 增量累加已处理毫秒数（断点续传用） */
  addProcessedMs(videoId: number, ms: number): void {
    this.db
      .prepare('UPDATE videos SET processed_ms = processed_ms + ? WHERE id = ?')
      .run(ms, videoId)
  }

  removeVideosUnder(rootPath: string): number[] {
    const key = pathKeyOf(rootPath)
    const rows = this.db
      .prepare('SELECT id, path_key FROM videos')
      .all() as { id: number; path_key: string }[]
    const ids = rows
      .filter((r) => r.path_key === key || r.path_key.startsWith(key + '\\'))
      .map((r) => r.id)
    if (ids.length === 0) return []
    const del = this.db.prepare('DELETE FROM videos WHERE id = ?')
    const tx = this.db.transaction((list: number[]) => {
      for (const id of list) del.run(id)
    })
    tx(ids)
    return ids
  }

  listVideos(query: VideoQuery = {}): { total: number; items: VideoRecord[] } {
    const where: string[] = []
    const params: unknown[] = []
    if (query.keyword) {
      where.push('(name LIKE ? OR dir LIKE ?)')
      const like = `%${query.keyword}%`
      params.push(like, like)
    }
    if (query.folderId != null) {
      where.push('folder_id = ?')
      params.push(query.folderId)
    }
    if (query.status && query.status !== 'all') {
      where.push('status = ?')
      params.push(query.status)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const sortMap: Record<string, string> = {
      added: 'added_at',
      name: 'name',
      size: 'size',
      duration: 'COALESCE(duration, 0)'
    }
    const sort = sortMap[query.sort ?? 'added'] ?? 'added_at'
    const order = query.order === 'asc' ? 'ASC' : 'DESC'
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 2000)
    const offset = Math.max(query.offset ?? 0, 0)

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM videos ${whereSql}`).get(...params) as { c: number }
    ).c
    const rows = this.db
      .prepare(`SELECT * FROM videos ${whereSql} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as VideoRow[]
    return { total, items: rows.map(rowToVideo) }
  }

  listPendingVideos(limit = 100000): VideoRecord[] {
    // 'indexing' 必须在列：崩溃/断电/强杀留下的假"索引中"只能靠启动恢复
    // （indexer.resumePending）捞回来。少这一档，重启后状态永远卡在"索引中"。
    const rows = this.db
      .prepare(
        `SELECT * FROM videos WHERE status IN ('pending', 'failed', 'indexing') ORDER BY added_at ASC LIMIT ?`
      )
      .all(limit) as VideoRow[]
    return rows.map(rowToVideo)
  }

  allVideoPaths(): { id: number; path: string; pathKey: string; size: number; mtimeMs: number }[] {
    return this.db.prepare('SELECT id, path, path_key, size, mtime_ms FROM videos').all() as {
      id: number
      path: string
      pathKey: string
      size: number
      mtimeMs: number
    }[]
  }

  stats(): LibraryStats {
    const v = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
                SUM(CASE WHEN status IN ('pending','indexing') THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                COALESCE(SUM(size), 0) AS bytes
         FROM videos`
      )
      .get() as { total: number; ready: number | null; pending: number | null; failed: number | null; bytes: number }
    const f = this.db.prepare('SELECT COUNT(*) AS c FROM frames').get() as { c: number }
    const folders = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
         FROM image_folders`
      )
      .get() as { total: number; enabled: number | null }
    return {
      videos: v.total ?? 0,
      indexedVideos: v.ready ?? 0,
      pendingVideos: v.pending ?? 0,
      failedVideos: v.failed ?? 0,
      frames: f.c ?? 0,
      totalBytes: v.bytes ?? 0,
      folders: folders.total ?? 0,
      watching: folders.enabled ?? 0
    }
  }

  /* ---------------------------- 帧检索 ---------------------------- */

  /**
   * 一次性把所有帧指纹读进内存。上万视频（数十万帧）约几十 MB，
   * 之后每次图片搜索都只是纯内存的汉明距离扫描。
   */
  loadFrameMatrix(): { buffer: Uint8Array<ArrayBufferLike>; videoIds: Int32Array<ArrayBufferLike>; count: number } {
    const rows = this.db
      .prepare('SELECT video_id, dhash, struct, color, frame_index, time_ms FROM frames')
      .all() as RawFrameRow[]
    return buildFrameMatrix(rows)
  }

  loadFrameMatrixForVideos(videoIds: number[]): {
    buffer: Uint8Array<ArrayBufferLike>
    videoIds: Int32Array<ArrayBufferLike>
    count: number
  } {
    if (videoIds.length === 0) {
      return { buffer: new Uint8Array(0), videoIds: new Int32Array(0), count: 0 }
    }
    const placeholders = videoIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT video_id, dhash, struct, color, frame_index, time_ms FROM frames WHERE video_id IN (${placeholders})`
      )
      .all(...videoIds) as RawFrameRow[]
    return buildFrameMatrix(rows)
  }

  getThumbnail(videoId: number): string | null {
    const row = this.db.prepare('SELECT thumbnail FROM videos WHERE id = ?').get(videoId) as
      | { thumbnail: Buffer | null }
      | undefined
    if (!row?.thumbnail) return null
    return `data:image/jpeg;base64,${Buffer.from(row.thumbnail).toString('base64')}`
  }

  /** 更新缩略图并标记为 ready，同时刷新帧数 */
  setReadyWithThumbnail(videoId: number, thumbnail: Buffer | null): void {
    const frameCount = (this.db.prepare('SELECT COUNT(*) AS c FROM frames WHERE video_id = ?').get(videoId) as { c: number }).c
    this.db
      .prepare(
        `UPDATE videos SET frame_count = ?, thumbnail = COALESCE(?, thumbnail), status = 'ready', error = NULL, indexed_at = ? WHERE id = ?`
      )
      .run(frameCount, thumbnail, Date.now(), videoId)
  }

  /** 内置演示/自检用：把一帧的量化颜色还原 */
  exportFrameColor(videoId: number, frameIndex: number): Float32Array | null {
    const row = this.db
      .prepare('SELECT color FROM frames WHERE video_id = ? AND frame_index = ?')
      .get(videoId, frameIndex) as { color: Buffer } | undefined
    if (!row) return null
    return dequantizeColor(new Uint8Array(row.color.subarray(0, 64)))
  }

  /** 打包后的帧行数（用于确认索引规模） */
  frameCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM frames').get() as { c: number }).c
  }
}

interface RawFrameRow {
  video_id: number
  dhash: Buffer
  struct: Buffer
  color: Buffer
  frame_index: number
  time_ms: number
}

export function u64ToLe(value: number): Uint8Array {
  const out = new Uint8Array(8)
  const big = BigInt.asUintN(64, BigInt(value))
  for (let i = 0; i < 8; i++) out[i] = Number(BigInt.asUintN(8, big >> BigInt(8 * i)))
  return out
}

/** 把查询结果按统一 stride 拼成一块连续内存，供搜索时顺序扫描 */
function buildFrameMatrix(rows: RawFrameRow[]): {
  buffer: Uint8Array<ArrayBufferLike>
  videoIds: Int32Array<ArrayBufferLike>
  count: number
} {
  const count = rows.length
  const buffer = new Uint8Array(count * FRAME_STRIDE)
  const videoIds = new Int32Array(count)
  const view = new DataView(buffer.buffer)
  for (let i = 0; i < count; i++) {
    const row = rows[i]
    const off = i * FRAME_STRIDE
    buffer.set(row.dhash.subarray(0, DHASH_BYTES), off + DHASH_OFFSET)
    buffer.set(row.struct.subarray(0, STRUCT_BYTES), off + STRUCT_OFFSET)
    buffer.set(row.color.subarray(0, COLOR_BYTES), off + COLOR_OFFSET)
    view.setUint32(off + META_OFFSET, row.frame_index >>> 0, true)
    view.setUint32(off + META_OFFSET + 4, row.time_ms >>> 0, true)
    videoIds[i] = row.video_id
  }
  return { buffer, videoIds, count }
}
