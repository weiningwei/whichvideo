/**
 * 打包配置检查逻辑（纯函数，供 scripts/test-build-config.mjs 与自检使用）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 递归收集目录下的源码文件 */
export function collectSourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectSourceFiles(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/** 找出文件里用到的别名（形如 "@shared/xxx" / "@renderer"） */
export function aliasesUsedIn(files) {
  const used = new Set()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/["'](@[a-z-]+)(?:\/[^"']*)?["']/g)) used.add(match[1])
  }
  return used
}

/**
 * 把 electron.vite.config.ts 切成 main / preload / renderer 三段。
 * 用"下一个顶层键"作为边界，够用且不引入 YAML/TS 解析依赖。
 */
export function splitConfigSections(config) {
  const sections = {}
  for (const name of ['main', 'preload', 'renderer']) {
    const start = config.indexOf(`\n  ${name}: {`)
    if (start < 0) {
      sections[name] = ''
      continue
    }
    const rest = config.slice(start + 1)
    const nextMatch = /\n  [a-zA-Z]+: \{/.exec(rest.slice(1))
    sections[name] = nextMatch ? rest.slice(0, nextMatch.index + 1) : rest
  }
  return sections
}

/** 某个构建目标用到的别名是否都在对应配置段里声明了 */
export function findMissingAliases(config, targetDir, sectionText) {
  const used = aliasesUsedIn(collectSourceFiles(targetDir))
  const missing = []
  for (const alias of used) {
    if (!sectionText.includes(`'${alias}'`)) missing.push(alias)
  }
  return { used: [...used], missing }
}
