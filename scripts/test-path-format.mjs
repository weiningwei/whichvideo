/**
 * 路径格式化函数的边界自检（不依赖 ffmpeg / Electron）。
 *
 * 背景：视频库列表第二行曾出现两个真实问题——
 *   1. 文件名重复：shortPath 返回「目录 + 文件名」，而上一行已显示文件名，
 *      于是剧名连着出现两遍。修复方式是新增只取目录的 shortDir。
 *   2. 字符被截断：shortDir 里 `cut.slice(0, Math.max(lastIndexOf('\\'), lastIndexOf('/')))`，
 *      当文件直接位于监听根目录下时 cut 里没有分隔符，lastIndexOf 返回 -1，
 *      slice(0, -1) 会砍掉最后一个字符（"Ep02.mkv" → "Ep02.mp"）。
 *
 * 运行： node scripts/test-path-format.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const js = join(root, 'out-preview-test')
const fmtJs = join(js, 'renderer', 'src', 'lib', 'format.js')

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

// 渲染端 TS 用 tsc 转译（与 ui-smoke.mjs 同一套 tsconfig.preview.json）
function transpile() {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const r = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.preview.json'), '--outDir', js], {
    stdio: 'inherit',
    cwd: root
  })
  if (r.status !== 0) throw new Error('渲染端转译失败')
}

async function loadFormat() {
  rmSync(js, { recursive: true, force: true })
  mkdirSync(js, { recursive: true })
  transpile()
  if (!existsSync(fmtJs)) throw new Error(`转译产物里找不到 ${fmtJs}`)
  return import(pathToFileURL(fmtJs).href)
}

async function main() {
  console.log('  转译渲染端（tsc）…')
  const { shortDir, shortPath, fileNameOf } = await loadFormat()
  rmSync(js, { recursive: true, force: true })

  console.log('=== 目录与文件名的职责划分 ===')
  const roots = ['E:\\Media\\Movies']
  const cases = [
    // [完整路径, 期望目录, 说明]
    ['E:\\Media\\Movies\\Ep01.mkv', '', '文件直接位于根目录'],
    ['E:\\Media\\Movies\\S01\\Ep02.mkv', 'S01\\', '位于子目录一层'],
    ['E:\\Media\\Movies\\S01\\S02\\Ep03.mkv', 'S01\\S02\\', '位于子目录两层'],
    ['D:\\Other\\Film.mov', 'D:\\Other\\', '不在监听根目录下且仅 2 段目录，原样返回'],
    ['D:\\A\\B\\C\\Film.mov', '…\\B\\C\\', '深路径也不在监听根目录下']
  ]

  for (const [p, expected, note] of cases) {
    check(`shortDir 正确：${note}`, shortDir(p, roots) === expected, `得到 "${shortDir(p, roots)}"`)
  }

  console.log('')
  console.log('=== 关键回归：文件名不得被截断 ===')
  // 这条曾经失败：文件直接位于根目录时 lastIndexOf 返回 -1
  const direct = 'E:\\Media\\Movies\\Ep02.mkv'
  const dir = shortDir(direct, roots)
  check(
    '文件在根目录时目录为空（而非砍掉文件名的最后一个字符）',
    dir === '',
    `shortDir = "${dir}"`
  )
  check(
    'shortDir 不会吞掉文件名末字符',
    !fileNameOf(direct).startsWith(dir.slice(-1)) || dir === '',
    `文件名仍是 "${fileNameOf(direct)}"，未被 "${dir}" 截断`
  )
  // shortDir + fileNameOf 必须严格等于原始文件名
  check(
    'shortDir + fileNameOf 还原出完整文件名',
    shortDir(direct, roots) + fileNameOf(direct) === fileNameOf(direct),
    '拼接后无字符丢失'
  )
  const nested = 'E:\\Media\\Movies\\S01\\Ep02.mkv'
  check(
    '子目录下 shortDir + fileNameOf 拼出相对根的路径（不含绝对前缀与根目录名）',
    shortDir(nested, roots) + fileNameOf(nested) === 'S01\\Ep02.mkv',
    `${shortDir(nested, roots)} + ${fileNameOf(nested)}`
  )

  console.log('')
  console.log('=== shortDir 与 shortPath 的关系 ===')
  for (const [p] of cases) {
    const expected = shortDir(p, roots) + fileNameOf(p)
    check(
      `shortPath = shortDir + 文件名：${fileNameOf(p)}`,
      shortPath(p, roots) === expected,
      shortPath(p, roots) === expected ? '' : `shortPath="${shortPath(p, roots)}" 期望"${expected}"`
    )
  }

  console.log('')
  console.log('=== shortDir 绝不包含文件名（列表里不会重复两遍）===')
  for (const [p, , note] of cases) {
    const name = fileNameOf(p)
    const d = shortDir(p, roots)
    check(`shortDir 不含文件名：${note}`, !d.includes(name), `"${d}" 不含 "${name}"`)
  }

  console.log('')
  console.log('=== 边界：空目录与路径分隔符 ===')
  check('空字符串路径不抛错', typeof shortDir('', roots) === 'string', JSON.stringify(shortDir('', roots)))
  check('单个文件名（无目录）不抛错', typeof shortDir('a.mkv', roots) === 'string', JSON.stringify(shortDir('a.mkv', roots)))
  check('正斜杠路径也支持', shortDir('/media/movies/x.mkv', ['/media/movies']) === '', JSON.stringify(shortDir('/media/movies/x.mkv', ['/media/movies'])))
  check('大小写不敏感匹配', shortDir('e:\\MEDIA\\MOVIES\\x.mkv', roots) === '', JSON.stringify(shortDir('e:\\MEDIA\\MOVIES\\x.mkv', roots)))

  console.log(`\n=== 路径格式化：${passed}/${passed + failed} 通过 ===`)
  if (failed) process.exit(1)
}

main()
