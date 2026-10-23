# 多平台发行流程

目标产物：Windows x64 NSIS + 便携 ZIP、macOS Apple Silicon / Intel 两种 `.app` ZIP、Linux x64 AppImage。每个平台都由 GitHub Actions 对应的原生 runner 编译，不能用本地旧产物替代。Tauri 的打包目标由各平台脚本显式指定。

## 版本与发布

每次发布同步修改 `package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 的版本号，并新增 `docs/releases/vX.Y.Z.md`。`pnpm test:release` 检查三处版本和说明；推送 `vX.Y.Z` 标签后流水线还会校验标签一致。版本说明应人工归纳功能、修复和限制；GitHub 自动说明只补充 PR 变更，直接提交的改动须用 `git log` 核对。

1. 合并代码后，从 GitHub Actions 手动运行 `Desktop checks`，等待 Windows、macOS、Linux 三个 runner 全部通过；`pnpm test` 会先生成契约测试需要的图标。
2. 在各平台做下面的手动验收，尤其检查原生窗口、文件对话框、FFmpeg 探测与安装目录写权限。
3. 推送版本标签。`Desktop release draft` 重新运行测试和原生构建，收集三个平台的资产，生成 `SHA256SUMS.txt`，创建 GitHub Release 草稿。不要使用本地 `dist`。该流程仅由版本标签触发；失败时在 Actions 中重跑对应运行，不从普通分支手动创建草稿。
4. 核对资产名、校验和、版本说明和签名状态；全部通过后人工发布草稿。任一平台未验收不得标为稳定支持，可先标记为预览版并明确限制。

## 手动验收

- 从发行资产解压或安装到**可写目录**，首次启动后确认同级 `data` 中产生数据库与日志；关闭重启后数据保留。WebView 缓存位置见 [使用指南](user-guide.md#数据与备份)。
- 导入单视频和嵌套文件夹，等待建索引；重建索引、搜索截图和网页图片、粘贴剪贴板截图、查重、播放定位、在文件管理器中定位。
- 从文件管理器向视频库拖入视频和目录，向搜图页拖入本地图片；确认目录的一次性导入与监视管理抽屉的持续监视行为不同。
- 重复导入未变化的视频应保持已建索引；检查缩略图正常显示、搜索最佳结果的命中时间可定位到正确画面，并分别试均匀与场景采样。
- 未安装 FFmpeg 时出现提示；手动指定 `ffmpeg`/`ffprobe` 目录后能索引；清除设置后按环境变量与 PATH 重新探测。
- 监听文件夹的新增/删除同步；移动整个便携目录后索引数据保留；升级覆盖程序文件但保留 `data` 后正常启动；若指纹预处理改变，验证重建索引后的搜索结果。
- Windows 在干净的 Windows 10/11 x64 上测 NSIS 和便携 ZIP；macOS 分别在 Apple Silicon 和 Intel Mac 上测各自 `.app` ZIP；Linux 在 x64 桌面上测 AppImage（含 X11/Wayland）。
- ZIP 不含测试者的 `data`、FFmpeg 或构建机绝对路径；比对 `SHA256SUMS.txt`。

## 安装目录数据与分发限制

所有平台都将数据保存在程序旁的 `data`，或由 `WHICHVIDEO_DATA_DIR` 显式覆盖。Windows NSIS 默认安装到当前用户可写位置。macOS `.app` **应放在可写目录**，数据位于 `.app` 同级；`/Applications` 通常不可写，不能直接套用系统常规安装流程。Linux AppImage 使用 `APPIMAGE` 所指文件的同级目录，不写入临时挂载镜像。以上限制应在下载说明中清楚告知。

当前没有 Windows 代码签名证书，也没有 Apple Developer 签名/公证。Windows 可能触发 SmartScreen，macOS 可能因 Gatekeeper 阻止打开；正式稳定发行前应增加受保护的签名密钥和原生签名步骤。不要在仓库中保存证书或密码。发布草稿不等于已通过实机验收。
