/** 本地快速绿色版：隔离 Cargo 缓存，避免影响正式发行构建。 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = join(root, 'src-tauri', 'target-fast')
const sourceExe = join(targetDir, 'release', 'whichvideo-tauri.exe')
const pnpm = process.env.npm_execpath || (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')

function run(command, args, env, shell = false) {
  const result = spawnSync(command, args, { cwd: root, env, shell, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log('快速本地构建：target-fast、Thin LTO、16 个 codegen 单元和 release 增量缓存。')
run(pnpm, ['tauri', 'build', '--no-bundle'], {
  ...process.env,
  CARGO_TARGET_DIR: targetDir,
  CARGO_PROFILE_RELEASE_LTO: 'thin',
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16',
  CARGO_PROFILE_RELEASE_INCREMENTAL: 'true'
}, process.platform === 'win32' && pnpm.toLowerCase().endsWith('.cmd'))
run(process.execPath, [join(root, 'scripts', 'build-tauri-portable.mjs')], {
  ...process.env,
  WHICHVIDEO_TAURI_EXE: sourceExe
})
