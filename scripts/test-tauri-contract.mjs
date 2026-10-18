import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const shared = readFileSync(join(root, 'src', 'shared', 'types.ts'), 'utf8')
const bridge = readFileSync(join(root, 'src', 'renderer', 'src', 'lib', 'tauri-api.ts'), 'utf8')
const rendererMain = readFileSync(join(root, 'src', 'renderer', 'src', 'main.tsx'), 'utf8')
const rustMain = readFileSync(join(root, 'src-tauri', 'src', 'main.rs'), 'utf8')
const commandsSource = readFileSync(join(root, 'src-tauri', 'src', 'commands.rs'), 'utf8')
const indexerSource = readFileSync(join(root, 'src-tauri', 'src', 'indexer.rs'), 'utf8')
const mediaSource = readFileSync(join(root, 'src-tauri', 'src', 'media.rs'), 'utf8')
const dbSource = readFileSync(join(root, 'src-tauri', 'src', 'db.rs'), 'utf8')
const portableSource = readFileSync(join(root, 'scripts', 'build-tauri-portable.mjs'), 'utf8')
const processExt = readFileSync(join(root, 'src-tauri', 'src', 'process_ext.rs'), 'utf8')
const watcherSource = readFileSync(join(root, 'src-tauri', 'src', 'watcher.rs'), 'utf8')
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
check(
  '前后端路径规范化保留 Windows 盘符根目录',
  shared.includes("/^[a-z]:\\\\+$/i.test(normalized)") &&
    dbSource.includes("return normalized[..3].to_string()")
)
check(
  'FFmpeg 支持环境变量、手动目录与 PATH 探测',
  mediaSource.includes('WHICHVIDEO_FFMPEG') &&
    mediaSource.includes('WHICHVIDEO_BIN_DIR') &&
    mediaSource.includes('configured_dir') &&
    mediaSource.includes('which(names.0)')
)
check('FFmpeg 手动目录持久化到 settings', dbSource.includes("key = 'ffmpegDir'") && dbSource.includes('set_ffmpeg_dir'))
check(
  '文件导入使用绑定主窗口的 Tauri 原生对话框',
  rustMain.includes('tauri_plugin_dialog::init()') &&
    commandsSource.includes('app.dialog().file()') &&
    commandsSource.includes('dialog.set_parent(&window)') &&
    !commandsSource.includes('System.Windows.Forms.OpenFileDialog') &&
    !commandsSource.includes('System.Windows.Forms.FolderBrowserDialog')
)
const importFilesCommand = commandsSource.match(/pub (?:async )?fn videos_import\([\s\S]*?\n}\n\n\/\/\/ 递归导入/)?.[0] ?? ''
const importFolderOnce = indexerSource.match(/pub fn import_folder_once\([\s\S]*?\n}/)?.[0] ?? ''
const reindexCommand = indexerSource.match(/pub fn reindex\([\s\S]*?\n}\n\n\/\/\/ 启动恢复/)?.[0] ?? ''
const foldersAddPathCommand = commandsSource.match(/pub fn folders_add_path\([\s\S]*?\n}\n\n\/\/\/ 通过系统文件夹/)?.[0] ?? ''
const foldersRemoveCommand = commandsSource.match(/pub fn folders_remove\([\s\S]*?\n}\n\n\/\/\/ 重新扫描文件夹/)?.[0] ?? ''
const foldersSetEnabledCommand = commandsSource.match(/pub fn folders_set_enabled\([\s\S]*?\n}\n\n\/\/\/ 单个视频记录/)?.[0] ?? ''
const videosRemoveCommand = commandsSource.match(/pub fn videos_remove\([\s\S]*?\n}\n\n\/\/\/ 在资源管理器/)?.[0] ?? ''
const libraryResetCommand = commandsSource.match(/pub fn library_reset\([\s\S]*?\n}\n\n\/\/\/ 打开数据目录/)?.[0] ?? ''
check(
  '导入视频不再隐式登记监听目录',
  importFilesCommand.includes('indexer::import_files') && !importFilesCommand.includes('indexer::import_folder(')
)
check(
  '一次性导入文件夹只扫描文件、不登记监听目录',
  importFolderOnce.includes('scan_video_files') &&
    importFolderOnce.includes('import_files') &&
    !importFolderOnce.includes('insert_folder')
)
check(
  '重建索引延迟到工作线程开始时清理旧数据',
  !reindexCommand.includes('clear_frames') &&
    reindexCommand.includes('enqueue(app.clone(), *id, true)') &&
    indexerSource.includes('reset_before_run') &&
    indexerSource.includes('process_video(app2, id, reset_before_run)')
)
for (const [name, source] of [
  ['添加监听文件夹', foldersAddPathCommand],
  ['移除监听文件夹', foldersRemoveCommand],
  ['启停监听文件夹', foldersSetEnabledCommand]
]) {
  check(
    `${name}在同步监听器前释放数据库锁`,
    source.includes('drop(guard);') &&
      source.indexOf('drop(guard);') < source.lastIndexOf('watcher::')
  )
}
check(
  '删除视频会取消后台索引并广播删除事件',
  videosRemoveCommand.includes('indexer::cancel(&app, video_id)') &&
    videosRemoveCommand.includes('LibraryEvent::VideoRemoved')
)
check(
  '清空资料库会停止监听并取消全部索引任务',
  libraryResetCommand.includes('watcher::stop_all(&app)?') &&
    libraryResetCommand.includes('indexer::cancel_all(&app)')
)
check(
  '文件监听遵循写入等待与删除清理设置',
  watcherSource.includes('await_write_ms') &&
    watcherSource.includes('Duration::from_millis(wait_ms)') &&
    watcherSource.includes('prune_on_delete')
)
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
check('bundle 不再内置 ffmpeg', !Object.keys(resources).some((key) => /ffmpeg|ffprobe/i.test(key)))
check('便携目录不再复制 ffmpeg', !portableSource.includes("for (const name of ['ffmpeg.exe', 'ffprobe.exe'])"))
check('ICO 与 PNG 已配置', config.bundle?.icon?.includes('icons/icon.ico') && config.bundle?.icon?.includes('icons/icon.png'))

const buildIco = readFileSync(join(root, 'build', 'icon.ico'))
const tauriIco = readFileSync(join(root, 'src-tauri', 'icons', 'icon.ico'))
check('Tauri ICO 与品牌 ICO 字节一致', buildIco.equals(tauriIco), `${tauriIco.length} B`)
check('Tauri PNG 存在', existsSync(join(root, 'src-tauri', 'icons', 'icon.png')))

console.log(`\nTauri 契约自检：${failed ? `失败 ${failed} 项` : `${commands.length} 个命令全部通过`}`)
process.exit(failed ? 1 : 0)
