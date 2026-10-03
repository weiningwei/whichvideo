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
for (let i = 0; i < 10; i++) computeSignature({ data: warm, width, height })

for (const count of counts) {
  const frames = Array.from({ length: count }, (_, i) => makeFrame(width, height, i))
  const start = performance.now()
  for (const frame of frames) {
    computeSignature({ data: frame, width, height })
  }
  const elapsed = performance.now() - start
  const perFrame = elapsed / count
  console.log(
    `  ${String(count).padStart(4)} 帧：总计 ${elapsed.toFixed(1)} ms，每帧 ${perFrame.toFixed(3)} ms`
  )
}

console.log('')
console.log('说明：索引实际走 scan.ts 的"逐点 seek"路径，解码成本约 25 ms/帧（与时长无关），')
console.log('      所以提高抽帧数会**同时**增加解码与这里的指纹成本（约 9.7 ms/帧）。')
console.log('      作为对照，media.ts 的单次 fps 采样解码成本与帧数无关（600 秒约 1.1 秒），')
console.log('      但帧数低于约 55 时反而比逐点 seek 慢。')
