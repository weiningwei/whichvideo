# 排障手册

> 启动、媒体工具与构建问题。日常操作见 [使用指南](user-guide.md)。

## 开发与构建入口

需要 Node.js ≥ 22、pnpm ≥ 10、Rust stable 和平台对应的 Tauri 系统依赖。
所有命令从仓库根目录执行：

```bash
pnpm install
pnpm dev                 # 开发模式
pnpm test                # 常规测试门禁
pnpm build:portable      # Windows 便携目录
pnpm build:win           # Windows NSIS
pnpm build:mac           # macOS .app
pnpm build:linux         # Linux AppImage
```

正式发行使用原生 CI 构建，见 [发行流程](releasing.md)。
各项测试与架构要求见 [AGENTS.md](../AGENTS.md)，真实窗口测试见 [桌面测试](real-use-case-tests.md)。

## 双击 exe 没有窗口

先查看当前数据目录下的 `whichvideo.log`：

| 运行形态 | 默认位置 |
| --- | --- |
| 便携版 | `exe 同级/data/logs/whichvideo.log` |
| 安装版 | `exe 同级/data/logs/whichvideo.log` |
| 指定 `WHICHVIDEO_DATA_DIR` | `<指定目录>/logs/whichvideo.log` |

日志会记录数据目录、数据库初始化、监听恢复和窗口生命周期。常见处理：

- 已有实例运行：从任务栏恢复原窗口，或在任务管理器结束旧进程后重试。
- 数据库损坏：先备份整个数据目录，再移走 `db/whichvideo.db`、`db/whichvideo.db-wal`、`db/whichvideo.db-shm` 后重启；
  这样会丢失索引状态，但不会删除视频源文件。
- 安装目录只读：应用不会回退到用户目录，请把软件安装或移动到当前用户可写的位置。
- 缺少 WebView2 Runtime：安装微软 WebView2 Runtime 后重试。Windows 10/11 通常已预装。
- 安全软件拦截未签名程序：检查 Windows 安全中心、企业 WDAC/AppLocker 策略和文件属性中的
  “解除锁定”。签名状态见对应版本的发行说明。

若连日志都没有，从 PowerShell 直接运行 exe 以取得退出信息：

```powershell
& '.\WhichVideo.exe'
$LASTEXITCODE
```

## 索引或搜索不可用

探测和抽帧依赖 `ffmpeg.exe` 与 `ffprobe.exe`：

- 正式版不内置媒体工具；首次启动找不到时会显示设置提示。
- 推荐在「索引设置 → 媒体工具」选择同时包含两者的 `bin` 目录。
- 也可加入系统 `PATH`，或设置 `WHICHVIDEO_BIN_DIR`。
- 从 `PATH` 自动查找时，`ffmpeg` 和 `ffprobe` 必须位于同一个目录；不会把两个不同安装位置的工具拼成一对。
- 需要分别指定时，同时设置 `WHICHVIDEO_FFMPEG` 和 `WHICHVIDEO_FFPROBE`，不要混用不同版本。
- 设置页显示当前生效的两个工具路径和已保存的手动目录；环境变量优先于手动目录。安装工具或修改当前进程可见的 `PATH` 后，可点「重新检测」。
- 开发环境可运行 `pnpm fetch:ffmpeg` 放到 `resources/bin`；该目录只在 debug/test 构建中自动探测。

媒体工具缺失不会阻止界面启动，但新增目录后的探测、索引和图片检索会失败。开发者可运行 `pnpm test:rust` 检查后端回归；
部分媒体测试在缺少 FFmpeg 时会跳过，测试通过不能替代工具可用性检查。

搜图卡片缩略图无法显示、或「查看索引帧」提示读取失败时，先确认原视频仍在原路径，
再检查 FFmpeg 配置和 `whichvideo.log`。预览失败不应让弹层一直停在「读取中」。

若启动或索引时出现一闪而过的终端窗口，说明新增的控制台子进程没有调用
`CommandNoWindow::no_window()`；`pnpm test:contract` 会检查所有已登记的启动入口。

## 开发环境下载 FFmpeg 失败

Windows 可运行 `pnpm fetch:ffmpeg` 下载到 `resources/bin`。脚本支持多源回退、超时和缓存；
也可使用本地工具目录或已下载的 ZIP：

```powershell
pnpm fetch:ffmpeg --from 'D:\tools\ffmpeg\bin'
pnpm fetch:ffmpeg --from 'D:\downloads\ffmpeg.zip'
```

代理下载需设置 `HTTPS_PROXY`；Node 24 使用环境代理时还需设置 `NODE_USE_ENV_PROXY=1`。
内置下载源仅提供 Windows 工具，macOS/Linux 请通过系统包管理器安装，或指定本机工具目录。
开发目录中的工具不会打进发行包。

## `pnpm build` / Cargo 编译失败

Windows 构建需要 Rust stable、MSVC C++ Build Tools 和 Windows SDK。先确认：

```powershell
rustc --version
cargo --version
pnpm typecheck
cargo check --manifest-path src-tauri/Cargo.toml
```

常见错误：

- `link.exe` 不存在：安装 Visual Studio Build Tools 的“使用 C++ 的桌面开发”工作负载。
- `c1.dll`、`C1902` 或 `/Z7`：开发机编译器组件不匹配。修复 Build Tools；临时跑测试可设置
  `$env:CARGO_PROFILE_DEV_DEBUG='0'`，完成后移除该环境变量。
- `Access is denied` / `EPERM`：退出正在运行的 WhichVideo、编辑器索引进程和停留在产物目录的
  资源管理器，再重试。Rust 编译目录是 `src-tauri/target`。
- crate 或 npm 包下载超时：确认 Cargo registry、npm registry 和代理设置；依赖已缓存后可离线构建。

## 本机反复构建很慢

`pnpm build:portable` 是正式发行配置：它使用完整 LTO 和单一 codegen 单元，以较长编译时间换取
更小的发布文件。Vite 一般只需数秒；数分钟通常来自 Rust 的链接与 LTO，不是前端没有缓存。

本机反复验证绿色版可使用：

```powershell
pnpm build:portable:fast
```

该命令仍会做类型检查和图标生成，但 Rust 产物写入 `src-tauri/target-fast`，并只对这套缓存启用
Thin LTO、16 个 codegen 单元和 release 增量编译。第一次构建仍可能较慢；之后小改动会复用缓存。
它不改动正式 `src-tauri/target/release`，也不应作为发布或 CI 的构建命令。Cargo 会自动使用可用 CPU，
不需要为了“多线程”再设置 `CARGO_BUILD_JOBS`。

## `pnpm build:win` 的 NSIS 问题

Tauri CLI 会把 NSIS 工具缓存到用户缓存目录。下载中断或缓存损坏时，删除对应的单个 NSIS
缓存版本目录后重试，不要删除整个用户缓存。跨盘临时目录可能导致 `rename` 报错；让 `TEMP`、
`TMP` 与 Tauri 缓存位于同一卷，或先把完整下载目录复制到 CLI 期望的缓存位置。

成功后安装包位于：

```text
src-tauri/target/release/bundle/nsis/
```

安装包不包含媒体工具。发布前至少运行一次 `pnpm build:win`，并在未安装 FFmpeg 的干净环境中
验证首次启动提示，再分别验证 PATH 自动检测、手动目录设置、建索引和卸载。

## `pnpm build:portable` 报占用或权限错误

默认产物是 `dist/WhichVideo-portable`。先关闭正在运行的便携版，再检查占用者：

```powershell
pwsh -File scripts/lib/who-locks-dir.ps1 -Path dist\WhichVideo-portable -All
```

便携构建会尽量保留旧目录中的 `data`。即便如此，替换产物前仍建议备份该目录；不要手工删除
用户数据来解决构建占用。可用 `WHICHVIDEO_RELEASE_DIR` 指定另一个输出根目录。

## 日志和诊断材料

反馈启动、索引或搜索问题时，优先在「索引设置」中点击「导出诊断包」，再附上：

1. 生成的 `whichvideo-diagnostics-*.zip`；
2. 复现步骤以及出问题的视频格式；
3. 若是开发或构建问题，`pnpm test` 或相关单项测试的完整错误。

诊断包仅含白名单中的运行汇总；不会包含日志、视频、缩略图、数据库、文件名、视频/文件夹
路径或 FFmpeg 实际位置。手动粘贴完整日志时仍可能泄露路径，公开分享前请先脱敏。
