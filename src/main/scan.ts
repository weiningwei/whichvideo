/**
 * 目录扫描与抽帧：把视频文件变成一组帧指纹。
 *
 * - 扫描阶段串行且轻量（stat + 必要时 ffprobe）
 * - 抽帧用一次 ffmpeg 调用，直接输出 rgb24 到 stdout，收完再逐帧算哈希，
 *   避免落任何临时图片文件
 *
 * 抽帧有两条路径，由帧数是否越过成本交叉点自动选择（见 extractAndHash）：
 *   · 少量帧：每个时间点一个 `-ss` 精确跳转（scan.ts::extractAndHashBySeek）
 *   · 大量帧：单次全片解码 + fps 采样（scan.ts::extractAndHashByFullScan）
 */
import { statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { isVideoFile, pathKeyOf, type AppSettings } from '@shared/types'
import { computeSignature, type ImageDataLike } from '@shared/hash'
import { extractFrames, requireTools, run, shouldUseFullScan, type ToolPaths } from './media'
import { quantizeColor } from '@shared/framepack'
import type { NewFrame } from './db'
import { EXTRACT_WIDTH, MAX_SCAN_DEPTH, DEFAULT_SKIP_DIRS } from './constants'
import { log } from './logger'

let cachedTools: ToolPaths | null = null

export function setTools(tools: ToolPaths): void {
  cachedTools = tools
}

function tools(): ToolPaths {
  return cachedTools ?? requireTools()
}

/* ------------------------------------------------------------------ *
 * 原始帧 → 指纹
 * ------------------------------------------------------------------ */

/**
 * 把视频按给定时间点抽帧并算成指纹，直接输出 rgb24 裸像素到 stdout（不落临时文件）。
 *
 * 两条路径按帧数自动切换（交叉点见 media.ts::SEEK_VS_FULLSCAN_CROSSOVER）：
 *   · 少量帧走 extractAndHashBySeek：每个时间点拆成一个 `-ss/-i` 输入，再为每个输入
 *     各写一路 `pipe:1` 输出。ffmpeg 按输出顺序把各帧依次写进同一管道，stdout 就是
 *     N 段等长的裸像素；各帧同源同 scale 滤镜故尺寸一致，用「总字节数 / 时间点数」
 *     即可还原单帧尺寸，无需解析 ffmpeg 日志。成本约 25 ms/帧，与时长无关。
 *   · 大量帧走 extractAndHashByFullScan：单次全片解码 + fps 采样，成本与帧数无关。
 *
 * 哈希与查询图共用 @shared/hash 的同一份实现，保证口径一致。
 */
export interface ExtractOptions {
  /** 每完成一帧回调 (done, total) */
  onFrame?: (done: number, total: number) => void
  /** 从哪个时间点索引开始处理（断点续传） */
  startIndex?: number
  /**
   * 处理到哪个时间点索引为止（**不含**），缺省到末尾。
   *
   * 调用方（indexer）按批落库，天然要求"只抽我这批"。此前只有 startIndex、
   * 没有上界 —— 逐点 seek 路径 slice(startIndex) 会**一路抽到片尾**：
   * 49 帧的计划被抽成 49 + 17 = 66 帧（第二批把 32~48 又抽一遍），
   * 进度分子随之出现"涨到 100% → 回退到 33 → 再涨到 100%"的假回退。
   */
  endIndex?: number
  /** 视频宽度（用于 4K 判断） */
  width?: number | null
  /** 视频高度（用于 4K 判断） */
  height?: number | null
  /** 强制逐点 seek：场景检测采样的时间点是非均匀的，fps 滤镜无法对齐 */
  forceSeek?: boolean
}

export async function extractAndHash(
  filePath: string,
  timestamps: number[],
  settings: AppSettings,
  durationSeconds?: number | null,
  options?: ExtractOptions
): Promise<NewFrame[]> {
  // settings 参数保留：抽帧模式等设置演进时不必改所有调用点（场景模式的
  // 采样计划在 indexer 里按 settings.samplingMode 生成，forceSeek 随 options 传入）
  void settings
  if (timestamps.length === 0) return []

  // 帧数越过成本交叉点后，改用"单次全片解码 + fps 采样"：
  // 逐点 seek 约 25 ms/帧（与时长无关），全片解码约等于该时长的解码时间（与帧数无关），
  // 实测 600 秒视频在约 55 帧处交叉。帧数上限提到 240 后，逐点 seek 会成为主要开销。
  //
  // 注：当前两条路径都固定用 EXTRACT_WIDTH 缩放，settings 暂未参与抽帧决策；
  // 参数保留以便后续设置（如缩放宽度、抽帧模式）演进时不必改所有调用点。
  // forceSeek：场景检测采样给的是**非均匀**时间点，fps 滤镜的均匀采样
  // 无法对齐 —— 必须逐点 seek 精确命中场景帧。
  if (!options?.forceSeek && shouldUseFullScan(timestamps.length, options?.width, options?.height)) {
    return extractAndHashByFullScan(filePath, timestamps, durationSeconds ?? null, options)
  }
  return extractAndHashBySeek(filePath, timestamps, options)
}

/**
 * 路径 A：逐点 seek。每个时间点一个 `-ss/-i` 输入，成本约 25 ms/帧，与时长无关。
 * 帧数较少时优于全片解码（无需从头解一遍）。
 * 为获得实时进度，按子批次（默认 8 帧）分多次调用 ffmpeg。
 */
async function extractAndHashBySeek(
  filePath: string,
  timestamps: number[],
  options?: ExtractOptions
): Promise<NewFrame[]> {
  const startIndex = options?.startIndex ?? 0
  const endIndex = options?.endIndex ?? timestamps.length
  const targetTimestamps = timestamps.slice(startIndex, endIndex)
  if (targetTimestamps.length === 0) return []

  const t = tools()
  const SUB_BATCH = 4 // 子批次大小：每次 ffmpeg 处理这么多帧，平衡性能与进度实时性（4K 视频减小以更快出进度）

  const frames: NewFrame[] = []
  const totalTimestamps = timestamps.length

  for (let batchStart = 0; batchStart < targetTimestamps.length; batchStart += SUB_BATCH) {
    const batchEnd = Math.min(batchStart + SUB_BATCH, targetTimestamps.length)
    const batchTimestamps = targetTimestamps.slice(batchStart, batchEnd)
    const batchStartTime = Date.now()

    const args: string[] = ['-hide_banner', '-v', 'error', '-nostdin']
    for (const ts of batchTimestamps) {
      args.push('-hwaccel', 'auto', '-ss', ts.toFixed(3), '-i', filePath)
    }
    for (let i = 0; i < batchTimestamps.length; i++) {
      args.push(
        '-map',
        `${i}:v:0`,
        '-frames:v',
        '1',
        '-vf',
        `scale=w=${EXTRACT_WIDTH}:h=-2`,
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        '-an',
        '-sn',
        '-dn',
        'pipe:1'
      )
    }

    log(`[抽帧] seek批次开始: ${filePath}, ${batchStart}-${batchEnd}/${targetTimestamps.length}, timestamps=${batchTimestamps.map(t => t.toFixed(1)).join(',')}`)
    const { code, stdout, stderr } = await run(t.ffmpeg, args, { timeoutMs: 10 * 60_000 })
    log(`[抽帧] seek批次完成: ${filePath}, ${batchStart}-${batchEnd}, 耗时=${Date.now() - batchStartTime}ms, 帧数=${batchTimestamps.length}, code=${code}`)
    const count = batchTimestamps.length
    if (stdout.length === 0) {
      throw new Error(`抽帧失败：${stderr.trim() || `ffmpeg 退出码 ${code}`}`)
    }

    const rowBytes = EXTRACT_WIDTH * 3
    if (stdout.length % count !== 0) {
      throw new Error(
        `抽帧失败：收到 ${stdout.length} 字节，无法均分为 ${count} 帧（部分时间点可能没有可解码画面）`
      )
    }
    const frameSize = stdout.length / count
    if (frameSize <= 0 || frameSize % rowBytes !== 0) {
      throw new Error(`抽帧失败：单帧 ${frameSize} 字节不是 ${EXTRACT_WIDTH} 宽 RGB24 的整数倍`)
    }
    const height = frameSize / rowBytes

    for (let i = 0; i < count; i++) {
      const rgb = stdout.subarray(i * frameSize, (i + 1) * frameSize)
      const image: ImageDataLike = { width: EXTRACT_WIDTH, height, channels: 3, order: 'rgb', data: rgb }
      const sig = computeSignature(image)
      const frameIndex = startIndex + batchStart + i
      frames.push({
        dhash: sig.dhash,
        struct: sig.struct,
        color: quantizeColor(sig.color),
        frameIndex,
        timeMs: Math.round(batchTimestamps[i] * 1000)
      })
      options?.onFrame?.(frameIndex + 1, totalTimestamps)
    }
  }
  return frames
}

/**
 * 路径 B：单次全片解码 + `fps=N/时长` 均匀采样，成本与帧数无关。
 * 帧数较多、或视频很长时优于逐点 seek。
 *
 * 与路径 A 的差别：fps 采样取的是"每 rate 帧一张"，实际落点与传入的 timestamps
 * 未必逐一对齐（尤其时长估计不准时）。但由于 timestamps 本身就是等间隔分布的，
 * 且搜索只按指纹比对、不依赖精确时间点，这个偏差不影响召回与排序；
 * 落点偏差仅体现在 UI 显示的命中时间上（可能有一帧左右的误差）。
 */
async function extractAndHashByFullScan(
  filePath: string,
  timestamps: number[],
  durationSeconds: number | null,
  options?: ExtractOptions
): Promise<NewFrame[]> {
  const startIndex = options?.startIndex ?? 0
  const endIndex = options?.endIndex ?? timestamps.length
  // 注：本路径的 fps 采样是"按帧数在全片均匀取点"，**无法对齐任意子区间** ——
  // 因此调用方（indexer）对全片解码路径不做分批，一次传整份计划（见 indexer
  // 的 batchSize 计算）。这里的 slice 只为兼容显式传入的窗口，语义是"取前
  // N 个位置"。
  const targetTimestamps = timestamps.slice(startIndex, endIndex)
  if (targetTimestamps.length === 0) return []

  const extracted = await extractFrames(filePath, targetTimestamps, tools(), {
    maxWidth: EXTRACT_WIDTH,
    durationSeconds: durationSeconds ?? undefined,
    onFrame: options?.onFrame
      ? (done) => options.onFrame!(startIndex + done, timestamps.length)
      : undefined
  })
  if (extracted.length === 0) {
    throw new Error('抽帧失败：全片解码未取到任何画面')
  }

  const frames: NewFrame[] = []
  for (let i = 0; i < extracted.length; i++) {
    const { rgb, width, height, time } = extracted[i]
    const image: ImageDataLike = { width, height, channels: 3, order: 'rgb', data: rgb }
    const sig = computeSignature(image)
    const frameIndex = startIndex + i
    frames.push({
      dhash: sig.dhash,
      struct: sig.struct,
      color: quantizeColor(sig.color),
      frameIndex,
      timeMs: Math.round(time * 1000)
    })
  }
  return frames
}

/* ------------------------------------------------------------------ *
 * 文件扫描
 * ------------------------------------------------------------------ */

export interface ScanOptions {
  /** 递归子目录 */
  recursive?: boolean
  /** 需要跳过的目录名（如系统目录、回收站） */
  skipDirs?: Set<string>
  signal?: { cancelled: boolean }
}

/** 递归列出目录下的视频文件（相对路径），按需回调节流 */
export async function scanVideoFiles(
  root: string,
  options: ScanOptions = {},
  onFile?: (filePath: string, dir: string) => void | Promise<void>
): Promise<{ files: number; skips: string[] }> {
  const recursive = options.recursive !== false
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS
  let files = 0
  const skips: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (options.signal?.cancelled) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      skips.push(dir)
      return
    }
    for (const entry of entries) {
      if (options.signal?.cancelled) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!recursive || depth >= MAX_SCAN_DEPTH) continue
        if (skipDirs.has(entry.name.toLowerCase())) continue
        await walk(full, depth + 1)
      } else if (entry.isFile() && isVideoFile(entry.name)) {
        files++
        if (onFile) await onFile(full, dir)
      }
    }
  }

  await walk(root, 0)
  return { files, skips }
}

export function statFile(filePath: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return null
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

export function isInside(root: string, dir: string): boolean {
  const r = pathKeyOf(root)
  const d = pathKeyOf(dir)
  return d === r || d.startsWith(r + sep)
}

/** 从根目录到当前目录的相对路径，用于“剧集/目录上下文”展示 */
export function relativeDir(root: string, dir: string): string {
  const rel = relative(root, dir)
  return rel === '' ? '.' : rel.split(sep).join('/')
}
