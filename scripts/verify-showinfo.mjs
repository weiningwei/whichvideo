/**
 * 实测验证：全片解码路径的帧时间戳是否为真实源时间（showinfo 修复）。
 *
 * 场景复现用户的 bug：ffprobe 报的时长与真实不符（这里故意把
 * durationSeconds 传大 25% 模拟），修复前帧时间 = 计划时间点（错位），
 * 修复后 = showinfo 的 pts_time（真实）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const out = join(root, 'out-e2e', 'main', 'media.js')

if (!existsSync(out)) {
  console.error('找不到 out-e2e/main/media.js —— 先跑 pnpm test:startup（内部会编译）')
  process.exit(1)
}
const { extractFrames } = await import(`file://${out.replace(/\\/g, '/')}`)

// 生成 60 秒测试视频（testsrc 时间轴绝对精准）
const tmp = join(root, 'tmp', 'showinfo-verify')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
const video = join(tmp, 'testsrc-60s.mp4')
const gen = spawnSync('ffmpeg.exe', [
  '-hide_banner', '-v', 'error', '-f', 'lavfi',
  '-i', 'testsrc=duration=60:size=320x180:rate=30',
  '-pix_fmt', 'yuv420p', '-y', video
], { timeout: 60_000 })
if (gen.status !== 0) {
  console.error('ffmpeg 生成测试视频失败：', gen.stderr?.toString().slice(0, 200))
  process.exit(1)
}
console.log('测试视频已生成（60 秒）')

let fail = 0
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) fail++
}

// 场景 1：时长准确 → 帧时间 ≈ 计划时间点（±1s 采样容差）
{
  const frames = await extractFrames(video, [10, 20, 30, 40, 50], { durationSeconds: 60 })
  check('输出帧数 = 5', frames.length === 5, `实际 ${frames.length}`)
  const diffs = frames.map((f) => Math.abs(f.time - [10, 20, 30, 40, 50][frames.indexOf(f)]))
  check('每帧真实时间 ≈ 计划时间（偏差 ≤ 1s）', diffs.every((d) => d <= 1), `偏差 ${diffs.map((d) => d.toFixed(2)).join('/')}`)
}

// 场景 2：ffprobe 时长虚高 25%（60 传成 75）→ 模拟时长估计不准
// 修复前：帧被记录为计划点 [12,24,36,48,60]（错）；修复后：真实时间 [15,30,45,60,75]（准）
{
  const frames = await extractFrames(video, [12, 24, 36, 48, 60], { durationSeconds: 75 })
  check('输出帧数 = 5', frames.length === 5, `实际 ${frames.length}`)
  const real = frames.map((f) => f.time)
  // fps = 5/75 → 每 15s 一帧：真实落点 0/15/30/45/60？不 —— fps 滤镜第一帧在 t=0
  // 之后每 15s：0,15,30,45,60。计划点是 12/24/36/48/60 —— 两套根本不同。
  // 修复生效的判据：记录的时间与"帧实际能被 seek 到的位置"一致（即 pts_time），
  // 不再是计划点。这里验证 pts_time 是 15 的整数倍序列（fps 采样的真实落点）。
  const isReal = real.every((t, i) => Math.abs(t - i * 15) <= 1)
  check('帧时间 = showinfo 真实落点（15s 间隔采样）', isReal, `实际 ${real.map((t) => t.toFixed(1)).join('/')}`)
  const mismatch = real.filter((t, i) => Math.abs(t - [12, 24, 36, 48, 60][i]) > 1).length
  check('与（错误的）计划点明显不同 —— 证明修的是真实数据源', mismatch >= 3, `${mismatch}/5 处不同`)
}

rmSync(tmp, { recursive: true, force: true })
console.log(fail ? `\n${fail} 项失败` : '\n验证全部通过')
process.exit(fail ? 1 : 0)
