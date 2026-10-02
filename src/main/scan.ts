/**
 * 目录扫描与抽帧：把视频文件变成一组帧指纹。
 *
 * - 扫描阶段串行且轻量（stat + 必要时 ffprobe）
 * - 抽帧用一次 ffmpeg 调用对多个时间点 seek，直接输出 rgb24 到 stdout，
 *   边收边算哈希，避免落任何临时图片文件
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { isVideoFile, normalizePath, pathKeyOf, type AppSettings, type LibraryEvent } from '@shared/types'
import { computeSignature, type ImageDataLike } from '@shared/hash'
import { requireTools, type ToolPaths } from './media'
import { quantizeColor } from '@shared/framepack'
import type { NewFrame } from './db'

export type EventEmitter = (event: LibraryEvent) => void

/** 抽帧时每帧额外写 12 字节头：'FRM1' + width(u32LE) + height(u32LE) */
const FRAME_HEADER_BYTES = 12
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
 * 单次 ffmpeg 调用按时间点 seek 抽帧，直接输出 rgb24 原始像素到 stdout。
 *
 * 输出流是连续的裸像素（rawvideo 没有分隔符），因此给每帧加 12 字节小头：
 *   'FRM1' + width(u32LE) + height(u32LE) + payload
 * 分辨率从 ffmpeg 的 stderr 里解析（scale 滤镜会打印 "320x180"）。
 * 哈希与查询图共用 @shared/hash 的同一份实现，保证口径一致。
 */
export function extractAndHash(
  filePath: string,
  timestamps: number[],
  settings: AppSettings
): Promise<NewFrame[]> {
  void settings
  const t = tools()
  return new Promise((resolve, reject) => {
    const args: string[] = ['-hide_banner', '-v', 'error', '-nostdin']
    for (const ts of timestamps) {
      args.push('-ss', ts.toFixed(3))
      args.push('-i', filePath)
    }
    args.push(
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-vf',
      `scale=w=${EXTRACT_WIDTH}:h=-2`,
      '-pix_fmt',
      'rgb24',
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-an',
      '-sn',
      '-dn',
      'pipe:1'
    )

    const child = spawn(t.ffmpeg, args, { windowsHide: true })
    let stderr = ''
    let pending: Buffer = Buffer.alloc(0)
    let dimension: { width: number; height: number } | null = null
    const frames: NewFrame[] = []

    /** ffmpeg 在 stderr 上打印缩放后的尺寸，形如 "320x180" */
    const readDimension = (): boolean => {
      if (dimension) return true
      const match = /\b(\d{2,5})x(\d{2,5})\b/.exec(stderr)
      if (!match) return false
      const width = Number(match[1])
      const height = Number(match[2])
      if (!width || !height || width > 4096 || height > 4096) return false
      dimension = { width, height }
      return true
    }

    /** 把累积的字节切成 [header + payload] 的帧块 */
    const drain = (): void => {
      while (true) {
        if (pending.length < FRAME_HEADER_BYTES) return
        if (!readDimension() || !dimension) return
        const payload = dimension.width * dimension.height * 3
        if (pending.length < FRAME_HEADER_BYTES + payload) return

        const width = pending.readUInt32LE(4)
        const height = pending.readUInt32LE(8)
        const rgb = pending.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + payload)
        const image: ImageDataLike = { width, height, channels: 3, order: 'rgb', data: rgb }
        const sig = computeSignature(image)
        const index = frames.length
        frames.push({
          dhash: sig.dhash,
          struct: sig.struct,
          color: quantizeColor(sig.color),
          frameIndex: index,
          timeMs: Math.round((timestamps[index] ?? 0) * 1000)
        })
        pending = pending.subarray(FRAME_HEADER_BYTES + payload)
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      drain()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 32 * 1024) stderr += chunk.toString()
      drain()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (dimension) drain()
      if (frames.length === 0) {
        reject(new Error(`抽帧失败：${stderr.trim() || `ffmpeg 退出码 ${code}`}`))
        return
      }
      resolve(frames)
    })
  })
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
