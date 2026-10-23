import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const runRoot = join(root, 'tmp', 'media-edge')
mkdirSync(runRoot, { recursive: true })
const runDir = mkdtempSync(join(runRoot, 'run-'))

for (const name of ['ffmpeg', 'ffprobe']) {
  const override = process.env[`WHICHVIDEO_${name.toUpperCase()}`]
  const found = override || spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' })
    .stdout?.split(/\r?\n/).find(Boolean)?.trim()
  if (!found) throw new Error(`找不到 ${name}，请设置 WHICHVIDEO_${name.toUpperCase()}`)
  process.env[`WHICHVIDEO_${name.toUpperCase()}`] = found
}

console.log(`边界媒体样本目录：${runDir}`)
const result = spawnSync('cargo', [
  'test', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'whichvideo-tauri',
  'media::tests::media_edge_cases', '--', '--ignored', '--exact', '--nocapture'
], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG || '0',
    WHICHVIDEO_MEDIA_EDGE_DIR: runDir
  }
})
if (result.error || result.status !== 0) {
  console.error(`边界媒体测试失败；样本保留在 ${runDir}`)
  process.exitCode = result.status || 1
}
