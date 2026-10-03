/**
 * 生成应用图标（零依赖，纯 Node + zlib 手写 PNG/ICO）。
 *
 * 为什么不用 sharp / png-to-ico：本项目刻意不引入图像处理依赖（打包体积、
 * 安装脚本与原生模块都要跟着走），而图标只需生成一次。图形也简单——
 * 圆角矩形 + 四个取景角 + 一个播放三角形，用像素级光栅化足够。
 *
 * 图形取「四角落框 + 播放键」：四角框表示"以图搜帧"的取景动作，
 * 中间三角表示视频。配色沿用渲染端的 accent（#38bdf8）与深蓝底（#042C53），
 * 与 Header 里的「WV」字母标同色系。不含文字，小尺寸下不会糊。
 *
 * 运行： node scripts/generate-icon.mjs
 * 产物： build/icon.ico（16/24/32/48/64/128/256）、build/icon.png（1024）
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const buildDir = join(root, 'build')

/* ---------------- 配色（与 src/renderer/src/index.css 保持一致） ---------------- */
const BG_TOP = [12, 68, 124] // #0C447C 上半部分
const BG_BOTTOM = [4, 44, 83] // #042C53 下半部分
const ACCENT = [56, 189, 248] // #38BDF8
const ACCENT_DEEP = [14, 165, 233] // #0EA5E9

/** 图标各元素都按 1024 画，再缩放到各尺寸 */
const BASE = 1024

/**
 * 圆角矩形的内部判定：点 (px,py) 是否落在 [0,S]²内、距各角圆心至少 r。
 * 用整数运算避免边界处的抗锯齿断裂。
 */
function insideRoundedRect(px, py, S, r) {
  if (px < 0 || py < 0 || px > S || py > S) return false
  const cx = px < r ? r : px > S - r ? S - r : px
  const cy = py < r ? r : py > S - r ? S - r : py
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= r * r
}

/**
 * 取景角：画出四个 L 形的两条边（只画角那一段，不画满整个边框）。
 * 粗细随尺寸缩放，保证 16×16 时仍看得见。
 *
 * 之前写成"在 x<len 或 x>=s-len 的整个竖带里判 y<thickness"，
 * 结果四条边整条都被填满，图标变成一个十字。正确做法是逐个角判断：
 * 某点落在该角的「竖臂 ∪ 横臂」内才算。
 */
function insideCornerBracket(x, y, s, thickness, len) {
  const inBand = (v) => v >= 0 && v < thickness
  const inArm = (v) => v >= 0 && v < len

  // 上左角
  if (inArm(x) && inArm(y) && (inBand(x) || inBand(y))) return true
  // 上右角
  if (inArm(s - 1 - x) && inArm(y) && (inBand(s - 1 - x) || inBand(y))) return true
  // 下左角
  if (inArm(x) && inArm(s - 1 - y) && (inBand(x) || inBand(s - 1 - y))) return true
  // 下右角
  if (inArm(s - 1 - x) && inArm(s - 1 - y) && (inBand(s - 1 - x) || inBand(s - 1 - y))) return true
  return false
}

/** 播放三角：顶点朝右的等腰三角形，带一点圆角观感（按比例内缩） */
function insidePlayTriangle(x, y, s) {
  // 以图形区 50% 宽为底，38% 高为高，垂直居中
  const w = s * 0.46
  const h = s * 0.44
  const cx = s * 0.44
  const cy = s * 0.5
  const left = cx - w / 2
  const right = cx + w / 2
  const top = cy - h / 2
  const bottom = cy + h / 2
  if (x < left || x > right || y < top || y > bottom) return false
  // 线性插值：越往右，允许的纵向范围越窄
  const t = (x - left) / w
  const halfH = (h / 2) * (1 - t)
  return Math.abs(y - cy) <= halfH
}

/** 生成单个尺寸的 RGBA 像素缓冲 */
function renderRGBA(size) {
  const S = size
  const px = new Uint8Array(S * S * 4)
  const radius = Math.round(S * 0.22) // 圆角半径约 22%（Windows 11 观感）
  // 取景角与三角的几何：小尺寸下要略加粗（否则细线在 16px 上几乎不可见），
  // 但角臂不能加长——角臂一旦变长，四个角会在小尺寸下连成一个方框，反而看不出是取景角。
  const small = S <= 32
  const thickness = small ? Math.max(2, Math.round(S * 0.094)) : Math.max(2, Math.round(S * 0.062))
  const bracketLen = small ? Math.round(S * 0.28) : Math.round(S * 0.26)
  const inset = Math.round(S * (small ? 0.19 : 0.20)) // 取景角距外边缘
  const glyph = S - inset * 2 // 取景角围出的正方形边长

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4
      // 圆角外透明
      if (!insideRoundedRect(x + 0.5, y + 0.5, S - 1, radius)) {
        px[i + 3] = 0
        continue
      }
      // 底色：上深下浅的竖向渐变
      const t = y / (S - 1)
      let r = Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
      let g = Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
      let b = Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)

      // 图形坐标（相对取景框）
      const gx = x - inset + 0.5
      const gy = y - inset + 0.5

      if (insideCornerBracket(gx, gy, glyph, thickness, bracketLen)) {
        r = ACCENT[0]
        g = ACCENT[1]
        b = ACCENT[2]
      } else if (insidePlayTriangle(gx, gy, glyph)) {
        // 三角形用稍深一档的天蓝，与角框拉开层次
        r = ACCENT_DEEP[0]
        g = ACCENT_DEEP[1]
        b = ACCENT_DEEP[2]
      }

      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
      px[i + 3] = 255
    }
  }
  return px
}

/* ---------------- PNG 编码（zlib + CRC32，全部手写） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** 把 RGBA 像素编码成 PNG 字节 */
function encodePNG(rgba, size) {
  // 每行前加一个 filter 字节；用 0（None）。逐行不压缩会大，但这里图元简单，
  // 选 filter=1（Sub）能显著压小竖向渐变。
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    const o = y * (stride + 1)
    raw[o] = 1 // Sub
    for (let x = 0; x < stride; x++) {
      const cur = rgba[y * stride + x]
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0
      raw[o + 1 + x] = (cur - left) & 0xff
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------------- ICO 封装 ---------------- */

/**
 * ICO 容器：6 字节头 + 每张图 16 字节目录项 + 各图数据。
 * ICO 里的图数据就是 PNG（Vista 起支持），比 BMP 简单且带 alpha。
 */
function encodeICO(images) {
  const count = images.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(count, 4)

  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  images.forEach((img, i) => {
    const o = i * 16
    dir[o] = img.size >= 256 ? 0 : img.size // 256 记作 0
    dir[o + 1] = img.size >= 256 ? 0 : img.size
    dir[o + 2] = 0 // 调色板数
    dir[o + 3] = 0 // reserved
    dir.writeUInt16LE(1, o + 4) // color planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32LE(0, o + 8)
    dir.writeUInt32LE(img.data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += img.data.length
  })

  return Buffer.concat([header, dir, ...images.map((i) => i.data)])
}

/* ---------------- 主流程 ---------------- */

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

function main() {
  mkdirSync(buildDir, { recursive: true })

  const images = []
  for (const size of ICO_SIZES) {
    const rgba = renderRGBA(size)
    const png = encodePNG(rgba, size)
    images.push({ size, data: png })
    console.log(`  ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`)
  }

  const icoPath = join(buildDir, 'icon.ico')
  writeFileSync(icoPath, encodeICO(images))

  // 另存一份到 out/：electron-builder 的 files 只含 out/**、package.json、LICENSE，
  // 打包后仓库根的 build/ 在 asar 外不可达。运行期要靠 __dirname/../icon.ico 拿到图标，
  // 否则绿色版（win-unpacked 直接跑 exe）的任务栏与标题栏会退回 Electron 默认图标。
  // electron-builder 自己仍从 build/ 读 win.icon，两份内容一致（同一批渲染结果）。
  const outIco = join(root, 'out', 'icon.ico')
  mkdirSync(dirname(outIco), { recursive: true })
  writeFileSync(outIco, encodeICO(images))

  // 单独存一份 1024 的 PNG：README / 应用商店 / 文档插图用
  const bigPng = encodePNG(renderRGBA(1024), 1024)
  const pngPath = join(buildDir, 'icon.png')
  writeFileSync(pngPath, bigPng)

  // favicon 从同一批渲染结果里切出来，避免"改了 build/ 忘了改 favicon"导致两边不一致
  const faviconDir = join(root, 'src', 'renderer', 'public')
  mkdirSync(faviconDir, { recursive: true })
  for (const size of [16, 32]) {
    writeFileSync(join(faviconDir, `favicon-${size}.png`), encodePNG(renderRGBA(size), size))
  }

  console.log('\n已生成：')
  console.log('  ' + icoPath + '  （' + ICO_SIZES.join(', ') + '）  打包用（electron-builder win.icon）')
  console.log('  ' + outIco + '  同上，运行期随包（__dirname/../icon.ico）')
  console.log('  ' + pngPath + '  1024×1024，' + (bigPng.length / 1024).toFixed(1) + ' KB')
  console.log('  ' + join(faviconDir, 'favicon-16.png') + ' / favicon-32.png')
}

main()
