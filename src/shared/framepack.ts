/**
 * 每帧的紧凑指纹布局，用于常驻内存的高速比对。
 *
 * 内存布局：
 *   0   : 8 字节  64bit dHash（搜索时先比它做剪枝）
 *   8   : 64 字节 512bit 均值归一化结构指纹
 *   72  : 64 字节 颜色直方图（4x4x4 RGB 分桶，量化为 u8）
 *   136 : 4 字节  frameIndex (u32)
 *   140 : 4 字节  timeMs (u32)
 * 合计 144 字节/帧 —— 10 万帧约 14MB，可以整块常驻内存。
 */
export const DHASH_OFFSET = 0
export const DHASH_BYTES = 8
export const STRUCT_OFFSET = DHASH_OFFSET + DHASH_BYTES
export const STRUCT_BYTES = 64
export const COLOR_OFFSET = STRUCT_OFFSET + STRUCT_BYTES
export const COLOR_BYTES = 64
export const META_OFFSET = COLOR_OFFSET + COLOR_BYTES
export const FRAME_STRIDE = META_OFFSET + 8

export interface PackedFrameRow {
  /** 64bit dHash */
  dhash: number
  /** 64 字节结构指纹 */
  struct: Uint8Array
  /** 64 字节量化颜色直方图 */
  color: Uint8Array
  frameIndex: number
  timeMs: number
}

export function packFrame(row: PackedFrameRow): Buffer {
  const buf = Buffer.allocUnsafe(FRAME_STRIDE)
  buf.writeBigUInt64LE(BigInt.asUintN(64, BigInt(row.dhash)), DHASH_OFFSET)
  buf.set(row.struct.subarray(0, STRUCT_BYTES), STRUCT_OFFSET)
  buf.set(row.color.subarray(0, COLOR_BYTES), COLOR_OFFSET)
  buf.writeUInt32LE(row.frameIndex >>> 0, META_OFFSET)
  buf.writeUInt32LE(Math.max(0, Math.round(row.timeMs)) >>> 0, META_OFFSET + 4)
  return buf
}

export function unpackFrame(buf: Uint8Array | Buffer): PackedFrameRow {
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  return {
    dhash: Number(view.readBigUInt64LE(DHASH_OFFSET)),
    struct: new Uint8Array(view.subarray(STRUCT_OFFSET, STRUCT_OFFSET + STRUCT_BYTES)),
    color: new Uint8Array(view.subarray(COLOR_OFFSET, COLOR_OFFSET + COLOR_BYTES)),
    frameIndex: view.readUInt32LE(META_OFFSET),
    timeMs: view.readUInt32LE(META_OFFSET + 4)
  }
}

/**
 * Float32 颜色直方图（和为 1）→ u8 量化。
 * 统一按 255 直接取整：直方图本身已归一化，弱分桶同样保留信息，
 * 量化误差有界（≤1/255），对相交相似度的影响可忽略。
 */
export function quantizeColor(hist: Float32Array): Uint8Array {
  const out = new Uint8Array(COLOR_BYTES)
  for (let i = 0; i < COLOR_BYTES; i++) {
    const v = Math.round(hist[i] * 255)
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v
  }
  return out
}

export function dequantizeColor(q: Uint8Array): Float32Array {
  const out = new Float32Array(COLOR_BYTES)
  let sum = 0
  for (let i = 0; i < COLOR_BYTES; i++) {
    out[i] = q[i] / 255
    sum += out[i]
  }
  if (sum > 0) for (let i = 0; i < COLOR_BYTES; i++) out[i] /= sum
  return out
}

/** 量化后的直方图相交相似度，避免搜索时还原 Float32 */
export function quantizedHistogramSimilarity(a: Uint8Array, b: Uint8Array, bOffset = 0): number {
  let sum = 0
  for (let i = 0; i < COLOR_BYTES; i++) {
    const bv = b[bOffset + i]
    sum += a[i] < bv ? a[i] : bv
  }
  return Math.min(1, sum / 255)
}

/** 从量化直方图推断颜色鲜明度（主导分桶占比） */
export function quantizedColorfulness(color: Uint8Array): number {
  let max = 0
  for (let i = 0; i < COLOR_BYTES; i++) if (color[i] > max) max = color[i]
  return max / 255
}
