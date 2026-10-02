/**
 * 用官方 Electron 二进制启动一个 3 行的极简应用，判断本机能否运行 Electron GUI。
 *
 * 用途：区分"WhichVideo 代码有问题"和"本机环境不允许运行 Electron GUI"。
 * 只依赖 node 与套件里自带的 electron 二进制，不经过任何 PowerShell 包装。
 *
 * 运行（仓库根目录）：
 *   node scripts/probe-electron-startup.mjs
 * 也可指定别的 Electron 二进制：
 *   $env:WHICHVIDEO_ELECTRON_EXE='E:\path\electron.exe'; node scripts/probe-electron-startup.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const electron =
  process.env.WHICHVIDEO_ELECTRON_EXE ?? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const work = join(root, 'tmp', 'electron-probe')

console.log('Electron 二进制:', electron)
if (!existsSync(electron)) {
  console.error('找不到该文件。请先执行 pnpm install 让 electron 下载二进制，或用 WHICHVIDEO_ELECTRON_EXE 指定路径。')
  process.exit(1)
}
console.log('版本信息        :', existsSync(join(dirname(electron), 'version')) ? readFileSync(join(dirname(electron), 'version'), 'utf8').trim() : '(未知)')

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

// 极简应用：只写日志，不开窗口，把退出情况记录下来
writeFileSync(
  join(work, 'package.json'),
  JSON.stringify({ name: 'probe', version: '1.0.0', main: 'main.js' }, null, 2)
)
writeFileSync(
  join(work, 'main.js'),
  [
    "const { app } = require('electron')",
    "const fs = require('fs')",
    "const log = (m) => fs.appendFileSync(__dirname + '/probe.log', m + '\\n')",
    "log('main started electron=' + process.versions.electron + ' node=' + process.versions.node)",
    "app.on('ready', () => { log('app ready'); setTimeout(() => app.quit(), 300) })",
    "process.on('uncaughtException', (e) => log('uncaught: ' + (e && e.stack || e)))",
    "process.on('exit', (code) => log('exit code=' + code))"
  ].join('\n')
)

const logFile = join(work, 'probe.log')

/**
 * 逐个试不同的命令行开关。
 * 已知 0x80000003（STATUS_BREAKPOINT）在 Windows 上常由 GPU 子进程/沙箱触发，
 * 而这些开关可以逐个绕开，因此一次跑完就能看出是哪一类原因。
 */
const scenarios = [
  { name: '默认（不加开关）', args: [] },
  { name: '--disable-gpu-sandbox', args: ['--disable-gpu-sandbox'] },
  { name: '--disable-gpu', args: ['--disable-gpu'] },
  { name: '--disable-gpu --disable-gpu-sandbox', args: ['--disable-gpu', '--disable-gpu-sandbox'] },
  { name: '--no-sandbox', args: ['--no-sandbox'] },
  { name: '--no-sandbox --disable-gpu', args: ['--no-sandbox', '--disable-gpu'] },
  { name: '--disable-crash-reporter --disable-breakpad', args: ['--disable-crash-reporter', '--disable-breakpad'] },
  { name: '--in-process-gpu', args: ['--in-process-gpu', '--no-sandbox'] },
  { name: '--single-process', args: ['--single-process', '--no-sandbox'] }
]

console.log('Electron 二进制:', electron)
console.log('版本信息        :', existsSync(join(dirname(electron), 'version')) ? readFileSync(join(dirname(electron), 'version'), 'utf8').trim() : '(未知)')
console.log('')
console.log('逐个试启动开关（每个最多等 25 秒）…')

const results = []
for (const scenario of scenarios) {
  rmSync(logFile, { force: true })
  const r = spawnSync(electron, [work, ...scenario.args], {
    cwd: work,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    encoding: 'utf8',
    timeout: 25000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim() : ''
  const code = r.status
  results.push({
    name: scenario.name,
    status: code,
    hex: code !== null ? `0x${(code >>> 0).toString(16)}` : '(null)',
    spawnError: r.error ? String(r.error.message).slice(0, 60) : '',
    ready: log.includes('app ready'),
    log: log || '(空)',
    stderr: (r.stderr ?? '').trim().split('\n').slice(0, 3).join(' | ') || '(空)'
  })
}

console.log('')
for (const r of results) {
  const mark = r.ready ? '✓' : '✗'
  console.log(`${mark} ${r.name}`)
  console.log(`    退出码 ${r.status} (${r.hex})${r.spawnError ? `  启动错误 ${r.spawnError}` : ''}`)
  console.log(`    日志 ${r.log}`)
}

const working = results.filter((r) => r.ready)
console.log('')
if (working.length === 0) {
  if (results.every((r) => r.spawnError)) {
    console.log('结论：所有组合都无法被创建（EPERM 等）—— 是当前会话禁止创建 Electron 进程。')
    console.log('      请在一个全新的普通 PowerShell 窗口里重跑本脚本。')
  } else {
    const hexes = [...new Set(results.filter((r) => r.status !== null).map((r) => r.hex))]
    console.log(`结论：所有开关组合都失败（退出码集合：${hexes.join(', ')}）。`)
    if (hexes.includes('0x80000003')) {
      console.log('      0x80000003 是 Chromium 的通用 CHECK 崩溃码。连极简应用也崩，')
      console.log('      说明本机环境无法运行 Electron GUI，与 WhichVideo 代码无关。')
      console.log('      可继续排查：安全软件/EDR、显卡驱动、系统版本与 Electron 版本兼容性。')
    }
  }
} else {
  console.log(`结论：以下组合可以正常启动 —— 应当把它加进应用的启动开关：`)
  for (const w of working) console.log(`      ${w.name}  →  参数 ${scenarios.find((s) => s.name === w.name)?.args.join(' ') || '(无)'}`)
}

