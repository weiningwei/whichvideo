import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const shared = readFileSync(join(root, 'src', 'shared', 'types.ts'), 'utf8')
const bridge = readFileSync(join(root, 'src', 'renderer', 'src', 'lib', 'tauri-api.ts'), 'utf8')
const rendererMain = readFileSync(join(root, 'src', 'renderer', 'src', 'main.tsx'), 'utf8')
const rustMain = readFileSync(join(root, 'src-tauri', 'src', 'main.rs'), 'utf8')
const processExt = readFileSync(join(root, 'src-tauri', 'src', 'process_ext.rs'), 'utf8')
const processSources = ['commands.rs', 'media.rs', 'updater.rs']
  .map((name) => readFileSync(join(root, 'src-tauri', 'src', name), 'utf8'))
  .join('\n')
const config = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))

let failed = 0
function check(name, condition, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failed++
}

const ipcBlock = shared.match(/export const IPC = \{([\s\S]*?)\} as const/)?.[1] ?? ''
const channels = [...ipcBlock.matchAll(/^\s*(\w+):\s*'([^']+)'/gm)].map((match) => ({
  key: match[1],
  value: match[2]
}))
const commands = channels.filter((item) => item.key !== 'eventChannel')

console.log('=== Tauri IPC 契约 ===')
for (const command of commands) {
  check(
    `${command.key} 已桥接并注册`,
    bridge.includes(`IPC.${command.key}`) && rustMain.includes(`commands::${command.value}`),
    command.value
  )
}
check('事件频道已桥接', bridge.includes('IPC.eventChannel') && shared.includes("eventChannel: 'library_event'"))
check('渲染入口安装 Tauri API', rendererMain.includes('window.whichvideo = tauriApi'))
check('Tauri 桥接无未实现占位', !bridge.includes('notImpl') && !bridge.includes('尚未实现'))
check('渲染端不导入 Electron', !/from ['"]electron['"]|require\(['"]electron['"]\)/.test(bridge + rendererMain))
check('主窗口由 setup 手动创建', config.app?.windows?.[0]?.create === false)
check('WebView 缓存写入统一 data/session', rustMain.includes('.data_directory(resolution.dir.join("session"))'))
const commandStarts = (processSources.match(/Command::new\(/g) ?? []).length
const hiddenStarts = (processSources.match(/\.no_window\(\)/g) ?? []).length
check(
  'Windows 子进程全部隐藏控制台窗口',
  commandStarts > 0 && commandStarts === hiddenStarts && processExt.includes('CREATE_NO_WINDOW'),
  `${hiddenStarts}/${commandStarts}`
)

console.log('\n=== Tauri bundle 资源 ===')
const resources = config.bundle?.resources ?? {}
check('bundle 目标为 NSIS', config.bundle?.targets === 'nsis')
check('ffmpeg 已纳入 bundle', resources['../resources/bin/ffmpeg.exe'] === 'resources/bin/ffmpeg.exe')
check('ffprobe 已纳入 bundle', resources['../resources/bin/ffprobe.exe'] === 'resources/bin/ffprobe.exe')
check('ICO 与 PNG 已配置', config.bundle?.icon?.includes('icons/icon.ico') && config.bundle?.icon?.includes('icons/icon.png'))

const buildIco = readFileSync(join(root, 'build', 'icon.ico'))
const tauriIco = readFileSync(join(root, 'src-tauri', 'icons', 'icon.ico'))
check('Tauri ICO 与品牌 ICO 字节一致', buildIco.equals(tauriIco), `${tauriIco.length} B`)
check('Tauri PNG 存在', existsSync(join(root, 'src-tauri', 'icons', 'icon.png')))

const generatedNsi = join(root, 'src-tauri', 'target', 'release', 'nsis', 'x64', 'installer.nsi')
if (existsSync(generatedNsi)) {
  const nsi = readFileSync(generatedNsi, 'utf8')
  check('实包脚本安装 ffmpeg', nsi.includes('resources\\bin\\ffmpeg.exe'))
  check('实包脚本安装 ffprobe', nsi.includes('resources\\bin\\ffprobe.exe'))
}

console.log(`\nTauri 契约自检：${failed ? `失败 ${failed} 项` : `${commands.length} 个命令全部通过`}`)
process.exit(failed ? 1 : 0)
