/**
 * 把主进程核心模块编译到 out-e2e，供 scripts/e2e.mjs 在纯 Node 环境里跑端到端自检
 * （不需要 Electron 窗口）。
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'out-e2e')

rmSync(outDir, { recursive: true, force: true })

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const result = spawnSync(
  process.execPath,
  [tsc, '-p', join(root, 'tsconfig.e2e.json')],
  { stdio: 'inherit', cwd: root }
)

if (result.status !== 0) {
  console.error('\n核心模块编译失败')
  process.exit(result.status ?? 1)
}

/** tsc 不会重写路径别名，这里把 "@shared/x" 换成产物的相对路径 */
function rewriteAliases(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      rewriteAliases(full)
      continue
    }
    if (!full.endsWith('.js')) continue
    const source = readFileSync(full, 'utf8')
    const target = join(outDir, 'shared')
    let rel = relative(dirname(full), target).split(sep).join('/')
    if (!rel.startsWith('.')) rel = `./${rel}`
    const updated = source.replace(/(["'])@shared\//g, `$1${rel}/`)
    if (updated !== source) writeFileSync(full, updated)
  }
}

rewriteAliases(outDir)

// 仓库 package.json 是 "type": "module"，而这里编译出来的是 CommonJS，
// 因此在产物目录里放一个自己的 package.json 明确模块类型。
writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2))
console.log(`\n核心模块已编译到 ${outDir}`)
