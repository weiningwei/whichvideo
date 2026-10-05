/**
 * 构建后校验：out/main 必须包含主进程真正会 require 的所有文件。
 *
 * 为什么需要：src/main/index.ts 用 `require('./db')` 这类字面量惰性加载核心模块，
 * 若某个文件没被列为主进程构建入口，Rollup **既不报错也不打包**，
 * 直到运行时才抛 "Cannot find module './db'"（表现为窗口标题「启动失败」）。
 * 历史上就漏过一次：手写入口列表时新增模块没同步。
 *
 * 现在入口由 electron.vite.config.ts 扫描 src/main 自动生成，本脚本作为第二道防线：
 * 直接从**编译产物**里把所有 require('./x') 摘出来，逐个确认 out/main/x.js 存在。
 * 这样即便将来有人改回手写列表，也会在构建阶段立刻失败。
 *
 * 运行： node scripts/test-build-output.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
// 优先校验发布产物 out/；它不存在时退回启动自检的编译产物 out-startup/
const outMain = existsSync(join(root, 'out', 'main'))
  ? join(root, 'out', 'main')
  : join(root, 'out-startup', 'main')

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

function main() {
  console.log('=== 主进程产物完整性 ===')
  console.log(`  校验目录：${outMain.replace(root + '\\', '')}`)

  if (!existsSync(outMain)) {
    console.error('  ✗ 找不到编译产物，请先运行 node scripts/build-core.mjs 或 pnpm build')
    process.exit(1)
  }

  const sourceFiles = readdirSync(join(root, 'src', 'main')).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.d.ts')
  )
  const builtFiles = readdirSync(outMain).filter((f) => f.endsWith('.js'))

  check(
    `src/main 下每个 .ts 都有对应产物（${sourceFiles.length} 个源文件）`,
    sourceFiles.every((f) => builtFiles.includes(f.replace(/\.ts$/, '.js'))),
    sourceFiles
      .filter((f) => !builtFiles.includes(f.replace(/\.ts$/, '.js')))
      .map((f) => `缺少 ${f.replace(/\.ts$/, '.js')}`)
      .join('、') || `产物：${builtFiles.join(', ')}`
  )

  // 从产物里摘出所有相对 require，逐个验证文件存在
  const indexJs = join(outMain, 'index.js')
  check('存在 out/main/index.js', existsSync(indexJs))
  if (!existsSync(indexJs)) {
    process.exit(1)
  }

  const code = readFileSync(indexJs, 'utf8')
  const required = new Set()
  for (const match of code.matchAll(/require\(\s*['"]\.\/([\w.-]+)['"]\s*\)/g)) {
    required.add(match[1])
  }
  // 排除 node_modules 内建与绝对包名，只留相对路径
  const missing = []
  for (const name of required) {
    const candidates = [join(outMain, `${name}.js`), join(outMain, name), join(outMain, `${name}.json`)]
    if (!candidates.some((p) => existsSync(p))) missing.push(name)
  }

  check(
    `index.js 里的每个 require('./x') 都有对应产物（共 ${required.size} 个）`,
    missing.length === 0,
    missing.length ? `缺失：${missing.join(', ')}` : [...required].sort().join(', ')
  )

  // 惰性加载的核心模块必须都能找到（这是历史上真实出过问题的那批）
  const coreExpected = ['db', 'search', 'indexer', 'watcher', 'media', 'datadir']
  const coreMissing = coreExpected.filter((n) => !existsSync(join(outMain, `${n}.js`)))
  check('惰性加载的核心模块产物齐全', coreMissing.length === 0, coreMissing.join(', ') || coreExpected.join(', '))

  // 解耦不变量：watcher 与 indexer 之间只允许经过文件事件总线（src/main/interfaces.ts）。
  // 回退成 watcher 直接 require indexer 也能跑，但模块图会重新缠死——这里按产物拦。
  const watcherJs = join(outMain, 'watcher.js')
  if (existsSync(watcherJs)) {
    const watcherCode = readFileSync(watcherJs, 'utf8')
    check(
      "watcher 产物不 require('./indexer')（文件变化走事件总线）",
      !/require\(\s*['"]\.\/indexer(\.js)?['"]\s*\)/.test(watcherCode)
    )
  } else {
    check('存在 watcher.js（解耦断言的前提）', false)
  }
  const indexCodeForWiring = readFileSync(indexJs, 'utf8')
  check(
    'index.js 把文件事件接进 indexer.handleFileEvent（组合点在 bootstrap）',
    /require\(\s*['"]\.\/interfaces(\.js)?['"]\s*\)/.test(indexCodeForWiring) &&
      indexCodeForWiring.includes('handleFileEvent')
  )

  console.log(`\n=== 主进程产物完整性：${passed}/${passed + failed} 通过 ===`)
  if (failed) process.exit(1)
}

main()
