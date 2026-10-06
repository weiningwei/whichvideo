# AGENTS.md — WhichVideo 开发指引

> Electron + electron-vite + React 19 + Tailwind v4 本地视频库（以图搜帧）。
> 主进程产物 **CommonJS** (`out/main/index.js`)；渲染端 React。包管理 **pnpm**，Node ≥ 22。

---

## ⚡ 铁律：从仓库根目录执行

`electron.vite.config.ts` 用 `process.cwd()` 解析路径并校验 `src/main/index.ts` 存在。**换目录执行直接抛错**。所有 `pnpm` 脚本假定 CWD = 仓库根。

---

## 📋 常用命令

```bash
pnpm dev              # electron-vite dev（渲染端热更新）
pnpm typecheck        # node + web 两套 tsc，无产物
pnpm test             # 19 套自检按序跑（见下「测试」）
pnpm build            # typecheck + electron-vite build + icon → out/
pnpm build:portable   # build + scripts/build-portable-folder.mjs → release/WhichVideo-portable/
pnpm build:win        # build + electron-builder --win → NSIS 安装包 + win-unpacked/
pnpm build:unpack     # build + electron-builder --win dir
pnpm fetch:ffmpeg     # 下载 ffmpeg/ffprobe 到 resources/bin（建索引需要；缺失可跑、不建索引）
```

**构建顺序固定**：`typecheck` 通过 → `electron-vite build`；`build:portable`/`build:win` 已含 `build`，不要单独跑。提交前至少跑 `pnpm typecheck`。

---

## 🔧 关键约束（改动易踩）

| 约束 | 细节 | 验证 |
|------|------|------|
| **禁用 `__dirname` / `import.meta.dirname`** | electron-vite 按 `package.json#type` 决定 ESM/CJS，二者混用加载失败。`@shared` 需在 main/preload/renderer **各自**声明 alias；`@renderer` 只在 renderer 段。 | `pnpm test:config` |
| **better-sqlite3 用 Node-API 预编译** | `electron-builder.yml: npmRebuild: false` 故意关闭 `@electron/rebuild`（沙箱易 `spawn EPERM`）。需重建跑 `pnpm rebuild:native`。 | — |
| **主进程惰性 `require` 加载核心模块** | `loadCoreModules()` 捕获原生模块加载失败落日志。**别改顶层 ESM import**。配套两件事不可动：① `mainEntries()` 扫描 `src/main` 自动生成入口（曾手写漏文件），② `preserveModules: true`（多入口时 Rollup 复制共享模块会导致 `logger.ts` 模块级缓冲状态分裂、早期日志丢失）。 | `pnpm test:output` |
| **`package.json` 禁 `"type": "module"`** | Electron 会把 CJS 主进程当 ESM 加载，首行抛错 → 无窗口无日志。 | `pnpm test:startup` 场景 0 |
| **`.gitignore` Python 规则锚定根目录** | 必须以 `/` 开头（如 `/lib/`），否则误伤 `src/renderer/src/lib/`。 | — |

---

## 📦 打包/启动类坑

**唯一归属 `docs/troubleshooting.md`**，本文件不复制。要点：

- 双击 exe 无反应 → 看 `<数据目录>\whichvideo.log`；无日志 → 看退出码（`0x80000003` = 环境类崩溃）
- `pnpm test:startup`（40 项）覆盖启动链路；环境判定跑 `node scripts/probe-electron-startup.mjs`
- EPERM 占用排查：`node scripts/build-portable-folder.mjs --who-locks <目录>`

---

## 🏗️ 打包实现约束（仅仓库侧）

- `build:portable` 产出两份：仓库内 `release\WhichVideo-portable\` + **仓库上一级**同名文件夹（用户双击版）。外层失败不判死整体打包，仅报错提示手动拷走。
- 外层**保留 `data\`**：`copyOutsideRepository` 先 `renameSync` 挪到 `.data-keep-<ts>`，替换后挪回。校验文件数/字节数用 `countFiles(dir, excludeDirName)` / `directorySize(...)` 排除 `data\`。挪不动退回删除并如实输出。环境变量 `WHICHVIDEO_OUTSIDE_DIR` 指定落点，`WHICHVIDEO_SKIP_OUTSIDE_COPY=1` 跳过（`test:pack` 用）。

### 路径可见性表（别搞反）

| 去处 | 路径 | 理由 |
|------|------|------|
| 终端输出 (`console.log/error`) | **绝对路径** | 开发者看、贴 issue |
| `便携版说明.txt`（随产品） | **相对描述** | 用户看、不该泄构建机结构 |
| README / docs / 注释 | **相对路径** | 公开流传、换机器对不上 |
| `WHICHVIDEO_TEST_REPORT` 字段 | **绝对路径** | 自检靠 `startsWith`/`join` 判定 |

`test:pack` 场景 5c 断言：说明文件/文档无泄漏，终端输出**保留**绝对路径。

> `.vscode/settings.json` **故意入库**（排除 `release`/`out*`/`tmp` 文件监视），**不要删或还原**。

---

## 📂 数据目录判定

优先级（`src/main/datadir.ts`，有独立测试）：

`WHICHVIDEO_DATA_DIR` → 便携启动器注入 `PORTABLE_EXECUTABLE_DIR\data` → exe 同级 `data\`（可写时） → 默认 `userData`。索引库 `whichvideo.db`（SQLite WAL）、日志 `whichvideo.log`、Chromium 缓存 `session\` 均在数据目录。只读位置（如 `Program Files`）回退 `%APPDATA%\WhichVideo`。

---

## 🧪 测试（19 套，顺序固定）

```bash
pnpm test
# test:config → test:output → test:frames → test:hash → test:path → test:url
# → test:icon → test:theme → test:network → test:cursor → test:range
# → test:url（再次） → test:scale → test:startup → test:core → test:portable
# → test:clipboard → test:pack → test:asar → test:ui → test:events
```

| 套件 | 守护内容 | 改相关代码前必跑 |
|------|----------|------------------|
| `test:config` | vite 别名、入口扫描 | `electron.vite.config.ts` |
| `test:output` | 编译产物 `require('./x')` 对应文件存在 | 新增 `src/main/*.ts` |
| `test:hash` | 结构指纹等距抽样、覆盖 16 行 | `hash.ts` 网格/抽样 |
| `test:path` | `shortDir` 不含文件名、根目录不截断 | `format.ts` 路径处理 |
| `test:url` | 网页主图解析 + 协议校验 | `main/url-image.ts` |
| `test:icon` | ICO 结构/7 尺寸、build/out 同步、favicon 同源、三处接线 | 图形/图标接线 |
| `test:network` | 除 `url-image.ts` 外零联网、9 核心模块零联网、CSP 无 connect-src 放宽 | 引入联网能力前 |
| `test:cursor` | 光标算法行为（28 项）：移动/单选跟随、Ctrl 只移光标、分组跳过标题、点击行后光标同步 | `LibraryView` 光标/选中 |
| `test:range` | 连选行为（24 项）：Shift 累积、Ctrl 点选、clearSelection 清锚点、静态守卫锚点用 ref | 连选逻辑 |
| `test:theme` | 组件无十六进制/内置色、语义 token 双侧齐全 | tsx 写固定色前 |
| `test:scale` | 指纹尺度不变：帧 320 宽、查询图原分辨率、盒式重采样+均值归一化 | `toGray`/`EXTRACT_WIDTH` |
| `test:startup` | 启动链路 40 项（入口/日志/便携目录/单实例锁/早期崩溃可见） | 启动相关 |
| `test:pack` | 便携版打包 62 场景（EPERM/回退/校验/data 保留/路径可见性） | 打包脚本 |
| `test:asar` | asar 解析逻辑（10 项） | asar 相关 |
| `test:events` | 视频事件消费（12 项）：索引完成 `video-updated` 就地刷新行（状态/帧数）、过滤视图下状态变化即移除、`video-removed` 不留僵尸行；静态守卫订阅必须接在 useVideoList | `useVideoList.ts` 事件处理 |

### 测试要点

- `test:startup`/`test:core`/`test:portable` 内部先跑 `node scripts/build-core.mjs` 编到 `out-e2e/`、`out-startup/`（非发布产物 `out/`，用 `tsconfig.e2e.json` / `tsconfig.startup.json`）。
- **`test:ui` 与 `test:path` 不能并发**：同用 `tsc -p tsconfig.preview.json` 转译渲染端，并发会假失败。
- 沙箱清空 `out-e2e` 被安全删除拦下时，手动逐个跑 `node scripts/test-xxx.mjs`。
- 受限沙箱禁管道时 `test:core` 依赖 ffmpeg 的用例 SKIP，核心链路仍验证。
- **新增 `src/main/*.ts` 后 `out/main/` 不自动更新**（`build-core.mjs` 只编 `out-e2e`/`out-startup`），正常跑 `pnpm build`；若 esbuild 报 `winapi error #5` 读 `package.json` 失败，用 tsc 单独补编译（**必须带 `--strict`**，否则判别式联合不窄化误报）。
- 打包脚本测试钩子（仅自检用）：`WHICHVIDEO_SKIP_BUILD_CHECK`、`WHICHVIDEO_SKIP_ELECTRON_BUILDER`、`WHICHVIDEO_TEST_FORCE_LOCKED`、`WHICHVIDEO_RELEASE_DIR`、`WHICHVIDEO_TEST_REPORT`。

---

## 🎨 主题与配色

三层：**语义 token** (`primary`/`surface-*`/`line`/`accent`…) → **两套色值** (`@theme` 深色 / `[data-theme='light']` 浅色) → `<html data-theme>`。组件只写第一层。

- `useTheme()`：深/浅/跟随系统三档循环，存 `localStorage["wv-theme"]`
- 跟随系统：`matchMedia("(prefers-color-scheme: dark)")` + 监听 `change`（非 CSS `prefers-color-scheme`，否则手动选浅色被系统覆盖）
- 旧 `ink-*`/`muted` 通过 `var()` 映射语义层，仍可用

**新增组件只能用语义 token**。深色下 `text-slate-100` 浅色是白字白底，`#38bdf8` 白底对比度 2.1:1 —— 靠 `test:theme` 静态拦。

---

## 🖼️ 图标

图形：圆角方形 + 四取景角 + 播放三角（以图搜帧），配色 accent `#38bdf8`。

`pnpm icon` → `scripts/generate-icon.mjs`（零依赖，纯 zlib 手写 PNG/ICO）产出三处：

- `build/icon.ico` (16~256) —— electron-builder 读 exe/快捷方式图标
- `out/icon.ico` —— **随包走**：`files` 只含 `out/**`，打包后 `build/` 在 asar 外不可达；绿色版靠 `__dirname/../icon.ico` 拿任务栏图标
- `src/renderer/public/favicon-{16,32}.png` —— 随源码入库

**`pnpm build` 末尾跑 `pnpm icon`**（`electron-vite build` 清空 `out/`，放前面会被删）。

> **任务栏有图标但 exe 是默认的 = Windows 图标缓存**，非打包问题。两路径互不相干：
> - 任务栏/窗口 = `BrowserWindow.icon` 运行期读 `out/icon.ico`
> - exe/快捷方式 = electron-builder 打包时读 `win.icon` 烧进 PE 资源节
>
> 先跑 `pnpm test:icon` 验证 PE 资源节与 `build/icon.ico` 字节级一致 → 清缓存：
> ```bash
> taskkill /f /im explorer.exe && del /f /q "%localappdata%IconCache.db" && del /f /q "%localappdata%MicrosoftWindowsExplorericoncache_*.db"
> start explorer.exe
> ```
> 再清任务栏固定项、桌面快捷方式。

---

## 🗂️ 项目结构（主进程链路）

```
src/main/index.ts      # 启动引导/窗口/数据目录/生命周期
src/main/ipc.ts        # 26 IPC 处理器；无模块级可变量，db/searchIndex/indexer/watcher/broadcast 经 IpcDeps 注入
src/main/db.ts         # SQLite
src/main/search.ts     # 常驻内存帧索引 + 打分
src/main/indexer.ts    # 抽帧队列
src/main/watcher.ts    # chokidar 监听
src/main/media.ts      # ffmpeg/ffprobe 查找
src/main/scan.ts       # 目录扫描
src/main/datadir.ts    # 便携目录判定
src/main/logger.ts     # 日志
src/main/constants.ts  # 魔法数字集中
src/main/interfaces.ts # 服务契约
src/shared/            # 主/渲染共用：types.ts(含 IPC 频道)、hash.ts、framepack.ts
```

渲染端列表：`LibraryView.tsx`（工具条/表格/分组标题/快捷键）、`VideoRow.tsx`（竖条+行底+文件名染色+4操作按钮）、`useVideoCursor.ts`（光标/导航/PAGE_JUMP）、`lib/selection.ts`（`blockModifierTextSelection` 视频行/分组标题/表头共用）。

---

## 📖 文档分工

| 文件 | 读者 | 内容 |
|------|------|------|
| `README.md` | 用户 | 快速开始、使用流程、配置项、用户级 FAQ |
| `docs/how-search-works.md` | 实现者 | 检索原理、内存布局、实测距离量级、调参依据 |
| `docs/troubleshooting.md` | 打包维护者 | 启动无反应、EPERM、环境崩溃、Electron 下载、构建期报错 |
| `AGENTS.md` | 开发者 | 架构约束、踩坑记录、19 套自检性质 |

> 写 README 先问：这条信息「用户」关心吗？不是 → `docs/`。崩溃排查与数学推导别进 README。

---

## ⚠️ 易踩 UI 约束（来自 ui-smoke/test:range/test:cursor）

### 选中样式
- 选中 = 左侧 2px 蓝竖条 + 整行 `bg-row-selected` + **文件名 `text-accent`**（单选多选同一条件）
- 4 操作按钮：`${selected ? 'bg-surface-2 text-white' : ''}`（**不透明底挡住行底透色**，文字保白）
- Shift 点击会触发浏览器原生 `::selection`，用 `blockModifierTextSelection` 仅拦带修饰键按下（视频行/分组标题/表头三处），**别用整行 `select-none`**（会干掉文件名双击复制）

### 工具条布局
- 「已选 N」常驻占位（`invisible` + `tabular-nums`），选中前后布局零变化
- **不按选中数量分档**（历史分两档又取消：交互两种状态长得不一样，用户每次得先判断单/多选）

### 列表行底色（sticky right-0 吸附列）
- **必须不透明实色 token**（`--color-row-*`），半透明会透出左侧滚动文字
- 只给 `td` 不给 `tr`（tr 有背景会与吸附格叠加）
- 分组标题行：**拆成 `colSpan={2}` + 空吸附格**，别用单 `colSpan={3}`（会盖住操作列、断开分隔线）

### 连选锚点
- **必须用 `useRef`**，不能用 state（updater 同步执行读旧值、依赖 `[videos]` 永不重建 → 退化单选）
- `clearSelection` 须清 `lastSelectedRef.current = null`
- `test:range` 三条静态守卫 + 行为验证（连按 Shift+↓ 每次累积）

### 光标与选中 = 同一东西
- `videoRowIndexes` 只收视频行，↑↓ 跳过分组标题
- 两条入口**都必须 `setFocusedIndex`**：
  1. 方向键/Home/End/翻页 → `moveCursor`/`jumpCursor`
  2. 鼠标点整行 → `handleRowClick` → `focusRow`/`selectRowRange`/`toggleRowSelection`
- `handleRowClick` **按 `video.id` 反查 `navigableItems.findIndex`**，别靠 map 回调位置参数（分组视图偏移易算错 → 症状：跳回首行）

---

## 📌 补充：新增 `src/main/*.ts` 后的编译

`test:output` 会报「缺少 xxx.js」。正常跑 `pnpm build` 即可。若 esbuild 报 `winapi error #5` 读 `package.json` 失败，用 tsc 单独补编译（**必须带 `--strict`**）：

```bash
node node_modules/typescript/bin/tsc src/main/x.ts \
  --module commonjs --target ES2022 --moduleResolution node \
  --esModuleInterop --skipLibCheck --strict --outDir <tmp>
# 再拷 <tmp>/x.js → out/main/
```