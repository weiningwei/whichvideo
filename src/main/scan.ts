/**
 * 目录扫描与抽帧：把视频文件变成一组帧指纹。
 *
 * - 扫描阶段串行且轻量（stat + 必要时 ffprobe）
 * - 抽帧用一次 ffmpeg 调用对多个时间点 seek，直接输出 rgb24 到 stdout，
 *   收完再逐帧算哈希，避免落任何临时图片文件
 */
import { existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { isVideoFile, normalizePath, pathKeyOf, type AppSettings, type LibraryEvent } from '@shared/types'
import { computeSignature, type ImageDataLike } from '@shared/hash'
import { requireTools, run, type ToolPaths } from './media'
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
 * 一次 ffmpeg 调用按时间点抽帧，直接输出 rgb24 裸像素到 stdout（不落临时文件）。
 *
 * 每个时间点拆成一个 `-ss/-i` 输入，再为每个输入各写一路 `pipe:1` 输出；
 * ffmpeg 会按输出顺序把各帧依次写进同一个管道，stdout 就是 N 段等长的裸像素。
 * 各帧来自同一个源、同一个 scale 滤镜，尺寸必然一致，因此用
 * 「总字节数 / 时间点数」即可还原单帧尺寸，无需解析 ffmpeg 日志。
 * 哈希与查询图共用 @shared/hash 的同一份实现，保证口径一致。
 */
export async function extractAndHash(
  filePath: string,
  timestamps: number[],
  settings: AppSettings
): Promise<NewFrame[]> {
  void settings
  if (timestamps.length === 0) return []
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
