/**
 * 内存帧索引 + 搜索打分。
 *
 * 帧指纹（8 字节 dHash + 64 字节结构 + 64 字节颜色 + 8 字节元信息）全量常驻内存，
 * 图片搜索 = 纯内存扫描：先用 64bit dHash 剪枝，再做 512bit 结构距离与颜色相交。
 *
 * 打分公式（内联于 search()，颜色权重上下界见 @shared/hash 的 COLOR_WEIGHT_MIN/MAX）：
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
import { temporalSupport } from './aggregate'
import { DHASH_PRUNE_BITS, STRUCT_PRUNE_BITS, TEMPORAL_WINDOW_SECONDS } from './constants'
import {
  COLOR_WEIGHT_MAX,
  COLOR_WEIGHT_MIN,
  computeSignature,
  type ImageDataLike
} from '@shared/hash'

const STRUCT_BITS = STRUCT_BYTES * 8
/** 视频级聚合保留的命中帧数（top-K）：足够捕获时间上贴近最佳帧的次强命中 */
const TOP_K = 4

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

/** 单个视频内的一帧命中（搜索聚合用），按 score 降序保留 top-K */
interface VideoHit {
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
  /** 小端 u32 视图：dHash/结构距离热循环直接索引（FRAME_STRIDE 与各偏移均 4 字节对齐） */
  private words: Uint32Array | null = null

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
    this.words = new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength >> 2)
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
   * 某视频的代表帧查询向量：取该视频在索引中**时间居中**的那一帧。
   *
   * 查重场景下没有外部查询图，只能拿库内自己的帧当查询 —— 中点帧是最具
   * 代表性的单帧选择（片头/片尾黑屏、水印帧都避开了一半以上）。
   * 该视频没有任何帧时返回 null。
   */
  videoQueryVector(videoId: number): QueryVector | null {
    return this.videoFrameVectors(videoId, 1)[0] ?? null
  }

  /**
   * 某视频的均匀采样帧向量（最多 maxCount 个，覆盖该视频在索引中的整个区间）。
   * 用于查重的深度验证：单帧代表会受画面偶然性影响，多帧覆盖率才是
   * "两个视频是否同一内容"的可靠判据。
   */
  videoFrameVectors(videoId: number, maxCount: number): QueryVector[] {
    const view = this.view
    const count = this.videoIds.length
    if (!view || count === 0 || maxCount < 1) return []
    let first = -1
    let last = -1
    for (let i = 0; i < count; i++) {
      if (this.videoIds[i] === videoId) {
        if (first < 0) first = i
        last = i
      }
    }
    if (first < 0) return []
    const span = last - first + 1
    const n = Math.min(maxCount, span)
    const vectors: QueryVector[] = []
    for (let k = 0; k < n; k++) {
      // 均匀取采样位（含首尾），中点帧是其中之一
      const mid = first + Math.round((k * (span - 1)) / Math.max(1, n - 1))
      const off = mid * FRAME_STRIDE
      const color = this.buffer.subarray(off + COLOR_OFFSET, off + COLOR_OFFSET + 64)
      const dLo = view.getUint32(off + DHASH_OFFSET, true)
      const dHi = view.getUint32(off + DHASH_OFFSET + 4, true)
      vectors.push({
        dhash: dHi * 0x100000000 + dLo,
        struct: this.buffer.subarray(off + STRUCT_OFFSET, off + STRUCT_OFFSET + STRUCT_BYTES),
        color: color,
        colorfulness: quantizedColorfulness(color)
      })
    }
    return vectors
  }

  /**
   * 视频级结果：
   * score = 最佳帧(0.75) + 时间一致性支持度(0.25)。次佳帧不再取「全局次佳」
   * （可在任意时间点），而是取「时间上贴近最佳帧」的次强命中（见 aggregate.ts），
   * 避免散落整片时间轴的偶然命中抬高无关视频。
   */
  search(query: QueryVector, options: SearchOptions): { results: IndexedHit[]; comparedFrames: number } {
    const view = this.view
    const words = this.words
    const count = this.videoIds.length
    if (!view || !words || count === 0) return { results: [], comparedFrames: 0 }

    const weight =
      COLOR_WEIGHT_MIN + (COLOR_WEIGHT_MAX - COLOR_WEIGHT_MIN) * Math.min(1, Math.max(0, query.colorfulness))
    const structWeight = 1 - weight
    const qDhashHi = Number(BigInt.asUintN(32, BigInt(query.dhash) >> BigInt(32))) >>> 0
    const qDhashLo = Number(BigInt.asUintN(32, BigInt(query.dhash))) >>> 0
    const qStruct = query.struct
    const qColor = query.color
    // 查询结构指纹转 u32（query 的 byteOffset 均为 4 的倍数：新建数组或
    // buffer 内 144*idx+8 的 subarray），与小端写入的库侧指纹逐字比较
    const qS32 = new Uint32Array(qStruct.buffer, qStruct.byteOffset, STRUCT_BYTES >> 2)
    const minHash = options.minHashScore
    const best = new Map<number, VideoHit[]>()

    for (let i = 0; i < count; i++) {
      const w = (i * FRAME_STRIDE) >> 2
      const dLo = words[w]
      const dHi = words[w + 1]
      const distD = popcount((qDhashLo ^ dLo) >>> 0) + popcount((qDhashHi ^ dHi) >>> 0)
      if (distD > DHASH_PRUNE_BITS) continue

      const sBase = w + (STRUCT_OFFSET >> 2)
      let structDistance = 0
      for (let j = 0; j < STRUCT_BYTES >> 2; j++) structDistance += popcount((qS32[j] ^ words[sBase + j]) >>> 0)
      if (structDistance > STRUCT_PRUNE_BITS) continue

      const hashScore = 1 - structDistance / STRUCT_BITS
      if (hashScore < minHash) continue

      const off = i * FRAME_STRIDE
      const colorScore = quantizedHistogramSimilarity(qColor, this.buffer, off + COLOR_OFFSET)
      const score = hashScore * structWeight + colorScore * weight

      const videoId = this.videoIds[i]
      const frameIndex = view.getUint32(off + META_OFFSET, true)
      const timeSeconds = view.getUint32(off + META_OFFSET + 4, true) / 1000
      let hits = best.get(videoId)
      if (!hits) {
        hits = []
        best.set(videoId, hits)
      }
      // 按 score 降序插入，只保留 top-K，供时间一致性聚合
      let pos = hits.length
      for (let j = 0; j < hits.length; j++) {
        if (score > hits[j].score) { pos = j; break }
      }
      hits.splice(pos, 0, { frameIndex, timeSeconds, score, hashScore, colorScore, hashDistance: structDistance })
      if (hits.length > TOP_K) hits.pop()
    }

    const results = [...best.entries()]
      .map(([videoId, hits]) => {
        const b = hits[0]
        const support = temporalSupport(hits, TEMPORAL_WINDOW_SECONDS)
        return {
          videoId,
          frameIndex: b.frameIndex,
          timeSeconds: b.timeSeconds,
          score: b.score * 0.75 + support * 0.25,
          hashScore: b.hashScore,
          colorScore: b.colorScore,
          hashDistance: b.hashDistance
        }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, options.maxResults)

    return { results, comparedFrames: count }
  }
}

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >>> 24
}
