/**
 * 把主进程/共享模块编译成纯 Node 可直接跑的 CommonJS 产物：
 *   out-e2e       核心链路自检（src/main 的核心模块）
 *   out-startup   启动链路自检（含 src/main/index.ts，配合 electron 桩运行）
 *
 * 仓库 package.json 是 "type": "module"，所以产物目录里各放一个
 * package.json 标注 commonjs，否则 Node 会按 ESM 解析而报 exports is not defined。
 *
 * 运行： node scripts/build-core.mjs
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** tsc 不会重写路径别名，这里把 "@shared/x" 换成产物的相对路径 */
function rewriteAliases(outDir) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
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
  walk(outDir)
}

function build(label, project, outDir, keep = false) {
  if (!keep) rmSync(outDir, { recursive: true, force: true })
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, project)], { stdio: 'inherit', cwd: root })
  if (result.status !== 0) {
    console.error(`\n${label} 编译失败`)
    process.exit(result.status ?? 1)
  }
  rewriteAliases(outDir)
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2))
  console.log(`${label} 已编译到 ${outDir}`)
}

build('核心模块', 'tsconfig.e2e.json', join(root, 'out-e2e'))
build('启动链路', 'tsconfig.startup.json', join(root, 'out-startup'))

console.log('\n完成。')
