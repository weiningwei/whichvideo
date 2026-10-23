import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateBenchmark } from './generate.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const profile = args.includes('--extended') ? 'extended' : 'regular'
if (args.some((arg) => arg !== '--extended')) throw new Error('只支持 --extended 参数')
const runRoot = join(root, 'tmp', 'search-benchmark')
mkdirSync(runRoot, { recursive: true })
const runDir = mkdtempSync(join(runRoot, 'run-'))
function executable(name) {
  const override = process.env[`WHICHVIDEO_${name.toUpperCase()}`]
  if (override) return override
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' })
  const path = lookup.stdout?.split(/\r?\n/).find(Boolean)
  if (!path) throw new Error(`找不到 ${name}，请设置 WHICHVIDEO_${name.toUpperCase()}`)
  return path.trim()
}
const ffmpeg = executable('ffmpeg')
const ffprobe = executable('ffprobe')
const manifest = generateBenchmark(ffmpeg, runDir, profile)
console.log(`直接搜索评测数据：${manifest}`)
const result = spawnSync('cargo', [
  'test', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'whichvideo-tauri',
  'search_benchmark::tests::benchmark', '--', '--ignored', '--nocapture'
], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG || '0',
    WHICHVIDEO_FFMPEG: ffmpeg,
    WHICHVIDEO_FFPROBE: ffprobe,
    WHICHVIDEO_SEARCH_BENCHMARK_MANIFEST: manifest
  }
})
if (result.error || result.status !== 0 || !existsSync(join(runDir, 'dataset', 'report.json'))) {
  console.error(`直接搜索评测失败；数据和报告目录：${runDir}`)
  process.exitCode = result.status || 1
}
