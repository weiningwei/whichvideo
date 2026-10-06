/**
 * 网络出口自检：确认"用户数据不会被上传到任何服务器"。
 *
 * 这个工具处理的是本地视频与图片索引，用户对隐私的预期很直接 —— 导入什么、
 * 搜什么、库里有哪些视频，这些都不该离开本机。本脚本把这条预期变成可执行的断言，
 * 避免以后引入某个 SDK 或自动更新时无声破坏它。
 *
 * 允许的出口只有一个：链接取图（IPC `search:url`），且必须由用户主动触发。
 *
 * 运行： node scripts/test-network.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const srcDir = join(root, 'src')

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

/** 递归列出源文件 */
function listSources(dir) {
  const out = []
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name)
    if (f.isDirectory()) out.push(...listSources(p))
    else if (/\.(ts|tsx)$/.test(f.name)) out.push(p)
  }
  return out
}

const files = listSources(srcDir)
/** 相对路径，便于报告 */
const rel = (p) => p.slice(root.length + 1).replace(/\\/g, '/')

console.log('=== 1. 网络请求点：只允许链接取图与版本检查 ===')
{
  // 任何联网 API 都算出口。逐个文件扫，不靠"我记得没有"。
  const patterns = [
    { re: /\bfetch\s*\(/g, name: 'fetch(' },
    { re: /require\(\s*['"](?:https?|net|dgram|tls|http2?|ws)['"]\s*\)/g, name: "require('http'/'net'/'tls'/'ws')" },
    { re: /from\s+['"](?:https?|net|dgram|tls|http2?|ws)['"]/g, name: "import from 'http'/'net'/'tls'/'ws'" },
    { re: /new\s+(?:WebSocket|XMLHttpRequest|EventSource)\b/g, name: 'WebSocket/XHR/EventSource' },
    { re: /\b(?:axios|got|superagent|request|node-fetch|undici)\b(?=\s*[.(])/g, name: '第三方 HTTP 库' }
  ]
  const hits = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const { re, name } of patterns) {
      const n = (text.match(re) ?? []).length
      if (n) hits.push({ file: rel(f), name, n })
    }
  }
  // 允许的出口（各文件职责见各自注释）：
  //   url-image.ts —— 用户贴链接时取图
  //   updater.ts   —— 启动后查一次 GitHub Releases（settings.updateCheck 守卫）
  const allowed = new Set(['src/main/url-image.ts', 'src/main/updater.ts'])
  const unexpected = hits.filter((h) => !allowed.has(h.file))
  check(
    '除链接取图与版本检查外，源码里没有任何网络请求',
    unexpected.length === 0,
    unexpected.length ? unexpected.map((h) => `${h.file} 用 ${h.name}×${h.n}`).join(' | ') : `扫描 ${files.length} 个源文件`
  )
  check(
    '网络出口只有这两个模块',
    hits.length > 0 && hits.every((h) => allowed.has(h.file)),
    hits.map((h) => `${h.file}:${h.name}×${h.n}`).join(', ') || '未找到'
  )
  // updater 的出口必须由设置开关守卫（否则"零联网"承诺对用户不成立）
  const updaterSrc = readFileSync(join(srcDir, 'main', 'updater.ts'), 'utf8')
  check(
    '版本检查引用 UPDATE_CHECK_URL 常量（不散落字面量）',
    updaterSrc.includes('UPDATE_CHECK_URL'),
    ''
  )
  const indexSrc = readFileSync(join(srcDir, 'main', 'index.ts'), 'utf8')
  check(
    '版本检查被 settings.updateCheck 守卫（用户可关）',
    /updateCheck[^]*?checkAndNotifyUpdate/.test(indexSrc),
    '调用点前必须有开关判断'
  )
}

console.log('')
console.log('=== 2. 核心链路（建库/索引/监听/检索）零网络 ===')
{
  // 这些是处理用户数据的地方，任何网络访问都意味着数据可能外流
  const core = ['indexer.ts', 'scan.ts', 'watcher.ts', 'db.ts', 'search.ts', 'media.ts', 'clipboard.ts', 'datadir.ts', 'logger.ts']
  const dirty = []
  for (const name of core) {
    const p = join(srcDir, 'main', name)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    if (/\bfetch\s*\(|require\(\s*['"](?:https?|net|dgram|tls|ws)['"]|new\s+WebSocket|https?:\/\//.test(text)) {
      dirty.push(name)
    }
  }
  check(
    `${core.length} 个核心模块都不联网`,
    dirty.length === 0,
    dirty.length ? dirty.join(', ') : '导入/抽帧/指纹/检索/存储全本地'
  )
}

console.log('')
console.log('=== 3. 链接取图的边界 ===')
{
  const url = readFileSync(join(srcDir, 'main', 'url-image.ts'), 'utf8')
  const main = readFileSync(join(srcDir, 'main', 'index.ts'), 'utf8')
  // IPC 处理器可能被拆到独立文件（如 ipc.ts）——按 handler 所在的实际文件查
  const ipcPath = join(srcDir, 'main', 'ipc.ts')
  const ipcSrc = existsSync(ipcPath) ? readFileSync(ipcPath, 'utf8') : ''

  check('由用户主动触发（IPC 处理器，不在启动流程里）', /ipcMain\.handle\(IPC\.searchUrl/.test(main + ipcSrc))
  const inBootstrap = /async function bootstrap[\s\S]*?searchUrl/.test(main)
  check('启动流程里不会自动触发', !inBootstrap, '只在用户点「链接检索」时调用')
  check('渲染端只能通过 IPC 调它（未直接暴露 fetch）', /byUrl: \(url: string\) => ipcRenderer\.invoke/.test(readFileSync(join(srcDir, 'preload', 'index.ts'), 'utf8')))

  // 请求头不能带任何本机标识。UA 字面量的定义处在 constants.ts（单一来源），
  // url-image.ts 必须引用它而不是自己再写一个字面量（否则两处会漂移）。
  const constantsSrc = readFileSync(join(srcDir, 'main', 'constants.ts'), 'utf8')
  const ua = constantsSrc.match(/USER_AGENT\s*=\s*'([^']+)'/)?.[1] ?? ''
  check(
    'User-Agent 是固定字符串，不含本机信息',
    ua === 'WhichVideo/0.1 (local image search)',
    ua
  )
  check(
    'url-image.ts 引用 USER_AGENT 常量（无第二个字面量）',
    /'User-Agent':\s*USER_AGENT/.test(url) && !/'User-Agent':\s*'/.test(url)
  )
  const headers = url.match(/headers:\s*\{[\s\S]{0,300}?\}/)?.[0] ?? ''
  // 关键词要精确：'user' 会误伤 User-Agent（那是固定字符串，上一条已单独断言）。
  // 这里只找"可能夹带本机信息/凭据"的字段名。
  const machineKeys = [
    'hostname', 'username', 'userdir', 'homedir', 'user-agent-token',
    'profile', 'token', 'auth', 'cookie', 'referer', 'origin', 'x-forwarded', 'mac', 'serial'
  ]
  const headerNames = [...headers.matchAll(/['"]([A-Za-z-]+)['"]\s*:/g)].map((m) => m[1].toLowerCase())
  const leaked = machineKeys.filter((k) => headerNames.some((h) => h.includes(k)))
  check(
    '请求头不含任何本机标识或凭据',
    leaked.length === 0,
    leaked.length
      ? `含：${leaked.join(', ')}`
      : `仅 ${headerNames.join(' / ')} 两个固定头`
  )

  check('只放行 http/https（挡掉 file: 等本地协议）', /protocol === 'http:' \|\| u\.protocol === 'https:'/.test(url))
  check('有体积上限与超时', /MAX_BYTES/.test(url) && /TIMEOUT_MS/.test(url))
  check('重定向每一跳都重新校验协议', url.includes('isHttpUrl(next)'))
}

console.log('')
console.log('=== 4. 无遥测 / 上报类依赖 ===')
{
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const all = { ...pkg.dependencies, ...pkg.devDependencies }
  const suspicious = Object.keys(all).filter((k) =>
    /sentry|analytics|telemetry|tracking|bugsnag|datadog|newrelic|amplitude|mixpanel|posthog|logrocket|segment|heap/i.test(k)
  )
  check('依赖里没有遥测/上报类库', suspicious.length === 0, suspicious.join(', ') || `运行时依赖：${Object.keys(pkg.dependencies || {}).join(', ')}`)
  // 自定义 registry 也是一种外传（依赖从别人那里拉）
  const registries = Object.entries(all).filter(([, v]) => typeof v === 'string' && /^(https?:|git|github:|file:)/.test(v))
  check('依赖全部来自默认 registry', registries.length === 0, registries.map(([k, v]) => k).join(', '))
}

console.log('')
console.log('=== 5. 版本检查是轻量实现（无 electron-updater）===')
{
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  const indexSrc = readFileSync(join(srcDir, 'main', 'index.ts'), 'utf8')

  // electron-updater 依赖 publish 配置与代码签名，从未真正启用过。
  // 现行方案是 updater.ts 的轻量检查（查 GitHub Releases + 弹窗给下载入口）。
  check('electron-builder.yml 里没有 publish 配置', !/^publish:/m.test(yml), '所以不会生成 app-update.yml')
  const updaterConfigs = ['out/app-update.yml', 'out/dev-app-update.yml',
    'release/win-unpacked/resources/app-update.yml', 'release/WhichVideo-portable/resources/app-update.yml']
  const present = updaterConfigs.filter((p) => existsSync(join(root, p)))
  check('产物里没有更新源配置文件', present.length === 0, present.join(', ') || '4 个位置都没有')
  check('没有 electron-updater 依赖（含可选依赖）', !pkg.dependencies?.['electron-updater'] && !pkg.optionalDependencies?.['electron-updater'], '')
  check('index.ts 不再残留 electron-updater 动态导入', !indexSrc.includes("import('electron-updater')"), '已由 updater.ts 取代')
  check('轻量版本检查已接入（checkAndNotifyUpdate）', indexSrc.includes('checkAndNotifyUpdate'), '')
}

console.log('')
console.log('=== 6. 渲染端被 CSP 限制，无法自行联网 ===')
{
  const html = readFileSync(join(root, 'src', 'renderer', 'index.html'), 'utf8')
  const csp = html.match(/content="(default-src[^"]*)"/)?.[1] ?? ''
  check('CSP 有 default-src', csp.includes("default-src 'self'"), csp)
  // connect-src 缺失时回退到 default-src 'self' —— 渲染端不能发 XHR/fetch
  check(
    '没有 connect-src 放宽网络（缺失时回退 default-src self）',
    !/connect-src/.test(csp),
    '渲染端无法 fetch 任何地址'
  )
  check('img-src 不含 http/https（渲染端不能加载远程图片）', !/img-src[^;]*https?:/.test(csp), csp.match(/img-src[^;]*/)?.[0] ?? '')

  const main = readFileSync(join(srcDir, 'main', 'index.ts'), 'utf8')
  check('nodeIntegration 关闭', /nodeIntegration:\s*false/.test(main))
  check('contextIsolation 开启', /contextIsolation:\s*true/.test(main))
  // 打包后只 loadFile 本地 html，不 loadURL 远程页面
  const loadsRemote = /loadURL\(\s*['"]https?:/.test(main)
  check('窗口不加载任何远程页面', !loadsRemote, '只 loadFile 本地 index.html')
}

console.log(`\n=== 网络出口：${passed}/${passed + failed} 通过 ===`)
if (failed) {
  console.log('\n有断言失败。若新增了网络访问，请确认它：')
  console.log('  · 是用户主动触发的，不是启动即联网')
  console.log('  · 不携带任何本机标识或凭据')
  console.log('  · 不会把用户数据（视频名、路径、指纹、搜索内容）发出去')
  process.exit(1)
}
