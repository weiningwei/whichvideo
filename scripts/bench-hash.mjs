/**
 * 结构化哈希方案对比实验（一次性调参脚本，供选型依据）。
 *
 * 目标：区分「库里没有的画面」与「同一画面的截图」，同时让 solid color 之类
 * 低纹理画面的排序由颜色直方图主导。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const work = join(root, 'tmp', 'bench')
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

function grid(w, h, size, at) {
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

/** 方案 A：当前实现（32x32 亮度梯度 248bit + 16x16 彩色梯度 88bit*3） */
function hashA(img) {
  const { width: w, height: h, channels, data } = img
  const at =
    (c) =>
    (idx) => {
      const base = idx * channels
      if (c === 0) return 0.299 * data[base] + 0.587 * data[base + 1] + 0.114 * data[base + 2]
      if (c === 1) return data[base]
      if (c === 2) return data[base + 1]
      return data[base + 2]
    }
  const bits = new Uint8Array(56)
  let off = 0
  const write = (on) => {
    if (on) bits[off >> 3] |= 1 << (off & 7)
    off++
  }
  const grad = (g, size) => {
    for (let j = 0; j < size; j++) for (let i = 0; i < size - 1; i++) write(g[j * size + i] > g[j * size + i + 1])
    for (let i = 0; i < size; i++) for (let j = 0; j < size - 1; j++) write(g[j * size + i] > g[(j + 1) * size + i])
  }
  grad(grid(w, h, 32, at(0)), 32)
  grad(grid(w, h, 16, at(1)), 16)
  grad(grid(w, h, 16, at(2)), 16)
  grad(grid(w, h, 16, at(3)), 16)
  return bits
}

/** 方案 B：均值归一化比特（16x16 网格，每通道按格均值与全局均值比较） */
function hashB(img) {
  const { width: w, height: h, channels, data } = img
  const at =
    (c) =>
    (idx) => {
      const base = idx * channels
      if (c === 0) return 0.299 * data[base] + 0.587 * data[base + 1] + 0.114 * data[base + 2]
      if (c === 1) return data[base]
      if (c === 2) return data[base + 1]
      return data[base + 2]
    }
  const bits = new Uint8Array(64)
  let off = 0
  const write = (on) => {
    if (on) bits[off >> 3] |= 1 << (off & 7)
    off++
  }
  for (const [size, c] of [
    [16, 0],
    [16, 1],
    [16, 2],
    [16, 3]
  ]) {
    const g = grid(w, h, size, at(c))
    let sum = 0
    for (const v of g) sum += v
    const mean = sum / g.length
    for (const v of g) write(v >= mean)
  }
  return bits
}

/** 方案 C：16x16 灰度量化（每格 2bit Gray 码） */
function hashC(img) {
  const { width: w, height: h, channels, data } = img
  const g = grid(w, h, 16, (idx) => {
    const base = idx * channels
    return 0.299 * data[base] + 0.587 * data[base + 1] + 0.114 * data[base + 2]
  })
  const bits = new Uint8Array(64)
  let off = 0
  const gray2 = (v) => {
    const q = Math.max(0, Math.min(3, Math.floor((v / 256) * 4)))
    return [0, 1, 3, 2][q]
  }
  for (const v of g) {
    const code = gray2(v)
    if (code & 1) {
      bits[off >> 3] |= 1 << (off & 7)
    }
    off++
    if (code & 2) {
      bits[off >> 3] |= 1 << (off & 7)
    }
    off++
  }
  return bits
}

function hamming(a, b) {
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = (a[i] ^ b[i]) >>> 0
    x = x - ((x >>> 1) & 0x55555555)
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
    x = (x + (x >>> 4)) & 0x0f0f0f0f
    d += (x * 0x01010101) >>> 24
  }
  return d
}

async function main() {
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  const bench = (name, fn) => {
    const cases = []
    const sources = {
      flatBlue: 'color=c=0x1b3a6b:size=480x270:rate=25',
      flatAmber: 'color=c=0x6b5a1b:size=480x270:rate=25',
      flatGray: 'color=c=0x404040:size=480x270:rate=25',
      testsrc2: 'testsrc2=size=640x360:rate=25',
      testsrc: 'testsrc=size=640x360:rate=25',
      bars: 'smptebars=size=640x360:rate=25',
      mandel: 'mandelbrot=size=640x360:rate=25'
    }
    const raw = {}
    const png = {}
    for (const [k, s] of Object.entries(sources)) {
      raw[k] = fn(rawAt(s, 100))
      png[k] = fn(rgbOfPng(pngAt(s, 100)))
    }

    const same = []
    const diff = []
    for (const k of Object.keys(sources)) {
      same.push({ pair: `${k}↔${k}`, d: hamming(png[k], raw[k]) })
      for (const j of Object.keys(sources)) {
        if (k === j) continue
        diff.push({ pair: `${k}↔${j}`, d: hamming(png[k], raw[j]) })
      }
    }
    same.sort((a, b) => b.d - a.d)
    diff.sort((a, b) => a.d - b.d)

    console.log(`\n--- ${name}（总位数 ${raw.testsrc2.length * 8}）---`)
    console.log(`  同源最大距离 : ${same[0].d} (${same[0].pair})`)
    console.log(`  跨源最小距离 : ${diff[0].d} (${diff[0].pair})`)
    console.log(`  跨源中位距离 : ${diff[Math.floor(diff.length / 2)].d}`)
    console.log(`  分离边距     : ${diff[0].d - same[0].d}`)
    const flatVsColor = diff.filter((x) => x.pair.startsWith('flat') !== x.pair.split('↔')[1].startsWith('flat'))
    console.log(`  纯色↔彩色最小: ${flatVsColor.length ? Math.min(...flatVsColor.map((x) => x.d)) : '-'}`)
    cases.push({ name, same: same[0].d, cross: diff[0].d })
    return cases
  }

  bench('A 梯度（当前）', hashA)
  bench('B 均值归一化', hashB)
  bench('C 16x16 灰度量化', hashC)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
