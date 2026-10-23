# WhichVideo · 以图搜视频

<img src="src/renderer/public/favicon-32.png" width="96" alt="WhichVideo 图标" align="right" />

**用一张截图，在本地视频库中查找对应的视频和画面时间点。**

[![最新版本](https://img.shields.io/github/v/tag/weiningwei/whichvideo?sort=semver&filter=v*&label=version)](https://github.com/weiningwei/whichvideo/releases)

WhichVideo 为导入的视频抽帧建立索引，支持截图搜索、相似视频查重和文件夹变化同步。
搜索结果显示文件名、目录、相似度和命中时间；支持定位的播放器可从命中位置起播。

## 下载与安装

从 [Releases](https://github.com/weiningwei/whichvideo/releases) 查看可用版本与平台说明。
目标产物包括 Windows x64 安装包和便携 ZIP、macOS Apple Silicon / Intel `.app` ZIP、Linux x64 AppImage。
非 Windows 平台须经过原生构建和实机验收，支持状态以对应发行说明为准。

1. 将程序安装或解压到当前用户可写的目录。当前 Windows 和 macOS 发行包未签名，可能出现系统安全提示。
2. 准备 **FFmpeg 和 ffprobe**；发行包不内置这两个工具。
3. 启动后若未自动检测到工具，在「索引设置 → 媒体工具」选择同时包含两者的 `bin` 目录。

使用发行包不需要安装 Node.js、pnpm 或 Rust。

## 三步开始

1. **导入视频**：在视频库的「添加」菜单选择视频文件、导入文件夹或监视文件夹。
2. **等待索引完成**：普通导入只扫描一次；监视文件夹会继续同步文件变化。
3. **搜索截图**：在搜图页拖入或选择图片、粘贴截图，也可以输入图片或网页链接。

视频库还支持查重、批量重建索引和文件夹浏览。**从库中移除只删除索引记录，不删除原视频。**
操作细节见 [使用指南](docs/user-guide.md)，快捷键可在应用内按 `?` 查看。

## 常见问题

**搜不到已有的视频？** 先确认索引完成，再尝试更完整、遮挡更少的截图。
采样可能漏掉短暂画面；可尝试场景采样并重建索引，但不能保证覆盖每个镜头。

**相似度是正确率吗？** 不是。它是排序分数，需结合缩略图、目录和播放画面核对；查重结果也需人工确认。

**找不到 FFmpeg 或无法启动？** 见 [排障手册](docs/troubleshooting.md)。

## 隐私与数据

视频、截图和索引保存在本地，不上传。导入、索引和本地搜图离线运行；
主动提交网页链接时会联网取图，启用版本检查时会请求 GitHub Releases。没有遥测或崩溃上报。

默认数据目录是程序同级的 `data`（macOS 为 `.app` 同级，Linux 为 AppImage 同级）。
迁移或备份前先退出应用，再复制程序和整个 `data` 目录。
macOS 的 WebView 界面偏好保存在系统 WebKit 目录，不随程序迁移；索引库不受影响。
详见 [数据与备份](docs/user-guide.md#数据与备份)。

## 开发与文档

技术栈：Tauri 2、Rust、React 19、Tailwind CSS v4、SQLite。
开发需要 Node.js ≥ 22、pnpm ≥ 10、Rust stable、Tauri 系统依赖及 FFmpeg。
在仓库根目录运行：

```bash
pnpm install
pnpm dev
```

- [使用指南](docs/user-guide.md)：导入、搜索、查重、设置和备份
- [检索原理](docs/how-search-works.md)：采样、指纹、评分及限制
- [开发与排障](docs/troubleshooting.md)：构建、媒体工具和诊断
- [桌面自动测试](docs/real-use-case-tests.md)：运行方式与覆盖范围
- [发行流程](docs/releasing.md)：发布与实机验收
- [开发约束](AGENTS.md)：架构、命令和测试门禁

## License

MIT
