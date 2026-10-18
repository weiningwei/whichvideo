# AGENTS.md — WhichVideo 开发指引

> Tauri 2 + Rust + React 19 + Tailwind v4 的本地视频库（以图搜帧）。
> 包管理使用 pnpm，Node.js ≥ 22；桌面后端与打包工具链使用 Rust stable。

## 从仓库根目录执行

所有 `pnpm`、Cargo 和测试命令都以仓库根目录为工作目录。前端源码位于
`src/renderer`，Rust crate 位于 `src-tauri`，但不要切换目录后运行项目脚本。

## 常用命令

```bash
pnpm dev              # Tauri 开发模式（Vite 热更新）
pnpm typecheck        # 渲染端 TypeScript 类型检查
pnpm test             # Rust、桥接契约、便携构建和 UI 回归门禁
pnpm build            # 类型检查 + 图标 + release exe（不生成安装包）
pnpm build:portable   # release exe + ffmpeg/ffprobe → dist/WhichVideo-portable
pnpm build:win        # Tauri NSIS 安装包
pnpm fetch:ffmpeg     # 下载 ffmpeg/ffprobe 到 resources/bin
```

提交前至少运行与改动相关的测试；跨前后端、打包或迁移类改动运行完整 `pnpm test`。

## 架构

```text
src-tauri/src/main.rs         Tauri 初始化、窗口、状态装配与生命周期
src-tauri/src/commands.rs     30 个前端命令入口
src-tauri/src/db.rs           SQLite 持久层与数据目录判定（rusqlite）
src-tauri/src/indexer.rs      抽帧与索引队列
src-tauri/src/search.rs       常驻内存帧索引、检索与时间纠偏
src-tauri/src/media.rs        ffmpeg/ffprobe 调用
src-tauri/src/sampling.rs     场景采样计划
src-tauri/src/watcher.rs      目录监听与变更同步
src-tauri/src/logger.rs       文件日志与 panic 记录
src-tauri/src/frames_store.rs 索引帧落盘、读取与清理
src/renderer/src              React 渲染端
src/shared                    前端共享类型、指纹和 IPC 频道名
```

渲染端只通过 `src/renderer/src/lib/tauri.ts` 调用后端。`src/shared/types.ts` 中的频道名、
桥接映射、`commands.rs` 的命令签名和 `main.rs` 的注册表必须同步；`pnpm test:contract`
会验证 30 个命令没有遗漏。

## 后端关键约束

- 所有版本默认把数据库、日志、索引帧、设置和 WebView 缓存写到 exe 同级 `data`。
  `WHICHVIDEO_DATA_DIR` 可显式覆盖；目标不可写时启动失败，不得回退到用户目录。
- SQLite 使用 WAL。改变表结构时必须保留已有库的迁移路径，不能靠删库升级。
- 帧指纹固定为 16×16 灰度（256 字节）；查询图和视频帧必须使用相同的缩放、
  重采样和均值归一化规则。
- 抽帧批次必须同时限定开始和结束索引。全片解码路径只跑一个批次，避免整片重复解码。
- 多时间点 seek 必须由 ffmpeg filter graph `concat` 成单输出流，并使用
  `-fps_mode passthrough`；不从 `showinfo` 推导 seek 帧时间，直接使用计划时间点，再由搜索阶段纠偏。
- 索引完成、移除视频或目录变化后，数据库、内存索引、帧文件和前端事件必须保持一致。
- 核心功能默认离线。只有用户主动粘贴网页地址或启用版本检查时才允许联网。
- 启动时先确定数据目录并初始化日志，再打开数据库、恢复目录监听和未完成任务。
  panic 信息也要写入同一日志。
- Windows GUI 进程启动 PowerShell、ffmpeg、ffprobe、reg、资源管理器或播放器时，必须通过
  `CommandNoWindow::no_window()` 创建，防止 release 应用闪出控制台窗口。

## 打包约束

- `src-tauri/tauri.conf.json` 是唯一桌面打包配置；`build/icon.ico` 是 Windows 图标源。
- 发布包必须包含 `resources/bin/ffmpeg.exe` 和 `ffprobe.exe`。没有它们时应用可以启动，
  但探测、抽帧和索引功能不可用。
- `build:portable` 生成 `dist/WhichVideo-portable`，包含 exe、两个媒体工具和说明文件。
  重建时必须保留已有 `data`，说明文件不能泄露构建机绝对路径。
- 不要用 UPX 压缩媒体工具；seek 路径会频繁启动进程，解压开销会被放大。
- `.vscode/settings.json` 故意入库，用来排除 `dist`、`target` 和临时目录的监视。

## 测试

```bash
pnpm test:rust        # Rust 单元与模块测试
pnpm test:contract    # 前端桥接、命令实现和注册表一致性
pnpm test:portable    # 便携目录结构、资源和 data 保留
pnpm test:theme       # 语义色 token
pnpm test:cursor      # 列表光标行为
pnpm test:range       # Shift/Ctrl 连选
pnpm test:path        # 路径展示
pnpm test:ui          # UI 静态与行为回归
pnpm test:events      # 后端事件消费
```

Windows MSVC 如果在 Cargo 编译时报告 `c1.dll` 或 `/Z7` 环境问题，可临时设置
`CARGO_PROFILE_DEV_DEBUG=0` 后重跑测试；这只关闭开发产物调试信息，不改变 release 配置。

## UI 约束

- 组件只使用 `primary`、`surface-*`、`line`、`accent` 等语义 token；不要写固定色值。
- 选中行使用左侧 2px 强调条、`bg-row-selected` 和文件名 `text-accent`。
- 操作列的 sticky 单元格必须用不透明行底 token；分组标题拆为内容格和空操作格。
- Shift/Ctrl 点击只阻止修饰键触发的原生文本选择，不要给整行加 `select-none`。
- 连选锚点使用 `useRef`，清空选择时同步清空锚点。
- 键盘导航跳过分组标题；鼠标和键盘入口都要更新 focused index。

## 文档分工

- `README.md`：面向用户的安装、使用和常见问题。
- `docs/how-search-works.md`：指纹、采样、内存布局和检索原理。
- `docs/troubleshooting.md`：开发环境、启动和打包排障。
- `AGENTS.md`：架构约束、开发命令和测试门禁。
