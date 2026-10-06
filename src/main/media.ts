/**
 * ffmpeg / ffprobe 封装：探测视频信息、定位抽帧、导出缩略图。
 *
 * 二进制查找顺序：
 *   1. 打包资源目录 resources/bin（随应用分发）
 *   2. 环境变量 WHICHVIDEO_FFMPEG / WHICHVIDEO_FFPROBE
 *   3. 系统 PATH
 *   4. 常见安装位置（winget / scoop / chocolatey）
 */
import { spawn, spawnSync } from 'node:child_process'
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

export function shouldUseFullScan(frameCount: number, width?: number | null, height?: number | null): boolean {
  // 4K 视频强制走全片解码：seek 模式对 4K 解码极慢
  const is4K = (width ?? 0) >= 3840 || (height ?? 0) >= 2160
  return is4K || frameCount > SEEK_VS_FULLSCAN_CROSSOVER
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

  // showinfo 打印每个输出帧的真实 pts_time/w/h —— 全片解码的帧时间轴与
  // 计划时间点并不逐一对齐（ffprobe 时长有偏差、流 start_time 可非零），
  // 把计划时间点硬贴上去会让"命中位置显示 3:50、实际播放在 4:37"。
  // showinfo 需要 info 级别日志，所以这里不是 -v error。
  const args: string[] = ['-hide_banner', '-v', 'info', '-nostdin', '-hwaccel', 'auto', '-i', filePath]
  // 启用进度输出到 stderr，供 onProgress 解析
  if (options.onFrame) args.push('-progress', 'pipe:2')
  const filter = `fps=${rate.toFixed(8)},scale=w='min(${maxWidth},iw)':h=-2,showinfo`
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

  // showinfo 行形如：n: 12 pts: 277000 pts_time:277 ... fmt:rgb24 ... w:320 h:180 ...
  // 按出现顺序就是输出帧顺序，pts_time 是**真实源时间轴**位置（秒）。
  const showinfoLines = stderr.split('\n').filter((l) => l.includes('pts_time:'))
  const realTimes = showinfoLines
    .map((l) => {
      const m = l.match(/pts_time:(\d+(?:\.\d+)?)/)
      return m ? Number.parseFloat(m[1]) : null
    })
    .filter((t): t is number => t !== null)
  const showinfoDims = showinfoLines
    .map((l) => {
      const m = l.match(/ w:(\d+) h:(\d+)/)
      return m ? { w: Number.parseInt(m[1], 10), h: Number.parseInt(m[2], 10) } : null
    })
    .filter((d): d is { w: number; h: number } => d !== null)

  // 尺寸：优先 showinfo（真实输出帧），退回旧行为 —— -v info 下 stderr 混有
  // 输入流信息，旧 matchAll 会匹配到源分辨率，所以先剔除 showinfo 行再扫
  const dims = [...stderr
    .split('\n')
    .filter((l) => !l.includes('pts_time:'))
    .join('\n')
    .matchAll(/(\d{2,5})x(\d{2,5})/g)].map((m) => ({
    w: Number.parseInt(m[1], 10),
    h: Number.parseInt(m[2], 10)
  }))
  const lastDim = showinfoDims.length
    ? showinfoDims[showinfoDims.length - 1]
    : dims.length
      ? dims[dims.length - 1]
      : null

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
        // 真实时间戳优先；showinfo 缺行时才退回计划时间点（旧行为，可能有偏差）
        time: realTimes[i] ?? timestamps[i],
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

/** 支持"从指定时间点起播"的播放器（用于搜索结果定位播放） */
export interface SeekablePlayer {
  /** 可执行文件路径 */
  exe: string
  /** 展示名（通知文案用） */
  name: string
  /** 组装起播参数 */
  args: (videoPath: string, startSeconds: number) => string[]
}

/**
 * 注册表兜底：PotPlayer 装在自定义路径时，文件探测全落空，
 * 但安装器一定会写 Uninstall 键（DisplayIcon 直接指向 exe）。
 * spawnSync `reg query` 逐键尝试，只在文件探测失败时被调用，无性能顾虑。
 */
/** 读一个注册表值（REG_SZ），键不存在或类型不符返回 null */
function regQueryString(key: string, valueName: string | null): string | null {
  const args = valueName === null ? ['query', key, '/ve'] : ['query', key, '/v', valueName]
  const r = spawnSync('reg', args, { encoding: 'utf8', timeout: 2000 })
  if (r.status !== 0 || !r.stdout) return null
  const m = r.stdout.match(/REG_SZ\s+(.+)/)
  return m ? m[1].trim() : null
}

/**
 * 从文件关联的命令模板里解析出 exe 路径。
 * 模板形如 `"C:\...\player.exe" /args "%1"`：优先取第一个带引号的段，
 * 否则取首个空白分隔 token。含未展开环境变量的模板（UWP 关联常见）放弃。
 */
function exeFromCommandTemplate(cmd: string): string | null {
  if (cmd.includes('%')) return null
  const quoted = cmd.match(/^\s*"([^"]+)"/)
  const exe = quoted ? quoted[1] : cmd.trim().split(/\s+/)[0]
  return exe && /\.exe$/i.test(exe) ? exe : null
}

/** 受支持播放器：exe 文件名（小写）→ 起播参数构造。关联探测与盲扫共用。 */
const KNOWN_SEEKABLE: Record<string, Pick<SeekablePlayer, 'name' | 'args'>> = {
  'mpv.exe': { name: 'mpv', args: (p, s) => ['--start=' + Math.floor(s), p] },
  'potplayermini64.exe': { name: 'PotPlayer', args: (p, s) => [p, '/new', '/seek=' + Math.floor(s)] },
  'potplayermini.exe': { name: 'PotPlayer', args: (p, s) => [p, '/new', '/seek=' + Math.floor(s)] },
  'vlc.exe': { name: 'VLC', args: (p, s) => ['--start-time=' + Math.floor(s), p] }
}

/**
 * 读系统对某视频扩展名的默认打开方式，若指向受支持的播放器就直接复用。
 *
 * 查询链（Windows 文件关联的正式结构）：
 *   HKCU\...\FileExts\.<ext>\UserChoice → ProgId（用户实际选择，Win8+ 存在）
 *   → HKCR\<ProgId>\shell\open\command 默认值 → 命令模板 → exe
 * UserChoice 没有时退回 HKCR\.<ext> 的老式关联。
 *
 * 优先级最高：它同时满足"用户预期"（点开就是这个播放器）与"自定义安装
 * 自动覆盖"（exe 路径来自关联，不用扫任何固定位置）。UWP 关联（电影和电视）
 * 的 ProgId 查不到 shell command，自然落空。
 */
function playerFromDefaultAssociation(videoExt: string): SeekablePlayer | null {
  const ext = videoExt.replace(/^\./, '').toLowerCase()
  if (!ext) return null
  const progId =
    regQueryString(
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.' +
        ext +
        '\\UserChoice',
      'ProgId'
    ) ?? regQueryString('HKCR\\.' + ext, null)
  if (!progId) return null
  const cmd = regQueryString('HKCR\\' + progId + '\\shell\\open\\command', null)
  if (!cmd) return null
  const exe = exeFromCommandTemplate(cmd)
  if (!exe) return null
  const known = KNOWN_SEEKABLE[exe.split('\\').pop()?.toLowerCase() ?? '']
  if (!known) return null
  return { exe, name: known.name, args: known.args }
}

function findPotPlayerFromRegistry(): string | null {
  const uninstallKeys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer64bit',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer64bit',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer'
  ]
  for (const key of uninstallKeys) {
    for (const valueName of ['DisplayIcon', 'InstallLocation']) {
      const r = spawnSync('reg', ['query', key, '/v', valueName], { encoding: 'utf8', timeout: 2000 })
      if (r.status !== 0 || !r.stdout) continue
      const m = r.stdout.match(/REG_SZ\s+(.+)/)
      if (!m) continue
      let p = m[1].trim()
      if (valueName === 'DisplayIcon') {
        p = p.replace(/,\s*\d+\s*$/, '') // DisplayIcon 形如 "...PotPlayerMini64.exe,0"
      } else {
        p = join(p, 'PotPlayerMini64.exe')
      }
      if (existsSync(p) && isExecutable(p)) return p
      // 64 位键指向 Mini64.exe 时，同目录的 32 位版也算数
      const alt32 = p.replace(/PotPlayerMini64\.exe$/, 'PotPlayerMini.exe')
      if (existsSync(alt32) && isExecutable(alt32)) return alt32
    }
  }
  return null
}

function pickExisting(candidates: string[]): string | null {
  for (const p of candidates) {
    if (p && existsSync(p) && isExecutable(p)) return p
  }
  return null
}

/**
 * 找一个支持时间点起播的本地播放器：mpv 优先（轻量、参数稳），
 * 其次 PotPlayer（国内 Windows 用户最常见），再次 VLC。都找不到返回 null —— 调用方退化为系统默认播放器（无法定位时间点）。
 *
 * 探测顺序：PATH（覆盖 scoop/winget/choco 等包管理器安装）→ 常见安装位置。
 */
export function findSeekablePlayer(videoPath: string): SeekablePlayer | null {
  // 第一优先级：系统默认关联。用户把 PotPlayer/mpv/VLC 设为默认播放器时
  // 直接命中（含自定义安装路径），后面的盲扫全部跳过。
  const assoc = playerFromDefaultAssociation(videoPath.slice(videoPath.lastIndexOf('.')))
  if (assoc) return assoc

  const mpv =
    whichSync('mpv') ??
    pickExisting([
      join(process.env.APPDATA ?? '', 'mpv', 'mpv.exe'),
      'C://Program Files\\mpv\\mpv.exe',
      'C://Program Files (x86)\\mpv\\mpv.exe',
      join(process.env.LOCALAPPDATA ?? '', 'Programs\\mpv', 'mpv.exe')
    ])
  if (mpv) {
    return { exe: mpv, ...KNOWN_SEEKABLE['mpv.exe'] }
  }

  // PotPlayer：国内 Windows 用户最常见。/new 强制新实例 —— 已运行的实例会
  // 吞掉命令行参数（/seek 失效 → 从头播）；/seek= 支持纯秒数（官方双格式之一）
  const potPlayer = pickExisting([
    'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
    'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini.exe',
    'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe',
    join(process.env.APPDATA ?? '', 'DAUM\\PotPlayer\\PotPlayerMini64.exe')
  ]) ?? findPotPlayerFromRegistry()
  if (potPlayer) {
    return {
      exe: potPlayer,
      name: 'PotPlayer',
      args: (p, s) => [p, '/new', '/seek=' + Math.floor(s)]
    }
  }

  const vlc =
    whichSync('vlc') ??
    pickExisting([
      'C://Program Files\\VideoLAN\\VLC\\vlc.exe',
      'C://Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
      join(process.env.LOCALAPPDATA ?? '', 'Programs\\VideoLAN\\VLC\\vlc.exe'),
      '/Applications/VLC.app/Contents/MacOS/VLC',
      '/usr/bin/vlc',
      '/snap/bin/vlc'
    ])
  if (vlc) {
    return { exe: vlc, ...KNOWN_SEEKABLE['vlc.exe'] }
  }

  return null
}
