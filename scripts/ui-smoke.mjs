/**
 * 渲染端冒烟测试：用 React 服务端渲染把真实组件渲染成 HTML，断言关键文案与状态。
 *
 * 覆盖：
 *   1. 顶栏（Header）+ 状态栏（StatusBar）
 *   2. 搜索页（SearchView）：首屏引导、命中态、未命中态、空索引态
 *   3. 视频库页（LibraryView）：视频表格、状态、监听文件夹与 watching 状态
 *   4. 设置面板（SettingsPanel）
 *   5. 纯函数（lib/format.ts）
 *
 * 运行： node scripts/ui-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const tmp = join(root, 'tmp', 'ui-smoke')
const js = join(tmp, 'js')

let failed = 0
const results = []

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
  results.push({ name, ok, detail })
}

/** 把编译产物里的裸模块说明符替换成 shim 的绝对 file:// 地址（Node 的 ESM 需要显式路径） */
function rewriteSpecifiers(dir, shims) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      rewriteSpecifiers(full, shims)
      continue
    }
    if (!/\.(js|jsx)$/.test(full)) continue
    let source = readFileSync(full, 'utf8')
    const base = dirname(full)
    let rel = relative(base, join(js, 'renderer', 'src')).split(sep).join('/')
    if (!rel.startsWith('.')) rel = `./${rel}`
    source = source.replace(/(["'])@renderer\//g, (_, q) => `${q}${rel}/`)
    let sharedRel = relative(base, join(js, 'shared')).split(sep).join('/')
    if (!sharedRel.startsWith('.')) sharedRel = `./${sharedRel}`
    source = source.replace(/(["'])@shared\//g, (_, q) => `${q}${sharedRel}/`)
    for (const [spec, target] of Object.entries(shims)) {
      const url = pathToFileURL(target).href
      source = source.split(`"${spec}"`).join(`"${url}"`).split(`'${spec}'`).join(`'${url}'`)
    }
    // tsc 产出的相对导入没有扩展名，Node 的 ESM 解析器要求写全
    source = source.replace(/(["'])(\.{1,2}\/[^"']*?)\1/g, (whole, quote, spec) => {
      if (/\.[a-z]+$/i.test(spec)) return whole
      const asFile = join(base, spec + '.js')
      return existsSync(asFile) ? `${quote}${spec}.js${quote}` : whole
    })
    writeFileSync(full, source)
  }
}

function transpile() {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const r = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.preview.json'), '--outDir', js], {
    stdio: 'inherit',
    cwd: root
  })
  if (r.status !== 0) throw new Error('渲染端转译失败')
}

async function main() {
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(js, { recursive: true })

  console.log('  转译渲染端（tsc）…')
  transpile()
  check('tsc 转译渲染端成功', existsSync(join(js, 'renderer', 'src', 'App.js')))

  /* ---------- React 的 ESM 转接头（内部用 createRequire 加载真实 CJS 包） ---------- */
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

  const hooks = [
    'useState',
    'useEffect',
    'useMemo',
    'useCallback',
    'useRef',
    'useReducer',
    'useContext',
    'useLayoutEffect',
    'useId',
    'useTransition',
    'useDeferredValue',
    'useSyncExternalStore',
    'useInsertionEffect',
    'useImperativeHandle',
    'useDebugValue'
  ]
  writeFileSync(
    shims.react,
    `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mod = require(${JSON.stringify(req.resolve('react'))})
export default mod
export const createElement = mod.createElement
export const cloneElement = mod.cloneElement
export const createContext = mod.createContext
export const createRef = mod.createRef
export const forwardRef = mod.forwardRef
export const isValidElement = mod.isValidElement
export const memo = mod.memo
export const lazy = mod.lazy
export const Fragment = mod.Fragment
export const StrictMode = mod.StrictMode
export const Children = mod.Children
export const Component = mod.Component
export const PureComponent = mod.PureComponent
export const startTransition = mod.startTransition
${hooks.map((h) => `export const ${h} = mod.${h}`).join('\n')}
`
  )
  writeFileSync(
    shims['react/jsx-runtime'],
    `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mod = require(${JSON.stringify(req.resolve('react/jsx-runtime'))})
export const jsx = mod.jsx
export const jsxs = mod.jsxs
export const jsxDEV = mod.jsxDEV
export const Fragment = mod.Fragment
export default mod
`
  )
  writeFileSync(
    shims['react-dom/server'],
    `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mod = require(${JSON.stringify(req.resolve('react-dom/server'))})
export const renderToStaticMarkup = mod.renderToStaticMarkup
export const renderToString = mod.renderToString
export default mod
`
  )
  writeFileSync(
    shims['react-dom/client'],
    `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mod = require(${JSON.stringify(req.resolve('react-dom/client'))})
export const createRoot = mod.createRoot
export const hydrateRoot = mod.hydrateRoot
export default mod
`
  )

  rewriteSpecifiers(js, shims)
  check(
    '渲染端产物已接上 React 转接头',
    readFileSync(join(js, 'renderer', 'src', 'components', 'Header.js'), 'utf8').includes('shims/jsx-runtime.js')
  )

  const { jsx } = req('react/jsx-runtime')
  const { renderToStaticMarkup } = req('react-dom/server')
  const load = async (name) =>
    import(pathToFileURL(join(js, 'renderer', 'src', 'components', `${name}.js`)).href)
  const { Header } = await load('Header')
  const { StatusBar } = await load('StatusBar')
  const { SearchView } = await load('SearchView')
  const { LibraryView } = await load('LibraryView')
  const { SettingsPanel } = await load('SettingsPanel')
  const format = await import(pathToFileURL(join(js, 'renderer', 'src', 'lib', 'format.js')).href)

  /* ---------- 固定样本 ---------- */
  const video = {
    id: 7,
    path: 'E:\\Media\\Movies\\Blue.Intro.1080p.mp4',
    pathKey: 'e:\\media\\movies\\blue.intro.1080p.mp4',
    name: 'Blue.Intro.1080p.mp4',
    dir: 'E:\\Media\\Movies',
    ext: '.mp4',
    size: 734003200,
    mtimeMs: Date.now(),
    duration: 3725,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    frameCount: 16,
    status: 'ready',
    error: null,
    addedAt: Date.now(),
    indexedAt: Date.now(),
    folderId: 1
  }
  const folder = {
    id: 1,
    path: 'E:\\Media\\Movies',
    pathKey: 'e:\\media\\movies',
    name: 'Movies',
    pinned: true,
    enabled: true,
    recursive: true,
    watchState: 'watching',
    message: null,
    addedAt: Date.now(),
    lastScanAt: Date.now()
  }
  const stats = {
    videos: 1,
    indexedVideos: 1,
    pendingVideos: 0,
    failedVideos: 0,
    frames: 16,
    totalBytes: 734003200,
    folders: 1,
    watching: 1
  }
  const status = {
    running: false,
    active: 0,
    queued: 0,
    total: 0,
    done: 0,
    failed: 0,
    currentPath: null,
    startedAt: null,
    finishedAt: Date.now(),
    lastError: null
  }
  const match = {
    video,
    score: 0.964,
    hashScore: 1,
    colorScore: 0.948,
    timeSeconds: 120,
    frameIndex: 2,
    hashDistance: 0
  }
  const hitResponse = {
    query: { width: 320, height: 180, colorScoreHint: 0.948 },
    matchCount: 1,
    comparedFrames: 160000,
    elapsedMs: 18,
    found: true,
    matches: [match]
  }

  const noop = () => {}
  const render = (element) => renderToStaticMarkup(element)

  /* ---------- 1. 顶栏 + 状态栏 ---------- */
  const headerHtml = render(
    jsx(Header, {
      stats,
      status,
      tab: 'search',
      onTab: noop,
      onImportFiles: noop,
      onImportFolder: noop,
      busy: null
    })
  )
  check('顶栏渲染品牌名', headerHtml.includes('WhichVideo'))
  check('顶栏渲染统计（监听 1/1）', /1\/1/.test(headerHtml), headerHtml.match(/监听[\s\S]{0,40}/)?.[0] ?? '')
  check('顶栏渲染帧指纹数量', headerHtml.includes('16'))
  check('顶栏渲染导入按钮', headerHtml.includes('导入视频') && headerHtml.includes('导入文件夹'))

  const barHtml = render(jsx(StatusBar, { status, busy: null, notice: null }))
  check('状态栏渲染空闲状态', barHtml.includes('索引空闲') || barHtml.includes('待机'))
  check('状态栏渲染操作提示', barHtml.includes('拖入图片') || barHtml.includes('Ctrl+V'))

  /* ---------- 2. 搜索页首屏 ---------- */
  const searchBase = {
    search: null,
    searching: false,
    error: null,
    queryImage: null,
    queryLabel: null,
    roots: [folder.path],
    onPickImageFile: async () => [],
    onSearchPath: noop,
    onSearchDataUrl: noop,
    onSearchClipboard: noop,
    onClear: noop,
    onOpen: noop,
    onReveal: noop,
    onReindex: noop
  }
  const emptyHtml = render(jsx(SearchView, searchBase))
  check('搜索页渲染拖拽引导', emptyHtml.includes('拖到这里'))
  check('搜索页渲染选择图片按钮', emptyHtml.includes('选择图片文件'))
  check('搜索页渲染使用剪贴板按钮', emptyHtml.includes('使用剪贴板图片'))
  check('搜索页渲染三步引导', emptyHtml.includes('建立索引') && emptyHtml.includes('丢一张图进来'))

  /* ---------- 3. 命中态 ---------- */
  const hitHtml = render(
    jsx(SearchView, {
      ...searchBase,
      search: hitResponse,
      queryImage: 'data:image/png;base64,AA',
      queryLabel: 'screenshot.png'
    })
  )
  check('命中时给出"已在本地库中找到"结论', hitHtml.includes('已在本地库中找到'))
  check('命中时展示视频文件名', hitHtml.includes('Blue.Intro.1080p.mp4'))
  check('结果卡片标注"已下载 · 本地库中"', hitHtml.includes('已下载 · 本地库中'))
  check('展示相似度百分比', hitHtml.includes('96%'))
  check('展示命中时间点（2:00）', hitHtml.includes('2:00'))
  check('展示结构/颜色分项', hitHtml.includes('结构') && hitHtml.includes('颜色'))
  check('展示比对规模与耗时', hitHtml.includes('160,000') && hitHtml.includes('18 ms'))
  check('结果卡片带播放/定位按钮', hitHtml.includes('播放') && hitHtml.includes('定位文件'))
  check('展示视频规格信息', hitHtml.includes('1920×1080') && hitHtml.includes('h264'))

  /* ---------- 4. 未命中态 ---------- */
  const missHtml = render(
    jsx(SearchView, {
      ...searchBase,
      search: { ...hitResponse, matchCount: 0, found: false, matches: [] },
      queryImage: 'data:image/png;base64,AA',
      queryLabel: 'unknown.png'
    })
  )
  check('未命中时提示"没有视频与这张图相似"', missHtml.includes('没有视频与这张图相似'))
  check('未命中结论说明还没下载', missHtml.includes('还没下载'))

  /* ---------- 5. 空索引态 ---------- */
  const noIndexHtml = render(
    jsx(SearchView, {
      ...searchBase,
      search: { ...hitResponse, matchCount: 0, found: false, matches: [], comparedFrames: 0 },
      queryImage: 'data:image/png;base64,AA'
    })
  )
  check('索引为空时提示先导入视频', noIndexHtml.includes('还没有任何帧指纹'))

  /* ---------- 5b. 比对中不能是空白、剪贴板搜索要显示查询图 ---------- */
  const searchingHtml = render(jsx(SearchView, { ...searchBase, searching: true }))
  check('比对中结果区有占位文案（不能一片空白）', searchingHtml.includes('正在读取图片并与帧指纹比对'))
  check('比对中时收起三步引导', !searchingHtml.includes('建立索引'))
  check('比对中时显示"比对中…"', searchingHtml.includes('比对中'))

  const clipboardHtml = render(
    jsx(SearchView, {
      ...searchBase,
      search: hitResponse,
      queryImage: 'data:image/png;base64,AA',
      queryLabel: '剪贴板图片'
    })
  )
  check('剪贴板搜索后左上角渲染出查询图', /<img[^>]*src="data:image\/png;base64,AA"/.test(clipboardHtml))
  check('剪贴板搜索后标注图片来源', clipboardHtml.includes('剪贴板图片'))
  check('剪贴板搜索后展示命中结果', clipboardHtml.includes('已在本地库中找到'))

  /* ---------- 6. 视频库页 ---------- */
  const emptySelected = new Set()
  const emptyExpanded = new Set()
  const noopSel = () => {}
  const noopBool = () => false
  const libraryHtml = render(
    jsx(LibraryView, {
      folders: [folder],
      videos: [video],
      total: 1,
      query: { limit: 500, status: 'all', sort: 'added' },
      onSetQuery: noop,
      onAddFolder: noop,
      onAddFolderPath: noop,
      onRemoveFolder: noop,
      onRescan: noop,
      onToggleFolder: noop,
      onOpen: noop,
      onReveal: noop,
      onRemoveVideo: noop,
      onReindex: noop,
      groupByFolder: false,
      onToggleGroupByFolder: noop,
      selectedVideoIds: emptySelected,
      expandedFolderIds: emptyExpanded,
      isVideoSelected: noopBool,
      isFolderExpanded: noopBool,
      toggleVideoSelection: noopSel,
      clearSelection: noopSel,
      selectAll: noopSel,
      toggleFolderExpanded: noopSel,
      expandAllFolders: noopSel,
      collapseAllFolders: noopSel,
      sideSettings: null
    })
  )
  check('视频库页显示视频行', libraryHtml.includes('Blue.Intro.1080p.mp4'))
  check('视频库页显示状态"已索引"', libraryHtml.includes('已索引'))
  // 表格已精简为 3 列（视频 / 状态 / 操作），元信息合并进视频列第二行。
  // 状态列仍需禁止换行：中文可逐字断行，列被压窄会竖排成多行。
  check(
    '状态列禁止换行（中文可逐字断行，列被压窄会竖排成多行）',
    /<td class="whitespace-nowrap px-2 py-1\.5"><span[^>]*>已索引<\/span><\/td>/.test(libraryHtml),
    libraryHtml.match(/<td class="[^"]*"><span[^>]*>已索引<\/span><\/td>/)?.[0] ?? '没找到状态单元格'
  )
  // 元信息合并进视频列第二行（用 · 分隔）；目录已由第一行的 title 提供，不再重复
  // mock 数据 size=734003200 → "700 MB"
  check(
    '元信息合并进视频列信息行（时长 · 体积 · 帧数）',
    /1:02:05 · 700 MB · 16 帧/.test(libraryHtml),
    (libraryHtml.match(/[^<>]*1:02:05[^<>]*/)?.[0] ?? '没找到信息行').slice(0, 90)
  )
  check(
    '表格已精简为 3 列（视频 / 状态 / 操作，「选择」列已移除）',
    /视频<\/th>[\s\S]*?状态<\/th>[\s\S]*?操作<\/th>/.test(libraryHtml) &&
      !/<th[^>]*>\s*<input[^>]*checkbox/.test(libraryHtml),
    (libraryHtml.match(/<th[^>]*>(?:(?!<\/th>)[\s\S])*?<\/th>/g) ?? []).length + ' 个表头，无全选框'
  )
  // 选中态改为左侧竖条提示。竖条只在 isVideoSelected 为真时渲染，而 mock 的
  // selectedVideoIds 是空集，SSR 走不到该分支，故静态检查源码。
  {
    const src = readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'LibraryView.tsx'), 'utf8')
    check(
      '选中提示用左侧竖条（绝对定位，不占列宽）',
      src.includes('w-[2px] bg-accent') && src.includes('absolute inset-y-0 left-0'),
      '2px accent 竖条'
    )
    check(
      '整行可点击切换选中（操作列 stopPropagation 避免误触）',
      src.includes('cursor-pointer border-b border-line/40') &&
        src.includes('onToggleSelect={() => toggleVideoSelection(video.id, false, false)}'),
      '点击整行即切换'
    )
    check(
      '分组标题选中态也改为竖条（不再是复选框）',
      src.includes("groupSelected ? 'bg-accent'") && src.includes('groupPartial'),
      '全选 / 部分选中两态'
    )
    const codeNoComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    check(
      '移除复选框后不再需要 indeterminate 同步副作用',
      !codeNoComments.includes('indeterminate') && !codeNoComments.includes('selectAllRef'),
      '已清理表头/分组复选框的 indeterminate 逻辑'
    )
  }
  // 目录不再重复显示文件名：可见文本里文件名只该出现一次（title 属性不计）
  const visibleText = libraryHtml.replace(/\stitle="[^"]*"/g, '')
  check(
    '目录不再重复显示文件名（可见文本里文件名只出现一次）',
    (visibleText.match(/Blue\.Intro\.1080p\.mp4/g) ?? []).length === 1,
    `可见文本中出现 ${(visibleText.match(/Blue\.Intro\.1080p\.mp4/g) ?? []).length} 次（应为 1）`
  )
  check(
    '行内操作收敛为「播放 + 更多」两个控件',
    libraryHtml.includes('播放') && libraryHtml.includes('⋯') && libraryHtml.includes('更多操作'),
    '低频操作收进 ⋯ 菜单'
  )
  // 菜单默认收起：SSR 输出里只有触发按钮（aria-expanded=false），没有菜单浮层本身。
  // 这正是「默认不占位」的行为证据——绝对定位的浮层不参与表格列宽计算。
  check(
    '更多菜单默认收起（不渲染浮层，不占列宽）',
    libraryHtml.includes('aria-expanded="false"') &&
      libraryHtml.includes('aria-haspopup="menu"') &&
      !libraryHtml.includes('absolute right-0 top-full'),
    '收起时只有触发按钮，无浮层元素'
  )
  // 菜单项文案单独断言：直接对 RowMenu 的 items 定义做静态检查，
  // 因为菜单默认收起，SSR 输出里不含菜单项。
  {
    const src = readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'LibraryView.tsx'), 'utf8')
    check(
      '更多菜单包含定位/重索引/移除三个操作',
      ['定位文件', '重索引', '从库中移除'].every((t) => src.includes(`'${t}'`)),
      '三个低频操作都在菜单定义里'
    )
    check(
      '菜单浮层绝对定位（展开后也不撑表格列宽）',
      src.includes('absolute right-0 top-full'),
      'right-0 top-full 绝对定位'
    )
    check(
      'RowMenu 点击外部与 Esc 都会关闭',
      src.includes("addEventListener('mousedown'") && src.includes("addEventListener('keydown'") &&
        src.includes("e.key === 'Escape'"),
      '菜单有外部点击与 Esc 两种关闭方式'
    )
  }
  check('视频库页显示监听文件夹', libraryHtml.includes('Movies') && libraryHtml.includes('E:\\Media\\Movies'))
  check('视频库页显示监听中状态', libraryHtml.includes('监听中'))
  check('视频库页显示手动标记', libraryHtml.includes('手动'))
  check('视频库页有筛选控件', libraryHtml.includes('全部监听目录') && libraryHtml.includes('全部状态'))
  check('视频库页有重建/重扫按钮', libraryHtml.includes('重建全部索引') && libraryHtml.includes('重新扫描目录'))
  check('视频库页有暂停与停止监听按钮', libraryHtml.includes('暂停监听') && libraryHtml.includes('停止监听'))
  check('右栏为单层面板（监听/索引设置 标签切换）', libraryHtml.includes('索引设置') && libraryHtml.includes('监听'))

  /* ---------- 7. 设置面板 ---------- */
  const appSettings = {
    framesPerVideo: 16,
    concurrency: 2,
    minHashScore: 0.6,
    maxResults: 40,
    awaitWriteMs: 1500,
    pruneOnDelete: true
  }
  const settingsHtml = render(
    jsx(SettingsPanel, {
      settings: appSettings,
      dataDir: { dir: 'C:\\Users\\me\\AppData\\Roaming\\WhichVideo', portable: false, source: 'default', toolsReady: true },
      initialOpen: true,
      onChange: noop,
      onReset: noop,
      onOpenDatabaseFolder: noop
    })
  )
  // 设置面板现在嵌在右栏的「索引设置」标签页内，自身标题改为「抽帧与匹配参数」
  check('设置面板有入口标题', settingsHtml.includes('抽帧与匹配参数'))
  check('设置面板展示数据目录', settingsHtml.includes('数据目录') && settingsHtml.includes('AppData\\Roaming\\WhichVideo'))
  check('默认模式标注为"默认（用户目录）"', settingsHtml.includes('默认（用户目录）'))

  const portablePanelHtml = render(
    jsx(SettingsPanel, {
      settings: appSettings,
      dataDir: { dir: 'E:\\WhichVideo\\data', portable: true, source: 'portable-launcher', toolsReady: true },
      initialOpen: true,
      onChange: noop,
      onReset: noop,
      onOpenDatabaseFolder: noop
    })
  )
  check('便携模式在界面上标注出来', portablePanelHtml.includes('便携模式') && portablePanelHtml.includes('E:\\WhichVideo\\data'))
  check('提示可整目录拷走迁移', portablePanelHtml.includes('整个文件夹拷走'))
  check('提示可用环境变量指定位置', portablePanelHtml.includes('WHICHVIDEO_DATA_DIR'))

  /* ---------- 8. 纯函数 ---------- */
  check('formatDuration 处理时分秒', format.formatDuration(3725) === '1:02:05', format.formatDuration(3725))
  check('formatDuration 处理分秒', format.formatDuration(120) === '2:00', format.formatDuration(120))
  check('formatDuration 处理未知', format.formatDuration(null) === '未知')
  check('formatBytes 处理 MB', format.formatBytes(734003200) === '700 MB', format.formatBytes(734003200))
  check('formatBytes 处理 GB', format.formatBytes(1610612736) === '1.5 GB', format.formatBytes(1610612736))
  check('formatBytes 处理 0', format.formatBytes(0) === '0 B')
  check('formatPercent 取整', format.formatPercent(0.964) === '96%', format.formatPercent(0.964))
  check('shortPath 相对监听目录', format.shortPath(video.path, [folder.path]) === 'Blue.Intro.1080p.mp4')
  check('scoreLabel 分级', format.scoreLabel(0.95) === '几乎确定' && format.scoreLabel(0.7) === '弱匹配')
  check(
    'fileNameOf/dirNameOf',
    format.fileNameOf(video.path) === 'Blue.Intro.1080p.mp4' && format.dirNameOf(video.path) === 'E:\\Media\\Movies'
  )

  console.log(`\n=== 渲染端冒烟：${results.filter((r) => r.ok).length}/${results.length} 通过 ===`)
  if (failed) for (const r of results.filter((x) => !x.ok)) console.log(`  - 失败：${r.name} ${r.detail}`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('\n渲染端冒烟测试异常：', err)
  process.exit(1)
})
