/**
 * 验证「光标移动 + 单选跟随」的行为，而不只是语法。
 *
 * 为什么需要它：ui-smoke 的断言全是静态检查（源码里有没有某个调用），
 * 抓不到"方向键动��选中没跟着动"这类**逻辑**错误——而这正是本项目反复出现的
 * 问题（焦点与选中曾被写成两个独立 state，语法完全正确，用起来却不跟手）。
 *
 * 这里复刻 moveCursor / jumpCursor 的核心算法（从 videoRowIndexes 上定位、
 * 按 Ctrl 决定动不动选中），喂各种边界情况看结果对不对。
 */

/** 造一份与 LibraryView 同构的 navigableItems */
function makeItems(ids, grouped) {
  if (!grouped) return ids.map((id) => ({ type: 'video', id }))
  return ids.flatMap((id) => [{ type: 'folder' }, { type: 'video', id }])
}

/** 只收视频行的下标 —— 与组件里 videoRowIndexes 同义 */
function videoRowIndexesOf(items) {
  const out = []
  items.forEach((it, i) => {
    if (it.type === 'video') out.push(i)
  })
  return out
}

/** 复刻 moveCursor：算出目标下标与新的选中集 */
function move(items, focusedIndex, delta, ctrlKey, selected) {
  const rows = videoRowIndexesOf(items)
  if (rows.length === 0) return null
  const pos = rows.indexOf(focusedIndex)
  // 光标可能落在分组标题上（index 0），此时按向下从首行起步、按向上从末行起步：
  // delta > 0 → from = -1，使 from + delta = 0（首行）
  // delta < 0 → from = rows.length，使 from + delta = 末行
  const from = pos === -1 ? (delta > 0 ? -1 : rows.length) : pos
  const nextPos = Math.max(0, Math.min(rows.length - 1, from + delta))
  const nextIndex = rows[nextPos]
  let nextSelected = selected
  if (!ctrlKey) {
    const it = items[nextIndex]
    if (it && it.type === 'video') nextSelected = new Set([it.id]) // 单选跟随
  }
  return { nextIndex, nextSelected }
}

/**
 * 复刻 handleRowClick：**点击必须同时移动光标**。
 *
 * 这一条是补上次的漏：上版只把方向键与光标打通了，点击仍只改选中，
 * 于是「点第三个视频 → 按 ↑」会从初始光标位置（第一个）起算，直接跳回第一个。
 * 按 videoId 反查下标而不是靠 map 位置参数算偏移 —— 分组视图下每组前面都插了
 * 标题，偏移量很容易算错，而算错的症状恰好就是"跳到第一个"这种。
 */
function clickRow(items, focusedIndex, videoId) {
  const index = items.findIndex((it) => it.type === 'video' && it.id === videoId)
  if (index === -1) return { nextIndex: focusedIndex, nextSelected: new Set([videoId]) }
  return { nextIndex: index, nextSelected: new Set([videoId]) }
}

/** 复刻 jumpCursor：Home / End / PageUp / PageDown 用 */
function jump(items, pos) {  const rows = videoRowIndexesOf(items)
  if (rows.length === 0) return null
  const nextPos = Math.max(0, Math.min(rows.length - 1, pos))
  return { nextIndex: rows[nextPos] }
}

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (detail ? '  ← ' + detail : ''))
  }
}

console.log('=== 平铺视图：↓ 逐行移动且单选跟随 ===')
{
  const items = makeItems([10, 11, 12, 13], false)
  let fi = 0
  let sel = new Set([10])
  const seen = []
  for (let i = 0; i < 3; i++) {
    const r = move(items, fi, 1, false, sel)
    fi = r.nextIndex
    sel = r.nextSelected
    seen.push([...sel][0])
  }
  check('连按三次 ↓，选中依次为 11/12/13', JSON.stringify(seen) === '[11,12,13]', JSON.stringify(seen))
  check('选中恒为 1 个（单选而非累积）', sel.size === 1, 'size=' + sel.size)
}

console.log('=== 边界：末行再按 ↓ / 首行再按 ↑ 不越界 ===')
{
  const items = makeItems([10, 11], false)
  const down = move(items, 1, 1, false, new Set([11]))
  check('末行按 ↓ 停在原处', down.nextIndex === 1, 'nextIndex=' + down.nextIndex)
  const up = move(items, 0, -1, false, new Set([10]))
  check('首行按 ↑ 停在原处', up.nextIndex === 0)
  const bigDown = move(items, 1, 99, false, new Set([11]))
  check('越界的 delta 被夹紧', bigDown.nextIndex === 1)
  const bigUp = move(items, 0, -99, false, new Set([10]))
  check('负向越界被夹紧', bigUp.nextIndex === 0)
}

console.log('=== Ctrl+↓ 只移光标，不改选中 ===')
{
  const items = makeItems([10, 11, 12], false)
  const before = new Set([10, 11])
  const r = move(items, 1, 1, true, before)
  check('光标确实移动了', r.nextIndex === 2, 'nextIndex=' + r.nextIndex)
  check('选中原封不动', r.nextSelected.size === 2 && r.nextSelected.has(10) && r.nextSelected.has(11))
  check('没有顺手选中新行 12', !r.nextSelected.has(12))
  check('返回的是同一个 Set（未被重建）', r.nextSelected === before)
}

console.log('=== 分组视图：方向键跳过分组标题 ===')
{
  const items = makeItems([10, 11], true) // [标题, v10, 标题, v11]
  const rows = videoRowIndexesOf(items)
  check('视频行下标是 [1,3]（两个标题都被跳过）', JSON.stringify(rows) === '[1,3]', JSON.stringify(rows))
  const r = move(items, 1, 1, false, new Set([10]))
  check('从 v10 按 ↓ 直接落到 v11，不经过标题', r.nextIndex === 3, 'nextIndex=' + r.nextIndex)
  check('选中同步变成 11', [...r.nextSelected][0] === 11)
}

console.log('=== 分组视图：光标误落在标题上时能起步 ===')
{
  const items = makeItems([10, 11], true)
  const down = move(items, 0, 1, false, new Set())
  check('光标在 index 0（标题）时按 ↓ 落到 v10', down.nextIndex === 1, 'nextIndex=' + down.nextIndex)
  check('并选中 v10', [...down.nextSelected][0] === 10)
  const up = move(items, 0, -1, false, new Set())
  check('按 ↑ 则从末行起步（v11）', up.nextIndex === 3, 'nextIndex=' + up.nextIndex)
}

console.log('=== jumpCursor：End / Home 的夹紧 ===')
{
  const items = makeItems([10, 11, 12, 13], false)
  const end = jump(items, 999)
  check('End 落到最后一行', end.nextIndex === 3, 'nextIndex=' + end.nextIndex)
  const home = jump(items, -5)
  check('Home 落到第一行', home.nextIndex === 0)
  const grouped = makeItems([10, 11, 12], true)
  const gEnd = jump(grouped, 999)
  check('分组视图 End 落到最后一个视频行（不是标题）', gEnd.nextIndex === 5, 'nextIndex=' + gEnd.nextIndex)
}

console.log('=== 空列表不崩 ===')
{
  check('平铺空列表返回 null', move([], 0, 1, false, new Set()) === null)
  check('分组但无视频返回 null', move([{ type: 'folder' }], 0, 1, false, new Set()) === null)
}

console.log('=== 点击整行会同步移动光标（用户报告的那个 bug）===')
{
  // 平铺：点第 3 个（id 12）后按 ↑，应落到 11 而不是 10
  const flat = makeItems([10, 11, 12, 13], false)
  const clicked = clickRow(flat, 0, 12)
  check('点击后光标落在被点的那一行', clicked.nextIndex === 2, 'nextIndex=' + clicked.nextIndex)
  check('点击后选中的是被点的那一行', [...clicked.nextSelected][0] === 12)
  const up = move(flat, clicked.nextIndex, -1, false, clicked.nextSelected)
  check('点第 3 个后按 ↑ 落到第 2 个（不是第 1 个）', [...up.nextSelected][0] === 11, '得到 ' + [...up.nextSelected][0])
}

console.log('=== 分组视图：点第 N 个后按 ↑ 不受标题偏移影响 ===')
{
  // [标题, v10, 标题, v11, 标题, v12, 标题, v13]
  const grouped = makeItems([10, 11, 12, 13], true)
  const rows = videoRowIndexesOf(grouped)
  const clicked = clickRow(grouped, rows[0], 12)
  check('按 id 反查到正确下标（不是靠位置算）', clicked.nextIndex === 5, 'nextIndex=' + clicked.nextIndex)
  const up = move(grouped, clicked.nextIndex, -1, false, clicked.nextSelected)
  check('点 v12 后按 ↑ 落到 v11', [...up.nextSelected][0] === 11, '得到 ' + [...up.nextSelected][0])
  // 反向：点第 1 个后按 ↓ 应到第 2 个
  const first = clickRow(grouped, rows[0], 10)
  const down = move(grouped, first.nextIndex, 1, false, first.nextSelected)
  check('点 v10 后按 ↓ 落到 v11', [...down.nextSelected][0] === 11, '得到 ' + [...down.nextSelected][0])
}

console.log('=== 点击后再连按方向键：从点击处连续走 ===')
{
  const flat = makeItems([10, 11, 12, 13, 14], false)
  let c = clickRow(flat, 0, 12)
  const seq = [12]
  for (let i = 0; i < 2; i++) {
    c = move(flat, c.nextIndex, 1, false, c.nextSelected)
    seq.push([...c.nextSelected][0])
  }
  check('点 12 后连按两次 ↓ 得到 12→13→14', JSON.stringify(seq) === '[12,13,14]', JSON.stringify(seq))
}

console.log(`\n=== 光标行为：${pass}/${pass + fail} 通过 ===`)
if (fail) process.exit(1)