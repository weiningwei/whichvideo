/**
 * 主进程启动自检（不需要 Electron 运行时）。
 *
 * 起因：打包后的 WhichVideo.exe 双击后毫无反应，终端里也立刻回到提示符 ——
 * 典型原因是主进程在启动阶段就退了，而 Windows 的 GUI 子系统不接控制台，看不到报错。
 *
 * 做法：把编译后的主进程产物跑在 Node 里，用 scripts/lib/electron-stub.mjs 替换
 * require('electron')，按场景验证启动链路。
 *
 * 两个必须绕开的坑：
 *   1. ESM 模块只求值一次，同一份 bundle 连续 import 不会重新执行启动流程
 *      → 每个场景复制一份 bundle，让 Node 认为是不同模块
 *   2. package.json 是 type: module，而产物是 CommonJS
 *      → 复制时用 .cjs 后缀
 * （本环境还禁止子进程管道，所以没用子进程隔离。）
 *
 * 运行： node scripts/startup-smoke.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const workBase = join(root, 'tmp', 'startup-smoke')
const outMain = join(root, 'out-startup', 'main')

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate, timeout = 8000, label = '条件') {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (predicate()) return true
    await sleep(60)
  }
  console.log(`    ! 等待超时：${label}`)
  return false
}

/** 把编译产物里的 require('electron') 重写到本地桩，并复制成独立模块 */
function makeScenarioBundle(id) {
  const source = readFileSync(join(outMain, 'index.js'), 'utf8')
  writeFileSync(
    join(outMain, '__electron_stub.cjs'),
    `const stub = globalThis.__ELECTRON_STUB__\nif (!stub) throw new Error('electron 桩未注入')\nmodule.exports = stub\n`
  )
  const rewritten = source.replace(/require\((['"])electron\1\)/g, "require('./__electron_stub.cjs')")
  const target = join(outMain, `index.scenario-${id}.cjs`)
  writeFileSync(target, rewritten)
  return target
}

async function runScenario(id, setup) {
  const paths = {
    appRoot: join(workBase, 'app'),
    userData: join(workBase, id, 'WhichVideo'),
    exeDir: join(workBase, id, 'green')
  }
  mkdirSync(join(paths.appRoot, 'renderer'), { recursive: true })
  const indexHtml = join(paths.appRoot, 'renderer', 'index.html')
  if (!existsSync(indexHtml)) writeFileSync(indexHtml, '<!doctype html><title>WhichVideo</title>')
  // 主进程会在启动时寻找 preload 产物（index.mjs / index.js），放一个占位文件，
  // 这样"preload 路径解析"也能被一起验证
  const preloadDir = join(paths.appRoot, 'preload')
  mkdirSync(preloadDir, { recursive: true })
  const preloadJs = join(preloadDir, 'index.mjs')
  if (!existsSync(preloadJs)) writeFileSync(preloadJs, 'export {}\n')
  mkdirSync(paths.userData, { recursive: true })
  mkdirSync(paths.exeDir, { recursive: true })

  const stubModule = await import(pathToFileURL(join(root, 'scripts', 'lib', 'electron-stub.mjs')).href)
  // 注意：要注入的是完整命名空间（含 resetState/state 这些控制接口），
  // 主进程用到的 app/BrowserWindow/... 也都在同一个命名空间上。
  const api = stubModule.default
    ? Object.assign(Object.create(null), stubModule.default, stubModule)
    : stubModule
  globalThis.__ELECTRON_STUB__ = api
  api.resetState()

  // logger 是模块单例，跨场景必须重置，否则启动日志会被追加到上一个场景的日志文件里
  const loggerModule = await import(
    pathToFileURL(join(root, 'out-startup', 'main', 'logger.js')).href
  ).catch(() => null)
  loggerModule?.resetLogger?.()

  process.env.__TEST_TMP__ = paths.userData
  process.env.__TEST_APP_PATH__ = paths.appRoot
  process.env.__TEST_EXE__ = join(paths.exeDir, 'WhichVideo.exe')
  // 默认按"开发模式"跑：不触发"exe 同级目录可写 → 写 exe 旁 data"这条回退。
  // 桩里的 exe 目录总是可写的，不关掉的话所有场景都会被判成便携模式。
  // 便携模式由场景 2 显式设置 PORTABLE_EXECUTABLE_DIR 来验证。
  process.env.__TEST_IS_PACKAGED__ = 'false'
  delete process.env.WHICHVIDEO_DATA_DIR
  delete process.env.PORTABLE_EXECUTABLE_DIR

  setup?.({ paths, api })

  const bundlePath = makeScenarioBundle(id)
  await import(pathToFileURL(bundlePath).href)
  const expectedDataDir = process.env.PORTABLE_EXECUTABLE_DIR
    ? join(process.env.PORTABLE_EXECUTABLE_DIR, 'data')
    : paths.userData
  await waitFor(
    () => api.state.windows.length > 0 || api.state.quitCalls > 0,
    15000,
    `${id}：窗口或退出`
  )
  await waitFor(() => api.state.shown > 0 || api.state.quitCalls > 0, 15000, `${id}：窗口显示或退出`)
  await sleep(600) // 等日志刷盘

  const logPath = join(expectedDataDir, 'whichvideo.log')
  const logExists = existsSync(logPath)
  const logText = logExists ? readFileSync(logPath, 'utf8') : ''
  console.log(`  · 场景 ${id}：日志 ${logExists ? '存在' : '缺失'}，${logText.split('\n').filter(Boolean).length} 行 → ${logPath}`)

  return {
    paths,
    api,
    expectedDataDir,
    logPath,
    logExists,
    log: logText,
    dbExists: existsSync(join(expectedDataDir, 'whichvideo.db')),
    markerExists: existsSync(join(expectedDataDir, 'whichvideo.portable'))
  }
}
function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

async function main() {
  if (!existsSync(join(outMain, 'index.js'))) {
    console.error('请先运行 node scripts/build-core.mjs')
    process.exit(1)
  }
  rmSync(workBase, { recursive: true, force: true })
  mkdirSync(workBase, { recursive: true })

  // 主进程从 __dirname（即 out-startup/main）往上一级找 preload 产物，
  // 所以这里在 out-startup/preload 下放一个占位文件，模拟真实构建结果。
  const stubPreloadDir = join(root, 'out-startup', 'preload')
  mkdirSync(stubPreloadDir, { recursive: true })
  writeFileSync(join(stubPreloadDir, 'index.mjs'), 'export {}\n')

  /* ---------------- 打包配置层面的启动前提 ---------------- */
  console.log('\n=== 场景 0：打包后能被 Electron 正确加载的前提 ===')
  {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    // Electron 会按 package.json 的 type 决定如何加载主进程入口。
    // 主进程产物是 CommonJS（electron-vite 默认），若这里声明 module，
    // Electron 会当 ESM 解析并立刻抛错退出 —— 表现为"双击没反应、无日志、无数据目录"。
    check(
      'package.json 不声明 type: module（避免主进程被当 ESM 加载）',
      pkg.type === undefined,
      pkg.type === undefined ? '' : `type=${pkg.type}`
    )
    check('主进程入口指向 out/main/index.js', pkg.main === './out/main/index.js', String(pkg.main))

    const config = readFileSync(join(root, 'electron.vite.config.ts'), 'utf8')
    // 只看代码，忽略注释（注释里会提到 __dirname 说明为什么不用它）
    const configCode = config
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    check('打包配置没有真的使用 __dirname', !configCode.includes('__dirname'))
    check('打包配置没有真的使用 import.meta.dirname', !configCode.includes('import.meta.dirname'))

    const mainSource = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8')
    check('主进程会自动解析 preload 扩展名', mainSource.includes('resolvePreloadPath'))
  }

  /* ---------------- 场景 1：默认模式 ---------------- */
  console.log('\n=== 场景 1：默认模式（数据写入 userData） ===')
  {
    const r = await runScenario('default')
    const urls = r.api.state.loadedUrls.join('\n')
    check('窗口被创建', r.api.state.windows.length > 0, `${r.api.state.windows.length} 个`)
    check('窗口被显示（不是静默退出）', r.api.state.shown > 0)
    check('生成了启动日志', r.logExists, r.logPath)
    check('日志记录了启动与数据目录', /启动：electron/.test(r.log) && r.log.includes('数据目录：'))
    check('日志记录了 IPC 注册', r.log.includes('IPC 已注册'))
    check('日志记录了初始化完成', r.log.includes('初始化完成'))
    check('加载的是内置界面（不是错误页）', urls.includes('renderer') && !urls.includes('data:text/html'))
    check('数据目录落在 userData 下', r.log.includes(r.paths.userData), r.paths.userData)
    check('未误判为便携模式', r.log.includes('portable=false'))
    check('默认模式不启用禁用磁盘缓存开关', !r.api.state.switches.includes('disable-http-cache'))
    check('创建了索引库文件', r.dbExists)
    const preloadOption = r.api.state.windows[0]?.options?.webPreferences?.preload
    check(
      'preload 路径指向真实存在的产物（自动适配 .mjs / .js）',
      typeof preloadOption === 'string' &&
        /index\.(mjs|js|cjs)$/.test(preloadOption) &&
        existsSync(preloadOption),
      String(preloadOption)
    )
    check(
      'preload 解析到了 out-startup/preload 下',
      typeof preloadOption === 'string' && preloadOption.includes(join('out-startup', 'preload')),
      String(preloadOption)
    )
    check('没有出现找不到 preload 的警告', !r.log.includes('未找到 preload 产物'))
  }

  /* ---------------- 场景 2：便携模式 ---------------- */
  console.log('\n=== 场景 2：便携模式（数据写入 exe 同级 data） ===')
  {
    const r = await runScenario('portable', ({ paths }) => {
      process.env.PORTABLE_EXECUTABLE_DIR = paths.exeDir
    })
    check('窗口被显示', r.api.state.shown > 0)
    check('在 exe 同级创建了 data 目录', existsSync(r.expectedDataDir), r.expectedDataDir)
    check('写入便携标记文件', r.markerExists)
    check('日志写入 data 目录', r.log.includes('portable=true'))
    check('启用了禁用磁盘缓存开关', r.api.state.switches.includes('disable-http-cache'))
    check('userData 被重定向到 data 目录', r.api.state.paths.get('userData') === r.expectedDataDir, r.api.state.paths.get('userData'))
    check('sessionData 被重定向到 data/session', r.api.state.paths.get('sessionData') === join(r.expectedDataDir, 'session'))
    check('创建了索引库文件', r.dbExists)
  }

  /* ---------------- 场景 3：初始化失败必须可见 ---------------- */
  console.log('\n=== 场景 3：初始化失败时不再静默退出 ===')
  {
    const r = await runScenario('broken', ({ paths }) => {
      // 放一个损坏的 sqlite 文件，让数据库打不开
      writeFileSync(join(paths.userData, 'whichvideo.db'), 'this is not a sqlite database')
    })
    const urls = r.api.state.loadedUrls.join('\n')
    check('窗口被创建', r.api.state.windows.length > 0)
    check('窗口显示出来', r.api.state.shown > 0)
    check('错误被写进日志', /\[ERROR\]/.test(r.log), lastErrorLine(r.log))
    check('日志里有初始化失败的记录', /初始化失败/.test(r.log))
    check(
      '日志里带上底层原因',
      /file is not a database|SQLITE_NOTADB|SqliteError/i.test(r.log),
      (r.log.split('\n').find((l) => /SqliteError|not a database/i.test(l)) ?? '').slice(0, 120)
    )
    check('通过事件通知界面（有窗口时不强行换页）', urls.includes('renderer'))
  }

  /* ---------------- 场景 4：单实例锁 ---------------- */
  console.log('\n=== 场景 4：重复启动的行为可解释 ===')
  {
    const r = await runScenario('second-instance', ({ api }) => {
      api.state.singleInstanceLock = false
    })
    check('拿不到单实例锁时调用 app.quit()', r.api.state.quitCalls > 0, `quit ${r.api.state.quitCalls} 次`)
    check('日志说明为什么没反应', r.log.includes('已有实例在运行'))
    check('不会再创建窗口', r.api.state.windows.length === 0)
  }

  // 关闭数据库连接后再清理临时目录（Windows 上文件被占用会删不掉）
  try {
    globalThis.__ELECTRON_STUB__?.closeDatabases?.()
  } catch {
    /* ignore */
  }
  await sleep(200)
  try {
    rmSync(workBase, { recursive: true, force: true })
  } catch {
    console.log(`  · 临时目录未能删除（文件被占用），保留在：${workBase}`)
  }
  console.log(`\n=== 启动自检：${passed}/${passed + failed} 通过 ===`)
  if (failed) process.exit(1)
}

function lastErrorLine(log) {
  const lines = log.split('\n').filter((l) => l.includes('[ERROR]'))
  return (lines[lines.length - 1] ?? '').slice(0, 140)
}

main().catch((err) => {
  console.error('\n启动自检异常：', err)
  process.exit(1)
})
