/**
 * 测每帧指纹（dHash + 结构哈希 + 颜色直方图）的耗时，
 * 用于评估"提高每视频抽帧数"对索引时间的真实影响。
 *
 * 帧尺寸取抽帧时的典型值：宽 320、高按 16:9 算 → 320x180。
 *
 * 运行： node scripts/bench-frames.mjs
 */
import { performance } from 'node:perf_hooks'
import { computeSignature } from '../out-e2e/shared/hash.js'

function makeFrame(width, height, seed) {
  const rgb = Buffer.allocUnsafe(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      // 造一个有结构、有颜色变化的图案，避免都是常数被 CPU 优化掉
      rgb[i] = (x * 3 + seed) % 256
      rgb[i + 1] = (y * 5 + seed * 2) % 256
      rgb[i + 2] = (x + y + seed * 3) % 256
    }
  }
  return rgb
}

const width = 320
const height = 180
const counts = [16, 64, 128, 256]

console.log('每帧指纹耗时（320x180 RGB24）')
console.log('')

// 预热
const warm = makeFrame(width, height, 0)
for (let i = 0; i < 10; i++) {
  computeSignature({ data: warm, width, height, channels: 3, order: 'rgb' })
}

for (const count of counts) {
  const frames = Array.from({ length: count }, (_, i) => makeFrame(width, height, i))
  const start = performance.now()
  for (const frame of frames) {
    computeSignature({ data: frame, width, height, channels: 3, order: 'rgb' })
  }
  const elapsed = performance.now() - start
  const perFrame = elapsed / count
  console.log(
    `  ${String(count).padStart(4)} 帧：总计 ${elapsed.toFixed(1)} ms，每帧 ${perFrame.toFixed(3)} ms`
  )
}

console.log('')
console.log('说明：索引实际走 scan.ts 的抽帧路径，帧数超约 48 时改用"单次全片解码"，')
console.log('      该路径的解码成本与视频时长相关、与帧数几乎无关（600 秒约 1.1 秒）；')
console.log('      帧数较少时用"逐点 seek"，约 25 ms/帧，与时长无关。两者在约 48~55 帧处交叉。')
console.log('指纹计算（就是上面测的这段）约 2.5 ms/帧，是三条路径都要付的固定成本。')
console.log('      1 小时视频 240 帧 → 指纹约 0.6 秒。')
