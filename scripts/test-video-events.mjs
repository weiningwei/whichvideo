/**
 * 视频列表事件消费的行为验证。
 *
 * 背景：索引完成时后端广播 `video-updated`（带完整 VideoRecord），但渲染端
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
const { applyVideoEvent, applyVideoEvents, shouldRefreshForUnseenVideo, reconcileFetchedPage } = await import(pathToFileURL(target).href)
const { applyImportProgress } = await import(
  pathToFileURL(join(js, 'renderer', 'src', 'lib', 'importProgress.js')).href
)

/** 最小 VideoRecord：applyVideoEvent 只读 id/status/addedAt，其余字段透传 */
const video = (id, status, frameCount, addedAt = id) => ({
  id,
  status,
  frameCount,
  addedAt,
  path: `F:\\Media\\v${id}.mp4`,
  name: `v${id}.mp4`
})
const indexed = (id, frameCount) => video(id, 'ready', frameCount)

// 默认视图：全部视频、按最近添加倒序（addedAt 递减）
const list = [video(1, 'indexing', 0, 30), video(2, 'indexing', 0, 20), video(3, 'ready', 10, 10)]
const ALL = { status: 'all' }

console.log('=== video-updated：索引完成后行内数据要刷新 ===')
{
  const out = applyVideoEvent(list, { type: 'video-updated', video: indexed(1, 64) }, ALL)
  check('状态从 indexing 变 ready', out[0].status === 'ready')
  check('帧数从 0 变 64', out[0].frameCount === 64)
  check('其它行不动', out[1].status === 'indexing' && out[2].frameCount === 10)
  check('行数不变、顺序不变', out.length === 3 && out[0].id === 1)
}

console.log('=== video-updated：导入中的新视频按最近添加插入 ===')
{
  const fresh = (id, addedAt) => video(id, 'pending', 0, addedAt)
  const out = applyVideoEvent(list, { type: 'video-updated', video: fresh(99, 40) }, ALL)
  check('默认视图插入新行并排在最前', out.length === 4 && out[0].id === 99)
  const middle = applyVideoEvent(list, { type: 'video-updated', video: fresh(98, 25) }, ALL)
  check('按 addedAt 降序插到中间', middle.map((v) => v.id).join(',') === '1,98,2,3')
  const asc = applyVideoEvent(
    list,
    { type: 'video-updated', video: fresh(97, 0) },
    { status: 'all', sort: 'added', order: 'asc' }
  )
  check('升序视图追加到末尾', asc[asc.length - 1].id === 97)
  const duplicate = applyVideoEvent(
    list,
    { type: 'video-updated', video: { ...indexed(2, 7), addedAt: 999 } },
    ALL
  )
  check('同一 id 只替换不重复插入', duplicate.length === 3 && duplicate[1].frameCount === 7)
  check(
    '筛选 / 其它排序 / 指定目录视图不插入（位置不确定）',
    applyVideoEvent(list, { type: 'video-updated', video: fresh(96, 9) }, { status: 'indexing' }).length === 3 &&
      applyVideoEvent(list, { type: 'video-updated', video: fresh(95, 9) }, { status: 'all', keyword: 'v' }).length === 3 &&
      applyVideoEvent(list, { type: 'video-updated', video: fresh(94, 9) }, { status: 'all', sort: 'name' }).length === 3 &&
      applyVideoEvent(list, { type: 'video-updated', video: fresh(93, 9) }, { status: 'all', folderId: 1 }).length === 3
  )
}

console.log('=== 过滤视图：状态变了就从视图移除 ===')
{
  // 正看着「索引中」过滤，这条完成了 → 应消失而不是以旧状态赖着
  const out = applyVideoEvent(list, { type: 'video-updated', video: indexed(1, 64) }, { status: 'indexing' })
  check('完成的行从「索引中」视图移除', out.length === 2 && !out.some((v) => v.id === 1))
  // 状态变为 failed → 不再属于「索引中」视图（status 是精确匹配，非包含）→ 移除
  const out2 = applyVideoEvent(list, { type: 'video-updated', video: video(1, 'failed', 0) }, { status: 'indexing' })
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

console.log('=== 批量事件：同一轮只应用最终状态 ===')
{
  const out = applyVideoEvents(list, [
    { type: 'video-updated', video: video(4, 'pending', 0, 25) },
    { type: 'video-updated', video: video(4, 'ready', 20, 25) },
    { type: 'video-updated', video: indexed(2, 32) },
    { type: 'video-removed', videoId: 3, path: '' },
    { type: 'video-updated', video: video(5, 'pending', 0, 35) }
  ], ALL)
  check('更新、插入与删除合并后顺序正确', out.map((v) => v.id).join(',') === '5,1,4,2')
  check('重复更新只保留最终状态', out.find((v) => v.id === 4)?.frameCount === 20 && out.find((v) => v.id === 2)?.frameCount === 32)
  const filtered = applyVideoEvents(list, [
    { type: 'video-updated', video: indexed(1, 64) },
    { type: 'video-removed', videoId: 2, path: '' }
  ], { status: 'indexing' })
  check('批量更新仍遵守状态筛选', filtered.length === 1 && filtered[0].id === 3)
}

console.log('=== 筛选视图：新视频触发数据库校正 ===')
{
  const known = new Set([1, 2, 3])
  const ready = { type: 'video-updated', video: { ...video(4, 'ready', 10), folderId: 7 } }
  check('新匹配行触发刷新', shouldRefreshForUnseenVideo(known, ready, { status: 'ready' }))
  check('已在列表中的行直接更新', !shouldRefreshForUnseenVideo(known, { type: 'video-updated', video: indexed(1, 10) }, { status: 'ready' }))
  check('状态和文件夹不匹配时不刷新',
    !shouldRefreshForUnseenVideo(known, ready, { status: 'pending' }) &&
    !shouldRefreshForUnseenVideo(known, ready, { folderId: 8 }))
  check('默认视图继续直接插入', !shouldRefreshForUnseenVideo(known, ready, ALL))
}

console.log('=== 分页拉取：较新事件不被旧快照覆盖 ===')
{
  const stale = { items: list, total: 3 }
  const out = reconcileFetchedPage(stale, [
    { type: 'video-updated', video: video(1, 'ready', 64, 30) },
    { type: 'video-removed', videoId: 2, path: '' },
    { type: 'video-updated', video: video(4, 'pending', 0, 40) }
  ], ALL)
  check('拉取中的索引完成状态得到保留', out.items.find((v) => v.id === 1)?.frameCount === 64)
  check('拉取中的删除和新增得到保留', out.items.map((v) => v.id).join(',') === '4,1,3' && out.total === 3)
}

console.log('=== 静态守卫：订阅真的接上了 ===')
{
  const src = readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useVideoList.ts'), 'utf8')
  check(
    'hook 内订阅了 events 并批量应用视频事件',
    src.includes('window.whichvideo.events.subscribe') &&
      /applyVideoEvents\(prev\.items, events, queryRef\.current\)/.test(src),
    '删掉订阅这个修复就失效'
  )
  check(
    '行数变化折算进工具栏总数（插入的新行不会与 N 个视频对不上）',
    src.includes('prev.total + items.length - prev.items.length'),
    ''
  )
  const coreSrc = readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useLibraryCore.ts'), 'utf8')
  check(
    'useLibraryCore 的空分支注明了事件归 useVideoList 管（防后人误修）',
    coreSrc.includes('由 useVideoList 消费'),
    ''
  )
  check(
    'useLibraryCore 消费 notice 事件（后端通知转渲染端提示）',
    coreSrc.includes("case 'notice':") && coreSrc.includes('onNotice?.(event.level, event.message)'),
    '此前该分支空置 —— 后端 notice 广播全被丢弃，索引失败等提示看不到'
  )
  const libSrc = readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useLibrary.ts'), 'utf8')
  check(
    'useLibrary 把 pushNotice 接进 core（notices 先于 core 定义）',
    /const notices = useNotices\(\)[\s\S]{0,300}useLibraryCore\(\{ onNotice: notices\.pushNotice \}\)/.test(
      libSrc
    ),
    '顺序反了会拿到未初始化的 pushNotice'
  )
}

console.log('=== import-progress：批量导入进度 ===')
{
  const ev = (id, processed, total, finished = false) => ({
    type: 'import-progress',
    id,
    processed,
    total,
    added: 0,
    skipped: 0,
    failed: 0,
    finished
  })
  check('扫描阶段（total = 0）也进入状态', applyImportProgress(null, ev(1, 42, 0))?.processed === 42)
  check(
    '遍历结束后总数接管显示',
    applyImportProgress(ev(1, 42, 0), ev(1, 0, 480))?.total === 480
  )
  check('旧批次迟到的事件被丢弃', applyImportProgress(ev(2, 10, 100), ev(1, 480, 480, true))?.id === 2)
  check('当前批次 finished 后清空', applyImportProgress(ev(2, 100, 100), ev(2, 100, 100, true)) === null)
  check('旧批次 finished 不清掉当前批次', applyImportProgress(ev(2, 50, 100), ev(1, 3, 3, true))?.id === 2)
  check(
    'useLibraryCore 订阅并应用 import-progress',
    readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useLibraryCore.ts'), 'utf8').includes(
      "case 'import-progress':"
    )
  )
}

console.log(`\n=== 视频事件消费：${pass}/${pass + fail} 通过 ===`)
if (fail) process.exit(1)
