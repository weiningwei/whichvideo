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
  const headerBase = {
    stats,
    status,
    tab: 'search',
    onTab: noop,
    onImportFiles: noop,
    onImportFolder: noop,
    busy: null
  }
  const headerHtml = render(jsx(Header, { ...headerBase, themeMode: 'dark', themeResolved: 'dark', onCycleTheme: noop }))
  // 顶栏左侧直接是页签，不放任何品牌标识。三级精简的结论：
  //  · 产品名 WhichVideo —— 窗口标题栏与任务栏已有
  //  · tagline「以图搜帧 本地视频库」—— 与页签语义重复
  //  · 字母标「WV」—— 只有内部才懂的缩写，陌生用户无联想，不传达信息
  check(
    '顶栏左侧无品牌标识（页签直接靠左）',
    !headerHtml.includes('WV') && !headerHtml.includes('WhichVideo'),
    '产品名与字母标都不在界内出现'
  )
  check(
    '品牌区不与页签语义重复（无 tagline）',
    !headerHtml.includes('以图搜帧') && !headerHtml.includes('本地视频库'),
    '「以图搜帧」与「图片搜索」页签不同时出现'
  )
  // 注意 render() 的产物以 <header> 开头，不能用 ^ 锚到 <div>；
  // 改为断言 header 标签之后紧跟的就是页签组（中间没有别的元素）。
  check(
    '页签组紧跟 <header>（中间无品牌元素）',
    /<header[^>]*>\s*<div class="flex items-center gap-1 rounded-xl/.test(headerHtml),
    '顶栏最左元素是页签组'
  )
  check('顶栏渲染统计（监听 1/1）', /1\/1/.test(headerHtml), headerHtml.match(/监听[\s\S]{0,40}/)?.[0] ?? '')
  check('顶栏渲染帧指纹数量', headerHtml.includes('16'))
  check('顶栏渲染导入按钮', headerHtml.includes('导入视频') && headerHtml.includes('导入文件夹'))

  // ---- 主题切换 ----
  check('顶栏有主题切换按钮', headerHtml.includes('切换主题') && /aria-label="切换主题"/.test(headerHtml))
  check(
    '顶栏有快捷键帮助入口（否则用户不知道 ? 能用）',
    headerHtml.includes('键盘快捷键') && /aria-label="键盘快捷键"/.test(headerHtml)
  )
  check(
    '深色模式按钮 title 说明当前档位',
    headerHtml.includes('主题：深色'),
    '三档循环：深色 → 浅色 → 跟随系统'
  )
  const lightHeaderHtml = render(
    jsx(Header, { ...headerBase, themeMode: 'light', themeResolved: 'light', onCycleTheme: noop })
  )
  check('浅色模式 title 正确', lightHeaderHtml.includes('主题：浅色'))
  const systemHeaderHtml = render(
    jsx(Header, { ...headerBase, themeMode: 'system', themeResolved: 'dark', onCycleTheme: noop })
  )
  check(
    '跟随系统会额外显示解析后的实际主题',
    systemHeaderHtml.includes('主题：跟随系统') && systemHeaderHtml.includes('当前深色'),
    '系统为深色时如实告知'
  )
  check(
    '三档图标各不相同（否则看不出当前在哪一档）',
    new Set(['◐', '◑', '◒']).size === 3 &&
      headerHtml.includes('◐') &&
      lightHeaderHtml.includes('◑') &&
      systemHeaderHtml.includes('◒'),
    '◐ 深色 / ◑ 浅色 / ◒ 跟随系统'
  )

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
    onSearchUrl: noop,
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

  // ---- 链接输入 ----
  check(
    '搜索页有链接输入框（占位文案说明支持网页）',
    emptyHtml.includes('粘贴图片链接或网页地址'),
    'placeholder 提示可贴图片或网页'
  )
  check('搜索页有「链接检索」按钮', emptyHtml.includes('链接检索'))
  check(
    '链接输入框初始为空且按钮禁用（无内容时不可提交）',
    emptyHtml.includes('粘贴图片链接或网页地址，回车检索（Ctrl+K 聚焦）') &&
      /<button[^>]*disabled[^>]*>\s*链接检索/.test(emptyHtml),
    '空链接时按钮 disabled'
  )
  check(
    '链接输入框在检索进行中禁用',
    /<input[^>]*placeholder="粘贴图片链接或网页地址[^>]*disabled/.test(emptyHtml) ||
      /<input[^>]*disabled[^>]*placeholder="粘贴图片链接或网页地址/.test(emptyHtml),
    '避免重复提交'
  )
  // 链接检索后：没有预览图（主进程不回字节），但要显示来源链接
  const urlHtml = render(
    jsx(SearchView, {
      ...searchBase,
      queryImage: null,
      queryLabel: 'https://cdn.example.com/poster.jpg',
      searching: false
    })
  )
  check(
    '链接检索后显示来源链接作为标题',
    urlHtml.includes('https://cdn.example.com/poster.jpg'),
    '顶部显示实际取图的地址'
  )
  check(
    '链接检索后左上角那格提示「来自链接」而非空白',
    urlHtml.includes('来自链接'),
    '没有预览图时给出占位说明'
  )
  // 失败提示
  const urlFailHtml = render(
    jsx(SearchView, {
      ...searchBase,
      searching: false,
      error: '这个网页里没找到图片（og:image 与 <img> 都没有）'
    })
  )
  check(
    '链接取图失败时把主进程给的原因原样显示',
    urlFailHtml.includes('这个网页里没找到图片'),
    '错误文案透出，不显示成 IPC 调用异常'
  )

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

  // 上面那份样本 selectedVideoIds 是空集，**永远走不到「选中」分支**，
  // 所以「选中时文件名染强调色」这条此前只有静态断言、没有被真实渲染验证过。
  // 这里补一份真的选中状态下的渲染，用正则数标题上的 text-accent 个数。
  {
    const two = [{ ...video, id: 1, name: 'Ep01.mkv' }, { ...video, id: 2, name: 'Ep02.mkv' }]
    const renderWith = (ids) =>
      render(
        jsx(LibraryView, {
          folders: [folder],
          videos: two,
          total: two.length,
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
          selectedVideoIds: new Set(ids),
          expandedFolderIds: emptyExpanded,
          isVideoSelected: (id) => ids.includes(id),
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
    // 标题行是 line-clamp-2 的那个 div。数它带不带 text-accent。
    // 选中时文件名要染强调色（用户要求"单选多选都要有明显提示"）；
    // 单选与多选走同一个 `selected` 条件，逐行同规则。
    const titleAccentCount = (html) =>
      (html.match(/line-clamp-2 break-all [^"]*text-accent/g) ?? []).length

    check(
      '单选时文件名变强调色（text-accent，明显提示）',
      titleAccentCount(renderWith([1])) === 1,
      `实际 ${titleAccentCount(renderWith([1]))} 处`
    )
    check(
      '多选时每行文件名同样变强调色（与单选一致，逐行同规则）',
      titleAccentCount(renderWith([1, 2])) === 2,
      `实际 ${titleAccentCount(renderWith([1, 2]))} 处`
    )
    const multiHtml = renderWith([1, 2])
    check(
      '多选时左侧蓝竖条仍在',
      (multiHtml.match(/absolute inset-y-0 left-0 w-\[2px\] bg-accent/g) ?? []).length === 2,
      '两行都有蓝竖条'
    )
    check(
      '多选时同样铺整行淡蓝底（与单选一致）',
      (multiHtml.match(/bg-row-selected/g) ?? []).length >= 4,
      `实际 ${(multiHtml.match(/bg-row-selected/g) ?? []).length} 处（每行选中产出 4 个，对应 4 列）`
    )
    // 核心断言：把单选与多选的渲染结果按"选中提示"维度逐项比对。
    // 每行选中时产出：竖条 1 个、bg-row-selected 3 个（三个 td 各一个）、
    // 标题 text-accent **1 个**、操作按钮 bg-surface-2 **4 个**（不透明底）。
    // 样本固定渲染 2 行视频，单选命中 1 行、多选命中 2 行，所以各项应恰好翻倍。
    const countOf = (html, re) => (html.match(re) ?? []).length
    const BAR = /absolute inset-y-0 left-0 w-\[2px\] bg-accent/g
    const ROW_BG = /bg-row-selected/g
    const TITLE_ACCENT = /line-clamp-2 break-all [^"]*text-accent/g
    const BTN_OPAQUE = /bg-surface-2/g
    const one = renderWith([1])
    const both = renderWith([1, 2])
    // 依次为：竖条 / 行底色 / 标题染色（选中即 1）/ 按钮不透明底
    const single = [
      countOf(one, BAR),
      countOf(one, ROW_BG),
      countOf(one, TITLE_ACCENT),
      countOf(one, BTN_OPAQUE)
    ]
    const multi = [
      countOf(both, BAR),
      countOf(both, ROW_BG),
      countOf(both, TITLE_ACCENT),
      countOf(both, BTN_OPAQUE)
    ]
    check(
      '单选 1 行 → 竖条 1、淡蓝底 4（4 列各一）、标题染色 1、按钮不透明底 4',
      single[0] === 1 && single[1] === 4 && single[2] === 1 && single[3] === 4,
      `实际 ${single.join('/')}`
    )
    check(
      '多选 2 行 → 四项都与单选成比例（选中提示完全统一）',
      multi.every((n, i) => n === single[i] * 2),
      `期望 ${single.map((n) => n * 2).join('/')}，实际 ${multi.join('/')}`
    )
    // 按钮的不透明底是防透色用的：btn-bg 半透明，不覆盖的话淡蓝底会透上来
    // 把按钮连边框染蓝，看着像"按钮被激活了"。
    check(
      '选中行的操作按钮用了不透明底色（阻止行底色透上来染蓝）',
      single[3] === 4,
      `实际 ${single[3]} 个（应为每行 4 个按钮）`
    )
  }
  // 表格 4 列（视频 / 状态 / 采样 / 操作），元信息合并进视频列第二行。
  // 状态列仍需禁止换行：中文可逐字断行，列被压窄会竖排成多行。
  // align-top 是配套的——文件名可占两行，状态徽标要与其顶端对齐而不是被拉高中间。
  check(
    '状态列禁止换行且顶端对齐（中文可逐字断行；文件名两行时不居中）',
    /<td class="whitespace-nowrap px-2 py-1\.5 align-top[^"]*"><span[^>]*>已索引<\/span><\/td>/.test(libraryHtml),
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
    '表格 4 列（视频 / 状态 / 采样 / 操作，「选择」列已移除）',
    /视频<\/th>[\s\S]*?状态<\/th>[\s\S]*?操作<\/th>/.test(libraryHtml) &&
      !/<th[^>]*>\s*<input[^>]*checkbox/.test(libraryHtml),
    (libraryHtml.match(/<th[^>]*>(?:(?!<\/th>)[\s\S])*?<\/th>/g) ?? []).length + ' 个表头，无全选框'
  )
  // 选中态改为左侧竖条提示。竖条只在 isVideoSelected 为真时渲染，而 mock 的
  // selectedVideoIds 是空集，SSR 走不到该分支，故静态检查源码。
  // 视频行与光标逻辑已拆到 VideoRow.tsx / useVideoCursor.ts：按合并源码查，
  // 检查范围与拆分前（单文件时代）完全一致。
  {
    const src = [
      readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'LibraryView.tsx'), 'utf8'),
      readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'VideoRow.tsx'), 'utf8'),
      readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useVideoCursor.ts'), 'utf8'),
      readFileSync(join(root, 'src', 'renderer', 'src', 'lib', 'selection.ts'), 'utf8')
    ].join('\n')
    check(
      '选中提示用左侧竖条（绝对定位，不占列宽）',
      src.includes('w-[2px] bg-accent') && src.includes('absolute inset-y-0 left-0'),
      '2px accent 竖条'
    )
    check(
      '整行可点击切换选中（操作列 stopPropagation 避免误触）',
      src.includes('cursor-pointer border-b border-line/40') &&
        src.includes('onRowClick={(shiftKey, ctrlKey) => handleRowClick(video.id, shiftKey, ctrlKey)}'),
      '点击整行即切换'
    )
    // 拦原生文本选中只能拦"带修饰键的按下"这一档。整行 select-none 虽然也关掉了
    // Shift 的蓝底，但把文件名的双击/拖选复制一起干掉了（用户反馈"文件名的选中
    // 效果也没有了"）。修饰键是行多选专用，普通点击必须保持可选中文本。
    check(
      '只拦带修饰键的按下（普通点击仍可选中文件名复制）',
      src.includes('const blockModifierTextSelection = (e: MouseEvent) =>') &&
        src.includes("if (e.shiftKey || e.ctrlKey || e.metaKey)") &&
        src.includes('window.getSelection()?.removeAllRanges()') &&
        (src.match(/onMouseDown=\{blockModifierTextSelection\}/g) ?? []).length === 3 &&
        !src.includes('border-b border-line/40 select-none'),
      '视频行/分组标题/表头三处都接了，select-none 已移除'
    )
    // 点击必须同时移动光标。上一版只把方向键打通了、忘了点击这条路，
    // 于是点第三个视频再按 ↑ 会从初始位置（第一个）起算 —— 又跳回第一个。
    check(
      '点击整行会同步移动光标（不只是改选中）',
      /const handleRowClick = \(videoId: number/.test(src) &&
        /setFocusedIndex\(index\)/.test(src) &&
        /focusRow = \(index: number\)/.test(src) &&
        /focusRow\(index\)/.test(src),
      'focusRow 里 setFocusedIndex + 改选中'
    )
    check(
      '点击按 videoId 反查行下标（不靠 map 位置参数算偏移）',
      src.includes('navigableItems.findIndex((it) => it.type === \'video\'') &&
        src.includes('handleRowClick(video.id'),
      'findIndex 反查，分组视图下偏移量不会算错'
    )
    check(
      '分组标题选中态也改为竖条（不再是复选框）',
      src.includes("groupSelected ? 'bg-accent'") && src.includes('groupPartial'),
      '全选 / 部分选中两态'
    )
    // 分组标题的点击热区职责划分：名字管展开收起，竖条管全选。
    // 此前名字被"全选该组"占用，只能点小三角展开，不符合直觉（用户反馈）。
    check(
      '分组标题：竖条是全选入口，且有足够大的点击热区',
      src.includes('全选该组') && /-m-1 flex h-5 w-3[^\n]*cursor-pointer/.test(src) &&
        src.includes('role="checkbox"'),
      '视觉 2px、点击区 12px'
    )
    check(
      '分组标题：展开/收起绑在名字那一整块上（不是只有小三角）',
      /onClick=\{\(\) => toggleFolderExpanded\(folderId\)\}[\s\S]{0,400}?展开该目录/.test(src) ||
        /展开该目录[\s\S]{0,400}?onClick=\{\(\) => toggleFolderExpanded\(folderId\)\}/.test(src),
      '点名字、点视频数、点空白都可展开收起'
    )
    check(
      '展开热区包住三角 + 名字 + 视频数（flex-1）',
      src.includes('flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2'),
      '热区连续，不留死区'
    )
    check(
      '全选与展开是两个独立元素，不会互相抢点击',
      !/onClick=\{toggleGroup\}[\s\S]{0,300}?\{displayName\}/.test(src),
      'toggleGroup 的元素内不含 displayName'
    )
    // 分组标题不再有键盘焦点态：↑↓ 只在视频行间移动，光标不会停在标题上。
    // 反过来断言「headerFocused 已彻底删除」——留着那个条件只会误导后来人
    // 以为标题能被键盘选中。剥掉注释再匹配：注释里为了说明历史会提到这两个名字。
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    check(
      '分组标题没有键盘焦点态（↑↓ 跳过分组标题）',
      !codeOnly.includes('headerFocused') && !codeOnly.includes('groupIdx'),
      'headerFocused / groupIdx 已从代码中移除'
    )
    check(
      '方向键在只含视频行的下标列表上移动（跳过分组标题）',
      src.includes('videoRowIndexes') && src.includes("if (item.type === 'video') acc.push(i)"),
      'videoRowIndexes 只收视频行'
    )
    check(
      '分组焦点用下标直取，不做 findIndex 遍历',
      src.includes('focusedIndex === groupIdx') && !/focusedIndex === navigableItems\.findIndex/.test(src),
      'navigableItems 与 groupedVideos 同序遍历，下标直接对应'
    )
    const codeNoComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    check(
      '移除复选框后不再需要 indeterminate 同步副作用',
      !codeNoComments.includes('indeterminate') && !codeNoComments.includes('selectAllRef'),
      '已清理表头/分组复选框的 indeterminate 逻辑'
    )

    // ---- 键盘导航 ----
    check(
      '焦点以 video.id 派生（focusedVideoId）',
      src.includes('const focusedVideoId = useMemo') &&
        src.includes('focused={focusedVideoId === video.id}'),
      '渲染时直接比 id，不按下标反查'
    )
    check(
      '焦点移动时自动滚进可视区',
      src.includes('scrollRef') && src.includes('querySelector<HTMLElement>') &&
        src.includes('data-video-id=') && src.includes('box.scrollTop'),
      '按 [data-video-id] 定位后调整 scrollTop'
    )
    check(
      '键盘焦点有独立视觉提示（淡灰竖条 + 稍亮底色，与选中蓝条区分）',
      src.includes('w-[2px] bg-disabled/60') && src.includes('bg-row-focus'),
      '焦点灰条 / 选中蓝条'
    )
    check(
      '工具条提示键盘快捷键',
      libraryHtml.includes('↑↓ 移动 · Enter 选中'),
      'lg 以上显示'
    )
  }
  // 目录不再重复显示文件名：可见文本里文件名只该出现一次（title 属性不计）
  const visibleText = libraryHtml.replace(/\stitle="[^"]*"/g, '')
  check(
    '目录不再重复显示文件名（可见文本里文件名只出现一次）',
    (visibleText.match(/Blue\.Intro\.1080p\.mp4/g) ?? []).length === 1,
    `可见文本中出现 ${(visibleText.match(/Blue\.Intro\.1080p\.mp4/g) ?? []).length} 次（应为 1）`
  )
  // ---- 操作列：四个按钮全部平铺，文字精简到 2 字 ----
  check(
    '操作列四个按钮全部平铺显示',
    ['播放', '定位', '索引', '移除'].every((t) => libraryHtml.includes(`>${t}</button>`)),
    '播放 / 定位 / 索引 / 移除'
  )
  check(
    '不再有「更多」菜单（⋯ 触发器与浮层都已移除）',
    !libraryHtml.includes('⋯') && !libraryHtml.includes('aria-haspopup="menu"') &&
      !libraryHtml.includes('absolute right-0 top-full'),
    'RowMenu 组件已删除'
  )
  {
    const src = [
      readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'LibraryView.tsx'), 'utf8'),
      readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'VideoRow.tsx'), 'utf8'),
      readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useVideoCursor.ts'), 'utf8'),
      readFileSync(join(root, 'src', 'renderer', 'src', 'lib', 'selection.ts'), 'utf8')
    ].join('\n')
    const codeNoComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    check(
      'RowMenu 组件已彻底移除（含外部点击/Esc 关闭逻辑）',
      !codeNoComments.includes('function RowMenu') &&
        !codeNoComments.includes("addEventListener('mousedown'"),
      '不再有菜单状态与关闭逻辑'
    )
    // 按钮内边距收到 px-1.5 才有宽度预算容纳四个 2 字按钮（合计约 156px）
    const btnCount = (codeNoComments.match(/btn px-1\.5 py-0\.5 text-\[11px\]/g) ?? []).length
    check(
      '操作按钮内边距收紧到 px-1.5（容纳四个 2 字按钮）',
      btnCount === 3 && codeNoComments.includes('btn-danger px-1.5 py-0.5 text-[11px]'),
      `3 个普通按钮 + 1 个危险按钮，均为 px-1.5`
    )
    check(
      '每个操作按钮都有 title 说明完整语义',
      src.includes('在资源管理器中定位该文件') &&
        src.includes('重新抽帧并重建指纹') &&
        src.includes('只从索引库移除记录，不会删除磁盘文件'),
      '精简文字后靠 title 保留完整含义'
    )
    check(
      '操作列宽度已相应放宽到 180px',
      src.includes('w-[180px]') && src.includes('min-w-[480px]'),
      '列宽 180px，表格 min-w 480px'
    )

    // 操作列吸附右侧：窗口窄到表格要横向滚动时，四个按钮仍必须看得见、点得到。
    // 这类问题 ui-smoke 的静态检查容易漏，所以逐条钉住关键前提。
    check(
      '操作列吸附在右侧（横向滚动时按钮不被推出视野）',
      /<th[^>]*sticky right-0[^>]*w-\[180px\]/.test(libraryHtml) &&
        /<td[^>]*sticky right-0[^>]*border-l/.test(libraryHtml),
      '表头与数据格都带 sticky right-0'
    )
    // 吸附列的底色必须不透明，否则左侧滚过来的内容会透上来叠在按钮上。
    // 实现上不是「给 td 加不透明色 + 内层覆盖层」（absolute 在表格布局里不可靠），
    // 而是改用预先混好的 row-* 实色——两个断言各守一半，都必要。
    check(
      '吸附列底色用的是不透明实色（不是 bg-accent/12 这类半透明叠色）',
      src.includes('const rowBg =') &&
        src.includes("'bg-row-selected'") &&
        src.includes("'bg-row-focus'") &&
        !/sticky right-0[^`]*bg-accent\//.test(src),
      'rowBg 走 row-* token，吸附格不再直接挂半透明色'
    )
    check(
      'row-* 三个色值在深浅两套主题里都定义（预混不透明色）',
      (() => {
        const css = readFileSync(join(root, 'src', 'renderer', 'src', 'index.css'), 'utf8')
        return (
          css.includes('--color-row-selected') &&
          css.includes('--color-row-focus') &&
          css.includes('--color-row-hover') &&
          (css.split("[data-theme='light']")[1] ?? '').includes('--color-row-selected')
        )
      })(),
      '深浅两侧齐备'
    )
    check(
      '行底色落在每个 td 上而不是 tr（否则吸附格与半透明 tr 背景叠出色差）',
      src.includes('const rowBg =') && !/className={`group cursor-pointer[^`]*\$\{rowBg\}/.test(src),
      'rowBg 只用于 td'
    )
    check(
      '分组标题行拆成两格（colSpan 会盖住吸附列、让分隔线断开）',
      src.includes('colSpan={2}') && !src.includes('colSpan={3}'),
      '标题格 colSpan=2 + 空采样格 + 空吸附格（共 4 列对齐）'
    )

    // 分组标题行的吸附格同样要实色——它也是 sticky，标题行滚动时会浮起来
    check(
      '分组标题行的吸附格也是实色（不挂半透明色）',
      /<td className="sticky right-0[^"]*bg-row-group"/.test(libraryHtml) ||
        /<td className="sticky right-0[^"]*bg-row-group/.test(src),
      'bg-row-group'
    )

    // 文件名多行：单行 truncate 时长片名（[1080p][x264] 那种）看不出是什么剧，
    // 而横向滚动才能看全名很反直觉。
    check(
      '文件名最多两行显示（line-clamp-2 + break-all）',
      src.includes('line-clamp-2') && src.includes('break-all'),
      '超长片名换行而非截断'
    )
    check(
      '元信息行保持单行（目录路径重复前缀多，展开反而更吵）',
      /<div className="truncate text-\[10\.5px\] text-muted"/.test(src),
      '第二行仍 truncate'
    )

    // 选中提示**单选多选完全一致**：蓝竖条 + 淡蓝底 + 文件名染强调色。
    // 曾按 selectedCount 分过两档（多选只留竖条），想"少即是多"，实际破坏了
    // 风格统一 —— 同一个交互在两种状态下长得不一样，用户得先判断自己在哪种状态。
    // 文件名染色也走同一个 `selected` 条件（用户要求明显提示），不引入分档变量。
    check(
      '选中时文件名染强调色，且与单选/多选共用同一个 selected 条件',
      /line-clamp-2 break-all \$\{selected \? 'text-accent' : 'text-primary'\}/.test(src),
      '标题条件染色，不分档'
    )
    check(
      '选中行的操作按钮用不透明底色（否则半透明 btn-bg 会透出行底色）',
      /btn px-1\.5 py-0\.5 text-\[11px\] hover:bg-ink-700\/70 \$\{selected \? 'bg-surface-2 text-white' : ''\}/.test(src) &&
        (src.match(/bg-surface-2/g) ?? []).length === 4,
      '四个按钮都加了（播放/定位/索引/移除）'
    )
    check(
      'rowBg 直接用 selected（没有 singleSelected 之类的中间变量）',
      /const rowBg = selected\s*\n(\s*)\? 'bg-row-selected'/.test(src) && !src.includes('singleSelected'),
      '选中即铺底色'
    )
    // 反向守护：别把 selectedCount 之类的分档变量加回来。
    // 它看起来很有用（"要不要强调当前项"），但会让单选与多选长得不一样。
    check(
      '没有引入按选中数量分档的变量（避免单选多选长得不一样）',
      !/selectedCount|singleSelected|isMultiSelect/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
      '源码里（剥掉注释后）不应出现分档变量'
    )
    // 工具条布局必须与选中状态无关：按钮区独立 shrink-0 分区（左侧筛选区怎么
    // 换行都影响不到它），「已选」计数 invisible 常驻占位（行宽不随选中变化）。
    // 否则选中一个视频，「已选 N」一出现就把按钮组挤到第二行 —— 用户反馈过。
    check(
      '工具条：按钮区独立 shrink-0，选中计数 invisible 常驻占位（选中不改布局）',
      src.includes('flex min-w-0 flex-1 flex-wrap items-center gap-2') &&
        src.includes('flex shrink-0 items-center gap-2') &&
        /selectedVideoIds\.size > 0 \? 'text-tertiary' : 'invisible'/.test(src) &&
        !src.includes('ml-auto flex gap-2'),
      '筛选区自己换行、按钮区不换行、计数不条件渲染'
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
      onChange: noop,
      onReset: noop,
      onOpenDatabaseFolder: noop
    })
  )
  // 参数一律直接展开：不再有「展开 / 收起」二级操作，滑块与开关应直接可见
  check('设置面板不再有「展开 / 收起」按钮', !settingsHtml.includes('收起') && !settingsHtml.includes('展开'))
  check(
    '五个参数滑块默认全部可见（无需点击展开）',
    ['每个视频抽帧数', '并发解码数', '匹配阈值', '最多返回结果', '新文件稳定等待'].every(
      (label) => settingsHtml.includes(label)
    ),
    '抽帧数 / 并发 / 阈值 / 结果数 / 稳定等待'
  )
  check(
    '参数滑块渲染为 range 输入',
    (settingsHtml.match(/type="range"/g) ?? []).length === 5,
    `${(settingsHtml.match(/type="range"/g) ?? []).length} 个滑块`
  )
  check('删除时自动移除的开关也直接可见', settingsHtml.includes('文件被删除时自动从库中移除'))
  check(
    '危险操作与说明直接可见（无需展开）',
    settingsHtml.includes('清空索引库') &&
      settingsHtml.includes('不会动你的视频文件') &&
      settingsHtml.includes('打开索引库位置'),
    '清空 / 说明 / 打开位置都在首屏'
  )
  check('设置面板展示数据目录', settingsHtml.includes('数据目录') && settingsHtml.includes('AppData\\Roaming\\WhichVideo'))
  check('默认模式标注为"默认（用户目录）"', settingsHtml.includes('默认（用户目录）'))

  const portablePanelHtml = render(
    jsx(SettingsPanel, {
      settings: appSettings,
      dataDir: { dir: 'E:\\WhichVideo\\data', portable: true, source: 'portable-launcher', toolsReady: true },
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

  console.log('\n=== 8. 快捷键 ===')
  {
    const lib = [
      readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'LibraryView.tsx'), 'utf8'),
      readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'VideoRow.tsx'), 'utf8'),
      readFileSync(join(root, 'src', 'renderer', 'src', 'hooks', 'useVideoCursor.ts'), 'utf8'),
      readFileSync(join(root, 'src', 'renderer', 'src', 'lib', 'selection.ts'), 'utf8'),
      readFileSync(join(root, 'src', 'renderer', 'src', 'constants.ts'), 'utf8')
    ].join('\n')
    const app = readFileSync(join(root, 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
    const sc = readFileSync(join(root, 'src', 'renderer', 'src', 'lib', 'shortcuts.ts'), 'utf8')

    // 键位声明集中在 shortcuts.ts，帮助面板从它生成 —— 不再散落在各组件
    // 通知分流：状态栏只承载 info，warn/error 固定在右下角浮层 ——
    // 否则同一条提示随新通知插入在两处之间"搬家"，位置不可预期
    check(
      '状态栏通知只取 info（warn/error 不占状态栏）',
      app.includes("state.notices.find((n) => n.level === 'info')") &&
        !app.includes('notice={state.notices[0]')
    )
    check(
      '右下角浮层排除状态栏那条（warn/error 全量进入）',
      app.includes('floating') && app.includes('n.id !== barNotice?.id')
    )

    check(
      '浮层用 flex-col-reverse（新通知在底部、旧的向上累积）',
      app.includes('flex-col-reverse') && !/flex w-\[360px\] flex-col gap-2/.test(app),
      '避免最新那条插到最上面第 1 位'
    )

    // 通知定时自动关闭：TTL 表三级齐全 + 悬停暂停挂钩 + 严格模式安全
    const noticesSrc = readFileSync(
      join(root, 'src', 'renderer', 'src', 'hooks', 'useNotices.ts'),
      'utf8'
    )
    check(
      '通知 TTL 按级别配置（info/warn/error 三级齐全）',
      noticesSrc.includes('export const NOTICE_TTL') &&
        /info: \d+/.test(noticesSrc) &&
        /warn: \d+/.test(noticesSrc) &&
        /error: \d+/.test(noticesSrc)
    )
    check(
      '推送时按级别调度自动关闭',
      noticesSrc.includes('schedule(next.id, NOTICE_TTL[level])')
    )
    check(
      'notice 构造在 setNotices updater 之外（严格模式不双执行副作用）',
      /const next: Notice = \{ id: \+\+noticeSeq/.test(noticesSrc)
    )
    check(
      '浮层条目悬停暂停、移开恢复倒计时',
      app.includes('onMouseEnter={() => pauseNotice(notice.id)}') &&
        app.includes('onMouseLeave={() => resumeNotice(notice.id)}')
    )

    // 进度条按阶段区分：场景采样多一段「检测」
    check(
      '进度条区分场景检测与抽帧两阶段',
      lib.includes("frameProgress.phase === 'detecting'") && lib.includes('场景检测'),
      '检测阶段不显示的话长视频索引期间界面像卡死'
    )
    check(
      '检测时长未知时显示不定态（不报假百分比）',
      lib.includes('分析中') && lib.includes('pct === null'),
      '时长探测失败时 total=0'
    )

    check(
      '徽标只表达状态（「索引中」），阶段交给进度条标签（不再两处重复）',
      !lib.includes('场景检测中') && lib.includes("'场景检测 1/2'"),
      '用户实测"场景检测出现两次"：徽标与标签都在说阶段'
    )
    // 阶段标签：两个阶段各有身份（检测=琥珀 / 抽帧=蓝）+ 场景采样标阶段序号
    check(
      '两阶段各有常驻标签与配色（检测=琥珀 / 抽帧=蓝）',
      lib.includes("'场景检测 1/2'") && lib.includes("detecting ? 'bg-warn' : 'bg-accent'"),
      '只靠文案区分太弱，阶段切换用户看不出是另一段进度'
    )
    check(
      '场景采样标阶段序号（1/2、2/2），均匀采样不标',
      lib.includes('twoPhase') && lib.includes("'抽帧 2/2'") && lib.includes(": '抽帧'"),
      '实测：检测 79% → 抽帧 0/18，不标序号会被误读为进度回退'
    )
    check(
      '进度数字只出现一次，且不压在进度条上（条会变色，压字看不清）',
      lib.includes('const countText') &&
        !lib.includes('text-[8px] text-primary') &&
        lib.includes('ml-auto text-[10px] leading-tight text-primary'),
      '数字移出条内：条随阶段变色（琥珀/蓝），压字对比度不稳'
    )
    check(
      '进度条独占一行并占满列宽（不被标签挤窄）',
      lib.includes('h-2 rounded-full overflow-hidden bg-line') &&
        !lib.includes('h-2.5 flex-1 rounded-full'),
      '标签与条并排时条只剩几十像素'
    )
    check(
      '冗余时长信息收进 hover title（不占视觉）',
      lib.includes('title={hint}') && lib.includes('已用 ') && lib.includes('剩余 '),
      '已用/剩余保留在 title 里可查，但不重复占版面'
    )



    check('有集中的快捷键定义', sc.includes('export const SHORTCUTS'))
    check('帮助面板按 group 聚合', sc.includes('export function groupShortcuts'))
    check('平台适配（Mac 显示 ⌘/⇧/⌥）', sc.includes("k === 'Ctrl'") && sc.includes('isMac'))

    // 列表导航：翻页与跳到首尾是新增的
    for (const k of ['PageDown', 'PageUp', 'Home', 'End']) {
      check(`支持 ${k}`, lib.includes(`case '${k}':`))
    }
    check('PageUp/PageDown 一次翻 PAGE_JUMP 行', lib.includes('const PAGE_JUMP'))
    check(
      '跳转会夹紧到合法范围',
      lib.includes('Math.max(0, Math.min(videoRowIndexes.length - 1'),
      '夹紧到视频行数而非 navigableItems 长度'
    )

    // 光标与选中必须合一：方向键移动时同步改选中，否则「按方向键切换」看起来毫无反应。
    // 这是本项目最容易反复的问题——两套独立 state 写起来很自然，用起来却不跟手。
    check(
      '方向键移动光标时同步单选（光标与选中是同一个东西）',
      lib.includes('moveCursor') &&
        /moveCursor = \(delta: number, rangeKey: boolean, ctrlKey: boolean\)/.test(lib) &&
        lib.includes('toggleVideoSelection(item.video.id, rangeKey, false)'),
      'moveCursor 里调 toggleVideoSelection'
    )
    check(
      'Shift+方向键连选 / Ctrl+方向键只移光标',
      lib.includes('moveCursor(1, e.shiftKey, mod)') && lib.includes('moveCursor(-1, e.shiftKey, mod)'),
      '修饰键透传给 moveCursor'
    )
    check(
      'Ctrl+方向键不改动选中区',
      /if \(ctrlKey\) return/.test(lib),
      'ctrlKey 时提前返回'
    )
    check(
      '分组视图下方向键跳过标题（↑↓ 只在视频行间走）',
      lib.includes('const videoRowIndexes = useMemo') && lib.includes('const focusedRowPos'),
      'videoRowIndexes / focusedRowPos'
    )
    check(
      '←→ 作用于光标所在视频的分组',
      lib.includes('const focusedFolderId = useMemo') &&
        lib.includes('expandedFolderIds.has(focusedFolderId)'),
      '从光标视频反查 folderId，不再等「光标在标题上」'
    )

    // 操作键
    check('Delete 可移除（不删磁盘文件）', lib.includes("case 'Delete':"))
    check('多选删除有二次确认', lib.includes('window.confirm'))
    check('确认文案说明不删磁盘文件', lib.includes('不会删除磁盘文件'))
    check('Enter 播放（选中优先，否则焦点处）', lib.includes('const target = getTargetVideo()'))
    check('Space 只做选中切换不播放', /case ' ':[\s\S]{0,200}?toggleFocusedSelection/.test(lib))
    check('Ctrl+L 定位文件', lib.includes("case 'l':"))
    check('Ctrl+R 重建索引', lib.includes("case 'r':"))

    // 发现性
    check('筛选框 placeholder 提示了 / 键', lib.includes('（/ 聚焦）'))
    check('筛选框有 ref 供 / 聚焦', lib.includes('filterInputRef.current?.focus()'))
    check('? 打开帮助面板', app.includes("case '?':"))
    check('1/2 切换页签', app.includes("case '1':") && app.includes("case '2':"))
    check('帮助面板打开时不响应其他全局键', app.includes('if (helpOpen) return'))
    check('输入框内不抢键', app.includes('HTMLInputElement'))

    // G 键不能被两个组件同时处理
    check('G 键只由 LibraryView 处理', lib.includes("case 'g':") && !/e\.key === 'g'/.test(app))

    // 帮助面板写"能按"但实际按不了，是最糟的情况 —— 逐条核对声明与实现。
    // 这里只查"单键且非组合键"的声明（组合键与页面态相关的另行处理）。
    const singleKeyDecls = [...sc.matchAll(/\{\s*group:\s*'[^']+',\s*keys:\s*'([A-Za-z?/])'/g)].map((m) => m[1])
    const search = readFileSync(join(root, 'src', 'renderer', 'src', 'components', 'SearchView.tsx'), 'utf8')
    const notImplemented = singleKeyDecls.filter((k) => {
      const esc = k.replace(/[?/]/g, '\\$&')
      return !new RegExp(`case '${esc}'`).test(lib) && !new RegExp(`case '${esc}'`).test(app) &&
        !new RegExp(`e\\.key === '${esc}'`).test(app) && !new RegExp(`e\\.key === '${esc}'`).test(search)
    })
    check(
      `单键快捷键声明与实现一致（${singleKeyDecls.length} 个单键）`,
      notImplemented.length === 0,
      notImplemented.length ? `声明了但没实现：${notImplemented.join(', ')}` : singleKeyDecls.join(' ')
    )
    check(
      'B 键触发重建全部索引（原先文档写了但没实现）',
      lib.includes("case 'b':") && sc.includes("keys: 'B'")
    )
    check(
      'Ctrl+K 聚焦链接输入框',
      search.includes("e.key === 'k'") && sc.includes('Ctrl+K')
    )
  }

  console.log(`\n=== 渲染端冒烟：${results.filter((r) => r.ok).length}/${results.length} 通过 ===`)
  if (failed) for (const r of results.filter((x) => !x.ok)) console.log(`  - 失败：${r.name} ${r.detail}`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('\n渲染端冒烟测试异常：', err)
  process.exit(1)
})
