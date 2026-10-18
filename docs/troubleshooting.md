# 排障手册

> 面向开发者与打包维护者。普通使用问题见 [README](../README.md)。

## 双击 exe 没有窗口

先查看当前数据目录下的 `whichvideo.log`：

| 运行形态 | 默认位置 |
| --- | --- |
| 便携版 | `exe 同级/data/whichvideo.log` |
| 安装版 | `exe 同级/data/whichvideo.log` |
| 指定 `WHICHVIDEO_DATA_DIR` | `<指定目录>/whichvideo.log` |

日志会记录数据目录、数据库初始化、监听恢复和窗口生命周期。常见处理：

- 已有实例运行：从任务栏恢复原窗口，或在任务管理器结束旧进程后重试。
- 数据库损坏：先备份整个数据目录，再移走 `whichvideo.db`、`-wal`、`-shm` 后重启；
  这样会丢失索引状态，但不会删除视频源文件。
- 安装目录只读：应用不会回退到用户目录，请把软件安装或移动到当前用户可写的位置。
- 缺少 WebView2 Runtime：安装微软 WebView2 Runtime 后重试。Windows 10/11 通常已预装。
- 安全软件拦截未签名程序：检查 Windows 安全中心、企业 WDAC/AppLocker 策略和文件属性中的
  “解除锁定”。发布前应为安装包和 exe 配置代码签名。

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
- 需要分别指定时，同时设置 `WHICHVIDEO_FFMPEG` 和 `WHICHVIDEO_FFPROBE`，不要混用不同版本。
- 开发环境可运行 `pnpm fetch:ffmpeg` 放到 `resources/bin`；该目录只在 debug/test 构建中自动探测。

媒体工具缺失不会阻止界面启动，但新增目录后的探测、索引和图片检索会失败。先运行
`pnpm test:rust` 区分后端逻辑问题与本机媒体工具问题。

搜图卡片缩略图无法显示、或「查看索引帧」提示读取失败时，先确认原视频仍在原路径，
再检查 FFmpeg 配置和 `whichvideo.log`。预览失败不应让弹层一直停在「读取中」。

若启动或索引时出现一闪而过的终端窗口，说明新增的控制台子进程没有调用
`CommandNoWindow::no_window()`；`pnpm test:contract` 会检查所有已登记的启动入口。

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

诊断包仅含运行汇总与最近 200 行脱敏日志；不会包含视频、缩略图、数据库、视频/文件夹
路径或 FFmpeg 实际位置。手动粘贴完整日志时仍可能泄露路径，公开分享前请先脱敏。
