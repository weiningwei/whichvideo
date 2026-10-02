/**
 * 用官方 @electron/asar 检查打包产物（先前的自研解析容易写错偏移）。
 * 用法： node scripts/lib/inspect-asar.mjs [asar 路径]
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

/** @electron/asar 是 electron-builder 的传递依赖，不一定提升到顶层，这里按需定位 */
function loadAsar() {
  const candidates = []
  try {
    candidates.push(require.resolve('@electron/asar'))
  } catch {
    /* 顶层没有就往下找 pnpm 虚拟 store */
  }
  const store = resolve('node_modules/.pnpm')
  if (existsSync(store)) {
    for (const dir of readdirSync(store)) {
      if (!dir.startsWith('@electron+asar@')) continue
      candidates.push(join(store, dir, 'node_modules', '@electron', 'asar', 'lib', 'asar.js'))
    }
  }
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('找不到 @electron/asar（应先执行 pnpm install）')
  return require(found)
}

const asar = loadAsar()

const path = resolve(process.argv[2] ?? 'release/WhichVideo-portable/resources/app.asar')
if (!existsSync(path)) {
  console.log(`asar 不存在：${path}`)
  process.exit(0)
}

console.log(`asar: ${path}`)
console.log(`大小 ${(statSync(path).size / 1024 / 1024).toFixed(2)} MB，mtime ${statSync(path).mtime.toLocaleString('zh-CN')}`)

const files = asar.listPackage(path).map((p) => p.replace(/\\/g, '/'))
console.log(`文件数 ${files.length}`)

console.log('\n--- out/ 产物 ---')
for (const f of files.filter((x) => x.startsWith('/out/'))) console.log(`  ${f}`)

console.log('\n--- 顶层文件 ---')
for (const f of files.filter((x) => x.split('/').length === 2)) console.log(`  ${f}`)

// asar.extractFile 的路径语义在不同版本间不一致，直接整体解出来更可靠
const extractDir = resolve('tmp', 'asar-inspect')
rmSync(extractDir, { recursive: true, force: true })
asar.extractAll(path, extractDir)
const read = (p) => readFileSync(join(extractDir, p.replace(/^\//, '')))

// 1) 包内 package.json 的 type 字段（关键：声明了 module 会让 Electron 按 ESM 加载主进程）
try {
  const pkg = JSON.parse(read('package.json').toString('utf8'))
  console.log('\n--- 包内 package.json ---')
  console.log(`  main = ${JSON.stringify(pkg.main)}`)
  console.log(
    `  type = ${JSON.stringify(pkg.type)}  ${
      pkg.type === undefined
        ? '✓ 未声明（主进程按 CommonJS 加载）'
        : '✗ 声明了 type（Electron 会按 ESM 加载主进程 → 启动即退出）'
    }`
  )
} catch (err) {
  console.log(`\n✗ 读不出包内 package.json：${err.message}`)
}

// 2) 包内主进程产物 vs 本地 out/
const packedMain = read('out/main/index.js')
const localPath = resolve('out/main/index.js')
const localMain = existsSync(localPath) ? readFileSync(localPath) : null
console.log('\n--- 包内主进程 vs 本地 out/main/index.js ---')
console.log(`  包内 ${packedMain.length} 字节`)
if (localMain) {
  console.log(`  本地 ${localMain.length} 字节`)
  console.log(`  完全一致：${packedMain.equals(localMain) ? '✓' : '✗（包内是旧代码）'}`)
} else {
  console.log('  本地 out/main/index.js 不存在，跳过比对')
}

console.log('\n--- 包内主进程的启动关键代码 ---')
const text = packedMain.toString('utf8')
for (const [label, needle] of [
  ['写入启动日志', '启动：electron'],
  ['解析数据目录', '数据目录'],
  ['自适应 preload 路径', '未找到 preload 产物'],
  ['单实例锁', '已有实例在运行']
]) {
  console.log(`  ${label}：${text.includes(needle) ? '✓' : '✗'}`)
}

// 3) preload 产物名
const preload = files.find((f) => /^\/out\/preload\/index\.(mjs|js|cjs)$/.test(f))
console.log(`\npreload 产物：${preload ?? '✗ 缺失'}`)
