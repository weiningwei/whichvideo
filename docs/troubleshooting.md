# 排障手册

> 面向开发者与打包维护者。**只想用软件请看 [README](../README.md) 的常见问题**——
> 那里只列了用户真正会遇到的几种。

本篇覆盖：绿色版启动无反应、打包 EPERM、环境类崩溃、构建期报错。

---

**双击 exe 没有任何反应 / 终端里立刻回到提示符？**
Windows 上 Electron 是 GUI 子系统程序，stdout 不接控制台，所以启动阶段一旦出错就是"没反应"。
现在启动过程会写日志：**`<数据目录>\whichvideo.log`**（便携模式是 `exe同级\data\whichvideo.log`，
安装版是 `%APPDATA%\WhichVideo\whichvideo.log`）。打开它看最后几行即可定位。

日志里会按顺序记录：启动参数 → 核心模块加载 → 数据目录 → 日志文件 → 窗口创建 → 界面加载 →
索引库打开 → IPC 注册 → 初始化完成。缺在哪一步，问题就在那一步。

常见原因：
- **已经在运行**：日志会写"已有实例在运行，本次启动退出"，去任务栏找已打开的窗口
- **界面文件缺失**：日志写"加载界面：…（存在=false）"，说明打包产物不完整 → 重新 `pnpm build:portable`
- **索引库损坏/被占用**：日志写 `[ERROR] 初始化失败: file is not a database` 等，删掉 `data\whichvideo.db` 重启即可（会重新建索引）
- **绿色版放进了 Program Files**：目录只读，数据会退回 `%APPDATA%`，日志里的"数据目录"会显示实际位置

排查自检：`pnpm test:startup` 会把编译后的主进程跑在 Node + Electron 桩上，覆盖"窗口创建/显示、
日志落盘、便携目录、初始化失败可见、单实例锁"这些启动路径。

**`pnpm build:portable` 报 EPERM / Permission denied？**
说明 `release\WhichVideo-portable`（或仓库上一级目录里那份同名文件夹）里的文件正被占用，
Windows 上删不掉也改不了名。常见占用者：

1. **绿色版还在运行**（最常见）：先退出 `WhichVideo.exe`，任务管理器确认进程没了
2. **编辑器**：Sublime Text 的 `plugin_host-3.3.exe`、VS Code 的 `Code.exe` 等在索引本项目时会持有目录句柄
3. **资源管理器停在那个目录**、或杀毒软件正在扫描刚生成的 exe

> 注意：占用跟进程 exe 在哪**没有关系**。编辑器装在哪都行，但它的索引/插件进程
> 只要把项目目录当作当前工作目录（CWD）或扫描了 `release`，就会锁住这里。

**想知道到底是谁占着？** 仓库带了一个诊断脚本，会读每个进程的真实工作目录并点名占用者：

```bash
node scripts/build-portable-folder.mjs --who-locks release\WhichVideo-portable
# 或直接： pwsh -File scripts/lib/who-locks-dir.ps1 -Path release\WhichVideo-portable -All
```

脚本的处理顺序是：**重试删除 → 改名成 `WhichVideo-portable.old-<时间戳>` 挪开 → 仍然不行就自动输出到 `WhichVideo-portable-<日期>-<时间>` 并继续打包**。
也就是说占用不会让打包失败，只会换个目录名；你的旧 `data\` 会完整留在原处或 `.old-*` 里，不会被静默删掉。

拷到仓库上一级目录的那份用的是同一套处理顺序，并在拷贝后核对文件数、总字节数和 `app.asar` 的 sha256。
只有这一份失败时不会让整次打包失败——`release\WhichVideo-portable` 仍然是可用的，输出里会提示手动拷走。

想让它一直用首选目录名，就把占用源关掉（或退出编辑器）再跑一次。
本仓库内置了 `.vscode/settings.json`，已经把 `release`、`out*`、`tmp` 排除在文件监视与搜索之外，可避免编辑器索引产物导致的占用。
用 Sublime 的话，把排除规则加进项目文件即可（`folder_exclude_patterns` 里加上 `release`、`out*`、`tmp`）。

**双击 exe 没有任何反应，连 `data\` 目录和 log 都没生成？**
这个组合（无窗口 + 无数据目录 + 无日志）说明**主进程的 JS 一行都没跑成功**——比初始化失败更早。
先看退出码，它能直接区分原因：

| 退出码 | 含义 | 往哪查 |
| --- | --- | --- |
| `-2147483645`（`0x80000003`） | `STATUS_BREAKPOINT`，Chromium 的通用 `CHECK` 崩溃码，**不是应用特有** | 下面的「环境类崩溃」 |
| 其他非零 | 代码执行到一半报错 | 此时应有 `<数据目录>\whichvideo.log`（现在极早期日志也会落盘） |
| 没有退出码 | 进程像根本没启动 | 下面的「被拦截」 |

再逐项排除代码/打包类原因：

- **`package.json` 里声明了 `type: module`**：Electron 会据此把主进程入口当 ESM 加载，
  而 electron-vite 默认产出 CommonJS（含 `require`/`exports`），第一行就抛错退出。
  本项目已移除该字段；改动过的话 `pnpm test:startup` 的场景 0 会直接失败。
- **`out/` 产物不全**（构建中断、漏跑 `electron-vite build`）：`pnpm build:portable` 会先校验
  `out/main`、`out/preload`、`out/renderer` 是否齐全，缺了就报错，不会再产出"双击没反应"的包。
- **preload 产物扩展名**：产物是 `index.mjs` 还是 `index.js` 都会自动适配，不再写死。
- **包里是旧代码**：见下面那条"打包'成功'了，但双击还是没反应"。

**环境类崩溃（退出码 `0x80000003` / `-2147483645`）**
已知在部分 Windows 11（26100 / 26200）上，Electron 的 **GPU 子进程或 renderer 会在启动约 2 秒内以
`STATUS_BREAKPOINT` 崩溃**，而且**不产生任何日志**（参考社区同类修复：orca 的 renderer 沙箱回退、
hermes-agent 的 GPU 沙箱回退）。本项目已做两件事：

1. Windows 上默认追加 `--disable-gpu-sandbox`（本应用不需要 GPU 渲染，代价接近零）
2. **日志初始化提前到主进程第一行附近**，并在数据目录确定后迁移（`relocateLogger`），
   保证"极早期崩溃"也有记录可查 —— 之前正是缺这段日志才迟迟定位不到

若仍以该码退出，逐个试这些开关：

```powershell
.\WhichVideo.exe --disable-gpu
.\WhichVideo.exe --disable-gpu-compositing
.\WhichVideo.exe --no-sandbox
.\WhichVideo.exe --disable-software-rasterizer
```

**先判断是不是环境问题**：用官方 Electron 二进制跑一个 3 行的极简应用。如果它也以
`0x80000003` 退出，就说明是本机环境无法运行 Electron GUI，与本项目代码无关：

```bash
node scripts/probe-electron-startup.mjs
```

**被拦截（进程像根本没启动）**
系统里查不到事件日志、没有崩溃转储、连 `CrashDumps` 目录都不存在时，多半是被安全策略拦下：

- **智能应用控制 / WDAC / AppLocker**：`pwsh -File scripts/lib/check-app-control.ps1` 一次性检查
- **杀毒软件**：240MB 未签名 exe 常被静默拦截，临时加白名单试一次
- **Zone.Identifier**：右键 exe → 属性，若底部有「解除锁定」就勾选
- **换目录**：复制到别的分区或桌面再试（排除所在盘权限受限、OneDrive 同步、网络盘等问题）

**打包"成功"了，但双击还是没反应？**
先确认包里装的是不是这次的代码 —— 这个坑真实发生过：`electron-builder` 那一步失败（它内部的
`@electron/rebuild` 会 fork 子进程，某些环境直接 `spawn EPERM`），而打包脚本看到目录里已有旧的
`win-unpacked` 就跳过了打包，于是绿色版一直是旧代码。

现在加了三道保险：

1. `electron-builder.yml` 设了 `npmRebuild: false` —— `better-sqlite3` 用 Node-API 预编译二进制，
   Node 与 Electron 通用，本来就不需要重建；关掉后这一类失败不会再出现
2. 打包脚本**每次都重新打包**，不再因为"目录里已有 exe"而跳过
3. 打包后**直接读 asar 里的 `out/main/index.js`**，与本地编译产物比对大小与关键标记，
   不一致就报错退出（不再产出"看起来正常"的旧包）

排查与兜底：

```bash
node scripts/test-asar-check.mjs   # 校验 asar 解析逻辑（7 项）
pnpm rebuild:native                # 需要时手动重建原生模块
npx electron-builder --win dir     # 或绕过脚本直接打包，观察完整报错
rm -rf release                     # 实在拿不准就整个删掉重来
```

排查自检：`pnpm test:startup`（36 项）会把编译后的主进程跑在 Node + Electron 桩上，
覆盖"打包前提（type 字段 / 入口 / preload 路径）→ 窗口创建与显示 → 日志落盘 → 便携目录 →
初始化失败可见 → 单实例锁"。

**日志文件支持便携模式吗？**
支持。日志固定写在**当前数据目录**下，即 `<数据目录>\whichvideo.log`：

| 形态 | 数据目录 | 日志路径 |
| --- | --- | --- |
| 绿色版（exe 同级可写） | `exe同级\data` | `exe同级\data\whichvideo.log` |
| 绿色版放进只读目录 | `%APPDATA%\WhichVideo` | `%APPDATA%\WhichVideo\whichvideo.log` |
| 安装版 | `%APPDATA%\WhichVideo` | `%APPDATA%\WhichVideo\whichvideo.log` |
| `WHICHVIDEO_DATA_DIR` 指定 | 该目录 | `<该目录>\whichvideo.log` |

界面「索引设置」里可以直接看到当前数据目录。**注意**：日志要等数据目录确定之后才会创建，
所以"连日志都没有"本身就说明进程在更早的阶段就失败了（见上一条）。

**`pnpm build` 报 `Failed to resolve import "@shared/..."`？**
说明 `electron.vite.config.ts` 里某个构建目标漏配了别名（main / preload / renderer 三段各自需要 `resolve.alias`）。
跑 `pnpm test:config` 能立刻定位是哪个目标缺了哪个别名 —— 这类错误只在完整构建时才暴露。

**clone 下来缺文件、渲染端报模块找不到？**
检查是不是 `.gitignore` 把源码误伤了：Python 模板里的 `lib/`、`build/` 这类规则如果不写前导斜杠，
会匹配任意层级（例如 `src/renderer/src/lib/`）。本项目已把这些规则统一锚定到仓库根目录。
