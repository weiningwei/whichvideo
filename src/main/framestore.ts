/**
 * 帧指纹的二进制存储格式。
 *
 * db.ts 负责 SQL CRUD；这里负责「一帧指纹 ↔ 80 字节 BLOB / 连续内存矩阵」的
 * 序列化口径，写路径（u64ToLe）与检索读路径（buildFrameMatrix）共用同一套偏移。
 *
 * 布局由 @shared/framepack 定义：dhash(8B) + struct(64B) + color(64B) + meta(8B)。
 * 这里不持任何 SQLite 状态，所有函数显式接收 db 句柄，避免再引入模块级可变状态。
 */
import type { Database as SqliteDatabase } from 'better-sqlite3'
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

/** frames 表一行的原始读出形状 */
export interface RawFrameRow {
  video_id: number
  dhash: Buffer
  struct: Buffer
  color: Buffer
  frame_index: number
  time_ms: number
}

/** 全量/批量读入内存的帧矩阵：一块连续 buffer + 与行对齐的 videoIds */
export interface FrameMatrix {
  buffer: Uint8Array<ArrayBufferLike>
  videoIds: Int32Array<ArrayBufferLike>
  count: number
}

/** 64bit dHash → 8 字节小端（帧 BLOB 的写入原语，读路径按 DHASH_BYTES 对齐） */
export function u64ToLe(value: number): Uint8Array {
  const out = new Uint8Array(8)
  const big = BigInt.asUintN(64, BigInt(value))
  for (let i = 0; i < 8; i++) out[i] = Number(BigInt.asUintN(8, big >> BigInt(8 * i)))
  return out
}

/** 把查询结果按统一 stride 拼成一块连续内存，供搜索时顺序扫描 */
export function buildFrameMatrix(rows: RawFrameRow[]): FrameMatrix {
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

/** 一次性把所有帧指纹读进内存（供搜索全量扫描） */
export function loadFrameMatrix(db: SqliteDatabase): FrameMatrix {
  const rows = db
    .prepare('SELECT video_id, dhash, struct, color, frame_index, time_ms FROM frames')
    .all() as RawFrameRow[]
  return buildFrameMatrix(rows)
}

export function loadFrameMatrixForVideos(db: SqliteDatabase, videoIds: number[]): FrameMatrix {
  if (videoIds.length === 0) {
    return { buffer: new Uint8Array(0), videoIds: new Int32Array(0), count: 0 }
  }
  const placeholders = videoIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT video_id, dhash, struct, color, frame_index, time_ms FROM frames WHERE video_id IN (${placeholders})`
    )
    .all(...videoIds) as RawFrameRow[]
  return buildFrameMatrix(rows)
}

/** 把一帧的量化颜色还原（内置演示/自检用） */
export function exportFrameColor(
  db: SqliteDatabase,
  videoId: number,
  frameIndex: number
): Float32Array | null {
  const row = db
    .prepare('SELECT color FROM frames WHERE video_id = ? AND frame_index = ?')
    .get(videoId, frameIndex) as { color: Buffer } | undefined
  if (!row) return null
  return dequantizeColor(new Uint8Array(row.color.subarray(0, 64)))
}

/** 打包后的帧行数（用于确认索引规模） */
export function frameCount(db: SqliteDatabase): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM frames').get() as { c: number }).c
}
