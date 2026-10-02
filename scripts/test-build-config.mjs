/**
 * 打包配置静态校验。
 *
 * 起因：electron-vite 的 preload 段漏配了 `@shared` 别名，
 * 导致 `pnpm build` 在 Rollup 解析 `src/preload/index.ts` 时报
 * `Failed to resolve import "@shared/types"`。
 *
 * 这类错误只在完整构建时暴露，而受限环境里又跑不了完整构建（esbuild 需要子进程），
 * 所以这里做静态检查，保证同样的坑不会再踩：
 *   1. src 下每个构建目标用到的别名，都必须在该目标的配置段里声明
 *   2. 别名目标目录存在
 *   3. 各构建目标入口文件存在
 *   4. 配置用 __dirname 解析路径（不依赖执行时的工作目录）
 *
 * 运行： node scripts/test-build-config.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findMissingAliases, splitConfigSections } from './lib/build-config-check.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

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
  const configPath = join(root, 'electron.vite.config.ts')
  check('存在 electron.vite.config.ts', existsSync(configPath))
  const config = readFileSync(configPath, 'utf8')
  const sections = splitConfigSections(config)

  for (const name of ['main', 'preload', 'renderer']) {
    check(`配置里存在 ${name} 段`, sections[name].includes(`${name}: {`))
  }

  // 1) 每个构建目标用到的别名都要声明
  const targets = [
    { name: 'main', dir: join(root, 'src', 'main') },
    { name: 'preload', dir: join(root, 'src', 'preload') },
    { name: 'renderer', dir: join(root, 'src', 'renderer', 'src') }
  ]
  for (const target of targets) {
    const { used, missing } = findMissingAliases(config, target.dir, sections[target.name])
    for (const alias of used) {
      check(
        `${target.name} 段声明了 ${alias} 别名`,
        !missing.includes(alias),
        missing.includes(alias) ? `src/${target.name} 里用到了但没在配置里声明` : ''
      )
    }
  }

  // 2) 别名目标目录存在
  for (const [label, expected] of [
    ['@shared', join(root, 'src', 'shared')],
    ['@renderer', join(root, 'src', 'renderer', 'src')]
  ]) {
    if (!config.includes(`'${label}'`)) continue
    check(`${label} 别名指向存在的目录`, existsSync(expected), expected)
  }

  // 3) 入口文件存在
  for (const [label, full] of [
    ['src/main/index.ts', join(root, 'src', 'main', 'index.ts')],
    ['src/preload/index.ts', join(root, 'src', 'preload', 'index.ts')],
    ['src/renderer/index.html', join(root, 'src', 'renderer', 'index.html')],
    ['src/renderer/src/main.tsx', join(root, 'src', 'renderer', 'src', 'main.tsx')]
  ]) {
    check(`入口存在：${label}`, existsSync(full))
  }

  // 4) 不依赖 cwd
  check('配置使用 __dirname 解析路径', config.includes('__dirname'), '避免"必须从仓库根目录执行"的隐性依赖')

  console.log(`\n=== 打包配置：${passed}/${passed + failed} 通过 ===`)
  process.exit(failed ? 1 : 0)
}

main()
