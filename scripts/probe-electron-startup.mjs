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
rmSync(logFile, { force: true })

console.log('启动极简应用（最多等 30 秒）…\n')
const r = spawnSync(electron, [work], {
  cwd: work,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  encoding: 'utf8',
  timeout: 30000,
  stdio: ['ignore', 'pipe', 'pipe']
})

const code = r.status
console.log('--- 结果 ---')
console.log(`退出码     : ${code}${code !== null ? `  (0x${(code >>> 0).toString(16)})` : ''}`)
if (r.signal) console.log(`信号       : ${r.signal}`)
if (r.error) console.log(`启动错误   : ${r.error.message}`)
console.log(`探针日志   : ${existsSync(logFile) ? readFileSync(logFile, 'utf8').trim() || '(空)' : '(文件未生成)'}`)
const stderr = (r.stderr ?? '').trim()
console.log(`stderr     : ${stderr ? stderr.split('\n').slice(0, 6).join('\n             ') : '(空)'}`)
const stdout = (r.stdout ?? '').trim()
console.log(`stdout     : ${stdout ? stdout.split('\n').slice(0, 6).join('\n             ') : '(空)'}`)

console.log('')
const ready = existsSync(logFile) && readFileSync(logFile, 'utf8').includes('app ready')
if (ready) {
  console.log('结论：本机可以正常运行 Electron GUI —— 那么 WhichVideo 启动失败就出在应用自身。')
} else if (code === -2147483645 || (code !== null && (code >>> 0) === 0x80000003)) {
  console.log('结论：连极简 Electron 应用都以 STATUS_BREAKPOINT(0x80000003) 退出。')
  console.log('      说明是"本机环境不允许运行 Electron GUI"，与 WhichVideo 代码无关。')
  console.log('      常见原因：安全软件/EDR 拦截、应用控制策略、或在受限沙箱里执行。')
} else {
  console.log('结论：极简应用也起不来，但退出码不同。请把上面全部输出贴回来。')
}
