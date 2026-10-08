/**
 * electron-builder afterPack 钩子：移除自动生成的 app-update.yml。
 *
 * 背景：electron-builder 26.x 会从 package.json 的 repository / git remote
 * 推断出 publish 信息（owner/repo/provider: github），即使 electron-builder.yml
 * 里**没有** publish 配置，也会在 `resources/app-update.yml` 写一份更新源配置。
 *
 * 本项目不用 electron-updater（自动更新依赖发布配置与代码签名，从未启用；
 * 版本检查走 updater.ts 的轻量实现），产物里带更新源配置有两个坏处：
 *   1. test:network 的「产物里没有更新源配置文件」断言失败（会拦住发布前的自检）
 *   2. 未来若有人引入 electron-updater，它会**静默**按这份配置联网检查更新
 *      —— 而「除链接取图外零联网」是本项目的硬约束（test:network 逐项断言）。
 *
 * 注：本文件是 CommonJS（.cjs）—— electron-builder 的钩子以 require 方式加载，
 * package.json 没有 "type": "module"，用 .cjs 明确语义、避免歧义。
 */
const { existsSync, rmSync } = require('node:fs')
const { join } = require('node:path')

module.exports = async function afterPack(context) {
  const target = join(context.appOutDir, 'resources', 'app-update.yml')
  if (existsSync(target)) {
    rmSync(target)
    console.log('[after-pack] 已移除 app-update.yml（本项目不使用 electron-updater）')
  }
}
