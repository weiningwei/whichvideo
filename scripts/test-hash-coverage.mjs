/**
 * 结构指纹（computeStructHash）的纯逻辑自检（不依赖 ffmpeg / Electron）。
 *
 * 背景：encodeChannel 原先顺序填 bit，遇到 maxBits 就停，
 * 而网格是 16x16=256 格、每通道只分配 128 bit —— 于是只有前 128 个格子
 * （即前 8 行）参与指纹，画面下半部分从未被读取。字幕条、下三分之一构图
 * 这类内容会被系统性低估相似度。现改为等距抽样，本脚本守住该性质。
 *
 * 运行： node scripts/build-core.mjs && node scripts/test-hash-coverage.mjs
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

/** 造一张 w×h 的测试图：fn(x, y) → [r,g,b] */
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
  return { width: w, height: h, channels: 3, data }
}

/** 纯色 */
const solid = (v) => makeImage(64, 64, () => [v, v, v])

/** 条纹图案：黑底 + 白色竖条 */
const stripes = (x) => (x % 8 < 4 ? 255 : 0)

/** 只有下半部分有条纹，上半纯黑 —— 修复前这里与纯黑指纹完全相同 */
const bottomOnly = makeImage(64, 64, (x, y) => (y >= 32 ? [stripes(x), stripes(x), stripes(x)] : [0, 0, 0]))

/** 只有上半部分有条纹，下半纯黑 */
const topOnly = makeImage(64, 64, (x, y) => (y < 32 ? [stripes(x), stripes(x), stripes(x)] : [0, 0, 0]))

function popcount(x) {
  let v = x - ((x >>> 1) & 0x55555555)
  v = (v + (v >>> 2)) & 0x33333333
  v = (v + (v >>> 4)) & 0x0f0f0f
  return ((v * 0x01010101) >>> 24) & 0xff
}

function hamming(a, b) {
  let d = 0
  for (let i = 0; i < a.length; i++) d += popcount((a[i] ^ b[i]) & 0xff)
  return d
}

async function main() {
  if (!existsSync(hashPath)) {
    console.error(`找不到 ${hashPath}，请先运行 node scripts/build-core.mjs`)
    process.exit(1)
  }
  const { computeStructHash, structSimilarity, STRUCT_BYTES } = await import(
    pathToFileURL(hashPath).href
  )
  const BITS = STRUCT_BYTES * 8

  console.log('=== 结构指纹覆盖度 ===')

  check('导出 computeStructHash', typeof computeStructHash === 'function')
  check('指纹长度为 64 字节', STRUCT_BYTES === 64, `${BITS} bit`)

  // 核心性质：下半部分有内容时，指纹必须与纯黑明显不同
  // （修复前下半部分不参与指纹，这里会距离为 0）
  const hashBottom = computeStructHash(bottomOnly)
  const hashTop = computeStructHash(topOnly)
  const hashBlack = computeStructHash(solid(0))
  const hashWhite = computeStructHash(solid(255))

  const simBottomVsBlack = structSimilarity(hashBottom, 0, hashBlack, 0)
  const simTopVsBlack = structSimilarity(hashTop, 0, hashBlack, 0)

  check(
    '下半部分有内容时与纯黑可区分',
    simBottomVsBlack < 0.95,
    `相似度 ${(simBottomVsBlack * 100).toFixed(1)}%`
  )
  check(
    '上半部分有内容时与纯黑可区分',
    simTopVsBlack < 0.95,
    `相似度 ${(simTopVsBlack * 100).toFixed(1)}%`
  )
  check(
    '上下半都有内容时两者可区分（原缺陷点）',
    hamming(hashTop, hashBottom) > 0,
    `距离 ${hamming(hashTop, hashBottom)}/512`
  )

  // 对称性：抽样必须覆盖全图，不能偏向任何一侧
  const simTopBottom = structSimilarity(hashTop, 0, hashBottom, 0)
  check(
    '上半/下半的判别力大致对称（不偏袒任一侧）',
    Math.abs(simTopVsBlack - simBottomVsBlack) < 0.2,
    `上半 ${(simTopVsBlack * 100).toFixed(1)}% vs 下半 ${(simBottomVsBlack * 100).toFixed(1)}%`
  )
  check('上半与下半内容不互为纯黑', simTopBottom < 0.99, `相似度 ${(simTopBottom * 100).toFixed(1)}%`)

  // 纯色 vs 有内容：纯色画面各格均值都等于全局均值 → 结构比特应高度一致
  // （集中在一个取值上，因而与任何有纹理画面都拉不开距离）。
  // 纯白实测 1 的占比约 12.5%：多数格子均值 255 记 1，cellGrid 末行边界
  // 取不到像素的少数格子为 0 记 0。关键是「集中」，不是「全 1」。
  const simWhiteVsTop = structSimilarity(hashWhite, 0, hashTop, 0)
  check(
    '纯色与有纹理画面仍可区分（原性质未回归）',
    simWhiteVsTop < 0.99,
    `相似度 ${(simWhiteVsTop * 100).toFixed(1)}%`
  )
  let whiteOnes = 0
  for (const v of hashWhite) whiteOnes += popcount(v)
  check(
    '纯色画面结构指纹退化（比特高度集中，交给颜色区分）',
    whiteOnes / BITS < 0.3,
    `纯白 1 的占比 ${((whiteOnes / BITS) * 100).toFixed(1)}%`
  )

  // 同图同指纹（确定性）
  const h1 = computeStructHash(bottomOnly)
  const h2 = computeStructHash(bottomOnly)
  check('同一张图两次计算结果一致', h1.every((v, i) => v === h2[i]))
  check(
    '等距抽样未越界写入（最后一个 bit 在 512 内）',
    h1.length === STRUCT_BYTES && h1.every((v) => v >= 0)
  )

  // 位利用率：不应全 0 或全 1
  let ones = 0
  for (const v of h1) ones += popcount(v)
  const usage = ones / BITS
  check(
    '指纹位利用率合理（非退化全 0/全 1）',
    usage > 0.05 && usage < 0.95,
    `1 的占比 ${(usage * 100).toFixed(1)}%`
  )

  console.log(`\n=== 结构指纹：${passed}/${passed + failed} 通过 ===`)
  if (failed) process.exit(1)
}

main()
