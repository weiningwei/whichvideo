/**
 * ffmpeg / ffprobe 封装：探测视频信息、定位抽帧、导出缩略图。
 *
 * 二进制查找顺序：
 *   1. 打包资源目录 resources/bin（随应用分发）
 *   2. 环境变量 WHICHVIDEO_FFMPEG / WHICHVIDEO_FFPROBE
 *   3. 系统 PATH
 *   4. 常见安装位置（winget / scoop / chocolatey）
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { VideoProbeInfo } from '@shared/types'
import { PROBE_MAX_WIDTH, FRAME_COUNT_TABLE, DEFAULT_FRAME_BUDGET, SEEK_VS_FULLSCAN_CROSSOVER } from './constants'
// 帧策略常量的定义处是 constants.ts；这里转出，因为 media 是抽帧策略的对外门面
export { DEFAULT_FRAME_BUDGET, SEEK_VS_FULLSCAN_CROSSOVER } from './constants'

export interface ToolPaths {
  ffmpeg: string
  ffprobe: string
}

let cached: ToolPaths | null = null

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function whichSync(name: string): string | null {
  const pathEnv = process.env.PATH ?? ''
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate) && isExecutable(candidate)) return candidate
    }
  }
  return null
}

const WINDOWS_FALLBACKS = [
  'C:\\ffmpeg\\bin',
  'C:\\Program Files\\ffmpeg\\bin',
  join(process.env.LOCALAPPDATA ?? '', 'Microsoft\\WinGet\\Links'),
  join(process.env.USERPROFILE ?? '', 'scoop\\shims'),
  join(process.env.ProgramData ?? '', 'chocolatey\\bin')
]

export function resolveTools(resourceBinDir?: string): ToolPaths | null {
  if (cached) return cached

  const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffprobe.exe'] : ['ffmpeg', 'ffprobe']
  const dirs: string[] = []
  if (resourceBinDir) dirs.push(resourceBinDir)
  if (process.env.WHICHVIDEO_BIN_DIR) dirs.push(process.env.WHICHVIDEO_BIN_DIR)
  dirs.push(...WINDOWS_FALLBACKS)

  const envFfmpeg = process.env.WHICHVIDEO_FFMPEG
  const envFfprobe = process.env.WHICHVIDEO_FFPROBE

  let ffmpeg: string | null = null
  let ffprobe: string | null = null

  for (const dir of dirs) {
    if (!dir) continue
    if (!ffmpeg) {
      const candidate = join(dir, names[0])
      if (existsSync(candidate)) ffmpeg = candidate
    }
    if (!ffprobe) {
      const candidate = join(dir, names[1])
      if (existsSync(candidate)) ffprobe = candidate
    }
  }
  if (!ffmpeg) ffmpeg = envFfmpeg && existsSync(envFfmpeg) ? envFfmpeg : whichSync('ffmpeg')
  if (!ffprobe) ffprobe = envFfprobe && existsSync(envFfprobe) ? envFfprobe : whichSync('ffprobe')

  if (!ffmpeg || !ffprobe) return null
  cached = { ffmpeg, ffprobe }
  return cached
}

export function requireTools(resourceBinDir?: string): ToolPaths {
  const tools = resolveTools(resourceBinDir)
  if (!tools) {
    throw new Error(
      '未找到 ffmpeg / ffprobe。请安装 ffmpeg 并加入 PATH，或把 ffmpeg.exe、ffprobe.exe 放到 resources/bin 目录（详见 README）。'
    )
  }
  return tools
}

export interface RunResult {
  code: number
  stdout: Buffer
  stderr: string
}

interface RunOptions {
  /** 只收集前 N 字节 stdout，防止误用大输出撑爆内存 */
  maxStdoutBytes?: number
  timeoutMs?: number
  /** ffmpeg -progress 回调 (frame, fps, out_time_ms, progress) */
  onProgress?: (info: { frame: number; fps: number; out_time_ms: number; progress: string }) => void
}

export function run(bin: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    const chunks: Buffer[] = []
    let size = 0
    const maxStdout = options.maxStdoutBytes ?? 512 * 1024 * 1024
    let stderr = ''
    let settled = false

    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (!settled) child.kill()
        }, options.timeoutMs)
      : null

    let progressBuf = ''

    child.stdout.on('data', (chunk: Buffer) => {
      if (size >= maxStdout) return
      chunks.push(chunk)
      size += chunk.length
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (stderr.length < 64 * 1024) stderr += text
      if (options.onProgress) {
        progressBuf += text
        const lines = progressBuf.split('\n')
        progressBuf = lines.pop() || ''
        for (const line of lines) {
          if (line.startsWith('frame=') || line.startsWith('fps=') || line.startsWith('out_time_ms=') || line.startsWith('progress=')) {
            const info: Record<string, string> = {}
            for (const part of line.split('=')) {
              const [k, v] = part.split('=')
              if (k && v !== undefined) info[k] = v
            }
            if (info.frame || info.fps || info.out_time_ms || info.progress) {
              options.onProgress({
                frame: Number(info.frame) || 0,
                fps: Number(info.fps) || 0,
                out_time_ms: Number(info.out_time_ms) || 0,
                progress: info.progress || ''
              })
            }
          }
        }
      }
    })
    child.on('error', (err) => {
      settled = true
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr })
    })
  })
}

export async function probeVideo(filePath: string, tools?: ToolPaths): Promise<VideoProbeInfo> {
  const t = tools ?? requireTools()
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-select_streams',
    'v:0',
    filePath
  ]
  const { code, stdout, stderr } = await run(t.ffprobe, args, { timeoutMs: 60_000 })
  if (code !== 0) {
    throw new Error(`ffprobe 失败：${stderr.trim() || `退出码 ${code}`}`)
  }
  const parsed = JSON.parse(stdout.toString('utf8')) as {
    streams?: Array<{
      width?: number
      height?: number
      codec_name?: string
      duration?: string
      nb_frames?: string
      avg_frame_rate?: string
    }>
    format?: { duration?: string; format_name?: string }
  }
  const stream = parsed.streams?.[0]
  const durationRaw = stream?.duration ?? parsed.format?.duration
  const duration = durationRaw ? Number.parseFloat(durationRaw) : null
  return {
    duration: duration && Number.isFinite(duration) ? duration : null,
    width: stream?.width ?? null,
    height: stream?.height ?? null,
    videoCodec: stream?.codec_name ?? null
  }
}

export function shouldUseFullScan(frameCount: number): boolean {
  return frameCount > SEEK_VS_FULLSCAN_CROSSOVER
}

/** 按视频时长得出的建议抽帧数（未与用户设置取小） */
export function framesForDuration(durationSeconds: number | null): number {
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return FRAME_COUNT_TABLE[0][1]
  }
  const table = FRAME_COUNT_TABLE
  if (durationSeconds >= table[table.length - 1][0]) return table[table.length - 1][1]
  for (let i = 1; i < table.length; i++) {
    const [t1, f1] = table[i]
    if (durationSeconds > t1) continue
    const [t0, f0] = table[i - 1]
    const ratio = t1 === t0 ? 0 : (durationSeconds - t0) / (t1 - t0)
    const value = f0 + (f1 - f0) * ratio
    return Math.max(2, Math.round(value / 2) * 2)
  }
  return table[table.length - 1][1]
}

/**
 * 计划抽帧用的帧数：策略值与用户设置（作为上限）取小。
 * 用户把"每视频帧数"调大也不会超过时长策略，避免短视频被抽过多帧。
 */
export function plannedFrameCount(durationSeconds: number | null, budget: number): number {
  const policy = framesForDuration(durationSeconds)
  const cap = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : DEFAULT_FRAME_BUDGET
  return Math.max(1, Math.min(policy, cap))
}

/** 根据时长与帧数决定抽帧时间点（秒），取每段中点以避开片头片尾黑场 */
export function planTimestamps(duration: number | null, frameBudget: number): number[] {
  if (!duration || !Number.isFinite(duration) || duration <= 0.5) {
    return [0]
  }
  const count = plannedFrameCount(duration, frameBudget)
  if (count <= 1) return [duration / 2]

  const list: number[] = []
  for (let i = 0; i < count; i++) {
    const t = duration * ((i + 0.5) / count)
    list.push(Math.min(Math.max(t, 0.05), Math.max(duration - 0.05, 0.05)))
  }
  return list
}

export interface ExtractedFrame {
  /** 均匀时间点（秒） */
  time: number
  /** 缩放后的帧尺寸 */
  width: number
  height: number
  /** RGB24 原始像素 */
  rgb: Buffer
}

function even(n: number): number {
  return n % 2 === 0 ? n : n - 1
}

/**
 * 简明抽帧接口：**单次 ffmpeg 调用**用 `fps=N/时长` 均匀采出 N 帧，输出 RGB24 裸像素。
 *
 * 与索引实际使用的 scan.ts::extractAndHash 的区别（两者都已实测，按帧数取长补短）：
 *   · scan.ts 用"每个时间点一个 `-ss` 精确跳转"，成本约 25 ms/帧，**与视频时长无关**
 *   · 本函数单次从头解码全片，成本约等于"时长对应的解码时间"，**与帧数无关**
 * 实测 600 秒视频：48 帧时两者都要约 1.1 秒；帧数低于约 55 时逐点 seek 更快，
 * 高于该点则本函数更快（128 帧时 4.5 秒 vs 1.1 秒）。
 * 索引走的是 scan.ts 那条路径，所以当前策略（封顶 64 帧）不必切换实现。
 */
export async function extractFrames(
  filePath: string,
  timestamps: number[],
  tools?: ToolPaths,
  options: { maxWidth?: number; timeoutMs?: number; durationSeconds?: number; onFrame?: (done: number, total: number) => void } = {}
): Promise<ExtractedFrame[]> {
  if (timestamps.length === 0) return []
  const t = tools ?? requireTools()
  const maxWidth = options.maxWidth ?? PROBE_MAX_WIDTH

  // fps 采样率必须用真实时长算，否则帧数与时间点会对不上
  const duration = options.durationSeconds ?? (timestamps[timestamps.length - 1] * 2 || 1)
  const rate = timestamps.length / Math.max(duration, 0.001)

  const args: string[] = ['-hide_banner', '-v', 'error', '-nostdin', '-i', filePath]
  // 启用进度输出到 stderr，供 onProgress 解析
  if (options.onFrame) args.push('-progress', 'pipe:2')
  const filter = `fps=${rate.toFixed(8)},scale=w='min(${maxWidth},iw)':h=-2`
  args.push(
    '-vf',
    filter,
    '-frames:v',
    String(timestamps.length),
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-an',
    '-sn',
    '-dn',
    'pipe:1'
  )

  // 进度回调：用 ffmpeg -progress 解析帧号
  let lastFrame = 0
  const { code, stdout, stderr } = await run(t.ffmpeg, args, {
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
    onProgress: options.onFrame ? (info) => {
      if (info.frame && info.frame > lastFrame) {
        lastFrame = info.frame
        options.onFrame!(Math.min(lastFrame, timestamps.length), timestamps.length)
      }
    } : undefined
  })
  if (code !== 0 && stdout.length === 0) {
    throw new Error(`ffmpeg 抽帧失败：${stderr.trim() || `退出码 ${code}`}`)
  }

  // ffmpeg 会为每个输入打印一次 scale 的尺寸信息；用最后一条输出尺寸做校验
  const dims = [...stderr.matchAll(/(\d{2,5})x(\d{2,5})/g)].map((m) => ({
    w: Number.parseInt(m[1], 10),
    h: Number.parseInt(m[2], 10)
  }))
  const lastDim = dims.length ? dims[dims.length - 1] : null

  const frames: ExtractedFrame[] = []
  let width = lastDim ? even(lastDim.w) : 0
  let height = lastDim ? lastDim.h : 0

  if (!width || !height) {
    // 无法从日志拿到尺寸时，利用“所有帧尺寸一致”反推：宽度上限已知，
    // 遍历可能的偶数宽度，找出能把总字节数整除且最接近上限的组合。
    const total = stdout.length
    const w0 = even(Math.min(maxWidth, 4096))
    for (let w = w0; w >= 2; w -= 2) {
      const pixelsPerFrame = total / 3 / timestamps.length
      const h = pixelsPerFrame / w
      const hh = Math.round(h / 2) * 2
      if (hh > 0 && w * hh * 3 * timestamps.length === total) {
        width = w
        height = hh
        break
      }
    }
    if (!width || !height) return []
  }

  const frameSize = width * height * 3
  if (frameSize > 0) {
    const available = Math.floor(stdout.length / frameSize)
    for (let i = 0; i < Math.min(available, timestamps.length); i++) {
      frames.push({
        time: timestamps[i],
        width,
        height,
        rgb: stdout.subarray(i * frameSize, (i + 1) * frameSize)
      })
    }
  }
  return frames
}

export async function makeThumbnail(
  filePath: string,
  timeSeconds: number,
  tools?: ToolPaths,
  width = 320
): Promise<Buffer | null> {
  const t = tools ?? requireTools()
  const args = [
    '-hide_banner',
    '-v',
    'error',
    '-nostdin',
    '-ss',
    Math.max(0, timeSeconds).toFixed(3),
    '-i',
    filePath,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:-2`,
    '-q:v',
    '6',
    '-f',
    'image2',
    '-c:v',
    'mjpeg',
    'pipe:1'
  ]
  try {
    const { code, stdout } = await run(t.ffmpeg, args, { timeoutMs: 30_000 })
    if (code !== 0 || stdout.length === 0) return null
    return stdout
  } catch {
    return null
  }
}

/** 判断文件是否是可解码的视频（导入时快速排除损坏文件） */
export async function isDecodable(filePath: string, tools?: ToolPaths): Promise<boolean> {
  try {
    const info = await probeVideo(filePath, tools)
    return info.width != null && info.height != null
  } catch {
    return false
  }
}
