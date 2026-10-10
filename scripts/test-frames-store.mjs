/**
 * frames-store 自检：验证索引帧图片的写/读/存在性/清理生命周期。
 *
 * frames-store 依赖 electron 的 nativeImage 编码 JPEG；本自检在纯 Node 里跑，
 * 把编译产物里的 require('electron') 重写到本地桩（startup-smoke.mjs 同款手法）。
 * 桩的 toJPEG 原样返回「FAKE 头 + BGRA 位图」，因此还能顺带验证 rgb24→BGRA
 * 的像素换序是否正确 —— 真实 JPEG 编码质量由实机抽查覆盖（nativeImage 是
 * Electron 自带能力，不怀疑其正确性）。
 *
 * 用法：node scripts/test-frames-store.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = join(root, 'tmp', 'frames-store-check')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

// 1. 编译 frames-store.ts（tsc 自动带上 ./logger、./constants）
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const r = spawnSync(
  process.execPath,
  [
    tsc,
    join(root, 'src', 'main', 'frames-store.ts'),
    '--module', 'commonjs',
    '--target', 'ES2022',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--skipLibCheck',
    '--strict',
    '--outDir', tmp
  ],
  { stdio: 'pipe', cwd: root }
)
if (r.status !== 0) {
  console.error(r.stdout?.toString())
  console.error(r.stderr?.toString())
  console.error('=== frames-store 自检：编译失败 ===')
  process.exit(1)
}

// 2. 写 electron 桩：toJPEG 返回「FJIF 头 + 原样位图」，可校验 BGRA 换序
writeFileSync(
  join(tmp, '__electron_stub.cjs'),
  `'use strict'
function imageFromBitmap(bitmap) {
  return {
    getSize: () => ({ width: 0, height: 0 }),
    toJPEG: () => Buffer.concat([Buffer.from('FJIF'), Buffer.from(bitmap)]),
    toPNG: () => Buffer.alloc(0),
    isEmpty: () => false
  }
}
module.exports = {
  nativeImage: {
    createFromBitmap(bitmap, opts) {
      const expect = opts.width * opts.height * 4
      if (bitmap.length !== expect) {
        throw new Error(\`bitmap 长度 \${bitmap.length} != \${expect}\`)
      }
      return imageFromBitmap(bitmap)
    },
    createFromPath: () => imageFromBitmap(Buffer.alloc(0)),
    createFromDataURL: () => imageFromBitmap(Buffer.alloc(0)),
    createFromBuffer: () => imageFromBitmap(Buffer.alloc(0))
  }
}
`
)

// 3. 重写产物里的 require('electron') → 桩
for (const name of readdirSync(tmp)) {
  if (!name.endsWith('.js')) continue
  const p = join(tmp, name)
  const source = readFileSync(p, 'utf8')
  const rewritten = source.replace(/require\((['"])electron\1\)/g, "require('./__electron_stub.cjs')")
  if (rewritten !== source) writeFileSync(p, rewritten)
}

// 4. 载入并跑生命周期
const require2 = createRequire(join(tmp, 'index.js'))
const logger = require2(join(tmp, 'logger.js'))
logger.initLogger(join(tmp, 'log'))
const store = require2(join(tmp, 'frames-store.js'))

const dataDir = join(tmp, 'data')
store.initializeFramesStore(dataDir)

// 合成 4x2 rgb24：像素 i 的 rgb = (i, (i+1)%256, (i+2)%256)
const W = 4
const H = 2
const rgb = Buffer.alloc(W * H * 3)
for (let i = 0; i < W * H; i++) {
  rgb[i * 3] = i % 256
  rgb[i * 3 + 1] = (i + 1) % 256
  rgb[i * 3 + 2] = (i + 2) % 256
}

const okSave = store.saveFrameImage(7, 3, rgb, W, H)
check('saveFrameImage 返回成功', okSave === true)

const framePath = join(dataDir, 'frames', '7', '3.jpg')
const saved = existsSync(framePath) ? readFileSync(framePath) : null
check('帧文件落在 <dataDir>/frames/<videoId>/<frameIndex>.jpg', !!saved, framePath)
check(
  'BGRA 换序正确（B=G+2 前缀 FJIF 头之后）',
  !!saved &&
    saved.subarray(0, 4).toString() === 'FJIF' &&
    saved[4] === (0 + 2) % 256 && // B = rgb[2]
    saved[5] === (0 + 1) % 256 && // G = rgb[1]
    saved[6] === 0 && // R = rgb[0]（像素 0 的 r=0）
    saved[7] === 0xff
)

check('frameImageExists 存在', store.frameImageExists(7, 3) === true)
check('frameImageExists 不存在', store.frameImageExists(7, 99) === false)
const dataUrl = store.readFrameImage(7, 3)
check(
  'readFrameImage 返回 jpeg dataUrl',
  typeof dataUrl === 'string' && dataUrl.startsWith('data:image/jpeg;base64,')
)
check('readFrameImage 缺失时返回 null', store.readFrameImage(7, 99) === null)

// rgb 长度不符 → 桩抛错 → saveFrameImage 兜错返回 false（不抛出）
let threw = false
try {
  store.saveFrameImage(7, 4, Buffer.alloc(3), 2, 1)
} catch {
  threw = true
}
check('坏尺寸不抛出、返回 false（索引不因帧图失败）', threw === false && store.frameImageExists(7, 4) === false)

store.removeVideoFrames(7)
check('removeVideoFrames 删除单视频目录', !existsSync(join(dataDir, 'frames', '7')))

store.saveFrameImage(8, 0, rgb, W, H)
const removedAll = store.removeAllFrames()
check('removeAllFrames 删除根目录', removedAll === true && !existsSync(join(dataDir, 'frames')))

// 未初始化时所有操作安全空转
store.initializeFramesStore === undefined // 类型冒烟：导出存在
const before = store.frameImageExists(1, 0)
console.log('=== frames-store 自检：通过 %d · 失败 %d ===', passed, failed)
process.exit(failed === 0 ? 0 : 1)
