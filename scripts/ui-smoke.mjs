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
    'react-dom/server': join(shimDir, 'server.js'),
    '@tauri-apps/api/window': join(shimDir, 'tauri-window.js')
  }
  const hooks = ['useState','useEffect','useMemo','useCallback','useRef','useReducer','useContext','useLayoutEffect','useId','useTransition','useDeferredValue','useSyncExternalStore','useInsertionEffect','useImperativeHandle','useDebugValue']
  writeFileSync(shims.react, `import { createRequire } from 'node:module'
const require=createRequire(import.meta.url); const mod=require(${JSON.stringify(req.resolve('react'))}); export default mod
export const createElement=mod.createElement, cloneElement=mod.cloneElement, createContext=mod.createContext, createRef=mod.createRef, forwardRef=mod.forwardRef, isValidElement=mod.isValidElement, memo=mod.memo, lazy=mod.lazy, Fragment=mod.Fragment, StrictMode=mod.StrictMode, Children=mod.Children, Component=mod.Component, PureComponent=mod.PureComponent, startTransition=mod.startTransition
${hooks.map((name) => `export const ${name}=mod.${name}`).join('\n')}`)
  writeFileSync(shims['react/jsx-runtime'], `import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); const mod=require(${JSON.stringify(req.resolve('react/jsx-runtime'))}); export const jsx=mod.jsx, jsxs=mod.jsxs, jsxDEV=mod.jsxDEV, Fragment=mod.Fragment; export default mod`)
  writeFileSync(shims['react-dom/server'], `import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); const mod=require(${JSON.stringify(req.resolve('react-dom/server'))}); export const renderToStaticMarkup=mod.renderToStaticMarkup, renderToString=mod.renderToString; export default mod`)
  writeFileSync(shims['react-dom/client'], `import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); const mod=require(${JSON.stringify(req.resolve('react-dom/client'))}); export const createRoot=mod.createRoot, hydrateRoot=mod.hydrateRoot; export default mod`)
  writeFileSync(shims['@tauri-apps/api/window'], `export const getCurrentWindow=()=>({onDragDropEvent:async()=>()=>{}})`)
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
  const { DuplicatesModal } = await load('DuplicatesModal')
  const format = await import(pathToFileURL(join(js, 'renderer', 'src', 'lib', 'format.js')).href)
  const explorer = await import(pathToFileURL(join(js, 'renderer', 'src', 'lib', 'libraryExplorer.js')).href)
  const tableWindow = await import(pathToFileURL(join(js, 'renderer', 'src', 'lib', 'tableWindow.js')).href)
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
  const sameNameVideo = { ...video, id: 8, path: 'F:\\Archive\\Blue.Intro.1080p.mp4', dir: 'F:\\Archive', pathKey: 'f:\\archive\\blue.intro.1080p.mp4' }
  const duplicateHtml = render(jsx(DuplicatesModal, {
    duplicates: [{ videoA: video, videoB: sameNameVideo, score: 0.98, identicalFile: false }],
    onClose: noop, onRemoveVideos: noop, onPrune: noop
  }))
  check('查重结果中同名文件显示各自目录', duplicateHtml.includes(video.dir) && duplicateHtml.includes(sameNameVideo.dir))
  const duplicatesSource = readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'DuplicatesModal.tsx'), 'utf8')
  check('查重移除等待后端成功后才更新结果', duplicatesSource.includes('const removedIds = await onRemoveVideos(ids)') && duplicatesSource.includes('onPrune(removedIds)'))
  check('批量移除失败时不会提前清空选中项', readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'Toolbar.tsx'), 'utf8').includes('const removedIds = await onRemoveVideos(ids)') && readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useLibraryShortcuts.ts'), 'utf8').includes('if (removedIds.length === ids.length) clearSelection()'))
  const duplicateScanSource = readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'Toolbar.tsx'), 'utf8')
  check('查重失败不打开空结果并有错误通知', duplicateScanSource.includes('if (pairs !== null) onDuplicatesResolved(pairs)') && readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useLibrary.ts'), 'utf8').includes("withBusy('正在查找相似视频…'"))

  console.log('\n=== 全局框架 ===')
  const header = render(jsx(Header, { stats, tab: 'search', onTab: noop, themeMode: 'dark', themeResolved: 'dark', onCycleTheme: noop, onShowShortcuts: noop }))
  check('顶栏展示品牌与两个简短导航', header.includes('WhichVideo') && header.includes('搜图') && header.includes('视频库'))
  check('顶栏不再堆放导入按钮和五项统计', !header.includes('导入视频') && !header.includes('帧指纹') && !header.includes('监听 1/1'))
  check('顶栏保留主题和快捷键入口', header.includes('切换主题') && header.includes('键盘快捷键'))
  const statusHtml = render(jsx(StatusBar, { status, busy: null }))
  check('状态栏空闲时只显示简短状态', statusHtml.includes('就绪') && !statusHtml.includes('拖入图片'))
  const loadFailedHtml = render(jsx(StatusBar, { status, busy: null, loadError: '视频列表加载失败：读取错误', onRetryLoad: noop }))
  check('后台数据加载失败时保留可重试入口', loadFailedHtml.includes('需要处理') && loadFailedHtml.includes('视频列表加载失败：读取错误 · 重试') && !loadFailedHtml.includes('就绪'))
  const unavailableHtml = render(jsx(StatusBar, { status, busy: null, mediaTools: { ready: false, message: '未找到 FFmpeg' }, failedVideos: 2, onConfigureMediaTools: noop, onViewFailedVideos: noop }))
  check('状态栏持续提示不可用功能与失败视频', unavailableHtml.includes('需要处理') && unavailableHtml.includes('FFmpeg 未配置 · 设置目录') && unavailableHtml.includes('2 个视频索引失败 · 查看') && !unavailableHtml.includes('就绪'))
  const scanning = { type: 'import-progress', id: 1, processed: 120, total: 480, added: 3, skipped: 0, failed: 0, finished: false }
  const scanningHtml = render(jsx(StatusBar, { status, busy: '正在扫描文件夹…', importProgress: scanning }))
  check('状态栏展示导入进度与新增数', scanningHtml.includes('120/480') && scanningHtml.includes('新增 3'))
  const discoveringHtml = render(jsx(StatusBar, { status, busy: '正在扫描文件夹…', importProgress: { ...scanning, processed: 42, total: 0 } }))
  check('遍历阶段显示已发现文件数', discoveringHtml.includes('已发现 42 个文件'))
  const videoRowSource = readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'VideoRow.tsx'), 'utf8')
  check('鼠标与键盘选中不混入浏览器默认焦点边线', videoRowSource.includes('border-line/40 outline-none'))
  const themeSource = readFileSync(join(root, 'src', 'renderer', 'src', 'index.css'), 'utf8')
  const gallerySource = readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'FrameGallery.tsx'), 'utf8')
  check('键盘焦点统一使用主题强调色，预览点击不误显焦点环', themeSource.includes("button:focus-visible") && themeSource.includes('outline: 2px solid var(--color-accent)') && gallerySource.includes('focus-visible:ring-2') && !gallerySource.includes(' focus:ring-2'))
  const overlayFiles = ['DuplicatesModal.tsx', 'SidePanel.tsx', 'MediaToolsSetup.tsx', 'FrameGallery.tsx', 'ShortcutHelp.tsx']
  check('所有覆盖层都可用 Esc 关闭并声明对话框语义', overlayFiles.every((name) => {
    const source = readFileSync(join(root, 'src', 'renderer', 'src', 'components', name), 'utf8')
    return source.includes("event.key !== 'Escape'") || source.includes("e.key === 'Escape'")
  }) && ['DuplicatesModal.tsx', 'SidePanel.tsx'].every((name) => readFileSync(join(root, 'src', 'renderer', 'src', 'components', name), 'utf8').includes('aria-modal="true"')))
  check('所有覆盖层统一使用焦点捕获并在关闭时恢复触发元素', overlayFiles.every((name) => readFileSync(join(root, 'src', 'renderer', 'src', 'components', name), 'utf8').includes('useModalFocus')) && (() => {
    const focusHook = readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useModalFocus.ts'), 'utf8')
    return focusHook.includes('const trapTab') && focusHook.includes('previous?.isConnected') && focusHook.includes('requestAnimationFrame(focusFirst)')
  })())

  console.log('\n=== 搜图页 ===')
  const searchBase = { searching: false, error: null, queryImage: null, queryLabel: null, hasIndexedFrames: true, libraryVideoCount: 1, onOpenLibrary: noop, onPickImageFile: async () => [], onSearchPath: noop, onSearchDataUrl: noop, onSearchClipboard: noop, onSearchUrl: noop, onReSearch: noop, onClear: noop, onOpen: noop, onReveal: noop, onReindex: noop }
  const emptySearch = render(jsx(SearchView, { ...searchBase, search: null }))
  const emptyLibrarySearch = render(jsx(SearchView, { ...searchBase, search: null, hasIndexedFrames: false, libraryVideoCount: 0 }))
  check('空库首屏有添加入口', emptyLibrarySearch.includes('先添加视频') && emptyLibrarySearch.includes('前往视频库添加'))
  const indexingSearch = render(jsx(SearchView, { ...searchBase, search: null, hasIndexedFrames: false }))
  check('已有视频但尚未索引时说明等待', indexingSearch.includes('等待视频索引完成') && indexingSearch.includes('查看视频库'))
  check('首屏只有一个清晰主任务', emptySearch.includes('用一张图，找到视频') && emptySearch.includes('选择图片') && emptySearch.includes('粘贴截图'))
  check('支持拖放、链接和本地隐私提示', emptySearch.includes('拖放图片') && emptySearch.includes('粘贴图片或网页链接') && emptySearch.includes('所有比对都在本机完成'))
  check('空链接时搜索按钮禁用', /<button[^>]*disabled=""[^>]*>搜索<\/button>/.test(emptySearch))
  check('删除了占空间的三步说明卡', !emptySearch.includes('1 · 建立索引') && !emptySearch.includes('3 · 看结果'))
  const hitHtml = render(jsx(SearchView, { ...searchBase, search: hit, queryLabel: 'query.png' }))
  check('命中态给出简短结论', hitHtml.includes('找到了') && hitHtml.includes(video.name))
  check('结果保留相似度、时间与播放定位', hitHtml.includes('96%') && hitHtml.includes('2:00') && hitHtml.includes('处播放') && hitHtml.includes('定位文件'))
  check('相似度不表示确定概率', hitHtml.includes('画面相似度 · 很相似') && !hitHtml.includes('几乎确定'))
  check('结果状态说明索引进度且不误报文件位置', hitHtml.includes('已索引') && !hitHtml.includes('视频不在本地'))
  check('搜图结果直接显示视频目录而不重复文件名', hitHtml.includes(`title="${video.dir}">${video.dir}</div>`))
  const miss = { ...hit, matchCount: 0, found: false, matches: [] }
  check('未命中态文案简洁', render(jsx(SearchView, { ...searchBase, search: miss })).includes('没有找到相似画面'))
  const searchHookSource = readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useSearch.ts'), 'utf8')
  check('搜索清除或新请求不会被旧响应覆盖', searchHookSource.includes('const currentRequest = ++requestId.current') && searchHookSource.includes('requestId.current++') && searchHookSource.includes('if (currentRequest !== requestId.current) return'))
  check('剪贴板图片解码失败会显示后端返回的错误', searchHookSource.includes('applyResponse(clipboard.response)'))
  check('预览请求失败有回退，帧清单不会无限加载', ['SearchView.tsx', 'VideoRow.tsx'].every((name) => readFileSync(join(root, 'src', 'renderer', 'src', 'components', name), 'utf8').includes('.catch(() => { if (alive) setThumb(null) })')) && readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'FrameGallery.tsx'), 'utf8').includes('读取帧清单失败'))

  console.log('\n=== 视频库 ===')
  const selected = new Set([video.id])
  const settings = jsx(SettingsPanel, {
    settings: null,
    dataDir: { dir: 'E:\\WhichVideo\\data', source: 'install', toolsReady: true },
    mediaTools: { ready: true, source: 'path', directory: 'D:\\ffmpeg\\bin', configuredDirectory: null, ffmpeg: 'D:\\ffmpeg\\bin\\ffmpeg.exe', ffprobe: 'D:\\ffmpeg\\bin\\ffprobe.exe', message: '使用系统 PATH 中的 FFmpeg' },
    onChange: noop, onSelectMediaTools: noop, onRefreshMediaTools: noop, onClearMediaTools: noop,
    onReset: noop, onOpenDatabaseFolder: noop, onExportDiagnostics: noop
  })
  const mediaSettingsHtml = render(settings)
  check('媒体工具设置显示生效路径与重新检测入口', mediaSettingsHtml.includes('D:\\ffmpeg\\bin\\ffmpeg.exe') && mediaSettingsHtml.includes('D:\\ffmpeg\\bin\\ffprobe.exe') && mediaSettingsHtml.includes('重新检测'))
  const overriddenTools = render(jsx(SettingsPanel, {
    settings: null,
    dataDir: null,
    mediaTools: { ready: true, source: 'environment', directory: 'D:\\ffmpeg\\bin', configuredDirectory: 'E:\\manual', ffmpeg: 'D:\\ffmpeg\\bin\\ffmpeg.exe', ffprobe: 'D:\\ffmpeg\\bin\\ffprobe.exe', message: '使用环境变量指定的 FFmpeg' },
    onChange: noop, onSelectMediaTools: noop, onRefreshMediaTools: noop, onClearMediaTools: noop,
    onReset: noop, onOpenDatabaseFolder: noop, onExportDiagnostics: noop
  }))
  check('手动目录被环境变量覆盖时明确提示', overriddenTools.includes('环境变量优先于手动目录') && overriddenTools.includes('E:\\manual') && overriddenTools.includes('恢复自动检测'))
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
  const emptyLibrary = render(jsx(LibraryView, { ...libraryProps, folders: [], videos: [], total: 0, selectedVideoIds: new Set() }))
  check('空库直接提供视频与文件夹两个入口', emptyLibrary.includes('导入视频</button>') && emptyLibrary.includes('导入文件夹</button>'))
  const emptyFilter = render(jsx(LibraryView, { ...libraryProps, folders: [], videos: [], total: 0, query: { keyword: '不存在' }, selectedVideoIds: new Set() }))
  check('筛选无结果不误报为空库，并可一键清除筛选', emptyFilter.includes('没有符合条件的视频') && emptyFilter.includes('清除筛选</button>') && !emptyFilter.includes('开始建立你的视频库'))
  check('默认只显示可展开的导入目录，不铺满视频文件', library.includes('Movies') && library.includes('aria-expanded="false"') && !library.includes(`播放 ${video.name}`))
  check('文件夹使用描边图标而非易混淆的方框符号', library.includes('data-folder-icon="true"') && !library.includes('▣'))
  const pausedFolder = { ...folder, enabled: false, watchState: 'idle' }
  const pausedLibrary = render(jsx(LibraryView, { ...libraryProps, folders: [pausedFolder] }))
  check('文件夹行显示实际监视状态', library.includes('监听中') && pausedLibrary.includes('已暂停') && !pausedLibrary.includes('自动同步'))
  check('显式提供文件夹和全部视频视图', library.includes('文件夹</button>') && library.includes('全部视频</button>'))
  check('主操作收进单个添加菜单入口', library.includes('＋ 添加') && !library.includes('导入文件夹'))
  check('工具栏保持搜索、状态筛选和排序', libraryUnselected.includes('搜索视频') && libraryUnselected.includes('全部状态') && libraryUnselected.includes('最近添加'))
  check('表格精简为五列且不重复显示复选框', library.includes('视频</button>') && library.includes('状态') && library.includes('时长</button>') && library.includes('大小</button>') && library.includes('操作</th>') && (library.match(/<th\b/g) ?? []).length === 5 && !flatLibrary.includes('type="checkbox"'))
  check('四个数据列有可拖拽的列宽手柄', (library.match(/role="separator"/g) ?? []).length === 4 && ['视频', '状态', '时长', '大小'].every((name) => library.includes(`aria-label="调整${name}列宽"`)))
  check('操作列标题与按钮靠左对齐', library.includes('border-l border-line bg-surface-1 px-2 py-2 text-left') && flatLibrary.includes('justify-start gap-1'))
  check('可排序列点击区域覆盖整个表头', (library.match(/<button class="block w-full px-[23] py-2 text-left"/g) ?? []).length === 3)
  check('视频、时长、大小列可排序并显示升降序入口', (library.match(/aria-sort="none"/g) ?? []).length === 3 && libraryUnselected.includes('降序，切换为升序'))
  check('整行可选并保留明显的全选入口', flatLibrary.includes('全选</button>') && flatLibrary.includes(`data-video-id="${video.id}"`))
  check('收起文件夹时不再误报“显示 0”', library.includes('1 个视频') && !library.includes('显示 0'))
  check('视频行只保留播放和更多两个高频入口', flatLibrary.includes(`播放 ${video.name}`) && flatLibrary.includes(`更多操作 ${video.name}`) && !flatLibrary.includes(`定位 ${video.name}`))
  check('索引状态内显示采样帧数且不增加表格列', flatLibrary.includes(`已索引 · ${video.frameCount} 帧`) && flatLibrary.includes(`已建立 ${video.frameCount} 个索引采样帧`))
  check('选中态仍有强调色和左侧标记', flatLibrary.includes('bg-row-selected') && flatLibrary.includes('w-[2px] bg-accent') && flatLibrary.includes('text-accent'))
  check('选中后搜索筛选仍在，批量操作可见', library.includes('搜索视频') && library.includes('已选 1') && library.includes('重建索引'))

  const nested = { ...video, id: 8, name: 'nested.mp4', path: 'E:\\Media\\Movies\\A\\nested.mp4', dir: 'E:\\Media\\Movies\\A' }
  const roots = explorer.buildExplorerTree([folder], [video, nested])
  const collapsed = explorer.visibleExplorerRows(roots, new Set())
  const expanded = explorer.visibleExplorerRows(roots, new Set([explorer.explorerPathKey(folder.path)]))
  const fullyExpanded = explorer.visibleExplorerRows(roots, new Set([explorer.explorerPathKey(folder.path), explorer.explorerPathKey(nested.dir)]))
  check('文件夹逐层展开且收起时不显示子视频', collapsed.length === 1 && expanded.some((row) => row.type === 'folder' && row.depth === 1) && expanded.some((row) => row.type === 'video' && row.video.id === 7) && !expanded.some((row) => row.type === 'video' && row.video.id === 8) && fullyExpanded.some((row) => row.type === 'video' && row.video.id === 8))
  const emptyFolderRows = explorer.visibleExplorerRows(explorer.buildExplorerTree([folder], []), new Set([explorer.explorerPathKey(folder.path)]))
  check('展开空文件夹会生成明确的空状态行', emptyFolderRows.length === 2 && emptyFolderRows[1].type === 'empty')
  const oneTime = { ...folder, id: 2, pinned: false, enabled: false }
  const importedRoots = explorer.buildExplorerTree([oneTime], [{ ...video, folderId: 2 }])
  const legacyRoots = explorer.buildExplorerTree([], [{ ...video, folderId: null }])
  const directInWatchedDir = explorer.buildExplorerTree([folder], [{ ...video, folderId: null }])
  check('一次性导入保留文件夹，单独导入视频留在顶层', importedRoots.folders.length === 1 && importedRoots.folders[0].folder?.id === 2 && importedRoots.folders[0].count === 1 && legacyRoots.looseVideos[0]?.id === video.id && directInWatchedDir.looseVideos[0]?.id === video.id)
  const outerFolder = { ...folder, id: 20, path: 'E:\\Media', pathKey: 'e:\\media', name: 'Media' }
  const innerFolder = { ...folder, id: 21, path: 'E:\\Media\\Series\\A', pathKey: 'e:\\media\\series\\a', name: 'A' }
  const innerVideo = { ...video, id: 22, path: 'E:\\Media\\Series\\A\\episode.mp4', dir: innerFolder.path, folderId: innerFolder.id }
  const overlappingTree = explorer.buildExplorerTree([innerFolder, outerFolder], [innerVideo])
  const outerNode = overlappingTree.folders[0]
  const intermediate = outerNode?.children[0]
  const innerNode = intermediate?.children[0]
  check('后导入多级父目录时合并成一棵树且视频只出现一次', overlappingTree.folders.length === 1 && outerNode?.folder?.id === outerFolder.id && intermediate?.name === 'Series' && innerNode?.folder?.id === innerFolder.id && outerNode?.count === 1 && innerNode?.count === 1 && innerNode?.videos[0]?.id === innerVideo.id)
  const unixFolder = { ...folder, id: 10, path: '/media/Movies', pathKey: '/media/Movies' }
  const unixVideo = { ...video, id: 11, path: '/media/Movies/A/clip.mp4', dir: '/media/Movies/A', folderId: 10 }
  const unixTree = explorer.buildExplorerTree([unixFolder], [unixVideo])
  check('Unix 文件夹保持正斜杠并按层级显示', unixTree.folders[0].children[0]?.path === '/media/Movies/A' && unixTree.folders[0].children[0]?.videos[0]?.id === 11)
  check('Unix 路径大小写不同不误归入文件夹', explorer.buildExplorerTree([unixFolder], [{ ...unixVideo, path: '/media/movies/a.mp4', dir: '/media/movies' }]).looseVideos.length === 1)

  const source = (name) => readFileSync(join(root, 'src', 'renderer', 'src', 'components', name), 'utf8')
  const toolbarSource = source('Toolbar.tsx')
  const rowSource = source('VideoRow.tsx')
  check('空文件夹提示文案清楚', source('LibraryView.tsx').includes('暂无已入库视频'))
  check('目录内视频不重复显示路径，顶层视频保留位置', source('LibraryView.tsx').includes('showLocation={!treeVisible || row.depth === 0}') && rowSource.includes('{showLocation &&'))
  const shortcutsSource = readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useLibraryShortcuts.ts'), 'utf8')
  check('文件夹和视频都能用上下键导航', source('LibraryView.tsx').includes('handleEntryKeyDown') && source('LibraryView.tsx').includes('data-library-entry') && rowSource.includes('data-library-entry') && shortcutsSource.includes("if (onButton && ['ArrowDown'"))
  const drawerSource = source('SidePanel.tsx')
  check('添加菜单明确区分三种导入方式', ['视频文件', '导入文件夹', '监视文件夹'].every((text) => toolbarSource.includes(text)))
  check('监视管理和设置改为按需抽屉', toolbarSource.includes("setDrawer") || (toolbarSource.includes('onManageFolders') && toolbarSource.includes('onOpenSettings')))
  check('管理抽屉明确说明添加和拖入都会持续监视', drawerSource.includes('＋ 监视文件夹') && source('LibraryView.tsx').includes('拖入文件夹将自动监视'))
  check('文件夹拖放使用 Tauri 原生绝对路径且不截断文件路径', source('LibraryView.tsx').includes("from '@tauri-apps/api/window'") && source('LibraryView.tsx').includes('onDragDropEvent') && !source('LibraryView.tsx').includes('extractDroppedDir') && !source('LibraryView.tsx').includes("replace(/\\//g, '\\\\')"))
  check('移除文件夹明确确认且说明重叠目录保留、磁盘文件不受影响', source('FolderCard.tsx').includes('从库中移除') && source('FolderCard.tsx').includes('未被其他导入目录覆盖的视频') && source('FolderCard.tsx').includes('不会删除磁盘文件'))
  check('抽屉覆盖内容而非永久占宽', drawerSource.includes('absolute inset-0') && drawerSource.includes('if (!mode) return null'))
  check('定位和索引等低频动作放入更多菜单', rowSource.includes('查看索引帧') && rowSource.includes('在资源管理器中显示') && rowSource.includes('按${sampling') && rowSource.includes('从视频库移除'))
  check('索引进度仍区分检测与抽帧', rowSource.includes('检测场景') && rowSource.includes('抽取帧'))
  check('行菜单由视频库统一管理并在外部点击、滚动、Escape 时关闭', source('LibraryView.tsx').includes('openMenuId') && source('LibraryView.tsx').includes("document.addEventListener('pointerdown', dismiss, true)") && source('LibraryView.tsx').includes("window.addEventListener('scroll', scroll, true)"))
  check('表格首屏只挂一屏行，避免几千行同时请求缩略图', tableWindow.ROW_CHUNK > 0 && tableWindow.ROW_CHUNK <= 200)
  check('滚到底部按 chunk 追加且不超过总行数', tableWindow.growLimit(150, 5000, 150) === 300 && tableWindow.growLimit(150, 160, 150) === 160)
  check('光标走出已挂载窗口时会补挂那一段', tableWindow.limitForFocus(150, 149, 5000) === 150 && tableWindow.limitForFocus(150, 150, 5000) === 300 && tableWindow.limitForFocus(150, 4000, 5000) === 4150)
  check('表格只渲染挂载窗口并提示已显示行数', source('LibraryView.tsx').includes('mountedRows.map(') && source('LibraryView.tsx').includes('growLimit(current, rows.length)') && source('LibraryView.tsx').includes('已显示 {mountedRows.length} / {rows.length} 项'))
  check(
    '补挂后重新把焦点行滚进可视区',
    source('LibraryView.tsx').includes('scrollSignal: renderLimit') &&
      readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useVideoCursor.ts'), 'utf8').includes('[focusedVideoId, scrollSignal]')
  )
  check('行内操作先对齐当前选中视频', source('LibraryView.tsx').includes('handleRowClick(row.video.id, false, false)') && source('LibraryView.tsx').includes('!selectedVideoIds.has(openMenuId)'))

  console.log('\n=== 设置与基础能力 ===')
  const settingsHtml = render(settings)
  check('设置按质量、监视与存储分组', settingsHtml.includes('索引质量') && settingsHtml.includes('监视与存储'))
  check('六个滑块仍完整保留', (settingsHtml.match(/type="range"/g) ?? []).length === 6)
  check('采样间隔说明显示为悬停提示', settingsHtml.includes('title="每隔指定时间取一帧') && !settingsHtml.includes('适合镜头切换密集'))
  check('数据目录、诊断导出与危险操作仍可访问', settingsHtml.includes('数据目录') && settingsHtml.includes('打开索引库位置') && settingsHtml.includes('导出诊断包') && settingsHtml.includes('清空索引库'))
  const settingsSource = readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'SettingsPanel.tsx'), 'utf8')
  check('诊断导出先说明隐私范围并在完成后打开目录', settingsSource.includes('不会导出日志') && settingsSource.includes('完成后会打开保存目录') && settingsSource.includes('选择保存位置'))
  check('FFmpeg 状态与手动目录入口可访问', settingsHtml.includes('FFmpeg 可用') && settingsHtml.includes('更换目录'))
  const missingTools = render(jsx(MediaToolsSetup, {
    status: { ready: false, source: 'missing', directory: null, ffmpeg: null, ffprobe: null, message: '未找到 FFmpeg' },
    onSelect: noop
  }))
  check('首次缺少 FFmpeg 时给出设置引导', missingTools.includes('设置 FFmpeg') && missingTools.includes('选择 bin 目录') && missingTools.includes('稍后设置'))
  check('FFmpeg 文件名提示适用于所有平台', missingTools.includes('>ffmpeg</span>') && missingTools.includes('>ffprobe</span>') && missingTools.includes('Windows 文件名以 .exe 结尾'))
  check('formatDuration 处理时分秒', format.formatDuration(3725) === '1:02:05')
  check('formatBytes 处理 MB', format.formatBytes(734003200) === '700 MB')
  check('shortPath 相对监听目录', format.shortPath(video.path, [folder.path]) === 'Blue.Intro.1080p.mp4')

  console.log(`\n=== 新版 UI 冒烟：${failed ? `失败 ${failed} 项` : '全部通过'} ===`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
