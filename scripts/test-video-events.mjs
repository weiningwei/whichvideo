/**
 * 视频列表事件消费的行为验证。
 *
 * 背景：索引完成时主进程广播 `video-updated`（带完整 VideoRecord），但渲染端
 * 没人消费 —— useLibraryCore 的分支是空的，videos state 又只在 useVideoList 里。
 * 于是新视频索引完了，列表还停在导入时的快照：状态「索引中」、帧数 0，
 * 直到手动切换查询或重开窗口才恢复。
 *
 * 修复：useVideoList 订阅事件，行更新逻辑抽成导出的纯函数 `applyVideoEvent`
 * （hook 里 useEffect 不会在 SSR 渲染里执行，只有纯函数可直接测）。
 *
 * 转译：独立于 ui-smoke（避免依赖其产物的新鲜度），整项目 tsc 到 tmp/video-events/js，
 * 然后给 useVideoList.js 换上一个最小 react shim —— 转译后它只剩 `import react`，
 * 而我们只取模块的纯函数导出，hook 永远不会被调用，shim 不需要任何真实行为。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const tmp = join(root, 'tmp', 'video-events')
const js = join(tmp, 'js')

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function transpile() {
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(js, { recursive: true })
  console.log('  转译渲染端（tsc）…')
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const r = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.preview.json'), '--outDir', js], {
    stdio: 'inherit',
    cwd: root
  })
  if (r.status !== 0) throw new Error('渲染端转译失败')

  // 最小 react shim：useVideoList.js 转译后仅剩 import react（类型导入被擦除），
  // 我们只调它的纯函数导出，hook 不执行，shim 无需任何真实行为。
  const target = join(js, 'renderer', 'src', 'hooks', 'useVideoList.js')
  const shim = join(js, 'shims', 'react.js')
  mkdirSync(join(js, 'shims'), { recursive: true })
  writeFileSync(shim, 'export const useCallback = () => {}\nexport const useEffect = () => {}\nexport const useRef = () => {}\nexport const useState = () => []\n')
  const url = pathToFileURL(shim).href
  const source = readFileSync(target, 'utf8').replace(/(["'])react\1/g, `$1${url}$1`)
  writeFileSync(target, source)
  return target
}

const target = transpile()
if (!existsSync(target)) {
  console.error(`转译产物缺失：${target}`)
  process.exit(1)
}
const { applyVideoEvent } = await import(pathToFileURL(target).href)

/** 最小 VideoRecord：applyVideoEvent 只读 id/status，其余字段透传 */
const video = (id, status, frameCount) => ({
  id,
  status,
  frameCount,
  path: `F:\\Media\\v${id}.mp4`,
  name: `v${id}.mp4`
})
const indexed = (id, frameCount) => video(id, 'ready', frameCount)

const list = [video(1, 'indexing', 0), video(2, 'indexing', 0), video(3, 'ready', 10)]
const ALL = 'all'

console.log('=== video-updated：索引完成后行内数据要刷新 ===')
{
  const out = applyVideoEvent(list, { type: 'video-updated', video: indexed(1, 64) }, ALL)
  check('状态从 indexing 变 ready', out[0].status === 'ready')
  check('帧数从 0 变 64', out[0].frameCount === 64)
  check('其它行不动', out[1].status === 'indexing' && out[2].frameCount === 10)
  check('行数不变、顺序不变', out.length === 3 && out[0].id === 1)
}

console.log('=== video-updated：不在当前列表的行不能乱插 ===')
{
  const out = applyVideoEvent(list, { type: 'video-updated', video: indexed(99, 5) }, ALL)
  check('列表原样返回（不插入）', out.length === 3 && !out.some((v) => v.id === 99))
}

console.log('=== 过滤视图：状态变了就从视图移除 ===')
{
  // 正看着「索引中」过滤，这条完成了 → 应消失而不是以旧状态赖着
  const out = applyVideoEvent(list, { type: 'video-updated', video: indexed(1, 64) }, 'indexing')
  check('完成的行从「索引中」视图移除', out.length === 2 && !out.some((v) => v.id === 1))
  // 状态变为 failed → 不再属于「索引中」视图（status 是精确匹配，非包含）→ 移除
  const out2 = applyVideoEvent(list, { type: 'video-updated', video: video(1, 'failed', 0) }, 'indexing')
  check('变失败同样从「索引中」视图移除（status 精确匹配）', out2.length === 2 && !out2.some((v) => v.id === 1))
}

console.log('=== video-removed：移除后不留僵尸行 ===')
{
  const out = applyVideoEvent(list, { type: 'video-removed', videoId: 2, path: '' }, ALL)
  check('目标行被移除', out.length === 2 && !out.some((v) => v.id === 2))
  const out2 = applyVideoEvent(list, { type: 'video-removed', videoId: 999, path: '' }, ALL)
  check('移除不存在的 id 无副作用', out2.length === 3)
}

console.log('=== 其它事件类型与列表无关 ===')
{
  const a = applyVideoEvent(list, { type: 'stats', stats: {} }, ALL)
  const b = applyVideoEvent(list, { type: 'notice', level: 'info', message: 'x' }, ALL)
  check('stats / notice 原样返回', a.length === 3 && b.length === 3)
}

console.log('=== 静态守卫：订阅真的接上了 ===')
{
  const src = readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useVideoList.ts'), 'utf8')
  check(
    'hook 内订阅了 events 并把事件交给 applyVideoEvent',
    src.includes('window.whichvideo.events.subscribe') &&
      /applyVideoEvent\(prev, event, queryRef\.current\.status\)/.test(src),
    '删掉订阅这个修复就失效'
  )
  const coreSrc = readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useLibraryCore.ts'), 'utf8')
  check(
    'useLibraryCore 的空分支注明了事件归 useVideoList 管（防后人误修）',
    coreSrc.includes('由 useVideoList 消费'),
    ''
  )
}

console.log(`\n=== 视频事件消费：${pass}/${pass + fail} 通过 ===`)
if (fail) process.exit(1)
