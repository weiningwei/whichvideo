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

  // 4) 配置不从 __dirname / import.meta.dirname 取路径
  //    electron-vite 会按 package.json 的 type 决定用 ESM 还是 CJS 解析配置，
  //    两者混用会导致配置加载失败，所以统一用 process.cwd() 并显式校验工作目录。
  const configCode = config
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  check('配置没有真的使用 __dirname', !configCode.includes('__dirname'))
  check('配置没有真的使用 import.meta.dirname', !configCode.includes('import.meta.dirname'))
  check('配置校验了工作目录', configCode.includes('process.cwd()') && configCode.includes('existsSync'))

  // 5) 主进程入口必须自动收集，不能退回手写列表
  //    历史上手写 7 个入口，新增 src/main/xxx.ts 后漏掉，运行时报 Cannot find module。
  check(
    '主进程入口由扫描 src/main 自动生成',
    configCode.includes('mainEntries') && configCode.includes('readdirSync'),
    '不应手写入口列表'
  )
  check(
    '主进程产物启用 preserveModules（一个模块一个文件）',
    configCode.includes('preserveModules'),
    '否则共享模块会被复制进多个入口，logger 这类模块级状态会分裂'
  )
  check('配置没有手写 datadir.ts 入口', !configCode.includes("'datadir.ts'"))

  console.log(`\n=== 打包配置：${passed}/${passed + failed} 通过 ===`)
  process.exit(failed ? 1 : 0)
}

main()
