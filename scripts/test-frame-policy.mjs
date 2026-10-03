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
  const {
    planTimestamps, framesForDuration, plannedFrameCount, DEFAULT_FRAME_BUDGET,
    shouldUseFullScan, SEEK_VS_FULLSCAN_CROSSOVER
  } = m

  console.log('=== 抽帧策略 ===')

  check('导出了 framesForDuration', typeof framesForDuration === 'function')
  check('导出了 plannedFrameCount', typeof plannedFrameCount === 'function')
  check('导出了 shouldUseFullScan', typeof shouldUseFullScan === 'function')
  check('默认上限为 240', DEFAULT_FRAME_BUDGET === 240, String(DEFAULT_FRAME_BUDGET))

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
  check('1 小时视频至少 200 帧', framesForDuration(3600) >= 200, String(framesForDuration(3600)))
  check('策略值不超过 240（保守封顶）', Math.max(...frames) <= 240, String(Math.max(...frames)))
  check('短视频也有下限（≥8）', framesForDuration(5) >= 8, String(framesForDuration(5)))
  check('非法时长不抛错', Number.isFinite(framesForDuration(null)) && Number.isFinite(framesForDuration(0)))

  // 抽帧路径切换：帧数越过交叉点后应改走"单次全片解码"（成本与帧数无关）。
  // 这是本轮能把上限从 128 提到 240 的前提，必须守住。
  console.log('')
  console.log('  抽帧路径选择（逐点 seek vs 单次全片解码）：')
  for (const n of [16, 32, 48, 64, 96, 240]) {
    console.log(`    ${String(n).padStart(3)} 帧 → ${shouldUseFullScan(n) ? '全片解码' : '逐点 seek'}`)
  }
  console.log('')
  check('交叉点常量在 40~60 之间', SEEK_VS_FULLSCAN_CROSSOVER >= 40 && SEEK_VS_FULLSCAN_CROSSOVER <= 60, String(SEEK_VS_FULLSCAN_CROSSOVER))
  check('少量帧走逐点 seek', shouldUseFullScan(16) === false && shouldUseFullScan(32) === false)
  check('大量帧走全片解码', shouldUseFullScan(96) === true && shouldUseFullScan(240) === true)
  check(
    '30 分钟与 1 小时视频都已越过交叉点',
    shouldUseFullScan(plannedFrameCount(1800, DEFAULT_FRAME_BUDGET)) &&
      shouldUseFullScan(plannedFrameCount(3600, DEFAULT_FRAME_BUDGET)),
    `${plannedFrameCount(1800, DEFAULT_FRAME_BUDGET)} / ${plannedFrameCount(3600, DEFAULT_FRAME_BUDGET)} 帧`
  )
  // 提高上限不该线性拖慢索引：越过交叉点后每帧只付指纹成本（约 2.5ms）
  const HASH_MS = 2.5
  const cost = (n) => (shouldUseFullScan(n) ? 1100 : n * 25) + n * HASH_MS
  const cost96 = cost(96)
  const cost240 = cost(240)
  check(
    '240 帧的索引耗时不比 96 帧高一个数量级',
    cost240 < cost96 * 3,
    `96 帧约 ${(cost96 / 1000).toFixed(1)}s → 240 帧约 ${(cost240 / 1000).toFixed(1)}s`
  )

  // 核心不变量：采样间隔。一集剧平均镜头约 5 秒，1 小时约 720 个镜头；
  // 间隔 gap = 时长/帧数，某个镜头至少被采到一帧的概率 ≈ min(1, 5/gap)。
  // 最初的表 1 小时只给 56 帧（gap=64s）→ 命中率约 8%，即 92% 的镜头在库里
  // 没有任何对应指纹，这类"明明有却搜不到"与匹配算法无关，纯粹是采样太稀。
  console.log('')
  console.log('  1 小时视频的采样间隔与镜头命中率：')
  for (const cap of [64, 128, 240, 400]) {
    const f = plannedFrameCount(3600, cap)
    const gap = 3600 / f
    const hit = Math.min(1, 5 / gap)
    console.log(
      `    上限 ${String(cap).padStart(3)} → ${String(f).padStart(3)} 帧，间隔 ${gap.toFixed(0)}s，单镜头命中约 ${(hit * 100).toFixed(0)}%`
    )
  }
  console.log('')
  const gapDefault = 3600 / plannedFrameCount(3600, DEFAULT_FRAME_BUDGET)
  const hitDefault = Math.min(1, 5 / gapDefault)
  check(
    '默认配置下 1 小时视频至少 200 帧（间隔 ≤ 18 秒）',
    plannedFrameCount(3600, DEFAULT_FRAME_BUDGET) >= 200 && gapDefault <= 18,
    `${plannedFrameCount(3600, DEFAULT_FRAME_BUDGET)} 帧，间隔 ${gapDefault.toFixed(0)} 秒`
  )
  check(
    '默认配置下单镜头命中率 ≥ 25%（最初策略仅 8%）',
    hitDefault >= 0.25,
    `${(hitDefault * 100).toFixed(0)}%`
  )
  // 守住"上限只是封顶、真正决定帧数的是表"这一性质，避免误以为调大设置就能加密
  check(
    '调大上限不再增加 1 小时视频的帧数（由分档表决定）',
    plannedFrameCount(3600, 400) === plannedFrameCount(3600, DEFAULT_FRAME_BUDGET),
    `${plannedFrameCount(3600, 400)} 帧`
  )

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
