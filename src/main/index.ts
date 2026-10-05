/**
 * Electron 主进程入口：窗口、IPC、库与索引器的生命周期。
 *
 * 打包后是 GUI 子系统程序，stdout 不出现在控制台，因此启动过程的关键节点
 * 都会写进 <数据目录>\whichvideo.log（见 ./logger.ts），方便排查"双击没反应"。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { IPC, type LibraryEvent } from '@shared/types'
import { getLogFile, initLogger, installCrashHandlers, log, logError, resetLogger } from './logger'
import { registerIpc } from './ipc'

installCrashHandlers()

// Windows 上未签名的 Electron 应用有若干已知的启动崩溃，统一表现为
// STATUS_BREAKPOINT（0x80000003 / 退出码 -2147483645）且**不产生任何日志**。
// 其中 GPU 沙箱相关的一类可以靠命令开关规避，本应用完全不需要 GPU 渲染，代价接近于零，
// 所以默认关掉 GPU 相关能力，宁可走软件渲染也要保证能启动。
// （参考：Chromium 在部分 Windows 11 版本上 GPU 子进程启动即崩的问题）
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

/**
 * 尽早把日志落到磁盘。
 *
 * 这里的目录是根据环境变量/便携标记**预先估算**出来的，可能与最终数据目录不同；
 * 后面 setupDataDirectory() 确定真实目录时会重新初始化并迁移日志（见 relocateLogger）。
 * 这么做是为了让"启动早期就崩溃"也能留下记录 —— 之前正是缺这段日志才无法定位问题。
 */
function bootstrapLogger(): void {
  const candidates: string[] = []
  if (process.env.WHICHVIDEO_DATA_DIR) candidates.push(process.env.WHICHVIDEO_DATA_DIR)
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'))
  }
  // app.getPath 在极早期理论上可能不可用，取不到就跳过（后面 relocateLogger 还会再初始化）
  try {
    candidates.push(app.getPath('userData'))
  } catch {
    /* ignore */
  }
  try {
    candidates.push(join(dirname(process.execPath), 'data'))
  } catch {
    /* ignore */
  }

  for (const dir of candidates) {
    try {
      initLogger(dir)
      return
    } catch {
      /* 换下一个候选目录 */
    }
  }
}

bootstrapLogger()
log(`启动：electron ${process.versions.electron} / node ${process.versions.node} / packaged=${app.isPackaged}`)
log(`exe=${process.execPath}`)
log(`早期日志目录=${getLogFile() ?? '(未启用)'}`)

// 单实例锁：重复启动时静默退出最容易被误认为"没反应"，这里显式记一笔并跳过后续初始化。
// 注意 app.quit() 不保证立刻终止进程，必须用标志位把后续流程挡住，否则照样会弹窗。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  log('已有实例在运行，本次启动退出（请查看已打开的那个窗口）')
  app.quit()
}

/* ------------------------------------------------------------------ *
 * 关键依赖：失败也要留下痕迹，不能静默退出
 * ------------------------------------------------------------------ */

interface CoreModules {
  LibraryDatabase: typeof import('./db').LibraryDatabase
  FrameSearchIndex: typeof import('./search').FrameSearchIndex
  queryVectorFromImage: typeof import('./search').queryVectorFromImage
  Indexer: typeof import('./indexer').Indexer
  FolderWatcher: typeof import('./watcher').FolderWatcher
  resolveTools: typeof import('./media').resolveTools
  resolveDataDir: typeof import('./datadir').resolveDataDir
  portableMarkerPath: typeof import('./datadir').portableMarkerPath
  DATABASE_FILES: typeof import('./datadir').DATABASE_FILES
  error: unknown
}

/**
 * 用 require 惰性加载核心模块（打包产物是 CJS）：
 * 任何模块级异常（原生模块加载失败、依赖缺失等）都能被捕获并写进日志，
 * 否则会表现为"双击没反应"。
 */
function loadCoreModules(): CoreModules {
  const core: Partial<CoreModules> = {}
  try {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const db = require('./db') as typeof import('./db')
    const search = require('./search') as typeof import('./search')
    const indexer = require('./indexer') as typeof import('./indexer')
    const watcher = require('./watcher') as typeof import('./watcher')
    const media = require('./media') as typeof import('./media')
    const datadir = require('./datadir') as typeof import('./datadir')
    core.LibraryDatabase = db.LibraryDatabase
    core.FrameSearchIndex = search.FrameSearchIndex
    core.queryVectorFromImage = search.queryVectorFromImage
    core.Indexer = indexer.Indexer
    core.FolderWatcher = watcher.FolderWatcher
    core.resolveTools = media.resolveTools
    core.resolveDataDir = datadir.resolveDataDir
    core.portableMarkerPath = datadir.portableMarkerPath
    core.DATABASE_FILES = datadir.DATABASE_FILES
    log('核心模块加载完成')
  } catch (err) {
    core.error = err
    logError('加载核心模块失败', err)
  }
  return core as CoreModules
}

const core = loadCoreModules()

let mainWindow: BrowserWindow | null = null
let db: InstanceType<CoreModules['LibraryDatabase']>
let searchIndex: InstanceType<CoreModules['FrameSearchIndex']>
let indexer: InstanceType<CoreModules['Indexer']>
let watcher: InstanceType<CoreModules['FolderWatcher']>
let toolsReady = false

/** 已打开的数据库连接，便于退出/自检时统一关闭，避免文件锁残留 */
const openDatabases: { close: () => void }[] = []

/* ------------------------------------------------------------------ *
 * 数据目录：绿色/便携模式
 *
 * 便携模式下数据（索引库、缓存）全部落在 exe 同级的 data/ 里，
 * 换机器时整个目录拷走即可，不会在系统盘留下任何东西。
 * 判定逻辑见 ./datadir.ts，这里只负责与 Electron 对接。
 * ------------------------------------------------------------------ */

/** 判断目录能否写入（不存在时尝试创建） */
function isWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, '.whichvideo-write-probe')
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/** 首次进入便携模式时，把系统盘里的旧索引库搬过来，避免用户白建一次索引 */
function migrateLegacyDatabase(targetDir: string, legacyDir: string): void {
  if (!legacyDir || resolve(legacyDir) === resolve(targetDir)) return
  for (const name of core.DATABASE_FILES ?? []) {
    const from = join(legacyDir, name)
    const to = join(targetDir, name)
    if (!existsSync(from)) continue
    try {
      copyFileSync(from, to)
    } catch {
      /* 迁移失败就让用户重新索引，不影响启动 */
    }
  }
}

/** 计算并应用数据目录（必须在 app ready 之前调用） */
function setupDataDirectory(): { dir: string; portable: boolean; source: string } {
  const legacyDir = app.getPath('userData')

  if (!core.resolveDataDir) {
    // 核心模块没加载成功时，退回默认位置并写日志，至少让窗口能起来把错误显示出来
    return { dir: legacyDir, portable: false, source: 'default' }
  }

  let resolution: { dir: string; portable: boolean; source: string }
  try {
    resolution = core.resolveDataDir({
      legacyDir,
      envDir: process.env.WHICHVIDEO_DATA_DIR,
      portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
      exeDir: dirname(app.getPath('exe')),
      isPackaged: app.isPackaged,
      isWritable: isWritableDir
    })
  } catch (err) {
    logError('解析数据目录失败，退回默认位置', err)
    return { dir: legacyDir, portable: false, source: 'default' }
  }

  if (resolution.portable) {
    try {
      mkdirSync(resolution.dir, { recursive: true })
      writeFileSync(
        core.portableMarkerPath(resolution.dir),
        `portable data directory\r\nbase: ${process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(app.getPath('exe'))}\r\n`
      )
    } catch {
      /* 标记文件写不了也不影响使用 */
    }
    if (!existsSync(join(resolution.dir, 'whichvideo.db'))) {
      migrateLegacyDatabase(resolution.dir, legacyDir)
    }
    // 便携模式下缓存也必须落在数据目录里，不能写 %TEMP%
    app.setPath('userData', resolution.dir)
    app.setPath('sessionData', join(resolution.dir, 'session'))
    app.commandLine.appendSwitch('disable-http-cache')
  } else {
    app.setPath('userData', legacyDir)
  }

  return resolution
}

/**
 * 把日志迁移到最终确定的数据目录。
 *
 * 启动早期为了尽快落盘，日志先写在"预估目录"里；真正的数据目录要等
 * resolveDataDir 判断完可写性/便携标记才确定，可能与之不同。
 * 这里把已写下的日志一并搬到新位置，避免排查时看漏最早的几行。
 */
function relocateLogger(finalDir: string): void {
  const previous = getLogFile()
  const target = join(finalDir, 'whichvideo.log')
  if (previous === target) return
  try {
    mkdirSync(finalDir, { recursive: true })
    if (previous && existsSync(previous)) {
      const earlier = existsSync(target) ? readFileSync(target, 'utf8') : ''
      const current = readFileSync(previous, 'utf8')
      writeFileSync(target, earlier + current)
      try {
        unlinkSync(previous)
      } catch {
        /* 删不掉就留着，不影响 */
      }
    }
  } catch {
    /* 迁移失败时保留原日志位置 */
  }
  resetLogger()
  initLogger(finalDir)
}

const dataDir = setupDataDirectory()
relocateLogger(dataDir.dir)
log(`数据目录：${dataDir.dir}（portable=${dataDir.portable} source=${dataDir.source}）`)
log(`日志文件：${getLogFile()}`)

/* ------------------------------------------------------------------ *
 * 事件广播
 * ------------------------------------------------------------------ */

function broadcast(event: LibraryEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.eventChannel, event)
  }
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

function dbPath(): string {
  return join(dataDir.dir, 'whichvideo.db')
}

/**
 * ffmpeg 二进制目录。
 * 便携模式额外支持把 ffmpeg.exe / ffprobe.exe 放在 exe 同级或 data/bin 里，
 * 这样绿色版可以完全自包含。
 */
function resourceBinDir(): string | undefined {
  const exeDir = dirname(app.getPath('exe'))
  const candidates = [
    process.env.WHICHVIDEO_BIN_DIR,
    join(dataDir.dir, 'bin'),
    app.isPackaged ? exeDir : undefined,
    process.resourcesPath ? join(process.resourcesPath, 'bin') : undefined,
    resolve(app.getAppPath(), 'resources', 'bin'),
    resolve(process.cwd(), 'resources', 'bin')
  ].filter((p): p is string => !!p)
  return candidates.find((dir) => existsSync(dir))
}

/**
 * 解析 preload 产物路径。
 * electron-vite 输出的是 ESM 时文件名为 index.mjs、CJS 时为 index.js，
 * 写死扩展名会导致 preload 静默加载失败（界面拿不到 window.whichvideo），
 * 所以两种都试一下。
 */
function resolvePreloadPath(): string {
  const candidates = [
    join(__dirname, '../preload/index.mjs'),
    join(__dirname, '../preload/index.js'),
    join(__dirname, '../preload/index.cjs')
  ]
  const found = candidates.find((p) => existsSync(p))
  if (found) return found
  log(`[WARN] 未找到 preload 产物，已尝试：${candidates.join('、')}`)
  return candidates[0]
}

/**
 * 解析应用图标，返回给 BrowserWindow 用。
 *
 * 图标由 scripts/generate-icon.mjs 生成，一份在 build/icon.ico（electron-builder
 * 读它做 exe 与快捷方式图标），一份在 out/icon.ico（随包走，运行期读它）。
 *
 * 为什么需要两处：electron-builder 的 files 只含 out/**、package.json、LICENSE，
 * 打包后仓库根的 build/ 在 asar 外不可达。若只放 build/，开发态（pnpm dev）
 * 能拿到图标，但绿色版（win-unpacked 直接跑 exe）的任务栏与标题栏
 * 会退回 Electron 默认图标。
 *
 * 找不到就返回 undefined 用默认图标，不影响启动。
 */
function resolveIconPath(): string | undefined {
  const candidates = [
    join(__dirname, '../icon.ico'), // 打包后 / 构建后：out/main → out/icon.ico
    join(__dirname, '../../build/icon.ico'), // 开发态：out/main → 仓库根/build
    join(__dirname, '../../../build/icon.ico')
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) {
    log('[WARN] 未找到应用图标，窗口将使用默认图标。已尝试：' + candidates.join('、'))
    return undefined
  }
  return found
}

function createWindow(): void {
  log('创建主窗口')
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0f17',
    title: 'WhichVideo · 以图搜视频',
    icon: resolveIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    log('窗口 ready-to-show，执行 show()')
    mainWindow?.show()
    mainWindow?.focus()
  })
  mainWindow.on('closed', () => {
    log('窗口已关闭')
    mainWindow = null
  })
  mainWindow.webContents.on('did-finish-load', () => log('渲染页面加载完成'))
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logError('渲染页面加载失败', new Error(`${desc} (${code}) ${url}`))
    // 页面加载失败也要让窗口可见，否则用户只看到"没反应"
    showFatalInWindow(`界面加载失败：${desc} (${code})`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logError('渲染进程异常退出', new Error(JSON.stringify(details)))
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    const indexHtml = join(__dirname, '../renderer/index.html')
    log(`加载界面：${indexHtml}（存在=${existsSync(indexHtml)}）`)
    void mainWindow.loadFile(indexHtml)
  }

  // 兜底：即使 ready-to-show 没触发（渲染失败等），3 秒后也要把窗口显示出来
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      log('ready-to-show 未触发，兜底显示窗口')
      mainWindow.show()
    }
  }, 3000)
}

/** 在窗口里直接显示致命错误，避免"双击没反应" */
function showFatalInWindow(message: string): void {
  // 极端情况下（窗口创建本身就失败）没有窗口可用，那就至少把错误写进日志，
  // 并把窗口补出来，保证用户/我们都能看到失败原因。
  if (!mainWindow) {
    logError('需要展示错误页但没有可用窗口', new Error(message))
    try {
      mainWindow = new BrowserWindow({
        width: 900,
        height: 620,
        backgroundColor: '#0b0f17',
        title: 'WhichVideo 启动失败',
        icon: resolveIconPath(),
        autoHideMenuBar: true,
        webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false }
      })
    } catch (err) {
      logError('创建错误窗口失败', err)
      return
    }
  }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>WhichVideo 启动失败</title></head>
<body style="margin:0;background:#0b0f17;color:#e2e8f0;font-family:'Segoe UI','Microsoft YaHei',system-ui;padding:32px">
<h2 style="color:#f87171;margin:0 0 12px">WhichVideo 启动失败</h2>
<pre style="white-space:pre-wrap;background:#141c2b;border:1px solid #223049;border-radius:10px;padding:16px;font-size:13px">${escapeHtml(
    message
  )}</pre>
<p style="color:#94a3b8;font-size:13px">数据目录：${escapeHtml(dataDir.dir)}<br>日志文件：${escapeHtml(
    getLogFile() ?? '（未初始化）'
  )}</p>
</body></html>`
  void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  if (!mainWindow.isVisible()) mainWindow.show()
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

async function bootstrap(): Promise<void> {
  log('开始初始化：数据库 / 索引 / 监听')
  if (core.error) {
    throw new Error(`核心模块加载失败：${core.error instanceof Error ? core.error.message : String(core.error)}`)
  }

  db = new core.LibraryDatabase(dbPath())
  openDatabases.push(db)
  log(`索引库已打开：${dbPath()}`)
  searchIndex = new core.FrameSearchIndex(db)
  log(`帧索引载入完成：${searchIndex.frameCount} 帧`)
  indexer = new core.Indexer(db, searchIndex, () => db.getSettings(), broadcast)
  watcher = new core.FolderWatcher(db, indexer, broadcast, () => db.getSettings().awaitWriteMs)

  toolsReady = !!core.resolveTools(resourceBinDir())
  log(`ffmpeg 可用：${toolsReady}`)

  registerIpc({
    db,
    searchIndex,
    indexer,
    watcher,
    dataDir,
    toolsReady,
    dbPath,
    broadcast,
    getMainWindow: () => mainWindow,
    queryVectorFromImage: core.queryVectorFromImage
  })
  log('IPC 已注册')
  await watcher.syncAll()
  log('文件夹监听已同步')
  indexer.resumePending()
  log('初始化完成')

  if (app.isPackaged) {
    // 自动更新是可选能力：未安装 electron-updater 时静默跳过
    void import('electron-updater')
      .then((mod) => mod.autoUpdater.checkForUpdatesAndNotify())
      .catch(() => undefined)
  }
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) {
    log('未获得单实例锁，跳过窗口与索引初始化')
    return
  }
  log('app ready')
  createWindow()
  try {
    await bootstrap()
  } catch (err) {
    logError('初始化失败', err)
    showFatalInWindow(
      `初始化失败：${err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err)}`
    )
    return
  }

  broadcast({ type: 'stats', stats: db.stats() })
  broadcast({ type: 'status', status: indexer.status() })
  broadcast({
    type: 'notice',
    level: toolsReady ? 'info' : 'warn',
    message: toolsReady
      ? `索引服务已就绪（数据目录：${dataDir.dir}${dataDir.portable ? ' · 便携模式' : ''}）`
      : '未找到 ffmpeg / ffprobe：可以浏览与管理视频，但无法建立索引。请参考 README 安装。'
  })
  if (dataDir.portable) {
    broadcast({
      type: 'notice',
      level: 'info',
      message: `便携模式：索引库与缓存都写在 ${dataDir.dir}，拷贝整个文件夹即可迁移`
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  log('检测到第二次启动，聚焦已有窗口')
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  log('所有窗口已关闭')
  void watcher?.stopAll().finally(() => {
    closeDatabases()
    if (process.platform !== 'darwin') app.quit()
  })
})

/** 统一关闭数据库连接（退出或启动自检清理时调用） */
function closeDatabases(): void {
  for (const handle of openDatabases.splice(0)) {
    try {
      handle.close()
    } catch {
      /* ignore */
    }
  }
}

// 供启动自检（scripts/startup-smoke.mjs）在进程内清理时调用
;(module.exports as { closeDatabases?: () => void }).closeDatabases = closeDatabases

// 兜底：初始化阶段出现未捕获异常时，把原因显示在窗口里并记入日志
process.on('uncaughtException', (err) => {
  logError('uncaughtException', err)
  if (mainWindow) {
    broadcast({ type: 'notice', level: 'error', message: `主进程异常：${err.message}` })
  } else {
    showFatalInWindow(`主进程异常：${err.message}\n\n${err.stack ?? ''}`)
  }
})

// Electron 自带子进程（GPU / 工具进程）异常退出的取证：索引期间硬死过一次、
// JS 级 handler（uncaught/unhandledRejection）全都没写日志，GPU oom 这类
// 只有这里能看到 reason。
app.on('child-process-gone', (_e, details) => {
  logError('子进程异常退出', new Error(`type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`))
})

// 退出的最后一笔：正常退出必有这行；下次再"软件直接关闭"却没有它 = 硬死
// （OOM / 被外部强杀 / 原生层崩溃），排查时先看这条在不在。
process.on('exit', (code) => {
  log(`进程退出 code=${code}`)
})
