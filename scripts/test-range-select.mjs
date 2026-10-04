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
 * 复刻 useLibrary 的选中算法（逐行照搬 src/renderer/src/hooks/useLibrary.ts）。
 * 用闭包模拟 React setState(fn) 的语义：fn 收到的 prev 是上一轮结果。
 */
function makeSelection(ids) {
  let selected = new Set()
  let lastSelectedId = null
  return {
    toggle(videoId, shiftKey = false, ctrlKey = false) {
      selected = (() => {
        const next = new Set(selected)
        if (shiftKey && lastSelectedId !== null) {
          const start = ids.indexOf(lastSelectedId)
          const end = ids.indexOf(videoId)
          const [min, max] = start < end ? [start, end] : [end, start]
          for (let i = min; i <= max; i++) next.add(ids[i])
        } else if (ctrlKey) {
          if (next.has(videoId)) next.delete(videoId)
          else next.add(videoId)
        } else {
          next.clear()
          next.add(videoId)
        }
        return next
      })()
      lastSelectedId = videoId
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
    algo.includes('if (shiftKey && lastSelectedVideoId !== null)') &&
      algo.includes('} else if (ctrlKey) {') &&
      algo.includes('next.clear()') &&
      algo.includes('setLastSelectedVideoId(videoId)'),
    'useLibrary 的选中算法变了，本脚本的复刻需要同步'
  )
  const viewSrc = readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'LibraryView.tsx'), 'utf8')
  check(
    '标题染蓝条件仍是 selected && selectedCount === 1',
    viewSrc.includes('const titleAccent = selected && selectedCount === 1'),
    '条件变了要同步'
  )
}

console.log(`\n=== 连选状态：${pass}/${pass + fail} 通过 ===`)
if (fail) process.exit(1)
