/**
 * 每帧的紧凑指纹布局，用于常驻内存的高速比对。
 *
 * 内存布局：
 *   0   : 8 字节  64bit dHash（搜索时先比它做剪枝）
 *   8   : 128 字节 1024bit 均值归一化结构指纹
 *   136 : 64 字节 颜色直方图（4x4x4 RGB 分桶，量化为 u8）
 *   200 : 48 字节 空间颜色布局（4x4 网格每格 RGB 均值，u8）
 *   248 : 4 字节  frameIndex (u32)
 *   252 : 4 字节  timeMs (u32)
 * 合计 256 字节/帧 —— 10 万帧约 26MB，可以整块常驻内存。
 */
export const DHASH_OFFSET = 0
export const DHASH_BYTES = 8
export const STRUCT_OFFSET = DHASH_OFFSET + DHASH_BYTES
export const STRUCT_BYTES = 128
export const COLOR_OFFSET = STRUCT_OFFSET + STRUCT_BYTES
export const COLOR_BYTES = 64
export const SPATIAL_OFFSET = COLOR_OFFSET + COLOR_BYTES
export const SPATIAL_BYTES = 48
export const META_OFFSET = SPATIAL_OFFSET + SPATIAL_BYTES
export const FRAME_STRIDE = META_OFFSET + 8

/**
 * 帧指纹格式版本。**任何**布局/尺寸变更（增删字段、改字节数）都必须 +1：
 * 库启动时对比 SQLite 的 user_version，落后即清空 frames 并标记全部视频
 * 待重索引（resumePending 会自动重抽）。旧指纹与新布局不兼容，不能留着。
 */
export const FRAME_FORMAT_VERSION = 3

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

/**
 * 空间颜色布局相似度（0~1）：48 字节（16 格 × RGB）的归一化 L1 距离。
 * 与直方图相交相似度互补 —— 直方图判"颜色组成"，这里判"颜色摆在哪"。
 */
export function spatialSimilarity(a: Uint8Array, b: Uint8Array, bOffset = 0): number {
  let diff = 0
  for (let i = 0; i < SPATIAL_BYTES; i++) {
    const d = a[i] - b[bOffset + i]
    diff += d < 0 ? -d : d
  }
  return Math.max(0, 1 - diff / (SPATIAL_BYTES * 255))
}
