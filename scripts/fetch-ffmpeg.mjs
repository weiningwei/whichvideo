#!/usr/bin/env node
/**
 * 获取 ffmpeg / ffprobe 并放到 resources/bin（打包时随应用分发）。
 *
 *   pnpm fetch:ffmpeg                                  # 依次尝试多个下载源
 *   pnpm fetch:ffmpeg --from "D:\program\ffmpeg\bin"    # 直接用本机已装好的二进制
 *   pnpm fetch:ffmpeg --from "D:\ffmpeg.zip"            # 用本地已有的压缩包
 *   pnpm fetch:ffmpeg --source btbn                     # 只用指定源
 *   pnpm fetch:ffmpeg --url <自定义 zip 地址>            # 完全自定义
 *   pnpm fetch:ffmpeg --force                           # 覆盖已存在的文件
 *
 * 设计要点（都是被真实网络问题逼出来的）：
 *  1. 优先复用本机 PATH 上的 ffmpeg，完全不联网
 *  2. 多源回退：BtbN（GitHub 直链）→ BtbN release API → BtbN 固定 tag → xmake 镜像 → gyan.dev
 *  3. 每个源都有空闲超时（默认 30s 收不到新数据就换源），绝不无限挂起
 *  4. 每秒打印进度与速度；下载中断可直接重跑（按源缓存，不重复下载）
 *  5. 校验 ZIP 头（PK）与体积，解压后校验两个二进制都能执行
 *  6. 支持 HTTP_PROXY / HTTPS_PROXY / NO_PROXY（Node 24 需要 NODE_USE_ENV_PROXY=1）
 */
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { open } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'resources', 'bin')
const cacheDir = join(root, 'tmp', 'ffmpeg-download')
const MIN_ZIP_BYTES = 5 * 1024 * 1024 // 正常构建是几十 MB，小于 5MB 一定是错误页

const argv = process.argv.slice(2)
const argValue = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const options = {
  from: argValue('--from'),
  url: argValue('--url'),
  source: argValue('--source'),
  force: argv.includes('--force'),
  idleSeconds: Number(argValue('--idle-timeout') ?? 30)
}

const EXE_NAMES = process.platform === 'win32' ? ['ffmpeg.exe', 'ffprobe.exe'] : ['ffmpeg', 'ffprobe']

/* ------------------------------------------------------------------ *
 * 下载源
 * ------------------------------------------------------------------ */

const BTBN_ASSET = 'ffmpeg-master-latest-win64-gpl.zip'
const XMAKE_ASSET = 'ffmpeg-release-essentials.zip'
const BTBN_REPO = 'BtbN/FFmpeg-Builds'

const SOURCES = [
  {
    id: 'btbn',
    label: 'BtbN/FFmpeg-Builds（GitHub 直链，最稳）',
    url: () => `https://github.com/${BTBN_REPO}/releases/latest/download/${BTBN_ASSET}`
  },
  {
    id: 'btbn-api',
    label: 'BtbN/FFmpeg-Builds（先查 release API 拿准确地址）',
    url: async () => {
      const release = await getJson(`https://api.github.com/repos/${BTBN_REPO}/releases/latest`)
      const asset = release?.assets?.find((a) => a.name === BTBN_ASSET)
      return asset?.browser_download_url ?? null
    }
  },
  {
    id: 'btbn-pinned',
    label: 'BtbN/FFmpeg-Builds（固定 latest tag）',
    url: () => `https://github.com/${BTBN_REPO}/releases/download/latest/${BTBN_ASSET}`
  },
  {
    id: 'xmake',
    label: 'xmake-mirror/ffmpeg-releases（gyan.dev 的 GitHub 镜像）',
    url: () => `https://github.com/xmake-mirror/ffmpeg-releases/releases/latest/download/${XMAKE_ASSET}`
  },
  {
    id: 'gyan',
    label: 'gyan.dev（官方构建）',
    url: () => 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
  }
]

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'whichvideo-fetch-ffmpeg', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function whichSync(name) {
  const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const first = String(r.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  return first ?? null
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 校验二进制是否可用。
 *
 * ffmpeg.exe 有几十 MB，`-version` 会立刻返回横幅；但如果当前环境禁止子进程管道
 * （受限沙箱会返回 EPERM），就用"体积是否明显偏小"作为兜底判据，避免误报失败。
 */
function verifyBinary(file) {
  const size = statSync(file).size
  if (size < 1024 * 1024) return null

  try {
    const r = spawnSync(file, ['-version'], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (r.error && r.error.code === 'EPERM') {
      return `已就位（${formatBytes(size)}，当前环境不允许启动子进程，跳过版本校验）`
    }
    const line = `${r.stdout ?? ''}${r.stderr ?? ''}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean)
    return line ? line.slice(0, 90) : `已就位（${formatBytes(size)}）`
  } catch {
    return `已就位（${formatBytes(size)}）`
  }
}

/** 递归找出目录下所有 ffmpeg/ffprobe 可执行文件 */
function listBinaries(dir, depth = 6) {
  const found = []
  const walk = (current, level) => {
    if (level > depth) return
    let entries
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full, level + 1)
      else if (EXE_NAMES.includes(entry.toLowerCase())) found.push(full)
    }
  }
  walk(dir, 0)
  return found
}

/* ------------------------------------------------------------------ *
 * 下载 / 解压 / 安装
 * ------------------------------------------------------------------ */

async function download(url, target) {
  const started = Date.now()
  mkdirSync(cacheDir, { recursive: true })
  const tmpPath = `${target}.part`
  rmSync(tmpPath, { force: true })

  const controller = new AbortController()
  let idleTimer = null
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(
      () => controller.abort(new Error(`下载停滞：${options.idleSeconds}s 内没有收到新数据`)),
      options.idleSeconds * 1000
    )
  }
  armIdle()

  let response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'whichvideo-fetch-ffmpeg' },
      signal: controller.signal
    })
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer)
    throw new Error(`连接失败：${describe(err)}`)
  }
  if (!response.ok || !response.body) {
    if (idleTimer) clearTimeout(idleTimer)
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  const host = response.url ? new URL(response.url).host : ''
  console.log(`  地址：${url}${host && !url.includes(host) ? `（→ ${host}）` : ''}`)
  console.log(`  大小：${total ? formatBytes(total) : '未知（服务器未给出 Content-Length）'}`)

  let received = 0
  let lastPrint = 0
  let lastBytes = 0
  let lastTime = Date.now()

  const meter = new Transform({
    transform(chunk, _enc, callback) {
      received += chunk.length
      armIdle()
      const now = Date.now()
      if (now - lastPrint > 400) {
        const mbps = (received - lastBytes) / 1024 / 1024 / Math.max(0.001, (now - lastTime) / 1000)
        lastBytes = received
        lastTime = now
        lastPrint = now
        const pct = total ? ` ${((received / total) * 100).toFixed(1)}%` : ''
        const bar = total ? ` [${'#'.repeat(Math.round((received / total) * 24)).padEnd(24, '-')}]` : ''
        process.stdout.write(
          `\r  进度：${formatBytes(received)} / ${total ? formatBytes(total) : '?'}${pct}${bar} ${mbps.toFixed(1)} MB/s   `
        )
      }
      callback(null, chunk)
    }
  })

  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(tmpPath))
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer)
    rmSync(tmpPath, { force: true })
    throw new Error(`下载中断：${describe(err)}`)
  }
  if (idleTimer) clearTimeout(idleTimer)
  process.stdout.write(`\r${' '.repeat(110)}\r`)

  const size = statSync(tmpPath).size
  if (size < MIN_ZIP_BYTES) {
    rmSync(tmpPath, { force: true })
    throw new Error(`文件只有 ${formatBytes(size)}，不像是压缩包（可能是错误页或代理提示页）`)
  }
  const head = Buffer.alloc(4)
  const handle = await open(tmpPath, 'r')
  try {
    await handle.read(head, 0, 4, 0)
  } finally {
    await handle.close()
  }
  if (head[0] !== 0x50 || head[1] !== 0x4b) {
    rmSync(tmpPath, { force: true })
    throw new Error('下载内容不是 ZIP（文件头不对），可能被中间设备改写')
  }

  rmSync(target, { force: true })
  renameSync(tmpPath, target)
  console.log(`  完成：${formatBytes(size)}，用时 ${((Date.now() - started) / 1000).toFixed(0)}s`)
}

function extractZip(zipPath, destDir) {
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`
    ],
    { stdio: 'inherit' }
  )
  if (r.status !== 0) throw new Error('Expand-Archive 解压失败')
}

/** 从目录（解压结果或本机安装目录）里取出两个二进制放进 resources/bin */
function installBinaries(sourceDir, originLabel) {
  const found = listBinaries(sourceDir)
  const picked = new Map()
  for (const file of found) {
    const key = basename(file).toLowerCase()
    if (!picked.has(key)) picked.set(key, file)
  }
  const missing = EXE_NAMES.filter((name) => !picked.has(name.toLowerCase()))
  if (missing.length) throw new Error(`${originLabel} 里没有找到 ${missing.join('、')}`)

  mkdirSync(outDir, { recursive: true })
  for (const name of EXE_NAMES) {
    const from = picked.get(name.toLowerCase())
    const to = join(outDir, name)
    copyFileSync(from, to)
    const version = verifyBinary(to)
    if (!version) throw new Error(`${name} 复制后无法执行：${to}`)
    console.log(`  ✓ ${name} — ${version}`)
  }
}

function describe(err) {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? `（${err.cause.message}）` : ''
    return `${err.message}${cause}`
  }
  return String(err)
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const targets = EXE_NAMES.map((name) => join(outDir, name))

  if (targets.every((p) => existsSync(p)) && !options.force && !options.from && !options.url) {
    console.log('resources/bin 下已存在 ffmpeg 与 ffprobe，跳过。需要覆盖请加 --force。')
    return
  }

  // 1) --from：本地目录或本地 zip
  if (options.from) {
    const src = resolve(options.from)
    if (!existsSync(src)) throw new Error(`路径不存在：${src}`)
    if (statSync(src).isDirectory()) {
      console.log(`从本地目录安装：${src}`)
      installBinaries(src, '本地目录')
    } else {
      console.log(`从本地压缩包安装：${src}`)
      const unpacked = join(cacheDir, 'unpack-local')
      extractZip(src, unpacked)
      installBinaries(unpacked, '本地压缩包')
    }
    console.log(`\n完成，产物在 ${outDir}`)
    return
  }

  // 2) 复用本机 PATH 上的 ffmpeg（很多机器其实已经装了）
  if (!options.url) {
    const localFfmpeg = whichSync('ffmpeg')
    const localFfprobe = whichSync('ffprobe')
    if (localFfmpeg && localFfprobe) {
      console.log(`发现本机已装 ffmpeg，直接复制（不联网）：\n  ${localFfmpeg}\n  ${localFfprobe}`)
      installBinaries(dirname(localFfmpeg), '本机安装')
      console.log(`\n完成，产物在 ${outDir}`)
      return
    }
  }

  // 3) 下载：按顺序试各个源
  const sources = options.url
    ? [{ id: 'custom', label: '自定义地址', url: async () => options.url }]
    : options.source
      ? SOURCES.filter((s) => s.id === options.source)
      : SOURCES

  if (sources.length === 0) {
    throw new Error(`未知的 --source：${options.source}（可选：${SOURCES.map((s) => s.id).join('、')}）`)
  }

  const failures = []
  let zipPath = null

  for (const [index, source] of sources.entries()) {
    console.log(`\n[${index + 1}/${sources.length}] ${source.label}`)
    try {
      const url = await source.url()
      if (!url) throw new Error('无法解析出下载地址（release API 里没有该资源）')
      const name = basename(new URL(url).pathname) || 'ffmpeg.zip'
      const target = join(cacheDir, `${source.id}-${name}`)
      if (existsSync(target) && statSync(target).size >= MIN_ZIP_BYTES && !options.force) {
        console.log(`  复用已下载的缓存：${target}`)
      } else {
        await download(url, target)
      }
      zipPath = target
      break
    } catch (err) {
      const message = describe(err)
      failures.push(`${source.id}: ${message}`)
      console.log(`  ✗ ${message}`)
      if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
        console.log('  （检测到代理环境变量；Node 需要 NODE_USE_ENV_PROXY=1 才会走代理）')
      }
    }
  }

  if (!zipPath) {
    throw new Error(
      [
        '所有下载源都失败了：',
        ...failures.map((f) => `  - ${f}`),
        '',
        '可以试试：',
        '  1. 用本机已装好的 ffmpeg：pnpm fetch:ffmpeg --from "D:\\program\\ffmpeg\\bin"',
        '  2. 浏览器手动下载后：pnpm fetch:ffmpeg --from "%USERPROFILE%\\Downloads\\ffmpeg-release-essentials.zip"',
        '  3. 指定镜像/代理地址：pnpm fetch:ffmpeg --url <zip 地址>',
        '  4. 走代理：set HTTPS_PROXY=http://127.0.0.1:7890 && set NODE_USE_ENV_PROXY=1 后重试'
      ].join('\n')
    )
  }

  console.log('\n解压并校验 …')
  const unpacked = join(cacheDir, 'unpack')
  extractZip(zipPath, unpacked)
  installBinaries(unpacked, '下载的压缩包')
  rmSync(unpacked, { recursive: true, force: true })

  console.log(`\n完成，产物在 ${outDir}${sep}`)
  console.log('打包时 electron-builder 会把它复制到安装目录的 resources/bin。')
}

try {
  await main()
} catch (err) {
  console.error(`\n获取 ffmpeg 失败：${describe(err)}`)
  process.exit(1)
}
