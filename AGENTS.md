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
pnpm test:e2e         # 真实桌面用例：FFmpeg 导入、索引、搜图与重启恢复（Linux CI 用 xvfb-run）
pnpm build            # 类型检查 + 图标 + release exe（不生成安装包）
pnpm build:portable   # 轻量 release exe → dist/WhichVideo-portable（不内置 FFmpeg）
pnpm build:win        # Tauri NSIS 安装包
pnpm build:mac        # macOS .app（Apple Silicon / Intel 原生 runner）
pnpm build:linux      # Linux AppImage（x64 runner）
pnpm fetch:ffmpeg     # Windows 下载 ffmpeg/ffprobe 到 resources/bin；其他平台用系统包管理器
```

提交前至少运行与改动相关的测试；跨前后端、打包或迁移类改动运行完整 `pnpm test`。

## 架构

```text
src-tauri/src/main.rs         Tauri 初始化、窗口、状态装配与生命周期
src-tauri/src/commands.rs     前端命令入口
src-tauri/src/db.rs           SQLite 持久层（rusqlite）
src-tauri/src/paths.rs        数据目录判定与全部落盘路径
src-tauri/src/indexer.rs      抽帧与索引队列
src-tauri/src/search.rs       常驻内存帧索引、检索与时间纠偏
src-tauri/src/search_service.rs 查询图指纹、候选重排与搜索结果编排
src-tauri/src/media.rs        ffmpeg/ffprobe 调用
src-tauri/src/platform_open.rs 原生打开文件、定位和发布页
src-tauri/src/url_image.rs    跨平台网页取图
src-tauri/src/sampling.rs     场景采样计划
src-tauri/src/watcher.rs      目录监听与变更同步
src-tauri/src/logger.rs       文件日志与 panic 记录
src-tauri/src/frames_store.rs 索引帧落盘、读取与清理
src/renderer/src              React 渲染端
src/renderer/src/hooks/useLibraryImports.ts 视频导入与目录监听操作
src/renderer/src/hooks/useLibraryColumns.tsx 视频表格列宽与调整交互
src/renderer/src/components/FolderCard.tsx 文件夹状态、卡片与图标
src/renderer/src/lib/ipc-contract.ts IPC 返回值与事件运行时校验
src/shared                    前端共享类型、指纹和 IPC 频道名
```

渲染端只通过 `src/renderer/src/lib/tauri-api.ts` 调用后端。`src/shared/types.ts` 中的频道名、
桥接映射、`commands.rs` 的命令签名和 `main.rs` 的注册表必须同步；`pnpm test:contract`
会验证命令没有遗漏。
新增 IPC 命令时也要在 `ipc-contract.ts` 登记返回值校验；组件与 hook 不直接使用 `invoke<T>`。
`pnpm test:ipc` 验证字段缺失或类型错误时在桥接层失败，不把 `undefined` 带进 UI。

## 错误处理

- IPC 命令失败统一返回 `error::AppError`（`code`、`message`、`operation`），通过
  `error::command_result` 在命令边界记录一次日志。内部模块可保留原生 `Result`，不要重复记录同一次传播的错误。
- 未分类的旧字符串错误使用 `internal`，不根据中文文案猜测错误码。
- 前端桥接将调用异常规范化为 `lib/errors.ts` 的 `AppError`；返回值校验失败使用
  `invalid-response`。界面通过 `errorMessage` 提取可读文案，不直接 `String(error)`。
- 基础错误层不弹通知、不自动重试。普通操作用 `useBusy`，搜索和刷新保留页面内错误与重试，
  预览保留局部回退，避免重复提示。搜索响应中的 `error/errorCode`、批量操作的部分失败与
  后台任务状态属于业务结果，保留各自契约，不当作整个 IPC 调用失败。
- IPC 命令需要运行同步 I/O 或 CPU 工作时统一调用 `error::blocking`，由它转换阻塞线程 panic/取消；
  命令模块不得直接调用 `spawn_blocking`。
- `pnpm test:errors` 验证错误规范化与桥接失败行为，并纳入完整 `pnpm test`。

## 日志

- 后端统一使用 `logger::{info,warn,error}`，并从 `logger::Module` 选择归属模块；不要在文案中手写
  `[WARN]`、`[indexer]` 等前缀，也不要直接 `eprintln!`。日志格式固定为
  `时间 + 级别 + 模块 + 稳定事件名 + key=value 上下文`。
- 后端库事件统一通过 `events::emit` 发送；业务模块不得直接调用 Tauri `emit` 或静默丢弃发送错误。
  发送失败只记录稳定事件类型和原始错误，不记录完整事件载荷。
- 错误只在负责处理或对外返回的边界记录一次。IPC 失败由 `error::command_result` 记录；内部函数用
  `?` 传播时不重复记录。后台任务自行处理的失败由所属模块记录。
- 日志应包含定位所需的操作名、视频或文件夹 ID、路径、回退动作和原始错误；不得记录图片数据、
  指纹、剪贴板内容等大块或敏感载荷。换行会被压成单行，便于搜索和诊断。
- 不记录用户取消对话框、普通轮询成功、已是最新版、正常退出等低价值过程。相同日志在 30 秒内
  自动抑制；高频循环使用稳定的去重键，下一次输出以 `repeated=N` 汇总被抑制次数。

## 后端关键约束

- 所有版本默认把数据库、日志、索引帧、设置和 WebView 缓存写到程序同级 `data`（macOS `.app` 和 Linux AppImage 取包文件同级），
  按用途分 `db/`、`logs/`、`frames/`、`session/` 四个子目录；路径只在 `paths.rs` 拼接，不要在别处硬编码文件名。
  `WHICHVIDEO_DATA_DIR` 可显式覆盖；目标不可写时启动失败，不得回退到用户目录。
- SQLite 使用 WAL。改变表结构时必须保留已有库的迁移路径，不能靠删库升级。
- 数据库连接在启动阶段建立，运行期不可为空。业务模块只通过 `AppState::db()` 或后台任务使用的
  `AppState::db_recover()` 访问连接，不得直接锁字段或重复处理“数据库未初始化”分支。
- 每帧打包为 256 字节（dHash、1024bit 四通道结构指纹、颜色直方图、空间布局和元信息）；查询图和视频帧必须使用相同的缩放、
  重采样和均值归一化规则。
- 抽帧批次必须同时限定开始和结束索引。全片解码路径只跑一个批次，避免整片重复解码。
- 多时间点 seek 必须由 ffmpeg filter graph `concat` 成单输出流，并使用
  `-fps_mode passthrough`；不从 `showinfo` 推导 seek 帧时间，直接使用计划时间点，再由搜索阶段纠偏。
- 索引完成、移除视频或目录变化后，数据库、内存索引、帧文件和前端事件必须保持一致。
- 核心功能默认离线。只有用户主动粘贴网页地址或启用版本检查时才允许联网。
- 启动时先确定数据目录并初始化日志，再打开数据库、恢复目录监听和未完成任务。
  panic 信息也要写入同一日志。
- Windows GUI 进程启动 ffmpeg、ffprobe、reg、资源管理器或播放器时，必须通过
  `CommandNoWindow::no_window()` 创建，防止 release 应用闪出控制台窗口。
- 路径比较按平台处理：Windows 统一反斜杠并忽略大小写，macOS/Linux 保留斜杠和大小写；监听器去重键必须与数据库一致。

## 打包约束

- `src-tauri/tauri.conf.json` 是主打包配置；macOS 有图标覆盖配置 `tauri.macos.conf.json`；`build/icon.ico` 是 Windows 图标源。
- `src-tauri/icons/icon.icns` 随仓库保留供 macOS 开发模式使用；更换图形后要从新生成的 `build/icon.png` 同步更新 ICNS。`build:mac` 会自动重新生成发布用 ICNS。
- 发布包不得包含 `ffmpeg` / `ffprobe`。启动探测顺序为显式环境变量、用户手动目录、系统 PATH；
  缺失时必须提示用户，并允许在设置中选择同时包含两个工具的 `bin` 目录。
- `build:portable` 生成 `dist/WhichVideo-portable`，包含 exe 和说明文件。
  重建时必须保留已有 `data`，说明文件不能泄露构建机绝对路径。
- `.vscode/settings.json` 故意入库，用来排除 `dist`、`target` 和临时目录的监视。

## 测试

```bash
pnpm test:rust        # Rust 单元与模块测试
pnpm test:contract    # 前端桥接、命令实现和注册表一致性
pnpm test:ipc         # IPC 返回值和事件运行时校验
pnpm test:portable    # 便携目录结构、资源和 data 保留
pnpm test:release     # 三处版本号、跨平台构建脚本与版本说明
pnpm test:theme       # 语义色 token
pnpm test:cursor      # 列表光标行为
pnpm test:range       # Shift/Ctrl 连选
pnpm test:path        # 路径展示
pnpm test:ui          # UI 静态与行为回归
pnpm test:events      # 后端事件消费
pnpm test:async       # 刷新失败、分页取消和链接输入恢复
```

Windows MSVC 如果在 Cargo 编译时报告 `c1.dll` 或 `/Z7` 环境问题，可临时设置
`CARGO_PROFILE_DEV_DEBUG=0` 后重跑测试；这只关闭开发产物调试信息，不改变 release 配置。

## 发行边界

- 源码已适配 Windows x64、macOS Apple Silicon / Intel 与 Linux x64；非 Windows 平台必须通过 CI 原生构建和实机验收后才能称为稳定支持。
- GitHub Actions 在推送 `vX.Y.Z` 标签后从该提交分别构建 NSIS、便携 ZIP、`.app` ZIP、AppImage，生成校验和并创建发行草稿；不上传本机 `dist` 或 `target` 产物。
- 每版同步三个版本号和 `docs/releases/vX.Y.Z.md`，运行 `pnpm test:release`；发布说明的人工作者摘要与 PR 自动分类互补。
- 草稿需经过三个系统的手动验收后才公开。Windows/Apple 均未签名，SmartScreen/Gatekeeper 风险须在首版说明中写清楚。完整流程见 `docs/releasing.md`。

## UI 约束

- 组件只使用 `primary`、`surface-*`、`line`、`accent` 等语义 token；不要写固定色值。
- 全局顶栏只放品牌、主导航和运行状态；导入、筛选、设置等动作归属具体页面。
- 视频库默认显示文件夹视图：导入目录逐层展开，单独导入的视频直接留在顶层；也能切到「全部视频」。监视管理与索引设置使用按需抽屉，不得常驻挤压列表。
- 三种导入方式统一放在「添加」菜单；高级库操作放在「更多」，不要平铺一整排按钮。
- 视频表格保持五列（视频、状态、时长、大小、操作），不加行尾复选框；行内只露出播放和更多两个高频入口。
- 文件夹行只负责浏览和过滤，不放批量选择复选框；视频选择通过点击列表行完成。
- 查重结果和搜图结果中的视频必须显示目录，同名文件不能只靠悬停提示区分；查重移除须按后端实际成功的 ID 更新结果。
- 异步搜索的新请求或清除操作必须使旧响应失效；媒体预览失败必须有回退或错误提示，不能无限加载。
- 渲染端会更新页面状态的异步请求统一使用 `useRequestGate`；新请求、清除和组件卸载都必须让旧响应失效，
  不要在各 hook 内重复维护请求序号。
- 选中行使用左侧 2px 强调条、`bg-row-selected` 和文件名 `text-accent`。
- 操作列的 sticky 单元格必须沿用不透明的 `row-*` 行底 token。
- Shift/Ctrl 点击只阻止修饰键触发的原生文本选择，不要给整行加 `select-none`。
- 连选锚点使用 `useRef`，清空选择时同步清空锚点。
- 键盘导航跳过分组标题；鼠标和键盘入口都要更新 focused index。

## 文档分工

- `README.md`：面向用户的安装、使用和常见问题。
- `docs/user-guide.md`：详细操作、索引设置和数据备份。
- `docs/how-search-works.md`：指纹、采样、内存布局和检索原理。
- `docs/troubleshooting.md`：开发环境、启动和打包排障。
- `AGENTS.md`：架构约束、开发命令和测试门禁。
