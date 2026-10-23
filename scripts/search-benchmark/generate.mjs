import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const WIDTH = 320
const HEIGHT = 180
const FAMILIES = ['mosaic', 'stripes', 'rings', 'checker', 'landscape', 'skyline', 'waves', 'spots']

function hash(seed, a, b = 0) {
  let n = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca77)) >>> 0
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d)
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b)
  return (n ^ (n >>> 16)) >>> 0
}

function color(seed, index) {
  const value = hash(seed, index)
  return [40 + (value & 191), 40 + ((value >>> 8) & 191), 40 + ((value >>> 16) & 191)]
}

function pixel(family, seed, x, y) {
  const a = seed % 17 + 1
  let region
  switch (family) {
    case 'mosaic': region = Math.floor(x / (32 + a)) + 11 * Math.floor(y / (24 + a)); break
    case 'stripes': region = Math.floor((x + (a - 9) * y / 5) / (14 + a)) % 7; break
    case 'rings': region = Math.floor(Math.hypot(x - 80 - a * 6, y - 40 - a * 4) / (10 + a)) % 7; break
    case 'checker': region = (Math.floor(x / (18 + a)) + Math.floor(y / (12 + a))) % 5; break
    case 'landscape': region = y < 45 + 12 * Math.sin(x / (25 + a)) ? 0 : y < 105 + 16 * Math.sin(x / (14 + a)) ? 1 : 2; break
    case 'skyline': region = y < 65 + (hash(seed, Math.floor(x / (18 + a))) % 95) ? 0 : 1 + Math.floor(x / (18 + a)) % 4; break
    case 'waves': region = Math.floor((y + 18 * Math.sin(x / (9 + a))) / (13 + a)) % 7; break
    default: region = (hash(seed, Math.floor(x / 28), Math.floor(y / 28)) % 5) + (Math.hypot(x - 160, y - 90) < 24 + a ? 5 : 0)
  }
  const rgb = color(seed, region)
  const shade = Math.round(12 * Math.sin((x + y + a * 13) / 29))
  return rgb.map((value) => Math.max(0, Math.min(255, value + shade)))
}

function makePpm(path, family, seed) {
  const header = Buffer.from(`P6\n${WIDTH} ${HEIGHT}\n255\n`)
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 3
      const rgb = pixel(family, seed, x, y)
      pixels[offset] = rgb[0]
      pixels[offset + 1] = rgb[1]
      pixels[offset + 2] = rgb[2]
    }
  }
  writeFileSync(path, Buffer.concat([header, pixels]))
}

function convert(ffmpeg, input, output, filter, quality) {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', input, '-vf', filter, '-frames:v', '1']
  if (quality) args.push('-q:v', String(quality))
  args.push('-y', output)
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error(`生成 ${output} 失败：${result.error?.message ?? result.stderr}`)
}

export function generateBenchmark(ffmpeg, runDir, profile = 'regular') {
  if (!['regular', 'extended'].includes(profile)) throw new Error(`未知评测模式：${profile}`)
  const root = join(runDir, 'dataset')
  const galleryDir = join(root, 'gallery')
  const queryDir = join(root, 'queries')
  mkdirSync(galleryDir, { recursive: true })
  mkdirSync(queryDir, { recursive: true })
  const perFamily = profile === 'extended' ? 24 : 12
  const gallery = []
  const queries = []
  for (const [familyIndex, family] of FAMILIES.entries()) {
    for (let i = 0; i < perFamily; i++) {
      const seed = hash(20261023, familyIndex, i)
      const id = `${family}-${String(i + 1).padStart(2, '0')}`
      const base = join(galleryDir, `${id}.ppm`)
      makePpm(base, family, seed)
      gallery.push({ id, family, path: base, seed })
      queries.push({ id: `${id}-exact`, path: base, expectedId: id, family, variant: 'exact' })
      const variants = [
        { name: 'jpeg', filter: 'null', ext: 'jpg', quality: 24 },
        { name: 'small', filter: 'scale=96:54', ext: 'png' },
        { name: 'crop', filter: 'crop=240:135:40:22', ext: 'png' },
        { name: 'letterbox', filter: 'pad=400:240:40:30:black', ext: 'png' },
        { name: 'occluded', filter: 'drawbox=x=30:y=115:w=220:h=40:color=black:t=fill', ext: 'png' },
        { name: 'combined', filter: 'crop=256:144:32:18,scale=200:112,eq=brightness=0.04:saturation=0.65', ext: 'jpg', quality: 26 }
      ]
      if (profile === 'extended') variants.push(
        { name: 'tight-crop', filter: 'crop=160:90:80:45', ext: 'png' },
        { name: 'corner-crop', filter: 'crop=176:99:0:0', ext: 'png' },
        { name: 'grayscale', filter: 'format=gray', ext: 'png' },
        { name: 'blur', filter: 'gblur=sigma=3', ext: 'png' },
        { name: 'flipped', filter: 'hflip', ext: 'png' }
      )
      for (const variant of variants) {
        const path = join(queryDir, `${id}-${variant.name}.${variant.ext}`)
        convert(ffmpeg, base, path, variant.filter, variant.quality)
        queries.push({ id: `${id}-${variant.name}`, path, expectedId: id, family, variant: variant.name })
      }
    }
    for (let i = 0; i < 4; i++) {
      const seed = hash(20261023, familyIndex, perFamily + i + 1000)
      const id = `${family}-held-out-${i + 1}`
      const path = join(queryDir, `${id}.ppm`)
      makePpm(path, family, seed)
      queries.push({ id, path, expectedId: null, family, variant: 'held-out' })
    }
  }
  const manifest = { version: 2, profile, seed: 20261023, gallery, queries }
  const manifestPath = join(root, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return manifestPath
}
