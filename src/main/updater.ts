/**
 * 版本检查（轻量）：启动后查一次 GitHub Releases，有新版则弹窗告知。
 *
 * 刻意**不用** electron-updater —— 它需要 publish 配置与代码签名，当前阶段
 * 引入只增加打包复杂度；这里的诉求只是"让用户知道有新版 + 给下载入口"。
 *
 * 设计约束：
 * - **绝不阻塞启动**：调用方延迟数秒后触发，且整体 try/catch，任何失败静默
 * - **尊重用户意愿**：仅当 settings.updateCheck 开启时才会被调用（调用方守卫）
 * - **零依赖**：用全局 fetch（Electron 主进程自带），5s 超时
 * - 这是全应用除 url-image.ts 外**唯一**的网络出口（test:network 白名单）
 */
import { dialog, shell } from 'electron'
import { UPDATE_CHECK_TIMEOUT_MS, UPDATE_CHECK_URL } from './constants'
import { log } from './logger'

export interface UpdateInfo {
  /** 最新版本号（tag_name，可能带 v 前缀） */
  latest: string
  /** 发布页地址 */
  url: string
}

/** 语义比较：'v2.10.0' > 'v2.9.9'。解析失败按 0 处理，不误报。 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((n) => {
        const num = Number.parseInt(n, 10)
        return Number.isNaN(num) ? 0 : num
      })
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

/** 查询 GitHub 最新 release；网络失败 / 限流 / 结构不符一律返回 null（静默）。 */
export async function fetchLatestRelease(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(UPDATE_CHECK_URL, {
      headers: { 'User-Agent': 'WhichVideo-UpdateCheck', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const body = (await res.json()) as { tag_name?: string; html_url?: string }
    if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string') return null
    return { latest: body.tag_name, url: body.html_url }
  } catch {
    return null
  }
}

/** 检查并在有新版时弹窗。失败静默 —— 更新提示永远不该打扰正常使用。 */
export async function checkAndNotifyUpdate(currentVersion: string): Promise<void> {
  try {
    const info = await fetchLatestRelease()
    if (!info) {
      log('版本检查：未获取到最新版本（网络不可用或限流），静默跳过')
      return
    }
    if (!isNewerVersion(info.latest, currentVersion)) {
      log(`版本检查：已是最新（${currentVersion}）`)
      return
    }
    log(`发现新版本：${info.latest}（当前 ${currentVersion}）`)
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 ${info.latest}`,
      detail: `当前版本 ${currentVersion}。新版本可能包含索引加速与问题修复。\n发布页：${info.url}`,
      buttons: ['前往下载', '忽略'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0) void shell.openExternal(info.url)
  } catch (err) {
    log(`版本检查失败（已忽略）：${err instanceof Error ? err.message : String(err)}`)
  }
}
