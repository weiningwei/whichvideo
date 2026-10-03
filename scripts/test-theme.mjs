/**
 * 配色 token 自检。
 *
 * 主题能切换的前提是「组件只写语义 token，不写固定色」。一旦有人在 tsx 里
 * 写 text-slate-100，浅色主题下就是白字白底；写 #38bdf8 则是浅色底下对比度
 * 不足（约 2.1:1）。这类问题不会在深色下暴露，只能静态守住。
 *
 * 覆盖：
 *   · 组件里没有 Tailwind 内置固定色（slate-/gray-/zinc-…）
 *   · 组件里没有十六进制字面量
 *   · 语义 token 在 @theme 里定义齐全，且深浅两套都有值
 *   · [data-theme='light'] 覆盖了所有可换色的 token
 *   · 已知必须保留的固定色有注释说明（滑块等无法 token 化的场景）
 *
 * 运行： node scripts/test-theme.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const compDir = join(root, 'src', 'renderer', 'src', 'components')

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

/** 深浅两套都必须能换色的 token（border / scroll 等结构性色也含在内） */
const THEMEABLE = [
  'surface-0', 'surface-1', 'surface-2', 'surface-3', 'surface-4', 'surface-inset',
  'line', 'line-strong',
  'primary', 'secondary', 'tertiary', 'disabled',
  'accent', 'accent-strong', 'accent-soft',
  'ok', 'warn', 'bad',
  'btn-bg', 'btn-border', 'btn-text',
  'scroll-thumb', 'scroll-thumb-hover'
]

/**
 * 允许的固定色例外。
 *
 * 格式：`文件 → 颜色 → 理由`。每条都要能自圆其说——写进这里等于承诺
 * 「这个颜色在深浅两套主题下都必须成立」，评审时会被逐条质疑。
 */
const HEX_EXCEPTIONS = [
  {
    file: 'Header.tsx',
    color: '#042C53',
    reason: '「WV」字母标压在 accent 渐变方块上，两套主题下都必须是深色；用语义 token 会跟着主题变，反而在浅色下变成浅字压浅底'
  }
]

function isException(file, hex) {
  return HEX_EXCEPTIONS.some((e) => e.file === file && e.color.toLowerCase() === hex.toLowerCase())
}

function main() {
  const css = readFileSync(join(root, 'src', 'renderer', 'src', 'index.css'), 'utf8')

  console.log('=== 组件里不得有固定色 ===')
  const files = readdirSync(compDir).filter((f) => f.endsWith('.tsx'))
  const hexHits = []
  const exemptUsed = new Set()
  const builtinHits = []
  for (const f of files) {
    const src = readFileSync(join(compDir, f), 'utf8')
    src.split('\n').forEach((line, i) => {
      // 剥掉行注释再匹配，避免把说明文字当成违规
      const code = line.replace(/\/\/.*$/, '').replace(/\{[^{}]*\/\*.*?\*\/[^{}]*\}/g, '')
      const hex = code.match(/#[0-9a-fA-F]{3,8}\b/g)
      if (hex) {
        for (const h of hex) {
          if (isException(f, h)) exemptUsed.add(`${f} ${h}`)
          else hexHits.push(`${f}:${i + 1} ${h}`)
        }
      }
      const builtin = code.match(
        /\b(?:text|bg|border|ring|from|to|via|decoration|outline|fill|stroke)-(?:slate|gray|zinc|neutral|stone|blue|sky|red|green|amber|emerald|indigo|violet|rose|orange|yellow|lime|fuchsia)-(?:[0-9]{2,3}|[A-Z][a-z]?)(?:\/[0-9]{1,3})?\b/g
      )
      if (builtin) builtinHits.push(`${f}:${i + 1} ${builtin.join(', ')}`)
    })
  }
  check(
    `组件里没有十六进制颜色字面量（${files.length} 个文件）`,
    hexHits.length === 0,
    hexHits.length ? hexHits.join(' | ') : '已清零'
  )
  check(
    '组件里没有 Tailwind 内置固定色（slate-100 / gray-500 等）',
    builtinHits.length === 0,
    builtinHits.length ? builtinHits.slice(0, 4).join(' | ') : '已清零'
  )
  check(
    '白名单里的固定色都被用上了（没有过时条目）',
    HEX_EXCEPTIONS.every((e) => exemptUsed.has(`${e.file} ${e.color}`)),
    `${exemptUsed.size}/${HEX_EXCEPTIONS.length} 条生效`
  )

  console.log('')
  console.log('=== 语义 token 齐全 ===')
  const themeBlock = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const lightBlock = css.match(/\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  check('@theme 存在', themeBlock.length > 0)
  check("[data-theme='light'] 覆盖块存在", lightBlock.length > 0)

  const missingTheme = THEMEABLE.filter((t) => !themeBlock.includes(`--color-${t}:`))
  check('@theme 里定义了全部语义 token', missingTheme.length === 0, missingTheme.length ? '缺：' + missingTheme.join(', ') : `${THEMEABLE.length} 个齐备`)

  const missingLight = THEMEABLE.filter((t) => !lightBlock.includes(`--color-${t}:`))
  check(
    '浅色主题覆盖了全部可换色 token',
    missingLight.length === 0,
    missingLight.length ? '缺：' + missingLight.join(', ') : '不会残留深色值'
  )

  console.log('')
  console.log('=== 旧名兼容映射 ===')
  // ink-* / muted 这些旧名还有零星引用，通过 var() 映射到语义层
  for (const legacy of ['ink-950', 'ink-900', 'ink-850', 'ink-800', 'ink-700', 'muted']) {
    check(
      `旧名 --color-${legacy} 映射到语义 token`,
      themeBlock.includes(`--color-${legacy}: var(--color-surface`) || themeBlock.includes(`--color-${legacy}: var(--color-tertiary`),
      'var() 引用，改主题时自动跟随'
    )
  }

  console.log('')
  console.log('=== 结构性色已 token 化 ===')
  // 这几处曾硬编码，浅色下会露出破绽：滚动条、按钮、body 背景
  check('body 文字色用 var(--color-primary)', /color:\s*var\(--color-primary\)/.test(css))
  check('滚动条用 var(--color-scroll-thumb)', css.includes('var(--color-scroll-thumb)'))
  check('btn 用 var(--color-btn-border) 而非字面量', /border:\s*1px solid var\(--color-btn-border\)/.test(css))
  check('btn 背景用 var(--color-btn-bg)', css.includes('var(--color-btn-bg)'))
  check(
    '浅色下 body 径向渐变单独提亮',
    css.includes("[data-theme='light'] body") && /\[data-theme='light'\][\s\S]{0,200}radial-gradient/.test(css),
    '否则深蓝底会透过内容层显出来'
  )

  console.log('')
  console.log('=== 切换机制 ===')
  check('有 useTheme hook', existsSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useTheme.ts')))
  const hook = readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useTheme.ts'), 'utf8')
  check('三档模式齐全', ["'dark'", "'light'", "'system'"].every((m) => hook.includes(m)))
  check('落在 data-theme 上', hook.includes('dataset.theme'))
  check('持久化到 localStorage', hook.includes('localStorage'))
  check('跟随系统时监听实时变化', hook.includes("addEventListener('change'"))
  check('监听能被移除（避免泄漏）', hook.includes("removeEventListener('change'"))
  check('localStorage 不可用时降级不抛', hook.includes('catch'))

  console.log(`\n=== 配色 token：${passed}/${passed + failed} 通过 ===`)
  if (failed) process.exit(1)
}

main()
