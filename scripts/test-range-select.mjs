/**
 * 连选状态的行为验证：Shift 连选与 Ctrl 点选，最终选中集合是否一致。
 *
 * 为什么 ui-smoke 已经验过还要这个：ui-smoke 是**直接构造** `selectedVideoIds`
 * 传进组件，跳过了 `toggleVideoSelection`。而用户实际操作走的是
 * 「点一个 → 按住 Shift 点/方向键」这条路径，中间经过 hook 的 setState 累积。
 * 万一那条路径没累积成功，selectedCount 仍是 1，标题就会照蓝不误 ——
 * 静态断言与 ui-smoke 都发现不了这种。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/**
 * 复刻 useLibrary 的选中算法（对照 src/renderer/src/hooks/useLibrary.ts）。
 *
 * 关键：锚点用 ref（同步可读），不是 state。
 * 曾经的 bug 是 useCallback([videos]) + 闭包读 state —— 而选中并不改变 videos，
 * 依赖永远不变、callback 永不重建，闭包里那个值永远是初始 null，
 * 于是 Shift 连选每次都退化成单选。本脚本的 makeSelection 用 ref 语义，
 * 若实现改回 state 会立刻暴露（见末尾的同步守卫）。
 */
function makeSelection(ids) {
  let selected = new Set()
  const lastSelectedRef = { current: null } // ref：同步读写
  return {
    toggle(videoId, shiftKey = false, ctrlKey = false) {
      const anchor = lastSelectedRef.current // updater 同步执行，读到的是最新值
      selected = (() => {
        const next = new Set(selected)
        if (shiftKey && anchor !== null) {
          const start = ids.indexOf(anchor)
          const end = ids.indexOf(videoId)
          const [min, max] = start < end ? [start, end] : [end, start]
          for (let i = min; i <= max; i++) next.add(ids[i])
          return next
        } else if (ctrlKey) {
          if (next.has(videoId)) next.delete(videoId)
          else next.add(videoId)
          return next
        } else {
          next.clear()
          next.add(videoId)
          return next
        }
      })()
      lastSelectedRef.current = videoId
    },
    clear() {
      selected = new Set()
      lastSelectedRef.current = null
    },
    size: () => selected.size,
    ids: () => [...selected]
  }
}

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (detail ? '  ← ' + detail : ''))
  }
}

const ids = [1, 2, 3, 4, 5]

console.log('=== Shift 连选：选中集合会累积 ===')
{
  const s = makeSelection(ids)
  s.toggle(2)
  check('点一个后 size=1', s.size() === 1, '实际 ' + s.size())

  s.toggle(3, true)
  check('Shift 扩展后 size=2', s.size() === 2, '实际 ' + s.size())

  s.toggle(4, true)
  check('再 Shift 后 size=3', s.size() === 3, '实际 ' + s.size())
  check('集合是 [2,3,4]', JSON.stringify(s.ids().sort((a, b) => a - b)) === '[2,3,4]', JSON.stringify(s.ids()))
}

console.log('=== 连按 Shift+↓ 持续累积（用户报告的那个场景）===')
{
  // 之前 useCallback([videos]) 捕获的锚点永远是 null，
  // 于是连按方向键每次都退化成单选 —— 界面表现为「已选 1」。
  // 光标从第 1 行起，按三次 Shift+↓，应选中 1~4 四个。
  const s = makeSelection(ids)
  s.toggle(1) // 落在第 1 行
  s.toggle(2, true)
  check('按一次 Shift+↓ 后 size=2', s.size() === 2, '实际 ' + s.size())
  s.toggle(3, true)
  check('按两次后 size=3', s.size() === 3, '实际 ' + s.size())
  s.toggle(4, true)
  check('按三次后 size=4（每次都累积）', s.size() === 4, '实际 ' + s.size())
  check('集合是 [1,2,3,4]', JSON.stringify(s.ids().sort((a, b) => a - b)) === '[1,2,3,4]', JSON.stringify(s.ids()))
}

console.log('=== clearSelection 后锚点要清掉 ===')
{
  const s = makeSelection(ids)
  s.toggle(3)
  s.toggle(4, true)
  s.clear()
  check('清空后 size=0', s.size() === 0)
  s.toggle(2, true) // 锚点已清 → 退化成单选而不是从旧的 4 开始
  check('清空后按 Shift 退化为单选（不从旧锚点扩展）', s.size() === 1, '实际 ' + s.size())
}

console.log('=== Shift 与 Ctrl 最终结果一致（提示才能统一）===')
{
  const a = makeSelection(ids)
  a.toggle(2)
  a.toggle(3, true)
  a.toggle(4, true)

  const b = makeSelection(ids)
  b.toggle(2)
  b.toggle(4, false, true)

  check('Shift 连选 3 个 / Ctrl 点选 2 个都是 size>1', a.size() === 3 && b.size() === 2, `Shift=${a.size()} Ctrl=${b.size()}`)
  check('两者都让 titleAccent 变成 false', a.size() !== 1 && b.size() !== 1)
}

console.log('=== 单选：size=1，标题应当染色 ===')
{
  const s = makeSelection(ids)
  s.toggle(3)
  check('单选 size=1', s.size() === 1, '实际 ' + s.size())
}

console.log('=== 边界 ===')
{
  // 从未点过就按 Shift：lastSelectedVideoId 为 null，退化成单选
  const a = makeSelection(ids)
  a.toggle(3, true)
  check('没点过就 Shift → 退化为单选 size=1', a.size() === 1, '实际 ' + a.size())

  // Shift 往回扩
  const b = makeSelection(ids)
  b.toggle(4)
  b.toggle(2, true)
  check('Shift 向前扩（4→2）得到 [2,3,4]', b.size() === 3, '实际 ' + b.size())

  // Ctrl 取消一个后回到 size=1
  const c = makeSelection(ids)
  c.toggle(2)
  c.toggle(4, false, true)
  c.toggle(2, false, true) // 再 Ctrl 一下取消第 2 个
  check('Ctrl 取消后剩 1 个（标题该染色）', c.size() === 1, '实际 ' + c.size() + ' → ' + JSON.stringify(c.ids()))
}

console.log('=== 实现与 useLibrary 的算法保持一致 ===')
{
  // 源码改动后这条会失败，提醒同步更新本脚本的复刻
  const hookSrc = readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useLibrary.ts'), 'utf8')
  const algo = hookSrc.slice(hookSrc.indexOf('const toggleVideoSelection'), hookSrc.indexOf('const clearSelection'))
  check(
    '复刻的算法与 useLibrary 里的分支结构一致',
    algo.includes('} else if (ctrlKey) {') &&
      algo.includes('next.clear()') &&
      algo.includes('lastSelectedRef.current = videoId'),
    'useLibrary 的选中算法变了，本脚本的复刻需要同步'
  )
  // 下面这条是本 bug 的核心防线：锚点必须走 ref。
  // 改回 state（哪怕分支结构没变）会立刻被抓住 —— 那个 bug 正是
  // typecheck 通过、静态断言全绿、只有真去连选才暴露。
  check(
    '连选锚点用 ref 而非 state（否则闭包陈旧导致连选退化成单选）',
    hookSrc.includes('const lastSelectedRef = useRef<number | null>(null)') &&
      algo.includes('const anchor = lastSelectedRef.current') &&
      !hookSrc.includes('useState<number | null>(null)'),
    'lastSelectedRef 存在，且 toggle 内读的是 ref'
  )
  check(
    '连选条件的判断用的是这个 ref 值',
    algo.includes('if (shiftKey && anchor !== null)'),
    '不能改回读 state'
  )
  check(
    'clearSelection 也清了锚点（否则取消后再 Shift 会从旧位置扩展）',
    /const clearSelection[\s\S]{0,200}lastSelectedRef\.current = null/.test(hookSrc),
    'clearSelection 里要重置 ref'
  )
  const viewSrc = readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'LibraryView.tsx'), 'utf8')
  const viewCode = viewSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  check(
    '选中时文件名染强调色（单选多选共用同一个 selected 条件）',
    /line-clamp-2 break-all \$\{selected \? 'text-accent' : 'text-primary'\}/.test(viewSrc),
    '标题条件染色，不分档'
  )
  check(
    '选中行的操作按钮用不透明底色（阻止半透明 btn-bg 透出行底色）',
    (viewSrc.match(/bg-surface-2/g) ?? []).length === 4,
    '四个按钮：播放 / 定位 / 索引 / 移除'
  )
  check(
    '选中提示单选多选一致：rowBg 直接用 selected',
    /const rowBg = selected\s*\n(\s*)\? 'bg-row-selected'/.test(viewSrc),
    '选中即铺底色'
  )
  check(
    '没有残留的分档变量（selectedCount / singleSelected）',
    !/selectedCount|singleSelected|isMultiSelect/.test(viewCode),
    '它们会让单选与多选长得不一样，别加回来'
  )
}

console.log(`\n=== 连选状态：${pass}/${pass + fail} 通过 ===`)
if (fail) process.exit(1)
