/**
 * 校准脚本：确认「查询图（PNG，经 YUV 往返）」与「视频帧（raw RGB）」之间的
 * 哈希距离量级，用于设定自检与默认阈值。
 *
 * 运行： node scripts/calibrate.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const work = join(root, 'tmp', 'calibrate')

const ff = 'D:/program/ffmpeg/bin/ffmpeg.exe'

function run(args, out) {
  const full = [...args, ...(out ? [out] : [])]
  const r = spawnSync(ff, ['-hide_banner', '-v', 'error', '-y', ...full], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`ffmpeg 失败: ${full.join(' ')}`)
}

async function main() {
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  const shared = join(root, 'out-e2e', 'shared', 'hash.js')
  const { computeFastFrameHash, hamming64Bytes } = await import(pathToFileURL(shared).href)

  const W = 320
  const sources = [
    ['testsrc2=size=640x360:rate=25:duration=6', 'testsrc2'],
    ['smptebars=size=640x360:rate=25:duration=6', 'bars'],
    ['color=c=0x1b3a6b:size=480x270:rate=25:duration=6', 'blue'],
    ['color=c=0x6b1b3a:size=480x270:rate=25:duration=6', 'red'],
    ['testsrc=size=640x360:rate=25:duration=6', 'testsrc']
  ]

  const hashes = {}

  for (const [source, name] of sources) {
    // 1) 直接取 raw RGB（模拟抽帧）
    const rawPath = join(work, `${name}.rgb`)
    run(
      ['-f', 'lavfi', '-i', source, '-ss', '3', '-frames:v', '1', '-vf', `scale=w=${W}:h=-2`, '-pix_fmt', 'rgb24', '-f', 'rawvideo'],
      rawPath
    )
    const rgb = readFileSync(rawPath)
    const height = rgb.length / (W * 3)
    hashes[name] = {
      raw: computeFastFrameHash({ width: W, height, channels: 3, order: 'rgb', data: rgb }).hash,
      // 2) 同一帧存成 PNG 再读回来（模拟用户截图/海报）
      png: (() => {
        run(
          ['-f', 'lavfi', '-i', source, '-ss', '3', '-frames:v', '1', '-vf', `scale=w=${W}:h=-2`, join(work, `${name}.png`)],
          null
        )
        const pngPath = join(work, `${name}.png`)
        const rawBack = join(work, `${name}.back.rgb`)
        run(['-i', pngPath, '-vf', `scale=w=${W}:h=-2`, '-pix_fmt', 'rgb24', '-f', 'rawvideo'], rawBack)
        const back = readFileSync(rawBack)
        const h = back.length / (W * 3)
        return computeFastFrameHash({ width: W, height: h, channels: 3, order: 'rgb', data: back }).hash
      })()
    }
  }

  console.log('\n同源帧 raw↔png 距离 / 跨源距离矩阵（dHash 前 8 字节）：\n')
  const names = sources.map((s) => s[1])
  process.stdout.write('        ' + names.map((n) => n.padEnd(10)).join('') + '\n')
  for (const a of names) {
    const row = []
    for (const b of names) {
      const d = hamming64Bytes(hashes[a].png, hashes[b].raw, 0)
      row.push(String(d).padEnd(10))
    }
    console.log(a.padEnd(8) + row.join(''))
  }

  console.log('\n自相似（同一源 png vs raw）：')
  for (const n of names) {
    console.log(`  ${n.padEnd(10)} dHash 距离 = ${hamming64Bytes(hashes[n].png, hashes[n].raw, 0)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
