/** 渲染端 UI 冒烟：SSR 真实组件，守住新版简洁信息架构与关键交互入口。 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = join(root, 'tmp', 'ui-smoke')
const js = join(tmp, 'js')
let failed = 0

function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

function rewriteSpecifiers(dir, shims) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { rewriteSpecifiers(full, shims); continue }
    if (!/\.(js|jsx)$/.test(full)) continue
    let source = readFileSync(full, 'utf8')
    const base = dirname(full)
    let renderer = relative(base, join(js, 'renderer', 'src')).split(sep).join('/')
    if (!renderer.startsWith('.')) renderer = `./${renderer}`
    source = source.replace(/(["'])@renderer\//g, (_, quote) => `${quote}${renderer}/`)
    let shared = relative(base, join(js, 'shared')).split(sep).join('/')
    if (!shared.startsWith('.')) shared = `./${shared}`
    source = source.replace(/(["'])@shared\//g, (_, quote) => `${quote}${shared}/`)
    for (const [spec, target] of Object.entries(shims)) {
      const url = pathToFileURL(target).href
      source = source.split(`"${spec}"`).join(`"${url}"`).split(`'${spec}'`).join(`'${url}'`)
    }
    source = source.replace(/(["'])(\.{1,2}\/[^"']*?)\1/g, (whole, quote, spec) => {
      if (/\.[a-z]+$/i.test(spec)) return whole
      return existsSync(join(base, `${spec}.js`)) ? `${quote}${spec}.js${quote}` : whole
    })
    writeFileSync(full, source)
  }
}

function transpile() {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.preview.json'), '--outDir', js], { stdio: 'inherit', cwd: root })
  if (result.status !== 0) throw new Error('渲染端转译失败')
}

async function main() {
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(js, { recursive: true })
  console.log('  转译渲染端（tsc）…')
  transpile()
  check('tsc 转译渲染端成功', existsSync(join(js, 'renderer', 'src', 'App.js')))

  const shimDir = join(js, 'shims')
  mkdirSync(shimDir, { recursive: true })
  const req = createRequire(import.meta.url)
  const shims = {
    react: join(shimDir, 'react.js'),
    'react/jsx-runtime': join(shimDir, 'jsx-runtime.js'),
    'react/jsx-dev-runtime': join(shimDir, 'jsx-runtime.js'),
    'react-dom/client': join(shimDir, 'client.js'),
    'react-dom/server': join(shimDir, 'server.js')
  }
  const hooks = ['useState','useEffect','useMemo','useCallback','useRef','useReducer','useContext','useLayoutEffect','useId','useTransition','useDeferredValue','useSyncExternalStore','useInsertionEffect','useImperativeHandle','useDebugValue']
  writeFileSync(shims.react, `import { createRequire } from 'node:module'
const require=createRequire(import.meta.url); const mod=require(${JSON.stringify(req.resolve('react'))}); export default mod
export const createElement=mod.createElement, cloneElement=mod.cloneElement, createContext=mod.createContext, createRef=mod.createRef, forwardRef=mod.forwardRef, isValidElement=mod.isValidElement, memo=mod.memo, lazy=mod.lazy, Fragment=mod.Fragment, StrictMode=mod.StrictMode, Children=mod.Children, Component=mod.Component, PureComponent=mod.PureComponent, startTransition=mod.startTransition
${hooks.map((name) => `export const ${name}=mod.${name}`).join('\n')}`)
  writeFileSync(shims['react/jsx-runtime'], `import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); const mod=require(${JSON.stringify(req.resolve('react/jsx-runtime'))}); export const jsx=mod.jsx, jsxs=mod.jsxs, jsxDEV=mod.jsxDEV, Fragment=mod.Fragment; export default mod`)
  writeFileSync(shims['react-dom/server'], `import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); const mod=require(${JSON.stringify(req.resolve('react-dom/server'))}); export const renderToStaticMarkup=mod.renderToStaticMarkup, renderToString=mod.renderToString; export default mod`)
  writeFileSync(shims['react-dom/client'], `import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); const mod=require(${JSON.stringify(req.resolve('react-dom/client'))}); export const createRoot=mod.createRoot, hydrateRoot=mod.hydrateRoot; export default mod`)
  rewriteSpecifiers(js, shims)

  const { jsx } = req('react/jsx-runtime')
  const { renderToStaticMarkup } = req('react-dom/server')
  const load = async (name) => import(pathToFileURL(join(js, 'renderer', 'src', 'components', `${name}.js`)).href)
  const { Header } = await load('Header')
  const { StatusBar } = await load('StatusBar')
  const { SearchView } = await load('SearchView')
  const { LibraryView } = await load('LibraryView')
  const { SettingsPanel } = await load('SettingsPanel')
  const { MediaToolsSetup } = await load('MediaToolsSetup')
  const format = await import(pathToFileURL(join(js, 'renderer', 'src', 'lib', 'format.js')).href)
  const explorer = await import(pathToFileURL(join(js, 'renderer', 'src', 'lib', 'libraryExplorer.js')).href)
  const render = (element) => renderToStaticMarkup(element)
  const noop = () => {}

  const video = {
    id: 7, path: 'E:\\Media\\Movies\\Blue.Intro.1080p.mp4', pathKey: 'e:\\media\\movies\\blue.intro.1080p.mp4',
    name: 'Blue.Intro.1080p.mp4', dir: 'E:\\Media\\Movies', ext: '.mp4', size: 734003200,
    mtimeMs: Date.now(), duration: 3725, width: 1920, height: 1080, videoCodec: 'h264', frameCount: 16,
    status: 'ready', error: null, addedAt: Date.now(), indexedAt: Date.now(), folderId: 1,
    processedTimestamps: [], samplingOverride: null, processedMs: 0, fileHash: null
  }
  const folder = {
    id: 1, path: 'E:\\Media\\Movies', pathKey: 'e:\\media\\movies', name: 'Movies', pinned: true,
    enabled: true, recursive: true, watchState: 'watching', message: null, addedAt: Date.now(), lastScanAt: Date.now()
  }
  const stats = { videos: 1, indexedVideos: 1, pendingVideos: 0, failedVideos: 0, frames: 16, totalBytes: 734003200, folders: 1, watching: 1 }
  const status = { running: false, active: 0, queued: 0, total: 0, done: 0, failed: 0, currentPath: null, startedAt: null, finishedAt: Date.now(), lastError: null }
  const match = { video, score: 0.964, hashScore: 1, colorScore: 0.948, timeSeconds: 120, frameIndex: 2, hashDistance: 0 }
  const hit = { query: { width: 320, height: 180, colorScoreHint: 0.948 }, matchCount: 1, comparedFrames: 160000, elapsedMs: 18, found: true, matches: [match] }

  console.log('\n=== 全局框架 ===')
  const header = render(jsx(Header, { stats, status, tab: 'search', onTab: noop, busy: null, themeMode: 'dark', themeResolved: 'dark', onCycleTheme: noop, onShowShortcuts: noop }))
  check('顶栏展示品牌与两个简短导航', header.includes('WhichVideo') && header.includes('搜图') && header.includes('视频库'))
  check('顶栏不再堆放导入按钮和五项统计', !header.includes('导入视频') && !header.includes('帧指纹') && !header.includes('监听 1/1'))
  check('顶栏保留主题和快捷键入口', header.includes('切换主题') && header.includes('键盘快捷键'))
  const statusHtml = render(jsx(StatusBar, { status, busy: null, notice: null }))
  check('状态栏空闲时只显示简短状态', statusHtml.includes('就绪') && !statusHtml.includes('拖入图片'))

  console.log('\n=== 搜图页 ===')
  const searchBase = { searching: false, error: null, queryImage: null, queryLabel: null, hasIndexedFrames: true, roots: [folder.path], onPickImageFile: async () => [], onSearchPath: noop, onSearchDataUrl: noop, onSearchClipboard: noop, onSearchUrl: noop, onReSearch: noop, onClear: noop, onOpen: noop, onReveal: noop, onReindex: noop }
  const emptySearch = render(jsx(SearchView, { ...searchBase, search: null }))
  check('首屏只有一个清晰主任务', emptySearch.includes('用一张图，找到视频') && emptySearch.includes('选择图片') && emptySearch.includes('粘贴截图'))
  check('支持拖放、链接和本地隐私提示', emptySearch.includes('拖放图片') && emptySearch.includes('粘贴图片或网页链接') && emptySearch.includes('所有比对都在本机完成'))
  check('空链接时搜索按钮禁用', /<button[^>]*disabled=""[^>]*>搜索<\/button>/.test(emptySearch))
  check('删除了占空间的三步说明卡', !emptySearch.includes('1 · 建立索引') && !emptySearch.includes('3 · 看结果'))
  const hitHtml = render(jsx(SearchView, { ...searchBase, search: hit, queryLabel: 'query.png' }))
  check('命中态给出简短结论', hitHtml.includes('找到了') && hitHtml.includes(video.name))
  check('结果保留相似度、时间与播放定位', hitHtml.includes('96%') && hitHtml.includes('2:00') && hitHtml.includes('处播放') && hitHtml.includes('定位文件'))
  const miss = { ...hit, matchCount: 0, found: false, matches: [] }
  check('未命中态文案简洁', render(jsx(SearchView, { ...searchBase, search: miss })).includes('没有找到相似画面'))

  console.log('\n=== 视频库 ===')
  const selected = new Set([video.id])
  const settings = jsx(SettingsPanel, {
    settings: null,
    dataDir: { dir: 'E:\\WhichVideo\\data', source: 'install', toolsReady: true },
    mediaTools: { ready: true, source: 'path', directory: 'D:\\ffmpeg\\bin', ffmpeg: 'D:\\ffmpeg\\bin\\ffmpeg.exe', ffprobe: 'D:\\ffmpeg\\bin\\ffprobe.exe', message: '使用系统 PATH 中的 FFmpeg' },
    onChange: noop, onSelectMediaTools: noop, onClearMediaTools: noop,
    onReset: noop, onOpenDatabaseFolder: noop
  })
  const libraryProps = {
    folders: [folder], videos: [video], total: 1, query: {}, onSetQuery: noop,
    onAddFolder: noop, onAddFolderPath: noop, onImportFolder: noop, onImportFiles: noop,
    onRemoveFolder: noop, onRescan: noop, onToggleFolder: noop, onOpen: noop, onReveal: noop,
    onRemoveVideo: noop, onRemoveVideos: noop, onReindex: noop, globalSampling: 'uniform', onFindDuplicates: async () => [],
    treeVisible: true, onToggleTree: noop,
    selectedVideoIds: selected, isVideoSelected: (id) => selected.has(id), toggleVideoSelection: noop,
    clearSelection: noop, selectAll: noop, setSelectedIds: noop, setSelectionOrder: noop, sideSettings: settings
  }
  const library = render(jsx(LibraryView, libraryProps))
  const flatLibrary = render(jsx(LibraryView, { ...libraryProps, treeVisible: false }))
  const libraryUnselected = render(jsx(LibraryView, {
    ...libraryProps,
    selectedVideoIds: new Set(),
    isVideoSelected: () => false
  }))
  check('默认只显示可展开的导入目录，不铺满视频文件', library.includes('Movies') && library.includes('aria-expanded="false"') && !library.includes(`播放 ${video.name}`))
  check('显式提供文件夹和全部视频视图', library.includes('文件夹</button>') && library.includes('全部视频</button>'))
  check('主操作收进单个添加菜单入口', library.includes('＋ 添加') && !library.includes('导入文件夹'))
  check('工具栏保持搜索、状态筛选和排序', libraryUnselected.includes('搜索视频') && libraryUnselected.includes('全部状态') && libraryUnselected.includes('最近添加'))
  check('表格精简为五列且不重复显示复选框', /视频<\/th>[\s\S]*状态<\/th>[\s\S]*时长<\/th>[\s\S]*大小<\/th>[\s\S]*操作<\/th>/.test(library) && (library.match(/<th\b/g) ?? []).length === 5 && !flatLibrary.includes('type="checkbox"'))
  check('整行可选并保留明显的全选入口', flatLibrary.includes('全选</button>') && flatLibrary.includes(`data-video-id="${video.id}"`))
  check('收起文件夹时不再误报“显示 0”', library.includes('1 个视频') && !library.includes('显示 0'))
  check('平铺视图的视频行保留三个高频操作', flatLibrary.includes(`播放 ${video.name}`) && flatLibrary.includes(`定位 ${video.name}`) && flatLibrary.includes(`更多操作 ${video.name}`))
  check('索引状态内显示采样帧数且不增加表格列', flatLibrary.includes(`已索引 · ${video.frameCount} 帧`) && flatLibrary.includes(`已建立 ${video.frameCount} 个索引采样帧`))
  check('选中态仍有强调色和左侧标记', flatLibrary.includes('bg-row-selected') && flatLibrary.includes('w-[2px] bg-accent') && flatLibrary.includes('text-accent'))
  check('选中后搜索筛选仍在，批量操作可见', library.includes('搜索视频') && library.includes('已选 1') && library.includes('重建索引'))

  const nested = { ...video, id: 8, name: 'nested.mp4', path: 'E:\\Media\\Movies\\A\\nested.mp4', dir: 'E:\\Media\\Movies\\A' }
  const roots = explorer.buildExplorerTree([folder], [video, nested])
  const collapsed = explorer.visibleExplorerRows(roots, new Set())
  const expanded = explorer.visibleExplorerRows(roots, new Set([explorer.explorerPathKey(folder.path)]))
  const fullyExpanded = explorer.visibleExplorerRows(roots, new Set([explorer.explorerPathKey(folder.path), explorer.explorerPathKey(nested.dir)]))
  check('文件夹逐层展开且收起时不显示子视频', collapsed.length === 1 && expanded.some((row) => row.type === 'folder' && row.depth === 1) && expanded.some((row) => row.type === 'video' && row.video.id === 7) && !expanded.some((row) => row.type === 'video' && row.video.id === 8) && fullyExpanded.some((row) => row.type === 'video' && row.video.id === 8))
  const oneTime = { ...folder, id: 2, pinned: false, enabled: false }
  const importedRoots = explorer.buildExplorerTree([oneTime], [{ ...video, folderId: 2 }])
  const legacyRoots = explorer.buildExplorerTree([], [{ ...video, folderId: null }])
  const directInWatchedDir = explorer.buildExplorerTree([folder], [{ ...video, folderId: null }])
  check('一次性导入保留文件夹，单独导入视频留在顶层', importedRoots.folders.length === 1 && importedRoots.folders[0].folder?.id === 2 && importedRoots.folders[0].count === 1 && legacyRoots.looseVideos[0]?.id === video.id && directInWatchedDir.looseVideos[0]?.id === video.id)

  const source = (name) => readFileSync(join(root, 'src', 'renderer', 'src', 'components', name), 'utf8')
  const toolbarSource = source('Toolbar.tsx')
  const rowSource = source('VideoRow.tsx')
  const drawerSource = source('SidePanel.tsx')
  check('添加菜单明确区分三种导入方式', ['视频文件', '导入文件夹', '监视文件夹'].every((text) => toolbarSource.includes(text)))
  check('监视管理和设置改为按需抽屉', toolbarSource.includes("setDrawer") || (toolbarSource.includes('onManageFolders') && toolbarSource.includes('onOpenSettings')))
  check('移除文件夹明确确认且说明不删除磁盘文件', source('LibraryView.tsx').includes('从库中移除') && source('LibraryView.tsx').includes('不会删除磁盘上的文件'))
  check('抽屉覆盖内容而非永久占宽', drawerSource.includes('absolute inset-0') && drawerSource.includes('if (!mode) return null'))
  check('行内低频动作放入更多菜单', rowSource.includes('查看索引帧') && rowSource.includes('按${sampling') && rowSource.includes('从视频库移除'))
  check('索引进度仍区分检测与抽帧', rowSource.includes('检测场景') && rowSource.includes('抽取帧'))
  check('行菜单由视频库统一管理并在外部点击、滚动、Escape 时关闭', source('LibraryView.tsx').includes('openMenuId') && source('LibraryView.tsx').includes("document.addEventListener('pointerdown', dismiss, true)") && source('LibraryView.tsx').includes("window.addEventListener('scroll', scroll, true)"))
  check('行内操作先对齐当前选中视频', source('LibraryView.tsx').includes('handleRowClick(row.video.id, false, false)') && source('LibraryView.tsx').includes('!selectedVideoIds.has(openMenuId)'))

  console.log('\n=== 设置与基础能力 ===')
  const settingsHtml = render(settings)
  check('设置按质量、监视与存储分组', settingsHtml.includes('索引质量') && settingsHtml.includes('监视与存储'))
  check('五个滑块仍完整保留', (settingsHtml.match(/type="range"/g) ?? []).length === 5)
  check('说明改为悬停提示而非大段常驻文字', settingsHtml.includes('title="实际帧数') && !settingsHtml.includes('适合镜头切换密集'))
  check('数据目录与危险操作仍可访问', settingsHtml.includes('数据目录') && settingsHtml.includes('打开索引库位置') && settingsHtml.includes('清空索引库'))
  check('FFmpeg 状态与手动目录入口可访问', settingsHtml.includes('FFmpeg 可用') && settingsHtml.includes('更换目录'))
  const missingTools = render(jsx(MediaToolsSetup, {
    status: { ready: false, source: 'missing', directory: null, ffmpeg: null, ffprobe: null, message: '未找到 FFmpeg' },
    onSelect: noop
  }))
  check('首次缺少 FFmpeg 时给出设置引导', missingTools.includes('设置 FFmpeg') && missingTools.includes('选择 bin 目录') && missingTools.includes('稍后设置'))
  check('formatDuration 处理时分秒', format.formatDuration(3725) === '1:02:05')
  check('formatBytes 处理 MB', format.formatBytes(734003200) === '700 MB')
  check('shortPath 相对监听目录', format.shortPath(video.path, [folder.path]) === 'Blue.Intro.1080p.mp4')

  console.log(`\n=== 新版 UI 冒烟：${failed ? `失败 ${failed} 项` : '全部通过'} ===`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
