/**
 * 内存帧索引 + 搜索打分。
 *
 * 帧指纹（8 字节 dHash + 64 字节结构 + 64 字节颜色 + 8 字节元信息）全量常驻内存，
 * 图片搜索 = 纯内存扫描：先用 64bit dHash 剪枝，再做 512bit 结构距离与颜色相交。
 *
 * 打分公式（见 src/shared/hash.ts 的 combinedScore）：
 *   颜色越鲜明的查询图，颜色直方图权重越高（0.3 → 0.7），
 *   因为纯色/少色画面的结构指纹会退化，必须靠颜色区分。
 */
import type { LibraryDatabase } from './db'
import {
  COLOR_OFFSET,
  DHASH_OFFSET,
  FRAME_STRIDE,
  META_OFFSET,
  STRUCT_BYTES,
  STRUCT_OFFSET,
  quantizeColor,
  quantizedColorfulness,
  quantizedHistogramSimilarity
} from '@shared/framepack'
import { DHASH_PRUNE_BITS, STRUCT_PRUNE_BITS } from './constants'
import {
  COLOR_WEIGHT_MAX,
  COLOR_WEIGHT_MIN,
  computeSignature,
  type ImageDataLike
} from '@shared/hash'

const STRUCT_BITS = STRUCT_BYTES * 8

export interface FrameIndexInfo {
  frames: number
  videos: number
  bytes: number
  builtAt: number
}

export interface IndexedHit {
  videoId: number
  frameIndex: number
  timeSeconds: number
  score: number
  hashScore: number
  colorScore: number
  hashDistance: number
}

export interface SearchOptions {
  /** 结构相似度低于该值的帧直接丢弃 */
  minHashScore: number
  /** 返回条数上限 */
  maxResults: number
}

export interface QueryVector {
  dhash: number
  /** 64 字节结构指纹 */
  struct: Uint8Array
  /** 64 字节量化颜色直方图 */
  color: Uint8Array
  /** 颜色鲜明度，决定结构与颜色的权重 */
  colorfulness: number
}

/** 把一张图（Electron nativeImage 的位图或 ffmpeg 的 rgb24）转成查询向量 */
export function queryVectorFromImage(img: ImageDataLike): QueryVector {
  const signature = computeSignature(img)
  const color = quantizeColor(signature.color)
  return {
    dhash: signature.dhash,
    struct: signature.struct,
    color,
    colorfulness: quantizedColorfulness(color)
  }
}

export class FrameSearchIndex {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private videoIds: Int32Array<ArrayBufferLike> = new Int32Array(0)
  private view: DataView | null = null
  private builtAt = 0

  constructor(private readonly db: LibraryDatabase) {
    this.rebuild()
  }

  get frameCount(): number {
    return this.videoIds.length
  }

  get info(): FrameIndexInfo {
    const seen = new Set<number>()
    for (let i = 0; i < this.videoIds.length; i++) seen.add(this.videoIds[i])
    return {
      frames: this.videoIds.length,
      videos: seen.size,
      bytes: this.buffer.byteLength,
      builtAt: this.builtAt
    }
  }

  /** 全量重建（导入 / 删除 / 重索引之后调用） */
  rebuild(): FrameIndexInfo {
    const { buffer, videoIds } = this.db.loadFrameMatrix()
    this.buffer = buffer
    this.videoIds = videoIds
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    this.builtAt = Date.now()
    return this.info
  }

  /** 索引中的所有视频 id（按帧首次出现顺序去重） */
  listVideoIds(): number[] {
    const seen: number[] = []
    const set = new Set<number>()
    for (let i = 0; i < this.videoIds.length; i++) {
      const id = this.videoIds[i]
      if (!set.has(id)) {
        set.add(id)
        seen.push(id)
      }
    }
    return seen
  }

  /**
   * 某视频的"代表帧"查询向量：取该视频在索引中**时间居中**的那一帧。
   *
   * 查重场景下没有外部查询图，只能拿库内自己的帧当查询 —— 中点帧是最具
   * 代表性的单帧选择（片头/片尾黑屏、水印帧都避开了一半以上）。
   * 该视频没有任何帧时返回 null。
   */
  videoQueryVector(videoId: number): QueryVector | null {
    const view = this.view
    const count = this.videoIds.length
    if (!view || count === 0) return null
    let first = -1
    let last = -1
    for (let i = 0; i < count; i++) {
      if (this.videoIds[i] === videoId) {
        if (first < 0) first = i
        last = i
      }
    }
    if (first < 0) return null
    const mid = (first + last) >> 1
    const off = mid * FRAME_STRIDE
    const color = this.buffer.subarray(off + COLOR_OFFSET, off + COLOR_OFFSET + 64)
    // dhash 用与 computeDHash 相同的方式拼回 number（lo 低地址、hi 高地址），
    // 不直接 getBigUint64 —— QueryVector.dhash 是 number，类型与数值语义都要一致
    const dLo = view.getUint32(off + DHASH_OFFSET, true)
    const dHi = view.getUint32(off + DHASH_OFFSET + 4, true)
    return {
      dhash: dHi * 0x100000000 + dLo,
      struct: this.buffer.subarray(off + STRUCT_OFFSET, off + STRUCT_OFFSET + STRUCT_BYTES),
      color: color,
      colorfulness: quantizedColorfulness(color)
    }
  }

  /**
   * 视频级结果：
   * score = 最佳帧(0.75) + 次佳帧(0.25)，避免单帧偶然命中把无关视频排到前面。
   */
  search(query: QueryVector, options: SearchOptions): { results: IndexedHit[]; comparedFrames: number } {
    const view = this.view
    const count = this.videoIds.length
    if (!view || count === 0) return { results: [], comparedFrames: 0 }

    const weight =
      COLOR_WEIGHT_MIN + (COLOR_WEIGHT_MAX - COLOR_WEIGHT_MIN) * Math.min(1, Math.max(0, query.colorfulness))
    const structWeight = 1 - weight
    const qDhashHi = Number(BigInt.asUintN(32, BigInt(query.dhash) >> BigInt(32))) >>> 0
    const qDhashLo = Number(BigInt.asUintN(32, BigInt(query.dhash))) >>> 0
    const qStruct = query.struct
    const qColor = query.color
    const minHash = options.minHashScore
    const best = new Map<number, IndexedHit & { secondBest: number }>()

    for (let i = 0; i < count; i++) {
      const off = i * FRAME_STRIDE
      const dLo = view.getUint32(off + DHASH_OFFSET, true)
      const dHi = view.getUint32(off + DHASH_OFFSET + 4, true)
      const distD = popcount((qDhashLo ^ dLo) >>> 0) + popcount((qDhashHi ^ dHi) >>> 0)
      if (distD > DHASH_PRUNE_BITS) continue

      const structDistance = hammingInBuffer(qStruct, this.buffer, off + STRUCT_OFFSET)
      if (structDistance > STRUCT_PRUNE_BITS) continue

      const hashScore = 1 - structDistance / STRUCT_BITS
      if (hashScore < minHash) continue

      const colorScore = quantizedHistogramSimilarity(qColor, this.buffer, off + COLOR_OFFSET)
      const score = hashScore * structWeight + colorScore * weight

      const videoId = this.videoIds[i]
      const current = best.get(videoId)
      const frameIndex = view.getUint32(off + META_OFFSET, true)
      const timeSeconds = view.getUint32(off + META_OFFSET + 4, true) / 1000
      if (!current) {
        best.set(videoId, {
          videoId,
          frameIndex,
          timeSeconds,
          score,
          hashScore,
          colorScore,
          hashDistance: structDistance,
          secondBest: 0
        })
      } else if (score > current.score) {
        current.secondBest = current.score
        current.frameIndex = frameIndex
        current.timeSeconds = timeSeconds
        current.score = score
        current.hashScore = hashScore
        current.colorScore = colorScore
        current.hashDistance = structDistance
      } else if (score > current.secondBest) {
        current.secondBest = score
      }
    }

    const results = [...best.values()]
      .map((v) => ({
        videoId: v.videoId,
        frameIndex: v.frameIndex,
        timeSeconds: v.timeSeconds,
        score: v.score * 0.75 + v.secondBest * 0.25,
        hashScore: v.hashScore,
        colorScore: v.colorScore,
        hashDistance: v.hashDistance
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.maxResults)

    return { results, comparedFrames: count }
  }
}

function hammingInBuffer(a: Uint8Array, b: Uint8Array, bOffset: number): number {
  let dist = 0
  for (let i = 0; i < STRUCT_BYTES; i += 4) {
    const av = (a[i] | (a[i + 1] << 8) | (a[i + 2] << 16) | (a[i + 3] << 24)) >>> 0
    const bv =
      (b[bOffset + i] |
        (b[bOffset + i + 1] << 8) |
        (b[bOffset + i + 2] << 16) |
        (b[bOffset + i + 3] << 24)) >>>
      0
    dist += popcount((av ^ bv) >>> 0)
  }
  return dist
}

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >>> 24
}
