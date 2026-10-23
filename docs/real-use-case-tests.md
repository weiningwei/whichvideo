# 搜索评测与桌面自动测试

匹配算法评测从仓库根目录运行 `pnpm test:search`；更大规模用 `pnpm test:search:extended`。它们直接调用 Rust 查询预处理与 `FrameSearchIndex::search`，不启动桌面或 WebDriver。需要 Rust stable、`ffmpeg` 和 `ffprobe`；工具在 `PATH` 中即可，也可设置 `WHICHVIDEO_FFMPEG`、`WHICHVIDEO_FFPROBE`。

`pnpm test:e2e` 仍用于真实桌面流程：脚本生成四秒视频和对应截图，在 `tmp/e2e/run-*` 下创建独立数据目录，编译测试专用 Tauri 程序并用 WebdriverIO 驱动真实窗口。Linux 无图形会话时使用 `xvfb-run -a pnpm test:e2e`，并安装 WebKitGTK 开发库及 `webkit2gtk-driver`。当前检查：

1. 递归导入本地目录，等待真实 FFmpeg 索引完成，并在视频库显示视频；重复导入不会生成第二条记录。
2. 用本地截图路径调用真实搜索命令，并在搜图页模拟图片文件拖放，检查结果显示。
3. 关闭并重新启动应用，确认数据库、帧索引和搜图结果恢复。

直接搜索评测用固定种子生成八类画面：色块、条纹、圆环、棋盘、风景、城市轮廓、波纹和斑点。常规模式有 96 张图库基础图、704 张查询图；扩展模式有 192 张图库基础图、2336 张查询图。每张图都生成 JPEG、缩略、裁剪、黑边、遮挡及叠加变换查询；扩展模式再加重裁剪、灰度、模糊和镜像。每类还生成四张未入库的相似画面，用来统计误报。所有样本与标准答案保存在 `tmp/search-benchmark/run-*/dataset/manifest.json`；同目录 `report.json` 给出逐条排名、Top-1/Top-5、误报、耗时和按画面类别、变换类型分组的指标。原图必须全部排首位；变换图和负例只记录结果，积累跨平台基线后再定回归门槛。

这项评测针对单帧指纹与内存检索，不覆盖视频采样、SQLite、重排及时间精修。合成画面能稳定比较算法版本，仍不能代表真实视频内容；真实截图、字幕和编码差异需要另建获授权的真实样本集。

失败时保留 `tmp/e2e/run-*` 中的桌面样本、`data/logs` 和截图，以及 `tmp/search-benchmark/run-*` 中的评测报告；Windows、macOS、Linux CI 会上传失败证据。测试只使用临时数据目录，不会读取或修改用户现有的视频库。测试不会访问远程图片，版本检查的联网结果不参与判定。

测试构建通过 Cargo `e2e` feature 和 `tauri.e2e.conf.json` 才加载 WebDriver 插件与权限。正式发行配置只启用 `default` capability，正常 `pnpm build` 不含测试插件。
两个 WebDriver 插件仍从 crates.io 获取。测试脚本把本次 Cargo 缓存设为仓库忽略的 `tmp/e2e/cargo-home`，避免插件构建脚本向受保护的系统 Cargo 缓存写入生成的权限文件。首次运行会为这个独立缓存下载 Rust 依赖，之后复用。
CI 为整个测试任务设置同一个 `CARGO_HOME`，因此 `cargo fetch`、`pnpm test` 和桌面用例共用依赖缓存；Rust 缓存 action 也会缓存该目录。
Windows 桌面测试默认关闭开发产物调试信息，以避开部分 MSVC 环境的 `c1.dll` / `/Z7` 编译错误；需要调试符号时可显式设置 `CARGO_PROFILE_DEV_DEBUG`。这不改变 release 配置。

这套自动用例覆盖真实进程、WebView、IPC、SQLite 和 FFmpeg。是否通过以对应提交的测试记录和 CI 结果为准，不能沿用历史结论。桌面文件管理器发起的原生拖放、系统文件选择框、安装与卸载、播放定位，以及各平台实际发行包仍按 [发行验收清单](releasing.md) 手动检查，后续可逐项自动化。
