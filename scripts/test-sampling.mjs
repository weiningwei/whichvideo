/**
 * 场景检测采样计划的行为测试（planSceneTimestamps，纯函数）。
 *
 * 用例覆盖：
 * 1. 无场景切换 → 退回均匀计划
 * 2. 场景点全部保留（模式存在的意义）
 * 3. 长镜头内部补帧（间隔 > max(2×理想间隔, 8s) 的段）
 * 4. 预算裁剪：只裁补充点、场景点不动
 * 5. 总数永不超预算；升序输出
 * 6. 场景点越界被夹到时长内
 *
 * 运行前置：pnpm test:startup（内部编译 out-e2e/main/media.js）。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const out = join(root, 'out-e2e', 'main', 'media.js')

if (!existsSync(out)) {
  console.error('找不到 out-e2e/main/media.js —— 先跑 pnpm test:startup')
  process.exit(1)
}
const { planSceneTimestamps, planTimestamps } = await import(`file://${out.replace(/\\/g, '/')}`)

let fail = 0
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) fail++
}
const sorted = (ts) => ts.every((t, i) => i === 0 || t >= ts[i - 1])
const inRange = (ts, D) => ts.every((t) => t >= 0 && t <= D)

// —— 1. 无场景切换 → 退回均匀计划 ——
{
  const a = planSceneTimestamps([], 600, 40)
  const b = planTimestamps(600, 40)
  check('无场景切换退回均匀计划', JSON.stringify(a) === JSON.stringify(b), `${a.length} 帧`)
}

// —— 2/3. 场景点保留 + 长镜头补帧 ——
{
  // 600s 预算 40 → idealGap=15，minGap=30
  // 场景：0, 15, 30（密集），320（超长镜头：30→320 间隔 290s → 补 8 帧），598
  const ts = planSceneTimestamps([0, 15, 30, 320, 598], 600, 40)
  // 0 被夹到 0.05（planTimestamps 同款边界处理，避开片头黑场）
  check('场景点 0/15/30/320/598 全部保留', [0.05, 15, 30, 320, 598].every((t) => ts.includes(t)), `${ts.length} 帧总量`)
  check('长镜头段（30→320）有补充帧', ts.some((t) => t > 50 && t < 300), `补帧 ${ts.filter((t) => t > 50 && t < 300).length} 个`)
  check('总数不超预算', ts.length <= 40, `${ts.length}`)
  check('升序且在时长内', sorted(ts) && inRange(ts, 600))
}

// —— 4. 预算裁剪：场景点多于预算 ——
{
  // 200s 预算 10：塞 15 个场景点（间隔 >0.5s 全保留？不 —— 超预算裁的是补充点，
  // 场景点全保留 ⇒ 这里预期场景点全在（总数=15 > 预算 10，因为无补充点可裁）
  const scenes = Array.from({ length: 15 }, (_, i) => 2 + i * 13)
  const ts = planSceneTimestamps(scenes, 200, 10)
  check('场景点多于预算时场景点仍全保留（设计取舍：场景点=镜头保证）', scenes.every((t) => ts.includes(t)), `${ts.length} 帧`)
  check('升序', sorted(ts))
}

// —— 5. 预算裁剪：场景 + 补充混合超预算 ——
{
  // 600s 预算 12：20 个均匀场景点（每 30s 一个）→ 无长镜头补充，
  // 总数 20 > 12 → 只裁补充点但补充点为 0 → 场景点全保留
  const scenes = Array.from({ length: 20 }, (_, i) => i * 30)
  const ts = planSceneTimestamps(scenes, 600, 12)
  check('补充点为 0 时预算裁剪不影响场景点', ts.length === 20, `${ts.length} 帧`)
}

// —— 6. 场景点越界被夹 ——
{
  const ts = planSceneTimestamps([-5, 700, 300], 600, 20)
  check('越界场景点被夹到 [0, 600]', inRange(ts, 600), JSON.stringify(ts.slice(0, 3)))
  check('负值与超界点合并为有效的夹值', ts.includes(0.05) || ts.includes(600) || ts.includes(599.95))
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
