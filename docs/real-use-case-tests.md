# 桌面自动测试

从仓库根目录执行 `pnpm test:e2e`。需要桌面会话、Node.js、Rust stable、`ffmpeg` 和 `ffprobe`。工具在 `PATH` 中即可，也可用 `WHICHVIDEO_FFMPEG`、`WHICHVIDEO_FFPROBE` 指定可执行文件。Linux 无图形会话时使用 `xvfb-run -a pnpm test:e2e`，并安装 WebKitGTK 开发库及 `webkit2gtk-driver`。

脚本会生成四秒视频和对应截图，在 `tmp/e2e/run-*` 下创建独立数据目录，编译测试专用 Tauri 程序并用 WebdriverIO 驱动真实窗口。当前检查：

1. 递归导入本地目录，等待真实 FFmpeg 索引完成，并在视频库显示视频；重复导入不会生成第二条记录。
2. 用本地截图路径调用真实搜索命令，并在搜图页模拟图片文件拖放，检查结果显示。
3. 关闭并重新启动应用，确认数据库、帧索引和搜图结果恢复。

失败时保留 `tmp/e2e/run-*` 中的样本、`data/logs` 和截图；Windows、macOS、Linux CI 都会上传失败证据。测试只使用临时数据目录，不会读取或修改用户现有的视频库。测试不会访问远程图片，版本检查的联网结果不参与判定。

测试构建通过 Cargo `e2e` feature 和 `tauri.e2e.conf.json` 才加载 WebDriver 插件与权限。正式发行配置只启用 `default` capability，正常 `pnpm build` 不含测试插件。

这套自动用例覆盖真实进程、WebView、IPC、SQLite 和 FFmpeg。是否通过以对应提交的测试记录和 CI 结果为准，不能沿用历史结论。桌面文件管理器发起的原生拖放、系统文件选择框、安装与卸载、播放定位，以及各平台实际发行包仍按 [发行验收清单](releasing.md) 手动检查，后续可逐项自动化。
