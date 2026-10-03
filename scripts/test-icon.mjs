/**
 * 应用图标自检。
 *
 * 图标是"生成物"，容易被无声破坏：改了几何参数忘了重跑、build/ 删了没补、
 * out/ 那一份与 build/ 不同步、favicon 忘了入库。这里把这些守住。
 *
 * 覆盖：
 *   · ICO 结构合法（7 个尺寸、目录项偏移/长度自洽、每个图都是合法 PNG）
 *   · build/icon.ico 与 out/icon.ico 内容一致（否则绿色版与开发态图标不同）
 *   · favicon 已入库且与 ICO 里的同尺寸图一致
 *   · electron-builder.yml 配了 win.icon（否则 exe / 快捷方式仍是默认图标）
 *   · index.html 引用了 favicon
 *   · 主窗口与错误窗口都设了 icon，且 resolveIconPath 会试 out/icon.ico
 *
 * 运行： node scripts/test-icon.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

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

const EXPECTED_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** 从 ICO 里取出某尺寸的 PNG 字节 */
function extractIcoImage(buf, want) {
  const count = buf.readUInt16LE(4)
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16
    // 注意：ICO 目录项里 0 表示 256，不能写 buf[o] || 256（0 会被当成假值）
    const w = buf[o] === 0 ? 256 : buf[o]
    if (w !== want) continue
    const size = buf.readUInt32LE(o + 8)
    const off = buf.readUInt32LE(o + 12)
    return { size, off, data: buf.subarray(off, off + size) }
  }
  return null
}

/** 校验一段字节确实是合法 PNG（签名 + IHDR 宽高 + IDAT 能解） */
function inspectPng(data) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) if (data[i] !== sig[i]) return { ok: false, reason: '签名不对' }
  if (data.subarray(12, 16).toString('ascii') !== 'IHDR') return { ok: false, reason: '缺 IHDR' }
  const width = data.readUInt32BE(16)
  const height = data.readUInt32BE(20)
  // 找 IDAT 并试解压，验证 deflate 流完整
  let off = 8
  while (off < data.length) {
    const len = data.readUInt32BE(off)
    const type = data.subarray(off + 4, off + 8).toString('ascii')
    if (type === 'IDAT') {
      try {
        inflateSync(data.subarray(off + 8, off + 8 + len))
      } catch (e) {
        return { ok: false, reason: 'IDAT 解压失败: ' + e.message }
      }
      return { ok: true, width, height }
    }
    off += 12 + len
  }
  return { ok: false, reason: '缺 IDAT' }
}

function main() {
  const icoPath = join(root, 'build', 'icon.ico')
  const outIcoPath = join(root, 'out', 'icon.ico')
  const pngPath = join(root, 'build', 'icon.png')

  console.log('=== 文件存在性 ===')
  check('build/icon.ico 存在（打包时 electron-builder 读它）', existsSync(icoPath))
  check('out/icon.ico 存在（运行期随包，绿色版靠它）', existsSync(outIcoPath))
  check('build/icon.png 存在（文档 / 商店用）', existsSync(pngPath))
  check(
    'favicon 已入库（src/renderer/public）',
    existsSync(join(root, 'src', 'renderer', 'public', 'favicon-16.png')) &&
      existsSync(join(root, 'src', 'renderer', 'public', 'favicon-32.png')),
    '两个尺寸都在版本控制内'
  )
  if (failed) {
    console.log('\n缺少图标文件，先跑 node scripts/generate-icon.mjs')
    process.exit(1)
  }

  const ico = readFileSync(icoPath)

  console.log('')
  console.log('=== ICO 结构 ===')
  check('reserved 字段为 0', ico.readUInt16LE(0) === 0)
  check('type 字段为 1（icon）', ico.readUInt16LE(2) === 1)
  check(`含 ${EXPECTED_SIZES.length} 个尺寸`, ico.readUInt16LE(4) === EXPECTED_SIZES.length, String(ico.readUInt16LE(4)))

  let structOk = true
  let structDetail = ''
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const o = 6 + i * 16
    const w = ico[o] === 0 ? 256 : ico[o]
    const h = ico[o + 1] === 0 ? 256 : ico[o + 1]
    const size = ico.readUInt32LE(o + 8)
    const off = ico.readUInt32LE(o + 12)
    if (w !== h) {
      structOk = false
      structDetail = `${w}×${h} 非正方形`
      break
    }
    if (off + size > ico.length) {
      structOk = false
      structDetail = `${w} 的数据越界（off=${off} size=${size} 实际=${ico.length}）`
      break
    }
    const png = inspectPng(ico.subarray(off, off + size))
    if (!png.ok) {
      structOk = false
      structDetail = `${w} 的图不是合法 PNG：${png.reason}`
      break
    }
    if (png.width !== w || png.height !== h) {
      structOk = false
      structDetail = `${w} 目录项与实际 ${png.width}×${png.height} 不符`
      break
    }
  }
  check('每个目录项的尺寸 / 偏移 / PNG 内容都自洽', structOk, structDetail || `${EXPECTED_SIZES.length} 项全部校验通过`)

  console.log('')
  console.log('=== 各尺寸齐全 ===')
  for (const size of EXPECTED_SIZES) {
    const img = extractIcoImage(ico, size)
    check(`含 ${size}×${size}`, img !== null, img ? `${img.size} B` : '缺失')
  }

  console.log('')
  console.log('=== 两份 ico 保持同步 ===')
  const outIco = readFileSync(outIcoPath)
  check(
    'out/icon.ico 与 build/icon.ico 字节一致',
    outIco.length === ico.length && outIco.equals(ico),
    `${ico.length} B / ${outIco.length} B`
  )

  console.log('')
  console.log('=== favicon 与 ico 同源 ===')
  for (const size of [16, 32]) {
    const fromIco = extractIcoImage(ico, size)
    const fav = readFileSync(join(root, 'src', 'renderer', 'public', `favicon-${size}.png`))
    check(
      `favicon-${size}.png 与 ICO 里的 ${size}×${size} 一致`,
      fromIco !== null && fav.equals(fromIco.data),
      `${fav.length} B`
    )
  }

  console.log('')
  console.log('=== 已接入运行时 ===')
  const builderYml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  check(
    'electron-builder.yml 配了 win.icon',
    /^win:\s*\n(?:\s*#[^\n]*\n)*\s*icon:\s*build\/icon\.ico/m.test(builderYml),
    'win.icon: build/icon.ico'
  )

  const html = readFileSync(join(root, 'src', 'renderer', 'index.html'), 'utf8')
  check('index.html 引用了 favicon', html.includes('favicon-32.png') && html.includes('favicon-16.png'))

  const mainSrc = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8')
  check('主进程有 resolveIconPath', mainSrc.includes('function resolveIconPath'))
  check(
    'resolveIconPath 会先找随包的 out/icon.ico',
    mainSrc.includes("join(__dirname, '../icon.ico')"),
    '开发态与绿色版都能拿到'
  )
  const iconUsages = (mainSrc.match(/icon: resolveIconPath\(\)/g) ?? []).length
  check('两个窗口都设了图标（主窗口 + 错误页）', iconUsages === 2, `${iconUsages} 处`)

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check('package.json 有 icon 脚本', Boolean(pkg.scripts?.icon), pkg.scripts?.icon)
  check(
    'build 脚本在 electron-vite build 之后生成图标',
    pkg.scripts.build.includes('npm run icon') &&
      pkg.scripts.build.indexOf('npm run icon') > pkg.scripts.build.indexOf('electron-vite build'),
    '图标不会被 build 清空 out/ 时删掉'
  )

  console.log(`\n=== 应用图标：${passed}/${passed + failed} 通过 ===`)
  if (failed) process.exit(1)
}

main()
