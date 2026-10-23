# 桌面自动测试

从仓库根目录执行 `pnpm test:e2e`。需要桌面会话、Node.js、Rust stable、`ffmpeg` 和 `ffprobe`。工具在 `PATH` 中即可，也可用 `WHICHVIDEO_FFMPEG`、`WHICHVIDEO_FFPROBE` 指定可执行文件。Linux 无图形会话时使用 `xvfb-run -a pnpm test:e2e`，并安装 WebKitGTK 开发库及 `webkit2gtk-driver`。

脚本会生成四秒视频和对应截图，在 `tmp/e2e/run-*` 下创建独立数据目录，编译测试专用 Tauri 程序并用 WebdriverIO 驱动真实窗口。当前检查：

1. 递归导入本地目录，等待真实 FFmpeg 索引完成，并在视频库显示视频；重复导入不会生成第二条记录。
2. 用本地截图路径调用真实搜索命令，并在搜图页模拟图片文件拖放，检查结果显示。
3. 关闭并重新启动应用，确认数据库、帧索引和搜图结果恢复。
4. 生成三段不同画面的视频及带标准答案的查询图，在真实索引和搜索后检查基础查询的首位结果，并记录压缩图与库外图片的表现。

每次运行的 `tmp/e2e/run-*/search-dataset/manifest.json` 记录视频、查询图、预期视频和可标注的时间点；同目录的 `report.json` 记录每条查询的排名、前五条结果、耗时和时间误差，以及汇总的 Top-1/Top-5 指标。静态画面没有唯一正确时间点，不纳入平均时间误差。基础查询必须全部排在首位。压缩图与库外图片目前只记录结果，积累稳定基线后再确定回归阈值。合成样本适合发现算法回退；实际截图的裁剪、字幕和编码差异仍需另建获授权的真实样本集评估。

失败时保留 `tmp/e2e/run-*` 中的样本、`data/logs` 和截图；Windows、macOS、Linux CI 都会上传失败证据。测试只使用临时数据目录，不会读取或修改用户现有的视频库。测试不会访问远程图片，版本检查的联网结果不参与判定。

测试构建通过 Cargo `e2e` feature 和 `tauri.e2e.conf.json` 才加载 WebDriver 插件与权限。正式发行配置只启用 `default` capability，正常 `pnpm build` 不含测试插件。
两个 WebDriver 插件仍从 crates.io 获取。测试脚本把本次 Cargo 缓存设为仓库忽略的 `tmp/e2e/cargo-home`，避免插件构建脚本向受保护的系统 Cargo 缓存写入生成的权限文件。首次运行会为这个独立缓存下载 Rust 依赖，之后复用。
CI 为整个测试任务设置同一个 `CARGO_HOME`，因此 `cargo fetch`、`pnpm test` 和桌面用例共用依赖缓存；Rust 缓存 action 也会缓存该目录。
Windows 桌面测试默认关闭开发产物调试信息，以避开部分 MSVC 环境的 `c1.dll` / `/Z7` 编译错误；需要调试符号时可显式设置 `CARGO_PROFILE_DEV_DEBUG`。这不改变 release 配置。

这套自动用例覆盖真实进程、WebView、IPC、SQLite 和 FFmpeg。是否通过以对应提交的测试记录和 CI 结果为准，不能沿用历史结论。桌面文件管理器发起的原生拖放、系统文件选择框、安装与卸载、播放定位，以及各平台实际发行包仍按 [发行验收清单](releasing.md) 手动检查，后续可逐项自动化。
