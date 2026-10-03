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
import { existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { isVideoFile, normalizePath, pathKeyOf, type AppSettings, type LibraryEvent } from '@shared/types'
import { computeSignature, type ImageDataLike } from '@shared/hash'
import { extractFrames, requireTools, run, shouldUseFullScan, type ToolPaths } from './media'
import { quantizeColor } from '@shared/framepack'
import type { NewFrame } from './db'

export type EventEmitter = (event: LibraryEvent) => void

/** 抽帧统一缩放到该宽度，兼顾速度与结构辨识度 */
const EXTRACT_WIDTH = 320

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
 * - 少量帧走 extractAndHashBySeek：每个时间点拆成一个 `-ss/-i` 输入，再为每个输入
 *   各写一路 `pipe:1` 输出。ffmpeg 按输出顺序把各帧依次写进同一管道，stdout 就是
 *   N 段等长的裸像素；各帧同源同 scale 滤镜故尺寸一致，用「总字节数 / 时间点数」
 *   即可还原单帧尺寸，无需解析 ffmpeg 日志。成本约 25 ms/帧，与时长无关。
 * - 大量帧走 extractAndHashByFullScan：单次全片解码 + fps 采样，成本与帧数无关。
 *
 * 哈希与查询图共用 @shared/hash 的同一份实现，保证口径一致。
 */
export async function extractAndHash(
  filePath: string,
  timestamps: number[],
  settings: AppSettings,
  durationSeconds?: number | null
): Promise<NewFrame[]> {
  if (timestamps.length === 0) return []

  // 帧数越过成本交叉点后，改用"单次全片解码 + fps 采样"：
  // 逐点 seek 约 25 ms/帧（与时长无关），全片解码约等于该时长的解码时间（与帧数无关），
  // 实测 600 秒视频在约 55 帧处交叉。帧数上限提到 240 后，逐点 seek 会成为主要开销。
  //
  // 注：当前两条路径都固定用 EXTRACT_WIDTH 缩放，settings 暂未参与抽帧决策；
  // 参数保留以便后续设置（如缩放宽度、抽帧模式）演进时不必改所有调用点。
  void settings
  if (shouldUseFullScan(timestamps.length)) {
    return extractAndHashByFullScan(filePath, timestamps, durationSeconds ?? null)
  }
  return extractAndHashBySeek(filePath, timestamps)
}

/**
 * 路径 A：逐点 seek。每个时间点一个 `-ss/-i` 输入，成本约 25 ms/帧，与时长无关。
 * 帧数较少时优于全片解码（无需从头解一遍）。
 */
async function extractAndHashBySeek(filePath: string, timestamps: number[]): Promise<NewFrame[]> {
  const t = tools()

  const args: string[] = ['-hide_banner', '-v', 'error', '-nostdin']
  for (const ts of timestamps) {
    args.push('-ss', ts.toFixed(3), '-i', filePath)
  }
  for (let i = 0; i < timestamps.length; i++) {
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

  const { code, stdout, stderr } = await run(t.ffmpeg, args, { timeoutMs: 10 * 60_000 })
  const count = timestamps.length
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

  const frames: NewFrame[] = []
  for (let i = 0; i < count; i++) {
    const rgb = stdout.subarray(i * frameSize, (i + 1) * frameSize)
    const image: ImageDataLike = { width: EXTRACT_WIDTH, height, channels: 3, order: 'rgb', data: rgb }
    const sig = computeSignature(image)
    frames.push({
      dhash: sig.dhash,
      struct: sig.struct,
      color: quantizeColor(sig.color),
      frameIndex: i,
      timeMs: Math.round(timestamps[i] * 1000)
    })
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
  durationSeconds: number | null
): Promise<NewFrame[]> {
  const extracted = await extractFrames(filePath, timestamps, tools(), {
    maxWidth: EXTRACT_WIDTH,
    durationSeconds: durationSeconds ?? undefined
  })
  if (extracted.length === 0) {
    throw new Error('抽帧失败：全片解码未取到任何画面')
  }

  const frames: NewFrame[] = []
  for (let i = 0; i < extracted.length; i++) {
    const { rgb, width, height, time } = extracted[i]
    const image: ImageDataLike = { width, height, channels: 3, order: 'rgb', data: rgb }
    const sig = computeSignature(image)
    frames.push({
      dhash: sig.dhash,
      struct: sig.struct,
      color: quantizeColor(sig.color),
      frameIndex: i,
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

const DEFAULT_SKIP_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'node_modules',
  '.git',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'appdata'
])

const MAX_SCAN_DEPTH = 24

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

/** 判断 dir 是否位于 root 之内（含自身） */
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

export function videoName(filePath: string): string {
  return basename(filePath, extname(filePath))
}

export { existsSync, normalizePath }
