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
import { createHash } from 'node:crypto'
import { accessSync, constants, createReadStream, existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { VideoProbeInfo } from '@shared/types'
import { PROBE_MAX_WIDTH } from './constants'
// 抽帧采样策略已拆到 sampling.ts；media 仍作为对外门面转出，调用方（scan/indexer/自检）无需改
export {
  DEFAULT_FRAME_BUDGET,
  SEEK_VS_FULLSCAN_CROSSOVER,
  framesForDuration,
  planSceneTimestamps,
  planTimestamps,
  plannedFrameCount,
  shouldUseFullScan
} from './sampling'

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
  /**
   * 只收集前 N 字节 stderr（默认 64KB）。
   * 需要**完整保留 stderr 内容**（如 showinfo 逐帧输出）且同时启用 -progress
   * 时必须调大 —— 进度行与业务行共用 stderr，64KB 会被进度挤满，
   * 后面的业务行静默丢失（场景检测曾因此丢场景点）。
   */
  maxStderrBytes?: number
  timeoutMs?: number
  /** ffmpeg -progress 回调；out_time_ms 已归一化为**真毫秒**（见解析处注释） */
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
      // 上限可调：启用 -progress 时进度行与业务行共用 stderr，默认 64KB
      // 会被进度挤满导致业务行（showinfo）丢失
      if (stderr.length < (options.maxStderrBytes ?? 64 * 1024)) stderr += text
      if (options.onProgress) {
        progressBuf += text
        const lines = progressBuf.split('\n')
        progressBuf = lines.pop() || ''
        // 一个进度块是多行 key=value（frame/fps/.../out_time_ms/progress），
        // 累积到 progress= 行时整体回调一次。
        //
        // 注意这里是**累积** info 而非逐行独立解析：frame 与 out_time_ms 在
        // 同一块的不同行上，只在 progress= 那一行触发才能带全信息。
        const info: Record<string, string> = {}
        for (const line of lines) {
          if (
            line.startsWith('frame=') ||
            line.startsWith('fps=') ||
            line.startsWith('out_time_ms=') ||
            line.startsWith('progress=')
          ) {
            // 按**第一个** = 拆分。历史实现写成 line.split('=') 再对每段
            // split('=')，导致 k/v 永远取不到值（info 恒为空、回调永不触发）——
            // onProgress 因此一直是死代码，检测与全片解码的进度都拿不到。
            const eq = line.indexOf('=')
            if (eq <= 0) continue
            const k = line.slice(0, eq).trim()
            const v = line.slice(eq + 1).trim()
            if (k && v) info[k] = v
          }
          if (info.progress) {
            options.onProgress({
              frame: Number(info.frame) || 0,
              fps: Number(info.fps) || 0,
              // ⚠️ ffmpeg 的进度字段 out_time_ms 单位是**微秒**（历史命名坑，
              // 与 out_time_us 同值），这里归一化成真毫秒，调用方按毫秒理解。
              // 曾直接当毫秒用 → 6 秒视频报 6000 秒，进度瞬间爆表。
              out_time_ms: Math.round((Number(info.out_time_ms) || 0) / 1000),
              progress: info.progress
            })
            // 块已消费，清空避免下一块复用旧值
            for (const key of Object.keys(info)) delete info[key]
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

/**
 * 解码单个时间点的一帧（rgb24 裸像素），用于搜索结果的二阶段验证。
 * 与 makeThumbnail 同源（`-ss` 前置于 `-i` 的快速定位 + `-frames:v 1`），
 * 但输出 rawvideo 而非 jpeg。失败（文件已删/时间点越界/解码错误）返回 null。
 */
export async function decodeFrameAt(
  filePath: string,
  timeSeconds: number,
  tools?: ToolPaths,
  width = 320
): Promise<{ width: number; height: number; rgb: Buffer } | null> {
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
    `scale=w=${width}:h=-2`,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-an',
    '-sn',
    '-dn',
    'pipe:1'
  ]
  try {
    const { code, stdout } = await run(t.ffmpeg, args, { timeoutMs: 15_000 })
    if (code !== 0 || stdout.length === 0) return null
    const rowBytes = width * 3
    if (stdout.length % rowBytes !== 0) return null
    const height = stdout.length / rowBytes
    if (height <= 0) return null
    return { width, height, rgb: stdout }
  } catch {
    return null
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
  // 只拒绝"未展开的环境变量"（%SystemRoot% 这类）；%1~%9 是正常的文件占位符，
  // 正常播放器关联的模板一定带 "%1" —— 连它一起拒掉的话关联探测永远落空
  // （自伤 bug：曾用 cmd.includes('%') 一刀切，导致该分支形同虚设）。
  const withoutPlaceholders = cmd.replace(/%\d/g, '').replace(/%\*/g, '')
  if (/%[^%]*%/.test(withoutPlaceholders)) return null
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

/**
 * 文件 SHA-256（流式，大文件不全量进内存）。
 *
 * 查重第一级用：size + duration 一致只是副本的**候选**信号（不充分 ——
 * 不同视频可能同大小同时长），哈希一致才是 bit 级相同的充分证明。
 * 结果缓存进 videos.file_hash，只算一次。
 */
export async function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/* ------------------------------------------------------------------ *
 * 场景检测采样（samplingMode='scene'）
 * ------------------------------------------------------------------ */

/**
 * 检测场景切换时间点（秒，升序）。
 *
 * ffmpeg `select=gt(scene,T)` 滤镜逐帧计算相邻帧差异分数（0~1），超过
 * 阈值 T 的帧被选为"镜头切换"。showinfo 打印每个输出帧的 pts_time。
 * 先缩到 160 宽做检测 —— 场景分数是粗粒度信号，低分辨率足够且快。
 *
 * 阈值 0.3 是召回/误检折中：过高漏切（快速闪切镜头）、过低把镜头内
 * 运动/闪光误判为切换（产生的重复帧会被预算裁剪吸收，无害）。
 */
export async function detectScenes(
  filePath: string,
  threshold: number,
  tools?: ToolPaths,
  timeoutMs = 10 * 60_000,
  /**
   * 检测进度回调（秒）：全片解码一趟，用 -progress 的 out_time_ms 折算
   * 已解码时长 —— 长视频检测期间界面不再是\"卡住\"的静默态。
   */
  onProgress?: (decodedSeconds: number) => void
): Promise<number[]> {
  const t = tools ?? requireTools()
  const args = [
    '-hide_banner',
    '-v',
    'info',
    '-nostdin',
    '-hwaccel',
    'auto',
    '-i',
    filePath
  ]
  // 进度输出到 stderr，复用 run() 的 onProgress 解析
  if (onProgress) args.push('-progress', 'pipe:2')
  // 关键结构：split 两路 + nullsink
  //
  //   [d] select+showinfo → nullsink   ← 场景点（pts_time 打到 stderr）
  //   [p] 全帧 → map 到 null muxer      ← 进度（frame/out_time_ms 才有效）
  //
  // 为什么不能直接 `-vf select=...,showinfo -f null -`：-progress 报的是
  // **muxer 收到的帧**，select 在 muxer 之前把绝大多数帧丢掉 → frame=0、
  // out_time_ms=N/A（实测），进度永远是 0。split 一路不 select 喂给 muxer，
  // 进度才反映真实解码位置。nullsink 让场景那路无需 -map 就能终止。
  args.push(
    '-filter_complex',
    `[0:v]split=2[d][p];[d]scale=w=160:h=-2,select='gt(scene,${threshold})',showinfo,nullsink;[p]scale=w=160:h=-2[prog]`,
    '-map',
    '[prog]',
    '-an',
    '-sn',
    '-dn',
    '-f',
    'null',
    '-'
  )
  const { code, stderr } = await run(t.ffmpeg, args, {
    timeoutMs,
    // 进度行与 showinfo 行共用 stderr：64KB 默认上限会被进度挤满，
    // 后面的 showinfo（场景点）静默丢失 → 调到 8MB（长片 showinfo 实测 <2MB）
    maxStderrBytes: 8 * 1024 * 1024,
    onProgress: onProgress
      ? (info) => {
          if (info.out_time_ms > 0) onProgress(info.out_time_ms / 1000)
        }
      : undefined
  })
  // 退出码非 0（滤镜串错误、文件损坏等）必须抛出 —— 静默返回空数组会让
  // 场景采样**悄悄退化成均匀采样**，用户毫无感知（历史上真发生过）。
  // indexer 的 catch 会 logError 并退回均匀计划，行为与失败语义一致。
  if (code !== 0) {
    throw new Error(`场景检测失败（退出码 ${code}）：${stderr.trim().slice(0, 200)}`)
  }
  const times: number[] = []
  for (const m of stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) {
    const v = Number.parseFloat(m[1])
    if (Number.isFinite(v)) times.push(v)
  }
  return times.sort((a, b) => a - b)
}
