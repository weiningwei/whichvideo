# AGENTS.md

Electron + electron-vite + React 19 + Tailwind v4 的本地视频库（以图搜帧）。
主进程产物是 **CommonJS**（`out/main/index.js`）；渲染端是 React。包管理用 **pnpm**，node >= 22。

## 铁律：从仓库根目录执行命令

`electron.vite.config.ts` 用 `process.cwd()` 解析所有路径，并在启动时校验 `src/main/index.ts` 是否存在；换目录执行会直接抛错。所有 `pnpm` 脚本都假定 CWD = 仓库根。

## 常用命令

```bash
pnpm dev              # electron-vite dev（渲染端热更新）
pnpm typecheck        # node + web 两套 tsc，无产物
pnpm build            # typecheck + electron-vite build → out/
pnpm build:portable   # build + scripts/build-portable-folder.mjs → release/WhichVideo-portable/
pnpm build:win        # build + electron-builder --win → NSIS 安装包 + release/win-unpacked/
pnpm build:unpack     # build + electron-builder --win dir
pnpm fetch:ffmpeg     # 下载 ffmpeg/ffprobe 到 resources/bin（建索引需要；缺失时应用仍能打开）
```

构建顺序固定：`typecheck` 通过后才会 `electron-vite build`；`build:portable`/`build:win` 已包含 `build`，不要再单独跑。提交前至少跑 `pnpm typecheck`。

## 便携版 exe 双击没反应（本仓库反复踩的坑，优先按此排查）

Windows 上 Electron 是 GUI 子系统程序，stdout 不接控制台，启动阶段出错就是"没反应"。按顺序查：

1. **看日志** `<数据目录>\whichvideo.log`。便携版是 `exe同级\data\whichvideo.log`，安装版是 `%APPDATA%\WhichVideo\whichvideo.log`。日志从启动参数一路记到"初始化完成"，缺哪步问题就在哪步。
2. **连日志/`data\` 都没生成** → 主进程 JS 一行都没跑成（比初始化失败更早）。看退出码：
   - `-2147483645`（`0x80000003`，`STATUS_BREAKPOINT`）= Chromium 通用崩溃码，**非本应用特有**。
   - 跑 `node scripts/probe-electron-startup.mjs`：用官方 Electron 跑极简应用并逐个试 `--disable-gpu-sandbox` / `--disable-gpu` / `--no-sandbox` 等开关。极简应用也崩 → 本机环境无法跑 Electron GUI，与代码无关。
3. **启动链路自检** `pnpm test:startup`（会自动先跑 `node scripts/build-core.mjs`）：把编译后的主进程跑在 Node + Electron 桩上,覆盖入口/日志/便携目录/单实例锁等 40 项。
4. **静默退出常见原因**：日志写"已有实例在运行" → 去任务栏找已开窗口（单实例锁）。
5. **`package.json` 绝不能有 `"type": "module"`**：Electron 会据此把 CJS 主进程当 ESM 加载，首行即抛错 → 无窗口无日志。`pnpm test:startup` 场景 0 会直接拦截。
6. **包里是旧代码**：`build:portable` 每次强制重新打包，并用 `@electron/asar` 读出包内 `out/main/index.js` 与本地产物做 sha256 比对，不一致即退出。出现该错误时删掉 `release\win-unpacked` 与 `release\WhichVideo-portable` 重跑。
7. **环境类开关兜底**：`.\WhichVideo.exe --disable-gpu` / `--disable-gpu-compositing` / `--no-sandbox` / `--disable-software-rasterizer`。主进程在 Windows 已默认 `--disable-gpu-sandbox`，且日志初始化早于单实例锁与数据目录解析（`bootstrapLogger` → `relocateLogger`），早期崩溃也会留记录。

## 打包时反复下载 Electron 运行时（`downloading label=electron`）

**症状**：每次 `pnpm build:unpack` 都在下载 158MB 的 Electron zip，日志显示
`downloading label=electron` + 100% 进度条，但本机明明已有缓存。

**根因**：`@electron/get` 命中缓存后**还要下载 `SHASUMS256.txt` 做 SHA256 校验**，
而那个校验文件是硬编码「Never use the cache」的（`@electron/get` 的
`dist/index.js`，注释写得很清楚）。于是：

```
Cache hit                              ← 缓存命中了 158MB 的 zip
Downloading .../SHASUMS256.txt         ← 但仍要联网取校验文件
ConnectTimeoutError: github.com:443    ← 连不上（本机 10s 超时）
Artifact in cache didn't match checksums
falling back to re-download            ← 于是重新下载
```

**那行 `downloading label=electron` 是误导性的** —— 不是"又在下载"，而是"缓存命中了
但校验没做，改走网络下载"，而网络又不通。

**解法**（已写进 `electron-builder.yml`）：

```yaml
electronDownload:
  unsafelyDisableChecksums: true
```

命中缓存后不再联网，实测 **4769ms 直接返回缓存**。不加这个配置则卡在
github 连接上直到超时。

代价是不再校验 zip 完整性，风险很低：缓存里是同一台机器从官方下载的产物、
同一版本；真损坏的话 electron-builder 后续解包会直接报错。删缓存重下即可恢复。

**排查手法**（下次遇到"明明有缓存却还在下"直接照这个走）：

```bash
# 1. 确认缓存里有没有（两个目录都要看）
ls "$LOCALAPPDATA/electron/Cache"/*/                       # @electron/get 的 zip 缓存
ls "$LOCALAPPDATA/electron-builder/Cache"/electron-v*/     # electron-builder 的解压缓存

# 2. 让 @electron/get 说话（这步最关键，日志会直接给出 Cache hit / miss / 为什么回退）
DEBUG='@electron/get*' node -e "
const {downloadArtifact}=require('./node_modules/.pnpm/@electron+get@5.1.0/node_modules/@electron/get/dist/index.js');
downloadArtifact({version:'44.5.1',artifactName:'electron',platform:'win32',arch:'x64'})
  .catch(e=>console.log('ERR',e.message));
"
```

缓存键是**下载 URL 目录部分的 sha256**（`Cache.getCacheDirectory`：去掉
query/hash 后取 `dirname` 再哈希），所以换镜像源就会换一份缓存、等于白下一遍。

顺带一提：`SAFE_DELETE_BULK_CONFIRM_REQUIRED` 是本机安全删除守卫在拦
（一次删 151 个文件超过阈值 50），与 electron 下载无关。

## 打包与目录占用（EPERM）

`build:portable` 产出两份目录：`release\WhichVideo-portable\`（在仓库内）与**仓库上一级目录**下的同名文件夹（`..\WhichVideo-portable\`）。外面那份是给用户直接双击运行的，刻意放在项目目录之外，避免被编辑器索引 / 杀软扫描 / 资源管理器停留锁住。拷贝后脚本会核对文件数、总字节数与 `app.asar` 的 sha256；**这一份失败不会让整次打包判死**（`release` 里的产物仍然是好的），只在输出里报错并提示手动拷走。

外面那份**会保留已有的 `data\`**（`copyOutsideRepository` 里先用 `renameSync` 挪到 `<dest>.data-keep-<时间戳>`，替换产物后再挪回）。理由是开发时反复打包，清掉索引库就得重跑一遍抽帧。相应地，拷贝校验的文件数与字节数统计都排除 `data\`（源目录 `release/` 里本来就没有这个目录）——`countFiles(dir, excludeDirName)` 与 `directorySize(dir, excludeDirName)` 因此都多了一个参数。挪不动时（跨卷、data 被占用）会退回删除并在输出里如实说明，不会静默丢索引库。落点可用 `WHICHVIDEO_OUTSIDE_DIR` 指定，`WHICHVIDEO_SKIP_OUTSIDE_COPY=1` 可跳过（`test:pack` 就是把它指向 `tmp\` 跑的，绝不能让它写真实的上一级目录）。

两份目录的占用处理完全一致。`pnpm build:portable` 报 EPERM 是目标目录被占用（绿色版仍在运行、编辑器 plugin_host / VS Code 索引了 `release`、资源管理器停在该目录、杀软扫描）。脚本会**重试删除 → 改名成 `.old-<时间戳>` 挪开 → 仍失败则输出到 `WhichVideo-portable-<日期>-<时间>` 继续**，旧 `data\` 不会静默删除。排查占用者：

**路径出现在哪里，按可见性分两种，别搞反：**

| 去处 | 用什么路径 | 理由 |
| --- | --- | --- |
| 终端输出（`console.log` / `error`） | **绝对路径** | 开发者自己看，要知道自己机器上落在哪；贴 issue 时也需要 |
| `便携版说明.txt`（跟着产品走） | **相对描述** | 终端用户看的，不该出现构建机目录结构 |
| README / docs / 注释 | **相对路径** | 会公开流传，且换台机器就对不上 |
| `WHICHVIDEO_TEST_REPORT` 的字段 | **绝对路径** | 自检靠它做 `startsWith` / `join` 判定 |

曾把第一格也做成相对（加了个 `displayPath()`），结果开发者自己在终端里看不到
绝对路径，而真正该干净的说明文件一直是好的 —— 判断标准搞反了。`test:pack`
的场景 5c 现在按这张表来查：断言说明文件与文档无泄漏，同时断言终端输出**保留**
绝对路径。

```bash
node scripts/build-portable-folder.mjs --who-locks release\WhichVideo-portable
pwsh -File scripts/lib/who-locks-dir.ps1 -Path release\WhichVideo-portable -All
```

`.vscode/settings.json` 是**故意入库**的，它把 `release`/`out*`/`tmp` 排除出文件监视，避免编辑器占用导致打包失败——不要删除或还原它。

## 数据目录判定

优先级（`src/main/datadir.ts`，有独立测试）：`WHICHVIDEO_DATA_DIR` → 便携启动器注入的 `PORTABLE_EXECUTABLE_DIR\data` → 打包后 exe 同级 `data\`（可写时）→ 默认 `userData`。索引库 `whichvideo.db`（SQLite WAL）、日志 `whichvideo.log`、Chromium 缓存 `session\` 都在数据目录内。放入 `Program Files` 等只读位置会回退到 `%APPDATA%\WhichVideo`。

## 关键约束（改动时容易忘）

- **`electron.vite.config.ts` 禁用 `__dirname` 与 `import.meta.dirname`**：electron-vite 按 `package.json` 的 `type` 字段决定用 ESM/CJS 解析配置，二者混用会加载失败。别名 `@shared` 要在 **main / preload / renderer 三段各自声明**，`@renderer` 只在 renderer 段。`pnpm test:config` 静态检查这些。
- **better-sqlite3 用 Node-API 预编译二进制**，Node 与 Electron 通用。`electron-builder.yml` 里 `npmRebuild: false` 是刻意关闭 `@electron/rebuild`（它在某些沙箱会 `spawn EPERM` 导致打包中断）。确需重建用 `pnpm rebuild:native`。
- **主进程用 `require` 惰性加载核心模块**（`loadCoreModules`），以便捕获原生模块加载失败并落日志，不要改成顶层 ESM import。配套两件事不能动：**`electron.vite.config.ts` 的 `mainEntries()` 扫描 `src/main` 自动生成入口**（曾手写 7 个入口，新增 `logger.ts`/`scan.ts` 后漏掉，运行时报 `Cannot find module`），以及 **`preserveModules: true`**（多入口时 Rollup 会把共享模块复制进每个入口，`logger.ts` 的模块级缓冲状态会分裂、早期日志丢失）。`pnpm test:output` 从编译产物里反查所有 `require('./x')` 是否都有对应文件。
- `.gitignore` 里的 Python 目录规则**以 `/` 锚定到仓库根**，否则 `lib/` 会误伤 `src/renderer/src/lib/`。不要去掉前导斜杠。

## 选中提示：单选与多选完全一致

**不要按选中数量分档。** 单选和多选都同时给三样：左侧 2px 亮蓝竖条 +
整行淡蓝底 `bg-row-selected` + 视频标题染蓝。

`VideoRow` 里只有 `selected` 一个判定，不存在 `selectedCount` / `singleSelected`
这类中间变量。

**我试过分档，又改回来了。** 当时的理由是"多选时整行铺底色会染到行里其它元素"：

- 状态徽标「待索引 / 索引中」本来就是 `text-accent` 蓝，叠在一起分不清是状态还是选中
- 操作按钮的 `btn-bg`（`--color-btn-bg`）是**半透明**的，淡蓝底透上来，
  四个按钮连边框一起泛蓝

这两条现象是真的，但**分档的代价比它们大**：同一个交互在两种状态下长得不一样，
用户每次看到列表都得先判断"我现在是单选还是多选"才知道该期待什么。视觉上"更干净"
换来的是交互模型不稳定，不值得。

所以：**接受这两处叠加**。徽标的蓝说的是状态、竖条和底色说的是选中，
本来就不是同一个信号，颜色接近不至于混淆；而分档会让"选中"这个状态
取决于"选了几个"，是更本质的混乱。

ui-smoke 里有三条断言守着它（标题直接用 `selected` / `rowBg` 直接用 `selected` /
没有残留的分档变量），反向验证时改回分档会报 146/149。

顺带一条容易踩的：`test-theme` 会扫源码里的十六进制色值字面量，
**注释里也别写 `#16203380` 这类色值** —— 会被当成"组件里硬编码颜色"而报错。
改写成"见 index.css 的 --color-btn-bg"即可。

## 列表行的底色必须是不透明实色

视频库操作列是 `sticky right-0`（横向滚动时吸附右侧）。**sticky 格若用半透明底色
（`bg-accent/12`、`bg-ink-800/70` 这类），左侧滚过来的文字会透上来叠在按钮上。**

行底色统一用 `--color-row-*` 这几个**预先混好**的实色，不要写半透明叠色：

| token | 由什么混成 | 用途 |
| --- | --- | --- |
| `--color-row-selected` | accent 12% + surface-1 | 选中行 |
| `--color-row-focus` | surface-3 70% + surface-1 | 仅键盘光标 |
| `--color-row-hover` | surface-3 40% + surface-1 | 悬停 |
| `--color-row-group` | surface-3 50% + surface-1 | 分组标题行 |

混色算法：`round(前景通道 × alpha + surface-1 通道 × (1 - alpha))`，深浅两套
各自的 surface-1 不同，所以四个色值在 `[data-theme='light']` 里要重新算一遍。

两个容易踩的点：

- **只给 td，不给 tr。** tr 若也有背景，会与吸附格叠加，同一行出现两种色块
- **分组标题行不能用一个 `colSpan={3}` 的 td**，那会盖住操作列、让左侧分隔线
  断开；必须拆成 `colSpan={2}` + 一个空的吸附格

试过的错路：给 td 铺不透明底色 + 内层 `absolute inset-0` 覆盖层渲染行色 ——
`absolute` 在表格布局里定位不可靠（兄弟节点不是定位祖先时它会跑到别处），
不如直接用实色 token。

## 连选锚点必须用 ref，不能用 state

`useLibrary` 的 Shift 连选锚点（`lastSelectedRef`）**必须是 ref**。改成 state 就会出
一个 typecheck 通过、静态断言全绿、只有真去连选才暴露的 bug。

**症状**：连按 Shift+↓ 选中不累积，每按一次都被清成 1 个（工具条显示「已选 1」）。

**根因**（两层，都很隐蔽）：

1. 连选逻辑写在 `setState` 的 updater 里，而 updater 是**同步执行**的 ——
   此刻读 state 拿到的还是本轮 `setLast` **之前**的旧值。React 不会因为我们刚调过
   `setLast` 就重跑一次 callback。
2. 原来的依赖是 `[videos]`，而**选中并不改变 videos**（videos 只在扫描/导入时 set）。
   所以依赖永远不变、callback 永不重建，闭包里那个 state 值永远是初始的 `null` ——
   连选每次都走 `else` 分支退化成单选。

**症状为什么"时好时坏"**：任何顺带 `setVideos` 的操作（重新扫描、导入）都会让
callback 重建，此时闭包能拿到新锚点，于是连选又能用一会儿。
这种间歇性表现让复现变得很困难，我一度误判成"用户跑的是旧构建"。

**正确写法**：

```ts
const lastSelectedRef = useRef<number | null>(null)
const toggleVideoSelection = useCallback((videoId, shiftKey, ctrlKey) => {
  const anchor = lastSelectedRef.current   // 同步读到最新值
  setSelectedVideoIds((prev) => { /* 用 anchor */ })
  lastSelectedRef.current = videoId        // 同步更新
}, [videos])
```

`clearSelection` 里也要清 `lastSelectedRef.current = null`，
否则取消选择后再按 Shift 会从上一次的位置开始扩展。

`test:range` 里有专门三条守着它（锚点用 ref、判断读 ref、clearSelection 清 ref），
外加「连按 Shift+↓ 每次都累积」的行为验证。**改连选逻辑前先跑它。**

顺带一个通用教训：**`useCallback` 的依赖数组是"何时重建闭包"的唯一依据，
而"读一个 state"不构成依赖 —— 因为 state 变了但你若没把它列进去，闭包就永远读不到
新值。** 凡是"上一次的位置/上一次的某状态"这类锚点，直接用 ref。

## 光标与选中

**光标与选中必须是同一个东西。** 文件管理器式的列表里，光标在哪单选就在哪。

此前写成两个独立 state（`focusedIndex` 本地 + `selectedVideoIds` 在 hook 里），语法完全正确、
静态检查也全绿，但用起来方向键只动灰竖条、蓝竖条留在原地——用户反馈"按方向键没反应"。
这种错静态断言抓不到，只能靠 `test:cursor` 复刻算法跑行为验证。

约定：

- `videoRowIndexes` 只收视频行，↑↓ 在它上面移动，**跳过分组标题**（标题不是视频，无从"选中"）
- 无修饰 → 单选跟随；`Shift` → 从上次选中处连选；`Ctrl` → 只移光标、选区不动
- 光标可能落在标题上（`focusedRowPos === -1`），按 ↓ 从首行起步、按 ↑ **从末行**起步
  （`from` 取 `-1` / `length`，不是 `0`——取 0 会被夹到首行，按↑没反应）
- `Space` 不动光标也不清其他行，是真正的加选 / 取消；
- `←→` 作用于**光标所在视频的分组**（`focusedFolderId`），不再等"光标在标题上"

**改光标的入口有两条，漏一条就会复现老 bug**：

| 入口 | 函数 | 修饰键 |
| --- | --- | --- |
| 方向键 / Home / End / 翻页 | `moveCursor` / `jumpCursor` | Shift 连选、Ctrl 只移光标 |
| **鼠标点整行** | `handleRowClick` → `focusRow` / `selectRowRange` / `toggleRowSelection` | Shift 连选、Ctrl 点选 |

我曾只打通了方向键那条，点击仍只改选中 —— 光标一直停在初始位置（第一个视频），
于是「点第三个视频再按 ↑」会从第一个起算，直接跳回第一个。**两条入口都必须
`setFocusedIndex`**。

`handleRowClick` **按 video.id 反查行下标**（`navigableItems.findIndex`），
不要靠 map 回调里的位置参数去算偏移：分组视图下每组前面都插了标题，偏移量容易
算错，而算错的症状恰好是"跳到第一个"这种，从界面上极难看出是偏移错了。

## 文档分工

面向的读者不同，别都塞进 README：

| 文件 | 读者 | 内容 |
| --- | --- | --- |
| `README.md` | 想用这个软件的人 | 快速开始、使用流程、配置项、用户级 FAQ |
| `docs/how-search-works.md` | 想了解实现的人 | 检索原理、内存布局、实测距离量级、调参依据 |
| `docs/troubleshooting.md` | 打包维护者 | 启动无反应、EPERM、环境类崩溃、构建期报错 |
| `AGENTS.md` | 参与开发的人 | 架构约束、踩坑记录、14 套自检的性质 |

写 README 时先问：这条信息是「想用的人」关心的吗？ 不是就往 docs/ 放。
同理，崩溃排查与数学推导不要写进 README —— 那两章曾占掉 58% 的篇幅。

## 测试

`pnpm test` 按序跑：`test:config → test:output → test:frames → test:hash → test:path → test:url → test:icon → test:theme → test:scale → test:startup → test:core → test:portable → test:clipboard → test:pack → test:asar → test:ui`。

- `test:startup` / `test:core` / `test:portable` 内部先跑 `node scripts/build-core.mjs`，把 `src/main` 编到 **`out-e2e/`、`out-startup/`**（与发布产物 `out/` 无关，用 `tsconfig.e2e.json` / `tsconfig.startup.json`）。
- `test:hash` 从 `out-e2e/shared/hash.js` 导入 `computeStructHash`，守住「结构指纹必须等距抽样、覆盖全部 16 行」这条性质——`encodeChannel` 曾因顺序填 bit 而只覆盖上半张图。改 `hash.ts` 的网格或抽样逻辑后务必跑它。
- `test:path` 转译渲染端后测 `format.ts` 的路径处理，守住「shortDir 不含文件名」与「文件在根目录时 lastIndexOf 返回 -1 不截断文件名」两条性质。改 `shortDir`/`shortPath` 前必须跑它。
- `test:url` 测 `main/url-image.ts`：网页主图解析（og:image / twitter:image / link / 首个 img、相对地址转绝对、跳过占位图与 data:）与协议校验（拒绝 file:/data:/javascript: 等）。改该文件前必须跑它。
- `test:icon` 校验图标：ICO 结构与 7 个尺寸、`build/` 与 `out/` 两份是否同步、favicon 是否与 ICO 同源、win.icon / favicon / BrowserWindow icon 是否都接上。改图形或图标接线后必须跑它。
- `test:range` 验证连选算法的**行为**（21 项）：点一个→Shift 扩展→Ctrl 点选/取消、**连按 Shift+↓ 每次都累积**、clearSelection 清锚点、单选 size=1。三条静态守卫确保锚点用 ref 而非 state（改回去会报 19/21）。改连选逻辑前必跑。
- `test:cursor` 验证光标算法的**行为**（28 项）：↓ 逐行移动且单选跟随、Ctrl+↓ 只移光标不动选区、分组视图跳过分组标题、光标误落在标题上时按 ↑ 从末行起步、End/Home 夹紧、空列表不崩，以及**点击整行后光标是否同步移动**（点第 3 个再按 ↑ 必须落到第 2 个，平铺与分组视图各验一遍）。ui-smoke 只能静态检查"源码里有没有某个调用"，抓不到"方向键动了但选中没跟着动"这类逻辑错误——**改 LibraryView 的光标/选中逻辑前必须跑它**。
- `test:network` 守住隐私边界：除 `main/url-image.ts`（链接取图）外源码不得有任何网络请求；9 个核心模块（导入/抽帧/指纹/检索/存储/监听/剪贴板/日志）零联网；链接取图必须用户主动触发、请求头不带本机标识；依赖里无遥测类库；产物里无更新源配置；渲染端 CSP 无 connect-src 放宽。**引入任何联网能力前先想清楚会不会把用户数据带出去**，改完必须跑它。
- `test:theme` 守住配色纪律：组件里不许出现十六进制颜色或 Tailwind 内置固定色（slate-100 等），语义 token 必须在 `@theme` 与 `[data-theme=light]` 两侧都定义齐全。**在 tsx 里写固定色前先想清楚它是否该 token 化**；确有例外（如 Header 的「WV」压在 accent 渐变上）要登记到该脚本的 `HEX_EXCEPTIONS`，并写明理由。
- `test:scale` 守住「指纹尺度不变」：视频帧抽到 320 宽、查询图保持原分辨率，两者靠 `toGray` 的盒式重采样 + 均值归一化对齐。改 `toGray` 的采样方式或 `EXTRACT_WIDTH` 时务必跑它。
- 沙箱里 `build-core.mjs` 清空 `out-e2e` 可能被安全删除守卫拦下（文件数超阈值），此时手动逐个跑 `node scripts/test-xxx.mjs` 即可，不要当成测试失败。
- **`test:ui` 与 `test:path` 不能并发跑**：两者都用 `tsc -p tsconfig.preview.json` 转译渲染端，并发执行会互相干扰导致假失败（输出为空 / 退出码 1）。批量验证时必须串行；单独复跑即可确认是否真失败。
- 受限沙箱禁止子进程管道时，`test:core` 依赖真实 ffmpeg 管道的用例会 SKIP 并说明原因，核心链路仍验证。
- **新增 `src/main/*.ts` 后 `out/main/` 不会自动更新**（`build-core.mjs` 只编 `out-e2e` 与 `out-startup`），`test:output` 会报「缺少 xxx.js」。正常情况跑 `pnpm build` 即可；**若 esbuild 报 `Cannot read file "package.json": winapi error #5`**（读 `electron.vite.config.ts` 时连带读 package.json 失败，本机沙箱内外都会发生），用 tsc 单独补编译：
  `node node_modules/typescript/bin/tsc src/main/x.ts --module commonjs --target ES2022 --moduleResolution node --esModuleInterop --skipLibCheck --strict --outDir <tmp>`，再把 `<tmp>/x.js` 拷进 `out/main/`。
  **`--strict` 不能省**：少了它 `strictNullChecks` 关闭，判别式联合（`{ok:true}|{ok:false}`）不窄化，会报 `Property 'message' does not exist`——这是误报，项目配置里 strict 是开的。
- `scripts/lib/electron-stub.mjs` 是测试用的 Electron 桩；主进程自检在纯 Node 下跑，无需安装 Electron 运行时。
- 打包脚本的测试钩子（只给自检用，不要在日常构建里设置）：`WHICHVIDEO_SKIP_BUILD_CHECK`、`WHICHVIDEO_SKIP_ELECTRON_BUILDER`、`WHICHVIDEO_TEST_FORCE_LOCKED`、`WHICHVIDEO_RELEASE_DIR`、`WHICHVIDEO_TEST_REPORT`。

## 主题与配色

三层结构：语义 token（`primary` / `surface-*` / `line` / `accent`…）→ 两套色值（`@theme` 深色 / `[data-theme='light']` 浅色）→ `<html data-theme>`。组件只写第一层。

- `useTheme()` 提供深色 / 浅色 / 跟随系统三档，循环切换，存在 `localStorage["wv-theme"]`
- 「跟随系统」用 `matchMedia("(prefers-color-scheme: dark)")` 并**监听 change**，用户改 Windows 深浅色时能实时跟随
- 没用 CSS 的 `prefers-color-scheme` 直接换色：那样手动选浅色就盖不住系统设置了
- 旧的 `ink-950…ink-700` / `muted` 通过 `var()` 映射到语义层，仍可用，改主题会自动跟随

**新增组件时只能用语义 token。** 深色下的 `text-slate-100` 在浅色主题里是白字白底，`#38bdf8` 在白底上对比度约 2.1:1——这类问题在深色下看不出，只能靠 `test:theme` 静态拦。

## 图标

图形是圆角方形 + 四个取景角 + 播放三角（"以图搜帧"），配色沿用 accent #38bdf8。

`pnpm icon` → `scripts/generate-icon.mjs`（零依赖，纯 zlib 手写 PNG/ICO）产出三处：

- `build/icon.ico`（16~256）—— electron-builder 读它做 exe 与快捷方式图标
- `out/icon.ico` —— 同上，但**随包走**：`files` 只含 `out/**`，打包后 `build/` 在 asar 外不可达，绿色版（win-unpacked 直跑 exe）靠 `__dirname/../icon.ico` 拿图标，否则任务栏退回默认图标
- `src/renderer/public/favicon-{16,32}.png` —— 随源码入库

`pnpm build` 的**末尾**跑 `pnpm icon`：`electron-vite build` 会清空 `out/`，放在前面生成会被删掉。
16×16 是纯像素光栅化（无抗锯齿）的辨识极限，32px 以上很干净——不要为了 16px 去加粗角臂，那会让四角连成方框。

**「任务栏有图标但 exe 还是默认的」不是打包问题，是 Windows 图标缓存。** 两处图标是**互不相干的两条路径**：

- 任务栏 / 窗口图标 = BrowserWindow 的 `icon`，运行期读 `out/icon.ico`（随包走）
- exe 文件 / 快捷方式图标 = electron-builder 打包时读 `win.icon`，**烧进 exe 资源节**，与运行期无关

先跑 `pnpm test:icon`——它会直接解析 exe 的 PE 资源节，列出 RT_ICON 下每张图的字节数并与 `build/icon.ico` 逐一比对。若显示「7 张 PNG 图标 / 完全一致」，说明打包是好的，**不用重打包**，按下面清缓存即可：

```bash
# 1) 清图标缓存（icache 是图标缓存服务，删掉后资源管理器会自动重建）
taskkill /f /im explorer.exe && del /f /q "%localappdata%IconCache.db" \n  && del /f /q "%localappdata%MicrosoftWindowsExplorericoncache_*.db"
start explorer.exe
```

还有两处缓存会骗人：**任务栏固定项**（取消固定 → 重新固定）与**桌面快捷方式**（删掉旧的 `.lnk` 再重新创建，`.lnk` 自身也缓存图标）。改了 exe 后若仍是旧图标，先清缓存再怀疑打包。

## 项目结构（主进程链路）

`src/main/index.ts`（窗口/IPC/生命周期）→ `db.ts`（SQLite）· `search.ts`（常驻内存帧索引+打分）· `indexer.ts`（抽帧队列）· `watcher.ts`（chokidar）· `media.ts`（ffmpeg/ffprobe 查找）· `scan.ts`（目录扫描）· `datadir.ts`（便携目录判定）· `logger.ts`（日志）。
`src/shared/` 为主/渲染共用（`types.ts` 含 IPC 频道名，`hash.ts` 指纹，`framepack.ts` 144B/帧内存布局）。

更多面向用户的细节（检索原理、参数、常见问题）见 `README.md`。
