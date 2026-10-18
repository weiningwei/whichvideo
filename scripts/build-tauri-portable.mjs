/** 把 Tauri release exe 整理成可直接拷走的绿色目录。FFmpeg 由用户外部配置。 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseRoot = process.env.WHICHVIDEO_RELEASE_DIR
  ? resolve(process.env.WHICHVIDEO_RELEASE_DIR)
  : join(root, 'dist')
const target = join(releaseRoot, 'WhichVideo-portable')
const sourceExe = process.env.WHICHVIDEO_TAURI_EXE
  ? resolve(process.env.WHICHVIDEO_TAURI_EXE)
  : join(root, 'src-tauri', 'target', 'release', 'whichvideo-tauri.exe')
const outsideRoot = process.env.WHICHVIDEO_OUTSIDE_DIR
  ? resolve(process.env.WHICHVIDEO_OUTSIDE_DIR)
  : resolve(root, '..')

function assertExactChild(path, parent, name) {
  const resolved = resolve(path)
  const resolvedParent = resolve(parent)
  if (dirname(resolved) !== resolvedParent || basename(resolved) !== name || !resolved.startsWith(resolvedParent + sep)) {
    throw new Error(`拒绝操作非预期目录：${resolved}`)
  }
}

function countFiles(dir, skipData = false) {
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipData && entry.name === 'data') continue
    count += entry.isDirectory() ? countFiles(join(dir, entry.name), false) : 1
  }
  return count
}

function sizeOf(dir, skipData = false) {
  let bytes = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipData && entry.name === 'data') continue
    const full = join(dir, entry.name)
    bytes += entry.isDirectory() ? sizeOf(full, false) : statSync(full).size
  }
  return bytes
}

function replaceDirectorySafely(dir, parent) {
  assertExactChild(dir, parent, 'WhichVideo-portable')
  mkdirSync(parent, { recursive: true })
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    return false
  }
  const data = join(dir, 'data')
  const keep = join(parent, `.whichvideo-data-keep-${process.pid}-${Date.now()}`)
  let preserved = false
  if (existsSync(data)) {
    renameSync(data, keep)
    preserved = true
  }
  try {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    if (preserved) renameSync(keep, data)
    return preserved
  } catch (error) {
    if (preserved && existsSync(keep) && !existsSync(data)) {
      mkdirSync(dir, { recursive: true })
      renameSync(keep, data)
    }
    throw error
  }
}

function writePortable(source, destination, parent) {
  const dataPreserved = replaceDirectorySafely(destination, parent)
  copyFileSync(sourceExe, join(destination, 'WhichVideo.exe'))
  writeFileSync(
    join(destination, '便携版说明.txt'),
    [
      'WhichVideo · Tauri 免安装绿色版',
      '',
      '1. 双击 WhichVideo.exe 直接运行。',
      '2. 首次运行会在本目录创建 data\\，索引库、日志与缓存都保存在其中。',
      '3. 迁移时复制整个 WhichVideo-portable 文件夹；升级时保留 data\\。',
      '4. 安装版与绿色版都把数据写在程序同级 data\\，目录必须可写。',
      '5. FFmpeg 不随软件分发；首次启动请选择同时包含 ffmpeg.exe 和 ffprobe.exe 的 bin 目录。',
      '6. 也可通过系统 PATH、WHICHVIDEO_BIN_DIR，或 WHICHVIDEO_FFMPEG / WHICHVIDEO_FFPROBE 指定媒体工具。',
      '7. 可用 WHICHVIDEO_DATA_DIR 环境变量显式指定数据位置。',
      ''
    ].join('\r\n'),
    'utf8'
  )
  return { dataPreserved, files: countFiles(destination, true), bytes: sizeOf(destination, true) }
}

function main() {
  if (!existsSync(sourceExe)) throw new Error(`缺少 Tauri release 可执行文件：${sourceExe}`)
  const built = writePortable(sourceExe, target, releaseRoot)
  console.log(`Tauri 绿色版已就绪：${target}`)
  console.log(`  文件 ${built.files} 个，${(built.bytes / 1024 / 1024).toFixed(1)} MiB`)
  if (built.dataPreserved) console.log('  已保留原有 data\\。')

  if (process.env.WHICHVIDEO_SKIP_OUTSIDE_COPY === '1') return
  const outside = join(outsideRoot, 'WhichVideo-portable')
  const outsideDataPreserved = replaceDirectorySafely(outside, outsideRoot)
  cpSync(target, outside, { recursive: true, filter: (path) => basename(path) !== 'data' })
  const outsideFiles = countFiles(outside, true)
  const outsideBytes = sizeOf(outside, true)
  if (outsideFiles !== built.files || outsideBytes !== built.bytes) {
    throw new Error('仓库外副本校验失败：文件数或字节数不一致')
  }
  console.log(`仓库外副本已就绪：${outside}`)
  if (outsideDataPreserved) console.log('  已保留仓库外原有 data\\。')
}

main()
