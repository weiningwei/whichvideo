import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const readSource = (...parts) => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n?/g, '\n')
const shared = readSource('src', 'shared', 'types.ts')
const bridge = readSource('src', 'renderer', 'src', 'lib', 'tauri-api.ts')
const ipcContractSource = readSource('src', 'renderer', 'src', 'lib', 'ipc-contract.ts')
const rendererMain = readSource('src', 'renderer', 'src', 'main.tsx')
const rustMain = readSource('src-tauri', 'src', 'main.rs')
const commandsSource = readSource('src-tauri', 'src', 'commands.rs')
const searchServiceSource = readSource('src-tauri', 'src', 'search_service.rs')
const eventsSource = readSource('src-tauri', 'src', 'events.rs')
const indexerSource = readSource('src-tauri', 'src', 'indexer.rs')
const mediaSource = readSource('src-tauri', 'src', 'media.rs')
const dbSource = readSource('src-tauri', 'src', 'db.rs')
const portableSource = readSource('scripts', 'build-tauri-portable.mjs')
const fastBuildSource = readSource('scripts', 'build-tauri-fast.mjs')
const iconSource = readSource('scripts', 'generate-icon.mjs')
const processExt = readSource('src-tauri', 'src', 'process_ext.rs')
const platformOpen = readSource('src-tauri', 'src', 'platform_open.rs')
const watcherSource = readSource('src-tauri', 'src', 'watcher.rs')
const stateSource = readSource('src-tauri', 'src', 'state.rs')
const constantsSource = readSource('src-tauri', 'src', 'constants.rs')
const backendModuleSources = readdirSync(join(root, 'src-tauri', 'src'))
  .filter((name) => name.endsWith('.rs') && name !== 'state.rs')
  .map((name) => readSource('src-tauri', 'src', name))
  .join('\n')
const processSources = ['commands.rs', 'media.rs', 'updater.rs']
  .map((name) => readSource('src-tauri', 'src', name))
  .join('\n')
const config = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

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
const rustEventChannel = constantsSource.match(/pub const EVENT_CHANNEL: &str = "([^"]+)"/)?.[1]
const tsEventChannel = ipcBlock.match(/eventChannel:\s*'([^']+)'/)?.[1]
check(
  '事件频道常量前后端一致',
  !!rustEventChannel &&
    rustEventChannel === tsEventChannel &&
    !commandsSource.includes('"library_event"') &&
    !indexerSource.includes('"library_event"') &&
    !watcherSource.includes('"library_event"'),
  rustEventChannel
)

const rustExtensionBlock =
  constantsSource.match(/pub const VIDEO_EXTENSIONS: &\[&str\] = &\[([\s\S]*?)\];/)?.[1] ?? ''
const rustExtensions = [...rustExtensionBlock.matchAll(/"([^"]+)"/g)]
  .map((match) => match[1].toLowerCase())
  .sort()
const tsExtensionBlock = shared.match(/export const VIDEO_EXTENSIONS = \[([\s\S]*?)\] as const/)?.[1] ?? ''
const tsExtensions = [...tsExtensionBlock.matchAll(/'([^']+)'/g)]
  .map((match) => match[1].replace(/^\./, '').toLowerCase())
  .sort()
check(
  '视频扩展名前后端一致',
  rustExtensions.length >= 10 && rustExtensions.join(' ') === tsExtensions.join(' '),
  rustExtensions.join(' ')
)
check(
  '扫描器与文件对话框复用统一扩展名',
  indexerSource.includes('constants::VIDEO_EXTENSIONS') &&
    commandsSource.includes('constants::VIDEO_EXTENSIONS')
)

const normalizeDefault = (raw) =>
  raw.replace(/\.to_string\(\)$/, '').replace(/^['"]|['"]$/g, '').trim()
const parseDefaults = (block) => {
  const values = {}
  for (const line of block.split('\n')) {
    if (line.trim().startsWith('//')) continue
    const match = line.match(/^\s*([A-Za-z_]+):\s*(.+?),?\s*$/)
    if (!match) continue
    const key = match[1].replace(/_([a-z])/g, (_, char) => char.toUpperCase())
    values[key] = normalizeDefault(match[2])
  }
  return values
}
const rustDefaultsBlock =
  dbSource.match(/pub fn default_settings\(\) -> AppSettings \{([\s\S]*?)\n    \}/)?.[1] ?? ''
const tsDefaultsBlock = shared.match(/export const DEFAULT_SETTINGS: AppSettings = \{([\s\S]*?)\n\}/)?.[1] ?? ''
const rustDefaults = parseDefaults(rustDefaultsBlock)
const tsDefaults = parseDefaults(tsDefaultsBlock)
const defaultKeys = Object.keys(tsDefaults)
check(
  '设置默认值前后端一致',
  defaultKeys.length >= 8 && defaultKeys.every((key) => rustDefaults[key] === tsDefaults[key]),
  defaultKeys.filter((key) => rustDefaults[key] !== tsDefaults[key]).join(' ')
)
check('渲染入口安装 Tauri API', rendererMain.includes('window.whichvideo = tauriApi'))
check('Tauri 桥接无未实现占位', !bridge.includes('notImpl') && !bridge.includes('尚未实现'))
check(
  '数据库连接由 AppState 统一管理且运行期不可为空',
  stateSource.includes('db: Mutex<Connection>') &&
    stateSource.includes('pub fn db(&self)') &&
    stateSource.includes('pub fn db_recover(&self)') &&
    !backendModuleSources.includes('.db.lock()') &&
    !backendModuleSources.includes('数据库未初始化'),
  '业务模块只能通过 state.db() 或 state.db_recover() 访问连接'
)
check(
  '全部 IPC 返回值统一经过运行时校验',
  bridge.includes('value = await invoke<unknown>(command, args)') &&
    bridge.includes('decodeResponse(command, value)') &&
    commands.every(({ value }) => ipcContractSource.includes(`${value}:`)) &&
    ipcContractSource.includes('satisfies Record<Exclude<(typeof IPC)[keyof typeof IPC]')
)
check('渲染端不导入 Electron', !/from ['"]electron['"]|require\(['"]electron['"]\)/.test(bridge + rendererMain))
check('主窗口由 setup 手动创建', config.app?.windows?.[0]?.create === false)
check('WebView 缓存写入统一 data/session', rustMain.includes('.data_directory(paths::webview_dir())'))
check(
  '前后端路径规范化保留 Windows 盘符根目录',
  shared.includes("/^[a-z]:\\\\+$/i.test(normalized)") &&
    dbSource.includes("return normalized[..3].to_string()")
)
check(
  'FFmpeg 支持环境变量、手动目录与 PATH 成对探测',
  mediaSource.includes('WHICHVIDEO_FFMPEG') &&
    mediaSource.includes('WHICHVIDEO_BIN_DIR') &&
    mediaSource.includes('configured_dir') &&
    mediaSource.includes('tools_in_path(&path, tools_are_usable)') &&
    mediaSource.includes('filter_map(|dir| paths_in_dir(&dir))')
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
const importFilesCommand = commandsSource.match(/fn import_videos_sync\([\s\S]*?\n}/)?.[0] ?? ''
const importFolderOnce = indexerSource.match(/pub fn import_folder_once\([\s\S]*?\n}/)?.[0] ?? ''
const reindexCommand = indexerSource.match(/pub fn reindex\([\s\S]*?\n}\n\n\/\/\/ 启动恢复/)?.[0] ?? ''
const foldersAddPathCommand = commandsSource.match(/pub (?:async )?fn folders_add_path\([\s\S]*?\n}\n\n\/\/\/ 通过系统文件夹/)?.[0] ?? ''
const foldersRemoveCommand = commandsSource.match(/pub async fn folders_remove\([\s\S]*?\n}\n\n\/\/\/ 重新扫描文件夹/)?.[0] ?? ''
const foldersSetEnabledCommand = commandsSource.match(/pub fn folders_set_enabled\([\s\S]*?\n}\n\n\/\/\/ 单个视频记录/)?.[0] ?? ''
const foldersAddDialogCommand = commandsSource.match(/pub async fn folders_add_dialog\([\s\S]*?\n}\n\n\/\/\/ 从索引库移除文件夹/)?.[0] ?? ''
const foldersRescanCommand = commandsSource.match(/pub (?:async )?fn folders_rescan\([\s\S]*?\n}\n\n\/\/\/ 启用\/停用/)?.[0] ?? ''
const videosRemoveCommand = commandsSource.match(/pub fn videos_remove\([\s\S]*?\n}\n\n\/\/\/ 在资源管理器/)?.[0] ?? ''
const libraryResetCommand = commandsSource.match(/fn reset_library_sync\([\s\S]*?\n}\n\n\/\/\/ 打开数据目录/)?.[0] ?? ''
check(
  '导入视频不再隐式登记监听目录',
  importFilesCommand.includes('indexer::import_files') && !importFilesCommand.includes('indexer::import_folder(')
)
check(
  '一次性导入文件夹保留目录记录但不建立监听',
  importFolderOnce.includes('scan_video_files') &&
    importFolderOnce.includes('import_files') &&
    importFolderOnce.includes('insert_imported_folder') &&
    dbSource.includes('set_folder_enabled(conn, folder.id, false)')
)
check(
  '重建索引延迟到工作线程开始时清理旧数据',
  !reindexCommand.includes('clear_frames') &&
    reindexCommand.includes('enqueue_many(app, &targets, true)') &&
    indexerSource.includes('reset_before_run') &&
    indexerSource.includes('process_video(app2, id, reset_before_run)')
)
check(
  '重新索引返回值与前端 count 契约一致',
  commandsSource.includes('Result<events::ReindexResult, crate::error::AppError>') &&
    commandsSource.includes('Ok(events::ReindexResult { count })') &&
    /pub struct ReindexResult\s*\{\s*pub count: i64,\s*\}/.test(eventsSource) &&
    /reindex\([^)]*\): Promise<\{ count: number \}>/.test(shared) &&
    bridge.includes('invokeChecked(IPC.videosReindex') &&
    ipcContractSource.includes('videos_reindex: shape({ count: number })')
)
for (const [name, source] of [
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
  '拖放添加监听文件夹会立即扫描已有视频',
  foldersAddPathCommand.includes('indexer::import_folder') &&
    foldersAddPathCommand.includes('watcher::sync_all(&app)?')
)
check(
  '文件夹导入与重扫不会静默吞掉错误',
  !foldersAddDialogCommand.includes('Err(_) => {}') &&
    foldersAddDialogCommand.includes('watcher::sync_all(&app)?') &&
    !foldersRescanCommand.includes('if let Ok((result') &&
    foldersRescanCommand.includes('watcher::sync_all(&app)?')
)
check(
  '移除文件夹会保留其他导入目录覆盖的视频与单独导入的视频',
  foldersRemoveCommand.includes('db::detach_folder_videos') &&
    foldersRemoveCommand.includes('db::remove_video_ids') &&
    foldersRemoveCommand.includes('db::remove_folder') &&
    dbSource.includes('WHERE folder_id = ? ORDER BY id') &&
    dbSource.includes('closest_folder(conn, &path, Some(folder_id))')
)
check(
  '删除视频会取消后台索引并广播删除事件',
  videosRemoveCommand.includes('indexer::cancel(&app, video_id)') &&
    videosRemoveCommand.includes('LibraryEvent::VideoRemoved')
)
check(
  '清空资料库会停止监听并取消全部索引任务',
  /watcher::stop_all\(&?app\)\?/.test(libraryResetCommand) &&
    /indexer::cancel_all\(&?app\)/.test(libraryResetCommand)
)
check(
  '文件监听遵循写入等待与删除清理设置',
  watcherSource.includes('await_write_ms') &&
    watcherSource.includes('Duration::from_millis(wait_ms)') &&
    watcherSource.includes('prune_on_delete')
)
check(
  '文件监听处理泛化删除事件并同步索引状态',
  watcherSource.includes('EventKind::Remove(_)') &&
    watcherSource.includes('indexer::cancel(app') &&
    watcherSource.includes('state.rebuild_search_index()')
)
check(
  '耗时图片检索在线程池运行且不持锁执行 FFmpeg',
  ['search_path', 'search_data_url', 'search_clipboard', 'search_url'].every((name) =>
    commandsSource.includes(`pub async fn ${name}`)
  ) &&
    (commandsSource.match(/spawn_blocking\(/g) ?? []).length >= 5 &&
    searchServiceSource.includes('let videos: HashMap<i64, db::VideoRecord>') &&
    searchServiceSource.indexOf('let videos: HashMap<i64, db::VideoRecord>') < searchServiceSource.indexOf('let decoded = rerank_matches')
)
check(
  '库统计/文件夹/视频列表不占用窗口主线程',
  ['library_stats', 'folders_list', 'videos_list'].every((name) => {
    const start = commandsSource.indexOf(`pub async fn ${name}(`)
    if (start < 0) return false
    return commandsSource.slice(start, start + 700).includes('spawn_blocking')
  }),
  '同步命令在窗口主线程执行，等数据库锁时整窗会卡住'
)
check(
  '导入阶段不计算文件哈希（避免与抽帧抢磁盘）',
  !indexerSource.includes('sha256_of_file') && commandsSource.includes('sha256_of_file'),
  '改回导入时整文件读取会重新拖慢扫描与索引'
)
check(
  '删除文件夹与重建索引不占用窗口主线程',
  ['folders_remove', 'videos_reindex'].every((name) => {
    const start = commandsSource.indexOf(`pub async fn ${name}(`)
    if (start < 0) return false
    return commandsSource.slice(start, start + 500).includes('spawn_blocking')
  }),
  '这两个动作会在主线程删几千条记录/发上万条事件'
)
const removeFolderBody = commandsSource.slice(
  commandsSource.indexOf('fn remove_folder_sync('),
  commandsSource.indexOf('/// 重新扫描文件夹')
)
check(
  '删文件夹批量处理且只发汇总事件',
  removeFolderBody.includes('db::remove_video_ids') &&
    removeFolderBody.includes('indexer::cancel_many') &&
    removeFolderBody.includes('remove_videos(&ids)') &&
    !removeFolderBody.includes('VideoRemoved'),
  '逐条删除 + 逐条事件 + 全量重建索引是大文件夹卡死的原因'
)
check(
  '批量移除/重置/改设置不占用窗口主线程',
  ['videos_remove_many', 'library_reset', 'library_update_settings'].every((name) => {
    const start = commandsSource.indexOf(`pub async fn ${name}`)
    if (start < 0) return false
    return commandsSource.slice(start, start + 500).includes('spawn_blocking')
  }) && commandsSource.includes('db::remove_video_ids(conn, &video_ids)'),
  '删除帧目录与递归删 frames 可能持续几十秒'
)
check(
  '常驻索引在后台构建，未就绪前不搜索、不开工',
  stateSource.includes('search_ready') &&
    rustMain.includes('rebuild_search_index') &&
    indexerSource.includes('if !state.search_ready.load') &&
    commandsSource.includes('正在加载索引'),
  '在主线程同步构建百万帧索引会让窗口白屏数秒'
)
check(
  '重建索引批量入队，统计事件节流',
  indexerSource.includes('pub fn enqueue_many') &&
    indexerSource.includes('enqueue_many(app, &targets, true)') &&
    indexerSource.includes('should_broadcast_stats') &&
    indexerSource.includes('broadcast_stats_now') &&
    indexerSource.includes('idx.concurrency.max(1)'),
  '逐条 enqueue 会为每个视频发两条事件并读一次设置'
)
const commandStarts = (processSources.match(/Command::new\(/g) ?? []).length
const hiddenStarts = (processSources.match(/\.no_window\(\)/g) ?? []).length
check(
  'Windows 子进程全部隐藏控制台窗口',
  commandStarts > 0 && commandStarts === hiddenStarts && processExt.includes('CREATE_NO_WINDOW'),
  `${hiddenStarts}/${commandStarts}`
)
check('文件管理器与播放器按平台启动', platformOpen.includes('target_os = "macos"') && platformOpen.includes('xdg-open') && platformOpen.includes('explorer.exe') && platformOpen.includes('.no_window()'))

console.log('\n=== Tauri bundle 资源 ===')
const resources = config.bundle?.resources ?? {}
check('bundle 目标可按平台选择', config.bundle?.targets === 'all')
check('bundle 不再内置 ffmpeg', !Object.keys(resources).some((key) => /ffmpeg|ffprobe/i.test(key)))
check('便携目录不再复制 ffmpeg', !portableSource.includes("for (const name of ['ffmpeg.exe', 'ffprobe.exe'])"))
check(
  '快速便携构建隔离缓存且不降低正式发行配置',
  pkg.scripts?.['build:portable:fast']?.includes('node scripts/build-tauri-fast.mjs') &&
    fastBuildSource.includes("CARGO_TARGET_DIR: targetDir") &&
    fastBuildSource.includes("CARGO_PROFILE_RELEASE_LTO: 'thin'") &&
    fastBuildSource.includes("CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16'") &&
    fastBuildSource.includes("CARGO_PROFILE_RELEASE_INCREMENTAL: 'true'") &&
    fastBuildSource.includes("process.env.npm_execpath ||") &&
    fastBuildSource.includes('WHICHVIDEO_TAURI_EXE: sourceExe')
)
check(
  '未变图标不会触发 Rust 资源重编译',
  iconSource.includes('function writeIfChanged') &&
    iconSource.includes('readFileSync(path).equals(data)') &&
    (iconSource.match(/writeIfChanged\(/g) ?? []).length >= 6
)
check('ICO 与 PNG 已配置', config.bundle?.icon?.includes('icons/icon.ico') && config.bundle?.icon?.includes('icons/icon.png'))

const buildIco = readFileSync(join(root, 'build', 'icon.ico'))
const tauriIco = readFileSync(join(root, 'src-tauri', 'icons', 'icon.ico'))
check('Tauri ICO 与品牌 ICO 字节一致', buildIco.equals(tauriIco), `${tauriIco.length} B`)
check('Tauri PNG 存在', existsSync(join(root, 'src-tauri', 'icons', 'icon.png')))
const macConfig = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.macos.conf.json'), 'utf8'))
const macIcon = readFileSync(join(root, 'src-tauri', 'icons', 'icon.icns'))
check('macOS ICNS 已配置且包含有效容器头', macConfig.bundle?.icon?.includes('icons/icon.icns') && macIcon.subarray(0, 4).toString('ascii') === 'icns')

console.log(`\nTauri 契约自检：${failed ? `失败 ${failed} 项` : `${commands.length} 个命令全部通过`}`)
process.exit(failed ? 1 : 0)
