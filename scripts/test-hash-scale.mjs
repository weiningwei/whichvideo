/**
 * 指纹的分辨率不变性自检（不依赖 ffmpeg / Electron）。
 *
 * 背景：视频帧抽帧时统一缩放到 320 宽（scan.ts::EXTRACT_WIDTH），而查询图
 * （用户丢进来的截图）**保持原始分辨率**（index.ts::nativeImageToImageData
 * 直接用 nativeImage 的原始尺寸）。两者分辨率必然不同，所以指纹必须对尺度
 * 不敏感，否则"截图分辨率 ≠ 视频帧分辨率"就会漏召回。
 *
 * 性质来自两处设计：
 *   · toGray 用盒式滤波把整幅图重采样到固定 9×8 / 16×16 网格，与源图尺寸无关；
 *   · encodeChannel 比较的是「格子均值 vs 该通道全局均值」，是相对量而非绝对值。
 * 所以同一画面无论渲染成 160 宽还是 1920 宽，指纹应完全一致。
 *
 * 运行： node scripts/build-core.mjs && node scripts/test-hash-scale.mjs
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const hashPath = join(root, 'out-e2e', 'shared', 'hash.js')

let failed = 0
let passed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

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
const dhashDistance = (a, b) => {
  const split = (v) => [
    Number(BigInt.asUintN(32, BigInt(v) >> BigInt(32))) >>> 0,
    Number(BigInt.asUintN(32, BigInt(v))) >>> 0
  ]
  const [ah, al] = split(a)
  const [bh, bl] = split(b)
  return popcount((ah ^ bh) >>> 0) + popcount((al ^ bl) >>> 0)
}

/** 用归一化坐标定义画面内容，保证不同分辨率下"看到的是同一个画面" */
const CONTENT = (u, v) => {
  const band = Math.floor(v * 3)
  if (band === 0) return [220, 30, 60]
  if (band === 1) return [40, 180, 90]
  return [u * 255, v * 255, 128]
}
const gen = (w, h) => makeImage(w, h, (x, y) => CONTENT(x / w, y / h))
/** 叠加细微噪声，模拟截图被 JPEG 再压缩过 */
const genNoisy = (w, h) =>
  makeImage(w, h, (x, y) => {
    const [r, g, b] = CONTENT(x / w, y / h)
    const n = ((x * 7 + y * 13) % 11) - 5
    return [
      Math.max(0, Math.min(255, r + n)),
      Math.max(0, Math.min(255, g + n)),
      Math.max(0, Math.min(255, b + n))
    ]
  })

async function main() {
  if (!existsSync(hashPath)) {
    console.error(`找不到 ${hashPath}，请先运行 node scripts/build-core.mjs`)
    process.exit(1)
  }
  const { toGray, computeDHash, computeStructHash, computeColorHistogram, structSimilarity } =
    await import(pathToFileURL(hashPath).href)

  console.log('=== 分辨率不变性 ===')
  console.log('  视频帧缩放到 320 宽，查询图保持原分辨率；两者尺度必须不同也能匹配。')
  console.log('')

  // 基准取抽帧后的典型尺寸 320x180
  const base = gen(320, 180)
  const baseDHash = computeDHash(toGray(base, 9, 8))
  const baseStruct = computeStructHash(base)

  // 覆盖从远小于到远大于 320 的各种分辨率
  const sizes = [
    [160, 90],    // 比抽帧宽度小一半
    [256, 144],
    [320, 180],   // 与抽帧宽度相同
    [640, 360],
    [1280, 720],
    [1920, 1080], // 典型桌面截图
    [2560, 1440]  // 2K 屏
  ]

  console.log('  分辨率        dHash距离  结构距离  结构相似度')
  for (const [w, h] of sizes) {
    const img = gen(w, h)
    const d = dhashDistance(computeDHash(toGray(img, 9, 8)), baseDHash)
    const s = hamming(computeStructHash(img), baseStruct)
    console.log(
      `  ${String(w).padStart(4)}x${String(h).padEnd(5)} ${String(d).padStart(9)} ${String(s).padStart(9)}  ${(structSimilarity(computeStructHash(img), 0, baseStruct, 0) * 100).toFixed(1).padStart(9)}%`
    )
  }
  console.log('')

  // 核心性质：同一画面、不同分辨率，结构距离必须为 0
  let worst = 0
  for (const [w, h] of sizes) {
    if (w === 320) continue
    worst = Math.max(worst, hamming(computeStructHash(gen(w, h)), baseStruct))
  }
  check('同一画面在 160~2560 宽之间结构距离恒为 0', worst === 0, `最大距离 ${worst}`)

  // dHash 允许有微小差异（它只比较相邻像素，边界处理会受尺度影响）
  let worstD = 0
  for (const [w, h] of sizes) {
    worstD = Math.max(worstD, dhashDistance(computeDHash(toGray(gen(w, h), 9, 8)), baseDHash))
  }
  check('dHash 距离始终远小于剪枝阈值 24', worstD < 24, `最大 ${worstD}`)

  // 再压缩噪声下仍应保持一致
  console.log('')
  console.log('  同一画面 + JPEG 噪声：')
  let noisyWorst = 0
  for (const [w, h] of [[320, 180], [1280, 720], [1920, 1080]]) {
    const img = genNoisy(w, h)
    const s = hamming(computeStructHash(img), baseStruct)
    noisyWorst = Math.max(noisyWorst, s)
    const d = dhashDistance(computeDHash(toGray(img, 9, 8)), baseDHash)
    console.log(
      `    ${String(w).padStart(4)}x${String(h).padEnd(5)}  dHash ${String(d).padStart(3)}  结构距离 ${String(s).padStart(3)}/512  相似度 ${(structSimilarity(computeStructHash(img), 0, baseStruct, 0) * 100).toFixed(1)}%`
    )
  }
  check('再压缩噪声下结构距离仍为 0', noisyWorst === 0, `最大 ${noisyWorst}`)

  // 对照：不同内容必须明显拉得开，否则上面那些 0 就没有意义
  const other = makeImage(1920, 1080, (x, y) => {
    const band = Math.floor((x / 1920) * 3)
    return band === 0 ? [20, 200, 220] : band === 1 ? [200, 40, 40] : [40, 40, 200]
  })
  const otherDist = hamming(computeStructHash(other), baseStruct)
  check('不同画面仍明显拉得开（≥100/512）', otherDist >= 100, `${otherDist}/512`)

  // 颜色直方图同样对分辨率稳定
  const histSmall = computeColorHistogram(gen(320, 180))
  const histBig = computeColorHistogram(gen(1920, 1080))
  let diff = 0
  for (let i = 0; i < histSmall.length; i++) {
    diff = Math.max(diff, Math.abs(histSmall[i] - histBig[i]))
  }
  check('颜色直方图在 320 与 1920 宽下几乎一致', diff < 0.02, `最大桶差 ${diff.toFixed(4)}`)

  // 归一化的依据：均值比较而非绝对值
  const inverted = makeImage(320, 180, (x, y) => {
    const [r, g, b] = CONTENT(1 - x / 320, y / 180)
    return [r, g, b]
  })
  check(
    '左右翻转后仍能匹配（说明只比较相对关系）',
    hamming(computeStructHash(inverted), baseStruct) < 100,
    `${hamming(computeStructHash(inverted), baseStruct)}/512`
  )

  console.log(`\n=== 分辨率不变性：${passed}/${passed + failed} 通过 ===`)
  if (failed) process.exit(1)
}

main()
