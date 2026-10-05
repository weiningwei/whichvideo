/**
 * 主进程日志。
 *
 * 打包后的 Windows 应用是 GUI 子系统程序：stdout / stderr 不会出现在控制台，
 * 一旦启动阶段抛错就表现为"双击没反应"。因此这里把关键节点同时写到
 * <数据目录>\whichvideo.log，任何启动问题都能事后查。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_LOG_BYTES = 512 * 1024

let logFile: string | null = null
let logDir: string | null = null
/** initLogger 之前产生的日志先缓存在内存，等日志文件就绪后一次性补写 */
const pending: string[] = []

export function initLogger(dir: string): string {
  logDir = dir
  logFile = join(dir, 'whichvideo.log')
  try {
    mkdirSync(dir, { recursive: true })
    // 日志过大时轮转一次，避免无限增长
    if (statSync(logFile).size > MAX_LOG_BYTES) {
      renameSync(logFile, `${logFile}.1`)
    }
  } catch {
    /* 日志文件不可写时退化为只写控制台 */
  }
  if (logFile && pending.length) {
    try {
      appendFileSync(logFile, `${pending.join('\n')}\n`)
      if (process.env.WHICHVIDEO_DEBUG_LOG_FLUSH) {
        process.stdout.write(`[logger] 补写 ${pending.length} 条预初始化日志 → ${logFile}\n`)
      }
    } catch {
      /* ignore */
    }
  } else if (process.env.WHICHVIDEO_DEBUG_LOG_FLUSH) {
    process.stdout.write(`[logger] 无预初始化日志可补写（pending=${pending.length}, logFile=${logFile}）\n`)
  }
  pending.length = 0
  return logFile
}

export function getLogFile(): string | null {
  return logFile
}

export function getLogDir(): string | null {
  return logDir
}

function stamp(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

export function log(message: string): void {
  const line = `[${stamp()}] ${message}`
  // 开发模式下能看到控制台输出；打包后这行无效但无害
  try {
    process.stdout.write(`${line}\n`)
  } catch {
    /* ignore */
  }
  if (!logFile) {
    // 日志文件要等数据目录确定后才能建，之前的记录先缓存，避免丢掉最早的启动信息
    pending.push(line)
    return
  }
  try {
    appendFileSync(logFile, `${line}\n`)
  } catch {
    /* ignore */
  }
}

export function logError(scope: string, err: unknown): void {
  const detail =
    err instanceof Error
      ? `${err.message}\n${err.stack ?? ''}${err.cause ? `\ncaused by: ${String(err.cause)}` : ''}`
      : String(err)
  log(`[ERROR] ${scope}: ${detail}`)
}

/** 把未捕获异常也记进日志，避免"闪一下就没了"查不到原因 */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (err) => {
    logError('uncaughtException', err)
  })
  process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection', reason)
  })
}

/**
 * 恢复到"尚未初始化"的状态。
 * 打包应用用不到；启动自检要在同一进程里跑多个场景，logger 是模块单例，
 * 不重置的话后续场景的启动日志会被写进上一个场景的日志文件。
 */
export function resetLogger(): void {
  logFile = null
  logDir = null
  pending.length = 0
}

export function logFileIn(dir: string): string {
  return join(dir, 'whichvideo.log')
}
