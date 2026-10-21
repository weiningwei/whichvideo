import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const runRoot = join(root, 'tmp', 'e2e')
mkdirSync(runRoot, { recursive: true })
const runDir = mkdtempSync(join(runRoot, 'run-'))
const mediaDir = join(runDir, 'media')
const nestedDir = join(mediaDir, 'nested')
mkdirSync(nestedDir, { recursive: true })
const videoPath = join(nestedDir, 'sample.mp4')
const imagePath = join(runDir, 'sample.png')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const pnpmEntry = process.env.npm_execpath

function executable(name, override) {
  if (override) return override
  const command = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(command, [name], { encoding: 'utf8' })
  const found = result.stdout?.split(/\r?\n/).find(Boolean)
  if (result.status !== 0 || !found) throw new Error(`找不到 ${name}，请设置 WHICHVIDEO_${name.toUpperCase()} 指向可执行文件`)
  return found.trim()
}

const ffmpeg = executable('ffmpeg', process.env.WHICHVIDEO_FFMPEG)
const ffprobe = executable('ffprobe', process.env.WHICHVIDEO_FFPROBE)

function run(program, args, env = process.env) {
  const result = spawnSync(program, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' && program === pnpm })
  if (result.error || result.status !== 0) throw new Error(`${program} ${args.join(' ')} 失败：${result.error?.message ?? result.status}`)
}

function runPnpm(args, env) {
  if (pnpmEntry && /\.[cm]?js$/i.test(pnpmEntry)) run(process.execPath, [pnpmEntry, ...args], env)
  else run(pnpm, args, env)
}

try {
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'smptebars=size=320x180:rate=5', '-t', '4', '-c:v', 'mpeg4', '-y', videoPath])
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', videoPath, '-frames:v', '1', '-y', imagePath])
  run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1', videoPath])
  if (!existsSync(videoPath) || !existsSync(imagePath)) throw new Error('媒体样本生成失败')
  const env = {
    ...process.env,
    WHICHVIDEO_DATA_DIR: join(runDir, 'data'),
    WHICHVIDEO_FFMPEG: ffmpeg,
    WHICHVIDEO_FFPROBE: ffprobe,
    WHICHVIDEO_E2E_VIDEO: videoPath,
    WHICHVIDEO_E2E_FOLDER: mediaDir,
    WHICHVIDEO_E2E_IMAGE: imagePath,
    WHICHVIDEO_E2E_RUN_DIR: runDir
  }
  writeFileSync(join(runDir, 'paths.json'), JSON.stringify({ videoPath, imagePath, mediaDir }, null, 2))
  console.log(`桌面验收临时目录：${runDir}`)
  runPnpm(['tauri', 'build', '--debug', '--no-bundle', '--features', 'e2e', '--config', 'src-tauri/tauri.e2e.conf.json'], env)
  runPnpm(['exec', 'wdio', 'run', 'scripts/e2e/wdio.conf.mjs'], env)
  console.log('真实桌面用例通过；日志与样本保存在上述临时目录')
} catch (error) {
  console.error(`真实桌面用例失败；请检查 ${runDir} 下的 data/logs 与截图`)
  console.error(error)
  process.exitCode = 1
}
