import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const fixtureRoot = join(root, 'tmp')
mkdirSync(fixtureRoot, { recursive: true })
const work = mkdtempSync(join(fixtureRoot, 'tauri-portable-'))
const release = join(work, 'release')
const outside = join(work, 'outside')
const sourceExe = join(work, 'whichvideo-tauri.exe')
writeFileSync(sourceExe, 'tauri-exe')

for (const parent of [release, outside]) {
  const data = join(parent, 'WhichVideo-portable', 'data')
  mkdirSync(data, { recursive: true })
  mkdirSync(join(data, 'db'), { recursive: true })
  writeFileSync(join(data, 'db', 'whichvideo.db'), `keep-${parent}`)
}

const run = spawnSync(process.execPath, [join(root, 'scripts', 'build-tauri-portable.mjs')], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    WHICHVIDEO_RELEASE_DIR: release,
    WHICHVIDEO_OUTSIDE_DIR: outside,
    WHICHVIDEO_TAURI_EXE: sourceExe
  }
})
if (run.status !== 0) throw new Error(`${run.stdout}\n${run.stderr}`)

for (const parent of [release, outside]) {
  const portable = join(parent, 'WhichVideo-portable')
  if (!existsSync(join(portable, 'WhichVideo.exe'))) throw new Error('缺少 WhichVideo.exe')
  if (existsSync(join(portable, 'resources', 'bin', 'ffmpeg.exe'))) throw new Error('不应内置 ffmpeg')
  if (existsSync(join(portable, 'resources', 'bin', 'ffprobe.exe'))) throw new Error('不应内置 ffprobe')
  if (!readFileSync(join(portable, 'data', 'db', 'whichvideo.db'), 'utf8').startsWith('keep-')) {
    throw new Error('data 未保留')
  }
  const note = readFileSync(join(portable, '便携版说明.txt'), 'utf8')
  if (/[A-Z]:\\/i.test(note)) throw new Error('说明文件泄漏了构建机绝对路径')
}
console.log('Tauri 便携版自检通过：双份轻量产物、不内置媒体工具、data 保留、路径可见性')
rmSync(work, { recursive: true, force: true })
