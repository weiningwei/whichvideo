/**
 * 抽帧策略的纯逻辑自检（不依赖 ffmpeg / Electron）。
 *
 * 背景：原先 `planTimestamps` 是"固定帧数"——`min(帧预算, ceil(时长/2))`，
 * 对任何长于 32 秒的视频都取同一个帧数，导致 10 分钟与 1 小时视频抽帧完全相同
 * （实测用户反馈正是如此）。现在改为按时长插值的分档策略，本脚本守住它的性质。
 *
 * 运行： node scripts/build-core.mjs && node scripts/test-frame-policy.mjs
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const mediaPath = join(root, 'out-e2e', 'main', 'media.js')

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

async function main() {
  if (!existsSync(mediaPath)) {
    console.error(`找不到 ${mediaPath}，请先运行 node scripts/build-core.mjs`)
    process.exit(1)
  }
  const m = await import(pathToFileURL(mediaPath).href)
  const { planTimestamps, framesForDuration, plannedFrameCount, DEFAULT_FRAME_BUDGET } = m

  console.log('=== 抽帧策略 ===')

  check('导出了 framesForDuration', typeof framesForDuration === 'function')
  check('导出了 plannedFrameCount', typeof plannedFrameCount === 'function')
  check('默认上限为 64', DEFAULT_FRAME_BUDGET === 64, String(DEFAULT_FRAME_BUDGET))

  // 核心诉求：时长越长，帧数越多（原来固定不变）
  const durations = [10, 30, 60, 300, 600, 900, 1800, 3600, 7200]
  const frames = durations.map((d) => framesForDuration(d))
  console.log('')
  console.log('  时长 → 策略帧数：')
  for (let i = 0; i < durations.length; i++) {
    console.log(`    ${String(durations[i]).padStart(5)} 秒  →  ${String(frames[i]).padStart(3)} 帧`)
  }
  console.log('')

  check(
    '帧数随时长单调不减',
    frames.every((f, i) => i === 0 || f >= frames[i - 1]),
    frames.join(' ≤ ')
  )
  check('10 分钟与 1 小时不再相同', framesForDuration(600) !== framesForDuration(3600), `${framesForDuration(600)} vs ${framesForDuration(3600)}`)
  check('1 小时视频至少 48 帧', framesForDuration(3600) >= 48, String(framesForDuration(3600)))
  check('策略值不超过 64（保守封顶）', Math.max(...frames) <= 64, String(Math.max(...frames)))
  check('短视频也有下限（≥8）', framesForDuration(5) >= 8, String(framesForDuration(5)))
  check('非法时长不抛错', Number.isFinite(framesForDuration(null)) && Number.isFinite(framesForDuration(0)))

  // 用户设置作为上限：取小
  check('设置 16 会压住策略值', plannedFrameCount(3600, 16) === 16, String(plannedFrameCount(3600, 16)))
  check('设置足够大时用策略值', plannedFrameCount(3600, 999) === framesForDuration(3600), String(plannedFrameCount(3600, 999)))
  check('设置非法时回落到默认上限', plannedFrameCount(3600, 0) === framesForDuration(3600))

  // 时间点
  const ts = planTimestamps(600, 64)
  check('时间点数量与策略一致', ts.length === plannedFrameCount(600, 64), `${ts.length} 个`)
  check('时间点严格递增', ts.every((t, i) => i === 0 || t > ts[i - 1]))
  check('时间点落在视频范围内', ts[0] > 0 && ts[ts.length - 1] < 600, `${ts[0].toFixed(1)} … ${ts[ts.length - 1].toFixed(1)}`)
  check('极短视频返回单点', planTimestamps(0.2, 64).length === 1, JSON.stringify(planTimestamps(0.2, 64)))

  console.log(`\n=== 抽帧策略：${passed}/${passed + failed} 通过 ===`)
  if (failed) process.exit(1)
}

main()
