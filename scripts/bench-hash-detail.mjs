/**
 * 指纹各阶段的可视化自检（不依赖 ffmpeg / Electron）。
 *
 * 用途：README「检索原理」里引用的所有数字（dHash 位数、结构指纹每通道抽样步长、
 * 纯色退化比例、各类画面之间的距离量级、单帧耗时）都由本脚本产出，
 * 避免文档与实现漂移。改 hash.ts 后跑一遍即可核对。
 *
 * 运行： node scripts/build-core.mjs && node scripts/bench-hash-detail.mjs
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const hashPath = join(root, 'out-e2e', 'shared', 'hash.js')

function makeImage(w, h, fn) {
  const data = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y)
      const i = (y * w + x) * 3
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
    }
  }
  return { width: w, height: h, channels: 3, order: 'rgb', data }
}

const popcount = (x) => {
  let v = x - ((x >>> 1) & 0x55555555)
  v = (v + (v >>> 2)) & 0x33333333
  v = (v + (v >>> 4)) & 0x0f0f
  return ((v * 0x01010101) >>> 24) & 0xff
}
const hamming = (a, b) => {
  let d = 0
  for (let i = 0; i < a.length; i++) d += popcount((a[i] ^ b[i]) & 0xff)
  return d
}
const onesOf = (bytes) => {
  let n = 0
  for (const v of bytes) n += popcount(v)
  return n
}

/** 有真实结构的测试图：色块 + 渐变（纯色或纯渐变会让指纹退化，测不出分离度） */
function structuredImage(delta = 0) {
  return makeImage(64, 64, (x, y) => {
    const band = Math.floor(y / 16)
    const r = band === 0 ? 220 + delta : band === 1 ? 40 + delta : x * 3
    const g = band === 0 ? 30 + delta : band === 1 ? 180 + delta : y * 3
    const b = band === 0 ? 60 : band === 1 ? 90 + delta : 128
    return [r & 255, g & 255, b & 255]
  })
}

async function main() {
  if (!existsSync(hashPath)) {
    console.error(`找不到 ${hashPath}，请先运行 node scripts/build-core.mjs`)
    process.exit(1)
  }
  const {
    toGray, computeDHash, computeStructHash, computeColorHistogram,
    structSimilarity, STRUCT_BYTES, COLOR_BINS
  } = await import(pathToFileURL(hashPath).href)
  const BITS = STRUCT_BYTES * 8

  const img = structuredImage()

  console.log('=== ① 灰度化 toGray：盒式滤波缩到 9x8 ===')
  const gray = toGray(img, 9, 8)
  for (let y = 0; y < 8; y++) {
    console.log(
      '  ' + Array.from({ length: 9 }, (_, x) => gray.g[y * 9 + x].toFixed(0).padStart(5)).join('')
    )
  }
  const spread = Math.max(...gray.g) - Math.min(...gray.g)
  console.log(`  灰度跨度 ${spread.toFixed(0)}（> 0 说明图有结构，不是纯色/纯渐变）`)

  console.log('\n=== ② dHash：9x8 灰度的水平相邻比较 → 64bit ===')
  const dhash = computeDHash(gray)
  let dOnes = 0
  for (const half of [
    Number(BigInt.asUintN(32, BigInt(dhash) >> BigInt(32))) >>> 0,
    Number(BigInt.asUintN(32, BigInt(dhash))) >>> 0
  ]) {
    for (let i = 0; i < 32; i++) dOnes += (half >>> i) & 1
  }
  console.log(`  dhash = ${dhash.toString(16).padStart(16, '0')}，64 bit 中 ${dOnes} 个 1`)
  console.log('  位数来源：8 行 × (9-1) 组相邻比较 = 64')

  console.log('\n=== ③ 结构指纹：16x16 网格 × 4 通道 = 1024 格，全量 1024 bit ===')
  const st = computeStructHash(img)
  let offset = 0
  const chName = ['Y(亮度)', 'R', 'G', 'B']
  for (let c = 0; c < 4; c++) {
    let n = 0
    for (let b = 0; b < 32; b++) n += popcount(st[offset + b])
    console.log(`  通道 ${chName[c]}：256 bit 中 ${String(n).padStart(3)} 个 1（${((n / 256) * 100).toFixed(1)}%）`)
    offset += 32
  }
  console.log(`  合计 ${onesOf(st)} / ${BITS} 个 1（${((onesOf(st) / BITS) * 100).toFixed(1)}%）`)
  console.log(`  网格 16×16 = 256 格，每通道 256 格全量（不再抽样）`)

  console.log('\n=== ④ 颜色直方图 4×4×4 ===')
  const hist = computeColorHistogram(img)
  let nz = 0
  let dominant = 0
  for (const v of hist) {
    if (v > 0) nz++
    if (v > dominant) dominant = v
  }
  let sum = 0
  for (const v of hist) sum += v
  console.log(`  ${COLOR_BINS} 个分桶，非空 ${nz} 个，总和 ${sum.toFixed(4)}（应为 1）`)
  console.log(`  colorfulness（主导桶占比）= ${dominant.toFixed(3)}，决定打分时颜色的权重`)

  console.log('\n=== ⑤ 纯色图：结构指纹为何退化 ===')
  for (const v of [0, 128, 255]) {
    const solid = makeImage(64, 64, () => [v, v, v])
    const hsh = computeStructHash(solid)
    const hh = computeColorHistogram(solid)
    let m = 0
    for (const x of hh) if (x > m) m = x
    console.log(
      `  纯色 ${String(v).padStart(3)}：结构 1 占比 ${((onesOf(hsh) / BITS) * 100).toFixed(1)}%，颜色主导桶 ${m.toFixed(2)}`
    )
  }
  console.log('  → 各格均值都等于全局均值 → 比特高度集中，与有纹理画面拉不开距离')
  console.log('  → 此时靠颜色直方图区分，搜索会自动把颜色权重升到 0.7')

  console.log('\n=== ⑥ 距离矩阵（结构指纹 1024bit）===')
  const imgs = {
    纯白: makeImage(64, 64, () => [255, 255, 255]),
    结构图: img,
    '同图改几十个像素': structuredImage(12),
    横条纹: makeImage(64, 64, (x, y) => ((Math.floor(y / 4) % 2) ? [255, 255, 255] : [0, 0, 0])),
    噪点: makeImage(64, 64, (x, y) => [
      (x * 37 + y * 91) % 256, (x * 13 + y * 47) % 256, (x * 61 + y * 29) % 256
    ])
  }
  const keys = Object.keys(imgs)
  console.log('            ' + keys.map((k) => k.padStart(18)).join(''))
  for (const a of keys) {
    const ha = computeStructHash(imgs[a])
    console.log(
      a.padEnd(12) + keys.map((b) => String(hamming(ha, computeStructHash(imgs[b]))).padStart(18)).join('')
    )
  }
  console.log('\n  自相似度（恒为 1.0）:')
  for (const k of keys) {
    const hk = computeStructHash(imgs[k])
    console.log(`    ${k.padEnd(18)} ${structSimilarity(hk, 0, hk, 0).toFixed(4)}`)
  }

  console.log('\n=== ⑦ 单帧耗时（320x180，三个指纹合计）===')
  const W = 320
  const H = 180
  const frame = makeImage(W, H, (x, y) => [(x * 3) % 256, (y * 5) % 256, (x + y) % 256])
  for (let i = 0; i < 10; i++) computeStructHash(frame) // 预热
  const N = 64
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    const f = makeImage(W, H, (x, y) => [(x * 3 + i) % 256, (y * 5) % 256, (x + y + i) % 256])
    const g = toGray(f, 9, 8)
    computeDHash(g)
    computeStructHash(f)
    computeColorHistogram(f)
  }
  const perFrame = (performance.now() - t0) / N
  console.log(`  三个指纹合计 ${perFrame.toFixed(3)} ms/帧（${N} 帧平均）`)
  console.log(`  1 小时视频 240 帧 → 约 ${((perFrame * 240) / 1000).toFixed(1)} 秒`)
}

main()
