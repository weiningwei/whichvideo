/**
 * 打分公式对比实验：在"真实截图 → 视频帧"的场景下，比较几种结构指纹 + 颜色加权方案，
 * 输出每个用例里"正确答案"与"最像的错误答案"的分数差。
 *
 * 运行： node scripts/bench-score.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const work = join(root, 'tmp', 'bench-score')
const FF = 'D:/program/ffmpeg/bin/ffmpeg.exe'
const F = 320

function ff(args, out) {
  const r = spawnSync(FF, ['-hide_banner', '-v', 'error', '-y', ...args, ...(out ? [out] : [])], {
    stdio: 'inherit'
  })
  if (r.status !== 0) throw new Error(`ffmpeg 失败: ${args.join(' ')}`)
}

function rawAt(source, frameIndex) {
  const out = join(work, `r-${Math.random().toString(36).slice(2)}.rgb`)
  ff(
    [
      '-f',
      'lavfi',
      '-i',
      source,
      '-vf',
      `select=eq(n\\,${frameIndex}),scale=w=${F}:h=-2`,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo'
    ],
    out
  )
  const data = readFileSync(out)
  rmSync(out, { force: true })
  return { width: F, height: data.length / (F * 3), channels: 3, order: 'rgb', data }
}

function pngAt(source, frameIndex) {
  const out = join(work, `p-${Math.random().toString(36).slice(2)}.png`)
  ff(
    ['-f', 'lavfi', '-i', source, '-vf', `select=eq(n\\,${frameIndex}),scale=w=${F}:h=-2`, '-frames:v', '1'],
    out
  )
  return out
}

function rgbOfPng(png) {
  const out = join(work, `i-${Math.random().toString(36).slice(2)}.rgb`)
  ff(['-i', png, '-vf', `scale=w=${F}:h=-2`, '-pix_fmt', 'rgb24', '-f', 'rawvideo'], out)
  const data = readFileSync(out)
  rmSync(out, { force: true })
  return { width: F, height: data.length / (F * 3), channels: 3, order: 'rgb', data }
}

function cellGrid(w, h, size, at) {
  const out = new Float32Array(size * size)
  const xr = w / size
  const yr = h / size
  for (let j = 0; j < size; j++) {
    const y0 = Math.floor(j * yr)
    const y1 = Math.max(y0 + 1, Math.floor((j + 1) * yr))
    for (let i = 0; i < size; i++) {
      const x0 = Math.floor(i * xr)
      const x1 = Math.max(x0 + 1, Math.floor((i + 1) * xr))
      let s = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          s += at(y * w + x)
          n++
        }
      }
      out[j * size + i] = n ? s / n : 0
    }
  }
  return out
}

/** 采样函数集合 */
function samplers(img) {
  const { width: w, channels, data } = img
  const luma = (idx) => {
    const b = idx * channels
    return 0.299 * data[b] + 0.587 * data[b + 1] + 0.114 * data[b + 2]
  }
  const chan = (c) => (idx) => {
    const b = idx * channels
    return c === 0 ? data[b] : c === 1 ? data[b + 1] : data[b + 2]
  }
  return { w, luma, chan }
}

/** 结构指纹：64bit dHash + 512bit 均值归一化（16x16 网格 × 4 通道） */
function structHash(img) {
  const { w, h } = img
  const { luma, chan } = samplers(img)
  const bits = new Uint8Array(8 + 64)
  // 64bit dHash（9x8）
  let bit = 0
  const g98 = cellGrid(w, h, 8, (idx) => luma(idx))
  // 8x8 网格：横向比较产生 8*7=56 bit，补齐到 64 用纵向
  for (let j = 0; j < 8; j++) {
    for (let i = 0; i < 7; i++) {
      if (g98[j * 8 + i] < g98[j * 8 + i + 1]) bits[bit >> 3] |= 1 << (bit & 7)
      bit++
    }
  }
  for (let i = 0; i < 8; i++) {
    if (g98[i] < g98[8 + i]) bits[bit >> 3] |= 1 << (bit & 7)
    bit++
  }
  // 512bit 均值归一化：Y/R/G/B 各 16x16=256bit
  let off = 64
  for (const fn of [luma, chan(0), chan(1), chan(2)]) {
    const g = cellGrid(w, h, 16, (idx) => fn(idx))
    let sum = 0
    for (const v of g) sum += v
    const mean = sum / g.length
    for (const v of g) {
      if (v >= mean) bits[off >> 3] |= 1 << (off & 7)
      off++
    }
  }
  return bits
}

function colorHist(img) {
  const { width: w, height: h, channels, data } = img
  const out = new Float32Array(64)
  let total = 0
  for (let y = 0; y < h; y++) {
    let base = y * w * channels
    for (let x = 0; x < w; x++) {
      const r = data[base]
      const g = data[base + 1]
      const b = data[base + 2]
      out[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)] += 1
      total++
      base += channels
    }
  }
  if (total) for (let i = 0; i < 64; i++) out[i] /= total
  return out
}

function hamming(a, b, aOff = 0, bOff = 0, bytes = 64) {
  let d = 0
  for (let i = 0; i < bytes; i++) {
    let x = (a[aOff + i] ^ b[bOff + i]) >>> 0
    x = x - ((x >>> 1) & 0x55555555)
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
    x = (x + (x >>> 4)) & 0x0f0f0f0f
    d += (x * 0x01010101) >>> 24
  }
  return d
}

function histSim(a, b) {
  let s = 0
  for (let i = 0; i < 64; i++) s += Math.min(a[i], b[i])
  return Math.min(1, s)
}

/** 颜色鲜明度：颜色直方图的主导分桶占比 */
function colorfulness(hist) {
  let max = 0
  for (const v of hist) if (v > max) max = v
  return max
}

const variants = {
  'W1 结构0.7/颜色0.3': (st, cs) => st * 0.7 + cs * 0.3,
  'W2 结构0.4/颜色0.6': (st, cs) => st * 0.4 + cs * 0.6,
  'W3 自适应(0.3~0.6 颜色)': (st, cs, conf) => {
    const wc = 0.3 + 0.4 * conf
    return st * (1 - wc) + cs * wc
  }
}

async function main() {
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  const library = {
    flatBlue: 'color=c=0x1b3a6b:size=480x270:rate=25',
    flatAmber: 'color=c=0x6b5a1b:size=480x270:rate=25',
    flatGray: 'color=c=0x404040:size=480x270:rate=25',
    testsrc2: 'testsrc2=size=640x360:rate=25',
    testsrc: 'testsrc=size=640x360:rate=25',
    bars: 'smptebars=size=640x360:rate=25'
  }

  const cases = [
    { name: '纯蓝截图 → 纯蓝', query: 'flatBlue', expect: 'flatBlue' },
    { name: '暗黄截图 → 暗黄', query: 'flatAmber', expect: 'flatAmber' },
    { name: '灰底截图 → 灰底', query: 'flatGray', expect: 'flatGray' },
    { name: '动态图案截图 → 动态图案', query: 'testsrc2', expect: 'testsrc2' },
    { name: '渐变图截图 → 渐变图', query: 'testsrc', expect: 'testsrc' },
    { name: '彩条截图 → 彩条', query: 'bars', expect: 'bars' },
    { name: '库里没有的图 → 期望低分', query: 'mandelbrot=size=640x360:rate=25', expect: null }
  ]

  const libData = {}
  for (const [k, src] of Object.entries(library)) {
    libData[k] = { struct: structHash(rawAt(src, 100)), color: colorHist(rawAt(src, 100)) }
  }

  const queryData = {}
  for (const c of cases) {
    const src = library[c.query] ?? c.query
    const img = rgbOfPng(pngAt(src, 100))
    queryData[c.name] = { struct: structHash(img), color: colorHist(img) }
  }

  for (const [vname, fn] of Object.entries(variants)) {
    console.log(`\n=== ${vname} ===`)
    for (const c of cases) {
      const q = queryData[c.name]
      const conf = colorfulness(q.color)
      const scored = Object.entries(libData).map(([k, v]) => {
        const d = hamming(q.struct, v.struct, 0, 0, 64) // 512bit 结构
        const struct = 1 - d / 512
        const color = histSim(q.color, v.color)
        return { k, score: fn(struct, color, conf), struct, color }
      })
      scored.sort((a, b) => b.score - a.score)
      const top = scored[0]
      const expected = c.expect ? scored.find((s) => s.k === c.expect) : null
      const others = scored.filter((s) => s.k !== c.expect)
      const runnerUp = others[0]
      const pass = c.expect ? top.k === c.expect : top.score < 0.8
      console.log(
        `  ${pass ? '✓' : '✗'} ${c.name.padEnd(24)} top=${top.k.padEnd(10)} ${top.score.toFixed(3)}` +
          (expected ? ` | 期望项 ${expected.score.toFixed(3)}，次优 ${runnerUp.k} ${runnerUp.score.toFixed(3)}，边距 ${(expected.score - runnerUp.score).toFixed(3)}` : '')
      )
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
