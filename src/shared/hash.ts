/**
 * 感知哈希（perceptual hash）实现，纯 TypeScript，主进程与渲染端共用。
 *
 * 一张图片被压成三部分指纹：
 *  1. 64bit dHash  —— 9x8 灰度梯度，用于搜索时的快速剪枝
 *  2. 512bit 均值归一化结构指纹 —— 16x16 网格 × Y/R/G/B 四通道。
 *     每个格子的均值与该通道全局均值比较，因此对分辨率、再压缩、亮度轻微变化稳定，
 *     同时又能把"纯色画面"与"有内容的画面"明显区分开（纯色帧的归一化位几乎全为 1，
 *     任何有纹理的画面都会产生大量 0，因此 512bit 距离很大）。
 *  3. 4x4x4 RGB 颜色直方图 —— 负责区分"结构相同但颜色不同"的画面。
 *
 * 实测（见 scripts/bench-score.mjs）：同源截图与视频帧的结构距离为 0，
 * 而不同内容之间结构距离 ≥ 246/512，纯色与彩色之间 ≥ 246/512。
 */

export interface ImageDataLike {
  width: number
  height: number
  /** 每像素通道数：3 = RGB 交错，4 = RGBA/BGRA 交错 */
  channels: 3 | 4
  /** 通道顺序，Electron nativeImage 的 toBitmap() 是 BGRA */
  order?: 'rgb' | 'bgr'
  data: Uint8Array | Buffer
}

export interface FrameSignature {
  /** 64bit dHash */
  dhash: number
  /** 512bit 均值归一化结构指纹（64 字节） */
  struct: Uint8Array
  /** 归一化颜色直方图，元素为 0~1 */
  color: Float32Array
  /** 空间颜色布局：4×4 网格每格 RGB 均值（48 字节，u8），补直方图丢掉的"颜色在哪" */
  spatial: Uint8Array
  /** 画面平均亮度 0~255 */
  luma: number
}

export const COLOR_BINS = 64
export const STRUCT_BYTES = 64
export const DHASH_BYTES = 8
export const SPATIAL_GRID = 4
export const SPATIAL_BYTES = SPATIAL_GRID * SPATIAL_GRID * 3

/** 结构指纹网格：16x16 × 4 通道 = 1024 个格子，每通道等距抽样 128 个共 512 bit */
const STRUCT_GRID = 16
const STRUCT_BITS = STRUCT_BYTES * 8
const CHANNELS_IN_HASH = 4

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** 32bit popcount（仅供 hammingBytes 内部使用） */
function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >>> 24
}

/** 字节数组之间的汉明距离（逐 4 字节展开） */
export function hammingBytes(a: Uint8Array, aOffset: number, b: Uint8Array, bOffset: number, length: number): number {
  let dist = 0
  let i = 0
  for (; i + 4 <= length; i += 4) {
    const av = (a[aOffset + i] | (a[aOffset + i + 1] << 8) | (a[aOffset + i + 2] << 16) | (a[aOffset + i + 3] << 24)) >>> 0
    const bv = (b[bOffset + i] | (b[bOffset + i + 1] << 8) | (b[bOffset + i + 2] << 16) | (b[bOffset + i + 3] << 24)) >>> 0
    dist += popcount32((av ^ bv) >>> 0)
  }
  for (; i < length; i++) {
    dist += popcount32(((a[aOffset + i] ^ b[bOffset + i]) & 0xff) >>> 0)
  }
  return dist
}

/* ------------------------------------------------------------------ *
 * 采样与灰度
 * ------------------------------------------------------------------ */

interface GrayImage {
  w: number
  h: number
  /** 0~255 灰度 */
  g: Float32Array
}

/**
 * 用盒式滤波把源图重采样成 w*h 的灰度图。
 * 盒式平均（而不是最近邻）能显著提升对缩放/截图分辨率变化的鲁棒性。
 */
export function toGray(img: ImageDataLike, w: number, h: number): GrayImage {
  const { width: sw, height: sh, channels, data } = img
  const bgr = img.order === 'bgr'
  const out = new Float32Array(w * h)
  const xRatio = sw / w
  const yRatio = sh / h

  for (let dy = 0; dy < h; dy++) {
    const sy0 = Math.floor(dy * yRatio)
    const sy1 = Math.min(sh, Math.max(sy0 + 1, Math.ceil((dy + 1) * yRatio)))
    for (let dx = 0; dx < w; dx++) {
      const sx0 = Math.floor(dx * xRatio)
      const sx1 = Math.min(sw, Math.max(sx0 + 1, Math.ceil((dx + 1) * xRatio)))
      let sum = 0
      let count = 0
      for (let sy = sy0; sy < sy1; sy++) {
        let idx = (sy * sw + sx0) * channels
        for (let sx = sx0; sx < sx1; sx++) {
          const r = bgr ? data[idx + 2] : data[idx]
          const g = data[idx + 1]
          const b = bgr ? data[idx] : data[idx + 2]
          // BT.601 亮度
          sum += 0.299 * r + 0.587 * g + 0.114 * b
          count++
          idx += channels
        }
      }
      out[dy * w + dx] = count > 0 ? sum / count : 0
    }
  }
  return { w, h, g: out }
}

/* ------------------------------------------------------------------ *
 * dHash：9x8 灰度，比较水平相邻像素
 * ------------------------------------------------------------------ */

export function computeDHash(gray: GrayImage): number {
  const { w, h, g } = gray
  let lo = 0
  let hi = 0
  let bit = 0
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w - 1; x++) {
      const on = g[row + x] < g[row + x + 1] ? 1 : 0
      if (bit < 32) lo |= on << bit
      else hi |= on << (bit - 32)
      bit++
    }
  }
  return (lo >>> 0) * 0x100000000 + (hi >>> 0)
}

/* ------------------------------------------------------------------ *
 * 均值归一化结构指纹
 * ------------------------------------------------------------------ */

/** 计算 size×size 的分块均值网格（块大小尽量均匀覆盖整幅图） */
function cellGrid(
  w: number,
  h: number,
  size: number,
  value: (x: number, y: number) => number
): Float32Array {
  const out = new Float32Array(size * size)
  const xRatio = w / size
  const yRatio = h / size
  for (let j = 0; j < size; j++) {
    const y0 = Math.floor(j * yRatio)
    const y1 = Math.max(y0 + 1, Math.floor((j + 1) * yRatio))
    for (let i = 0; i < size; i++) {
      const x0 = Math.floor(i * xRatio)
      const x1 = Math.max(x0 + 1, Math.floor((i + 1) * xRatio))
      let sum = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += value(x, y)
          n++
        }
      }
      out[j * size + i] = n ? sum / n : 0
    }
  }
  return out
}

/**
 * 把单个通道的分块网格编码成比特：格子均值 ≥ 全局均值 → 1。
 * 纯色画面的格子均值彼此相等，会全部记为 1；有内容的画面则 0/1 混杂，
 * 因此该指纹天然能把"纯色"与"有画面"分开。
 *
 * 网格有 STRUCT_GRID² 个格子（256），但每通道只分配 128 bit，必须**等距抽样**
 * 而不是顺序截取。顺序填满会在 bit 达到 maxBits 时停在网格前半部分
 * （16 行只用到前 8 行），导致画面下半部分完全不参与指纹——字幕条、
 * 下三分之一构图这类内容会因此被系统性低估相似度。
 * 这里按下标 `floor(bit * grid.length / maxBits)` 均匀取样，覆盖全部 16 行。
 */
function encodeChannel(
  grid: Float32Array,
  out: Uint8Array,
  bitOffset: number,
  maxBits: number
): number {
  let sum = 0
  for (let i = 0; i < grid.length; i++) sum += grid[i]
  const mean = grid.length ? sum / grid.length : 0
  const bits = Math.min(maxBits, grid.length)
  for (let bit = 0; bit < bits; bit++) {
    const i = grid.length === bits ? bit : Math.floor((bit * grid.length) / bits)
    if (grid[i] >= mean) {
      const pos = bitOffset + bit
      out[pos >> 3] |= 1 << (pos & 7)
    }
  }
  return bits
}

export function computeStructHash(img: ImageDataLike): Uint8Array {
  const { width: w, height: h, channels, data } = img
  const bgr = img.order === 'bgr'
  const out = new Uint8Array(STRUCT_BYTES)

  const luma = (x: number, y: number): number => {
    const idx = (y * w + x) * channels
    const r = bgr ? data[idx + 2] : data[idx]
    const g = data[idx + 1]
    const b = bgr ? data[idx] : data[idx + 2]
    return 0.299 * r + 0.587 * g + 0.114 * b
  }
  const channel = (c: number) => (x: number, y: number): number => {
    const idx = (y * w + x) * channels
    if (c === 0) return bgr ? data[idx + 2] : data[idx]
    if (c === 1) return data[idx + 1]
    return bgr ? data[idx] : data[idx + 2]
  }

  const perChannel = Math.floor(STRUCT_BITS / CHANNELS_IN_HASH)
  let offset = 0
  offset += encodeChannel(cellGrid(w, h, STRUCT_GRID, luma), out, offset, perChannel)
  for (let c = 0; c < 3; c++) {
    offset += encodeChannel(cellGrid(w, h, STRUCT_GRID, channel(c)), out, offset, perChannel)
  }
  return out
}

/** 512bit 结构相似度（0~1） */
export function structSimilarity(a: Uint8Array, aOffset: number, b: Uint8Array, bOffset: number): number {
  return 1 - hammingBytes(a, aOffset, b, bOffset, STRUCT_BYTES) / STRUCT_BITS
}

/* ------------------------------------------------------------------ *
 * 颜色直方图：4x4x4 RGB 分桶
 * ------------------------------------------------------------------ */

export function computeColorHistogram(img: ImageDataLike): Float32Array {
  const hist = new Float32Array(COLOR_BINS)
  const { width, height, channels, data } = img
  const bgr = img.order === 'bgr'
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 65536)))
  let total = 0
  for (let y = 0; y < height; y += step) {
    let idx = y * width * channels
    for (let x = 0; x < width; x += step) {
      const r = bgr ? data[idx + 2] : data[idx]
      const g = data[idx + 1]
      const b = bgr ? data[idx] : data[idx + 2]
      const bucket = ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)
      hist[bucket] += 1
      total++
      idx += channels * step
    }
  }
  if (total > 0) {
    for (let i = 0; i < COLOR_BINS; i++) hist[i] /= total
  }
  return hist
}

export function meanLuma(gray: GrayImage): number {
  let sum = 0
  for (let i = 0; i < gray.g.length; i++) sum += gray.g[i]
  return gray.g.length ? sum / gray.g.length : 0
}

/* ------------------------------------------------------------------ *
 * 空间颜色布局：4x4 网格每格 RGB 均值
 * ------------------------------------------------------------------ */

/**
 * 把图切成 4×4 网格，记录每格的 R/G/B 均值（各量化为 u8），共 48 字节。
 *
 * 全局颜色直方图只统计"画面里有哪些颜色、各占多少"，完全丢掉"颜色分布在哪"：
 * 上半红下半蓝与上半蓝下半红直方图完全一致，却显然是两幅画面。空间布局描述符
 * 补上这块：直方图负责"颜色组成"，网格均值负责"颜色在空间上的摆法"，二者合起来
 * 才是完整的颜色判据。网格均值用 box 平均（与 cellGrid 同一套），对缩放/再压缩
 * 稳定；绝对值（非均值归一化）——颜色绝对值本就该由颜色通道保留，结构指纹才做
 * 相对归一化。
 */
export function computeSpatialLayout(img: ImageDataLike): Uint8Array {
  const { width: w, height: h, channels, data } = img
  const bgr = img.order === 'bgr'
  const out = new Uint8Array(SPATIAL_BYTES)
  const channel = (c: number) => (x: number, y: number): number => {
    const idx = (y * w + x) * channels
    if (c === 0) return bgr ? data[idx + 2] : data[idx]
    if (c === 1) return data[idx + 1]
    return bgr ? data[idx] : data[idx + 2]
  }
  let o = 0
  for (let c = 0; c < 3; c++) {
    const grid = cellGrid(w, h, SPATIAL_GRID, channel(c))
    for (let i = 0; i < grid.length; i++) {
      const v = grid[i]
      out[o++] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 像素级结构相似度（SSIM）—— 二阶段验证重排用
 * ------------------------------------------------------------------ */

const SSIM_C1 = (0.01 * 255) ** 2
const SSIM_C2 = (0.03 * 255) ** 2

/**
 * 两幅图的像素级相似度（0~1，SSIM）：把双方都重采样成 w×h 灰度后用 8×8 滑窗。
 * 比哈希精确得多、也更贵 —— 只用于 top-K 命中帧的验证重排，不用于全库扫描。
 * 双方分辨率/通道序可不同（内部统一走 toGray 的盒式重采样）。
 */
export function ssimSimilarity(a: ImageDataLike, b: ImageDataLike, w = 48, h = 48): number {
  const ga = toGray(a, w, h).g
  const gb = toGray(b, w, h).g
  const win = 8
  let ssimSum = 0
  let winCount = 0
  for (let wy = 0; wy + win <= h; wy += win) {
    for (let wx = 0; wx + win <= w; wx += win) {
      let ma = 0
      let mb = 0
      for (let y = wy; y < wy + win; y++) {
        const row = y * w
        for (let x = wx; x < wx + win; x++) {
          ma += ga[row + x]
          mb += gb[row + x]
        }
      }
      const n = win * win
      ma /= n
      mb /= n
      let va = 0
      let vb = 0
      let cov = 0
      for (let y = wy; y < wy + win; y++) {
        const row = y * w
        for (let x = wx; x < wx + win; x++) {
          const da = ga[row + x] - ma
          const db = gb[row + x] - mb
          va += da * da
          vb += db * db
          cov += da * db
        }
      }
      const nm1 = n - 1
      va /= nm1
      vb /= nm1
      cov /= nm1
      const num = (2 * ma * mb + SSIM_C1) * (2 * cov + SSIM_C2)
      const den = (ma * ma + mb * mb + SSIM_C1) * (va + vb + SSIM_C2)
      ssimSum += den > 0 ? num / den : 0
      winCount++
    }
  }
  return winCount > 0 ? Math.max(0, ssimSum / winCount) : 0
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/** 计算一帧/一张图的完整指纹 */
export function computeSignature(img: ImageDataLike): FrameSignature {
  const gray98 = toGray(img, 9, 8)
  return {
    dhash: computeDHash(gray98),
    struct: computeStructHash(img),
    color: computeColorHistogram(img),
    spatial: computeSpatialLayout(img),
    luma: meanLuma(gray98)
  }
}

/**
 * 颜色权重上下界：结构分与颜色分加权时，颜色越"鲜明"（画面越接近纯色/少色），
 * 颜色直方图越可信，权重从 COLOR_WEIGHT_MIN 提升到 COLOR_WEIGHT_MAX；反之纹理
 * 丰富时以结构为主。这样纯色截图能稳稳命中同色画面，而不会因为结构指纹退化成
 * 全 1 而误配到彩色画面。
 *
 * 打分公式内联在 src/main/search.ts 的 search()（权重只算一次，不进逐帧热循环）。
 */
export const COLOR_WEIGHT_MIN = 0.3
export const COLOR_WEIGHT_MAX = 0.7
/** 颜色分内部：空间布局相似度占比（直方图相交占 1 - 该值） */
export const SPATIAL_WEIGHT = 0.35
