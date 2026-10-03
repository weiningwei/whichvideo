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

## 打包与目录占用（EPERM）

`build:portable` 产出两份目录：`release\WhichVideo-portable\`（在仓库内）与**仓库上一级目录**下的同名文件夹（`E:\code\weiningwei\WhichVideo-portable\`）。外面那份是给用户直接双击运行的，刻意放在项目目录之外，避免被编辑器索引 / 杀软扫描 / 资源管理器停留锁住。拷贝后脚本会核对文件数、总字节数与 `app.asar` 的 sha256；**这一份失败不会让整次打包判死**（`release` 里的产物仍然是好的），只在输出里报错并提示手动拷走。落点可用 `WHICHVIDEO_OUTSIDE_DIR` 指定，`WHICHVIDEO_SKIP_OUTSIDE_COPY=1` 可跳过（`test:pack` 就是把它指向 `tmp\` 跑的，绝不能让它写真实的上一级目录）。

两份目录的占用处理完全一致。`pnpm build:portable` 报 EPERM 是目标目录被占用（绿色版仍在运行、编辑器 plugin_host / VS Code 索引了 `release`、资源管理器停在该目录、杀软扫描）。脚本会**重试删除 → 改名成 `.old-<时间戳>` 挪开 → 仍失败则输出到 `WhichVideo-portable-<日期>-<时间>` 继续**，旧 `data\` 不会静默删除。排查占用者：

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

## 测试

`pnpm test` 按序跑：`test:config → test:startup → test:core → test:portable → test:pack → test:asar → test:ui`。

- `test:startup` / `test:core` / `test:portable` 内部先跑 `node scripts/build-core.mjs`，把 `src/main` 编到 **`out-e2e/`、`out-startup/`**（与发布产物 `out/` 无关，用 `tsconfig.e2e.json` / `tsconfig.startup.json`）。
- 受限沙箱禁止子进程管道时，`test:core` 依赖真实 ffmpeg 管道的用例会 SKIP 并说明原因，核心链路仍验证。
- `scripts/lib/electron-stub.mjs` 是测试用的 Electron 桩；主进程自检在纯 Node 下跑，无需安装 Electron 运行时。
- 打包脚本的测试钩子（只给自检用，不要在日常构建里设置）：`WHICHVIDEO_SKIP_BUILD_CHECK`、`WHICHVIDEO_SKIP_ELECTRON_BUILDER`、`WHICHVIDEO_TEST_FORCE_LOCKED`、`WHICHVIDEO_RELEASE_DIR`、`WHICHVIDEO_TEST_REPORT`。

## 项目结构（主进程链路）

`src/main/index.ts`（窗口/IPC/生命周期）→ `db.ts`（SQLite）· `search.ts`（常驻内存帧索引+打分）· `indexer.ts`（抽帧队列）· `watcher.ts`（chokidar）· `media.ts`（ffmpeg/ffprobe 查找）· `scan.ts`（目录扫描）· `datadir.ts`（便携目录判定）· `logger.ts`（日志）。
`src/shared/` 为主/渲染共用（`types.ts` 含 IPC 频道名，`hash.ts` 指纹，`framepack.ts` 144B/帧内存布局）。

更多面向用户的细节（检索原理、参数、常见问题）见 `README.md`。
