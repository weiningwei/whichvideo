# WhichVideo · 以图搜视频

本地视频库工具：**导入视频或整个文件夹 → 自动抽帧建立指纹索引 → 丢一张图进来，立刻知道这个画面属于哪个视频、这个视频是不是已经在本地库里。**

典型场景：网盘里存了几百集剧集，看到一张截图想确认"这集我下过没有"。

- 单个视频导入：文件多选
- 文件夹递归导入：整棵目录树一次性入库
- 以图搜帧：截图 / 海报 / 缩略图 / 屏摄都能匹配，靠画面内容而不是文件名
- 是否已下载：命中即代表该视频就在本地已导入的目录中，并给出命中时间点
- 文件夹动态更新：被监听目录里新增、覆盖、删除、移动视频，索引自动跟进

---

## 快速开始

```bash
# 1. 安装依赖（node >= 22，pnpm >= 10）
pnpm install

# 2. 准备 ffmpeg（三选一）
#    a) 系统已装 ffmpeg 并加入 PATH —— 脚本会直接复制，不联网
#    b) 从本机已有的安装/压缩包复制到 resources/bin
pnpm fetch:ffmpeg --from "D:\program\ffmpeg\bin"
pnpm fetch:ffmpeg --from "%USERPROFILE%\Downloads\ffmpeg-release-essentials.zip"
#    c) 联网下载（默认多源自动回退，带进度与超时）
pnpm fetch:ffmpeg

# 3. 开发模式运行
pnpm dev

# 4. 类型检查 + 构建
pnpm build

# 5. 打包：绿色版目录 / NSIS 安装包
pnpm build:portable    # → release/WhichVideo-portable/（免安装、免解压，数据写在同级 data\）
                       #   同时再拷一份到仓库上一级目录，直接双击那份即可运行
pnpm build:win         # → release/WhichVideo-0.1.0-x64.exe（安装包，数据写在 %APPDATA%）
```

ffmpeg 查找顺序：`resources/bin` → 环境变量 `WHICHVIDEO_BIN_DIR` / `WHICHVIDEO_FFMPEG` → 系统 `PATH` → 常见安装目录（winget / scoop / chocolatey）。
**找不到 ffmpeg 时程序仍可打开**，只是无法建立索引，界面会明确提示。

### `pnpm fetch:ffmpeg` 下载不动怎么办

`gyan.dev` 与 `github.com` 的连通性在不同网络下差异很大（实测同一条 URL 会时通时断）。脚本已做的处理：

1. **优先复用本机 ffmpeg**：PATH 上有就直接复制，完全不联网
2. **多源自动回退**：BtbN 直链 → BtbN release API → BtbN 固定 tag → xmake 镜像 → gyan.dev
3. **有进度、有超时**：每秒打印进度与速度；默认 30s 收不到新数据就换源，不会无限挂着
4. **缓存与续跑**：已下载的 zip 缓存在 `tmp/ffmpeg-download/`，重跑会复用；`--force` 可强制重下
5. **校验**：检查 ZIP 文件头与体积，解压后确认两个二进制都在

常用参数：

```bash
pnpm fetch:ffmpeg --from "D:\program\ffmpeg\bin"     # 用本机已有的
pnpm fetch:ffmpeg --source btbn                      # 只用一个源
pnpm fetch:ffmpeg --url "https://.../ffmpeg.zip"      # 自定义地址（内网镜像）
pnpm fetch:ffmpeg --idle-timeout 120                 # 放宽空闲超时
pnpm fetch:ffmpeg --force                            # 覆盖已有文件
```

走代理时注意：**Node 的 `fetch` 默认不读系统代理**，需要显式设环境变量（Node 24 还要开 `NODE_USE_ENV_PROXY`）：

```bat
set HTTPS_PROXY=http://127.0.0.1:7890
set HTTP_PROXY=http://127.0.0.1:7890
set NODE_USE_ENV_PROXY=1
pnpm fetch:ffmpeg
```

实在不行就用浏览器下载 zip，再 `pnpm fetch:ffmpeg --from "<下载到的 zip 路径>"`。

> `better-sqlite3` 使用 Node-API 预编译二进制，Electron 与 Node 都直接可用，无需重新编译。
> 如果确实需要重建原生模块，运行 `pnpm rebuild:native`。
> 受限环境（无法写入 pnpm 全局 store）可以这样安装：`pnpm install --store-dir .pnpm-store`，
> 之后 `pnpm run` 也要带上这个环境变量，例如
> `set npm_config_store_dir=%CD%\.pnpm-store && pnpm test`。

---

## 便携（绿色）模式

绿色形态是**免安装目录版**（不是单文件自解压 exe），双击 exe 就地运行，没有解压环节：

```bash
pnpm fetch:ffmpeg       # 可选：把 ffmpeg 一起打包进去
pnpm build:portable     # → release/WhichVideo-portable/  绿色版目录（并拷一份到仓库上一级目录）
pnpm build:win          # → release/WhichVideo-0.1.0-x64.exe  安装包
```

```
WhichVideo-portable\          ← 拷走整个文件夹即可迁移
├─ WhichVideo.exe
├─ 便携版说明.txt
├─ resources\                # app.asar、ffmpeg、原生模块
├─ locales\ *.dll ...
└─ data\                     # 首次运行自动创建
   ├─ whichvideo.db          # 索引库（元数据 + 帧指纹 + 缩略图 + 监听配置）
   ├─ whichvideo.db-wal
   ├─ session\               # Chromium 缓存
   └─ whichvideo.portable    # 便携模式标记
```

- 启动无解压开销（秒开），可以在不同盘符放多份互不干扰
- 索引库、缓存全部写在 `data\`，不在 `%APPDATA%`、`%TEMP%` 留任何东西
- 首次进入便携模式时，如果系统盘里已有旧的索引库，会自动复制一份过去，不会白建一次索引
- ffmpeg 可以放在 exe 同级、`data\bin\` 或随打包分发（`resources/bin`）
- 想固定数据位置（例如放到移动硬盘）：`set WHICHVIDEO_DATA_DIR=E:\WhichVideoData` 再启动
- 安装版仍然使用标准位置 `%APPDATA%\WhichVideo`；界面「索引设置」里能看到当前用的是哪种
- ⚠️ 别把绿色版放进 `Program Files`：那里只读，检测不到可写就会退回默认数据目录

> 没有采用 electron-builder 的单文件 `portable` 目标：那个形态每次启动都要把整个应用（约 250MB）
> 解压到 `%TEMP%`、退出时再删除，启动慢且无法同时运行两份。需要单文件分发时，
> 在 `electron-builder.yml` 的 `win.target` 里临时加回 `portable` 即可。

数据目录判定优先级：`WHICHVIDEO_DATA_DIR` → 便携版启动器注入的 exe 所在目录 → 打包后 exe 所在目录（可写时）→ 默认用户目录。
判定逻辑在 `src/main/datadir.ts`，有独立的单元测试 `pnpm test:portable` 覆盖各种组合。

---

## 使用流程

### 1. 建库

| 操作 | 位置 | 说明 |
| --- | --- | --- |
| 导入视频文件 | 顶部「+ 导入视频」 | 可多选；导入后会自动把它所在目录登记为监听目录 |
| 导入文件夹 | 顶部「+ 导入文件夹」 | 递归扫描整棵目录树，并持续监听 |
| 拖入文件夹 | 「视频库与监听」右侧面板 | 直接把资源管理器里的文件夹拖进来 |
| 重新扫描 | 监听面板 / 列表工具栏 | 手动兜底（例如从网络位置恢复后） |

扫描是流式的：边扫描边入库，界面上的进度、视频数量、帧指纹数量实时变化；抽帧与哈希计算在后台并发队列里跑，不阻塞操作。

### 2. 搜图

- 把图片**拖进窗口**
- **Ctrl+V 粘贴**截图
- 点「选择图片文件」

结果按相似度排序，每张卡片给出：

- 相似度百分比 + 结构 / 颜色分项
- **命中时间点**（视频中第几分几秒出现这个画面）与缩略图
- `已下载 · 本地库中` 状态、文件时长 / 分辨率 / 体积 / 编码
- 播放、定位文件、重新索引

顶部横幅直接给出结论：命中 → "已在本地库中找到这张图对应的视频"；未命中 → "这张图对应的视频大概率还没下载到已导入的目录里"。

### 3. 动态更新

被监听目录（含子目录，深度 32 层）里发生以下变化时，索引自动同步：

| 变化 | 行为 |
| --- | --- |
| 新文件出现 | 等文件写入稳定（默认 1.5s）后自动入队、抽帧、入库 |
| 文件被覆盖/修改 | 大小或修改时间变化 → 旧指纹作废、重新抽帧 |
| 文件被删除 | 从索引库移除对应记录与帧指纹 |
| 整个目录被删除 | 该目录下所有视频记录一并清理 |
| 监听被暂停 | 只停止监听，已入库的数据保留 |

暂停 / 恢复 / 移除监听、重新扫描都在右侧监听面板里操作。移除监听**不会**删除磁盘文件。

---

## 检索原理

1. **抽帧**（`src/main/indexer.ts` + `src/main/scan.ts` + `src/main/media.ts`）
   帧数**按时长分档**（`src/main/media.ts` 的 `framesForDuration`，折点间线性插值）：

   | 时长 | 10 秒 | 1 分 | 5 分 | 10 分 | 30 分 | 1 小时 | ≥2 小时 |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | 帧数 | 8 | 12 | 24 | 36 | 96 | 240 | 240 |

   再与设置里的 `framesPerVideo`（**上限**，默认 240）取小。

   **帧数就是召回率的天花板**，这一点比匹配算法更关键。一集剧平均镜头约 5 秒，
   1 小时约 720 个镜头；采样间隔 `gap = 时长/帧数`，某个镜头至少被采到一帧的概率
   约为 `min(1, 5/gap)`：

   | 1 小时视频 | 56 帧（旧） | 96 帧 | 240 帧（现） |
   | --- | --- | --- | --- |
   | 采样间隔 | 64 秒 | 38 秒 | 15 秒 |
   | 单镜头命中率 | 约 8% | 约 13% | 约 33% |

   换句话说最初那版 92% 的镜头在库里根本没有对应指纹——这类"明明有却搜不到"
   与算法无关，纯粹是采样太稀。

   > 注意：调大 `framesPerVideo` **并不总能增加帧数**——分档表 1 小时折点已封顶 240 帧，
   > 上限设 300 或 400 拿到的都是 240 帧。真正决定抽多少帧的是 `FRAME_COUNT_TABLE`。

   **两条抽帧路径，按帧数自动切换**（`scan.ts::extractAndHash`）：

   | 路径 | 适用 | 成本 |
   | --- | --- | --- |
   | 逐点 seek（每时间点一个 `-ss`） | 少量帧（≤ 48） | 约 25 ms/帧，**与时长无关** |
   | 单次全片解码 + `fps` 采样 | 大量帧（> 48） | 约等于该时长的解码时间，**与帧数无关** |

   实测两条路径在 600 秒视频上约 44 帧处交叉（40 帧时都是 1.1 秒；240 帧时
   逐点 seek 约 6.6 秒 vs 全片解码约 1.7 秒），代码取 48 作为阈值（略保守）。
   正是这个切换让上限得以从 128 提到 240：越过交叉点后每加一帧只多付指纹计算
   （实测 2.5 ms/帧），1 小时 240 帧 ≈ 0.6 秒指纹 + 1.1 秒解码 ≈ 1.7 秒。

   两条路径都缩放到 `-vf scale=w=320:h=-2`、输出 RGB24 到 stdout，
   **不落任何临时图片**。全片解码路径的落点由 `fps=N/时长` 决定，与传入的
   时间点未必逐一对齐（时长估计不准时）；由于搜索只按指纹比对、不依赖精确
   时间点，偏差仅影响 UI 显示的命中时间，可能有一帧左右误差。

2. **指纹**（`src/shared/hash.ts`）
   一帧 320 宽的 RGB24 裸像素压成 **144 字节**（8 + 64 + 64 + 8 元信息），
   全部是手写 TypedArray 位运算，无任何模型与外部依赖。

   **第 0 步 · 灰度化（`toGray`）**
   源图先用**盒式滤波**（区域平均，不是最近邻）缩到 9×8 灰度网格，每个格子取
   覆盖区域所有像素的 BT.601 亮度均值（`0.299R + 0.587G + 0.114B`）。
   之所以用平均而非取点，是因为源图可能来自不同分辨率的截图（PNG 存的是原图，
   视频帧是 320 宽），盒式平均能显著提升对缩放的鲁棒性。
   实测 64×64 的图缩到 9×8，每格约对应 7×8 像素。

   **① 8 字节 · 64bit dHash（`computeDHash`）—— 只做粗筛**
   在 9×8 灰度图上比较**水平相邻**像素：右边是否比左边亮，是则该位记 1，否则记 0。
   8 行 × 8 组相邻 = 64 bit，正好 8 字节。存成 JS 的 64bit `number`
   （低 32 位 + 高 32 位各存一个 `uint32`）。
   特点是对亮度/对比度整体变化几乎免疫，但区分力有限——所以搜索时只拿它做
   **第一层剪枝**（距离 > 24 直接跳过），不参与最终打分。

   **② 64 字节 · 512bit 结构指纹（`computeStructHash`）—— 打分主力**
   把图切成 **16×16 网格**，对 **Y/R/G/B 四个通道各算一遍**，得到 4×256 = 1024 个格子。
   每个通道的 256 个格子算完均值后，逐格比较「本格均值 ≥ 该通道全局均值」：
   成立记 1，否则记 0。

   网格有 256 格但每通道只分配 128 bit，所以要**等距抽样**取一半
   （`Math.floor(bit * 256 / 128)`，步长为 2，均匀落在全部 16 行），
   4 个通道共 512 bit = 64 字节。
   > 曾经的 bug：早期实现按顺序填 bit，填满 128 就停，实际只用了**前 128 格
   > （即前 8 行）**，画面下半部分完全不参与指纹。字幕条、下三分之一构图这类
   > 内容会被系统性低估。现已改为等距抽样，`pnpm test:hash` 守住这条性质。

   这个指纹的关键性质是**纯色画面会退化**：各格均值都等于全局均值，于是所有格
   都记 1，512 bit 高度集中，与任何有纹理的画面都拉不开距离。实测纯色图 1 的占比
   约 12.5%（`cellGrid` 末行边界取不到像素，多数格子仍是 1）。
   这不是缺陷而是刻意留给颜色直方图发挥的空间——所以搜索时**纯色查询图会自动
   提高颜色权重**（见下面第 4 步的 `colorfulness`）。

   **③ 64 字节 · 4×4×4 颜色直方图（`computeColorHistogram`）**
   把 RGB 各用 2 个 bit 分成 4 档（`r>>6`），组合成 `((r>>6)<<4) | ((g>>6)<<2) | (b>>6)`
   共 **64 个分桶**；统计像素落入各桶的频率并归一化（总和为 1）。
   相似度用**直方图相交**：`sum(min(a[i], b[i]))`，即"共有部分"的面积，0~1。
   它负责区分「结构相同但颜色不同」的画面（例如同一构图的实拍版与动画版）。
   另外由 `colorfulness`（主导分桶占比）决定这张表的权重——纯色画面所有像素都落在
   同一个桶，colorfulness 接近 1。

   指纹计算耗时：单帧约 10.4ms（`pnpm bench:frames` 可复测，实测 16/64/128/256 帧
   分别为 2.841 / 2.636 / 2.552 / 2.676 ms，严格线性）。
   1 小时视频 240 帧 → 约 0.6 秒。

   **内存布局**（`src/shared/framepack.ts`，stride = 144 字节）
   三段拼进一个固定步长的连续缓冲区，整块常驻内存、搜索时纯 `DataView` 位运算：

   | 偏移 | 长度 | 内容 |
   | --- | --- | --- |
   | 0 | 8 | 64bit dHash（`writeBigUInt64LE`） |
   | 8 | 64 | 512bit 结构指纹 |
   | 72 | 64 | 64 桶颜色直方图，每桶量化为 1 字节（u8） |
   | 136 | 4 | `frameIndex`（u32） |
   | 140 | 4 | `timeMs`（u32） |

   144 字节 × 10 万帧 ≈ 14MB，正是「10 万帧全量扫描 20ms 以内」的原因。

   **实测距离量级**（512bit 结构指纹，可复现）：

   | 画面关系 | 距离 | 说明 |
   | --- | --- | --- |
   | 同一张图自己比自己 | 0 | 自相似度恒为 1.0 |
   | 同一画面重新压缩（改了几十个像素值） | **3** | 对再压缩极其鲁棒，这是命中率的关键 |
   | 不同画面之间 | 49 ~ 58 | 分离度充足，阈值 224 之下都算候选 |
   | 纯色 vs 有内容 | 250 以上 | 纯色退化后只能靠颜色区分 |

   换句话说：**同一画面的两次不同编码只差个位数 bit，而不同内容差几十 bit**，
   这个落差就是"能不能搜到"的分界线。

3. **存储**（`src/main/db.ts`）
   SQLite 单文件（WAL）。`videos` 存元数据与 JPEG 缩略图，`frames` 每行一条指纹，
   `image_folders` 存监听配置。1 万视频（平均 45 分钟，各 96 帧）≈ 96 万帧 ≈ 内存索引 132MB。

4. **检索**（`src/main/search.ts`）
   全部指纹按固定 stride 载入连续内存。搜索 = 纯内存扫描：
   - 先用 64bit dHash 剪枝，距离过大的帧直接跳过
   - 再算 512bit 结构距离与颜色直方图相交相似度
   - **自适应加权**：查询图颜色越鲜明（越接近纯色），颜色权重越高（0.3 → 0.7）；
     纹理丰富时以结构为主。这样纯色截图能稳稳命中同色画面，而不会误配到彩色画面。
   - 视频分数 = 最佳帧 0.75 + 次佳帧 0.25，避免单帧偶然命中
   帧数上限提高后扫描量同比上升（1 万视频约 96 万帧），但仍是纯内存位运算，
   10 万帧全量扫描在 20ms 以内，搜索响应基本等于解码查询图的时间。

### 自检与调参脚本

| 命令 | 作用 |
| --- | --- |
| `pnpm test` | 依次跑下面各套自检 |
| `pnpm test:config` | 打包配置校验（16 项）：别名声明、入口存在、不使用 __dirname、校验工作目录 |
| `pnpm test:startup` | 主进程启动自检（40 项）：打包前提、窗口创建与显示、**极早期日志**、便携目录、失败可见、单实例锁、GPU 沙箱规避 |
| `pnpm test:core` | 端到端核心自检（26 项）：指纹精度、排序正确性、未下载判定、检索性能、库管理 |
| `pnpm test:portable` | 便携模式数据目录判定（18 项）：环境变量 / 便携启动器 / 只读目录回退 / 打包目标 |
| `pnpm test:pack` | 绿色版打包脚本自检（28 项）：重建覆盖、旧 data 清理、占用时改名挪开/自动换目录、产物不全或过期时拒绝打包 |
| `pnpm test:asar` | asar 解析与包新鲜度校验自检（7 项）：直接读包内 out/main/index.js 与本地产物比对 |
| `pnpm test:frames` | 抽帧时长分档策略自检（25 项）：单调不减、封顶 240、设置作上限、抽帧路径按交叉点切换、采样间隔与镜头命中率 |
| `pnpm test:hash` | 结构指纹覆盖度自检（12 项）：指纹必须覆盖全部 16 行、上下半判别力对称、纯色退化性质未回归 |
| `pnpm test:ui` | 渲染端组件冒烟（57 项）：真实 React 组件服务端渲染后断言关键文案与状态 |
| `node scripts/bench-hash.mjs` | 对比几种结构指纹方案的区分度（选型依据） |
| `pnpm bench:hash` | 打印指纹各阶段细节：9×8 灰度矩阵、dHash 比特、每通道 1 的分布、纯色退化比例、距离矩阵、单帧耗时 |
| `node scripts/bench-score.mjs` | 对比几种打分加权公式的排序边距 |
| `node scripts/calibrate.mjs` | 校准"截图 ↔ 视频帧"的哈希距离量级 |

> 注：`test:core` 里真实的抽帧流水线需要 `ffmpeg` 且允许子进程管道。在禁止子进程管道的受限沙箱里，
> 依赖管道的部分会自动标记 SKIP 并给出原因，而核心链路（真实帧数据 → 真实哈希/量化/检索/排序）仍完整验证。

---

## 项目结构

```
src/
├─ main/                  # Electron 主进程
│  ├─ index.ts            # 窗口、IPC、生命周期
│  ├─ db.ts               # SQLite 索引层（videos / frames / image_folders / settings）
│  ├─ search.ts           # 常驻内存帧索引 + 相似度打分
│  ├─ indexer.ts          # 扫描/抽帧/哈希 队列与进度播报
│  ├─ watcher.ts          # chokidar 文件夹动态监听
│  ├─ media.ts            # ffmpeg / ffprobe 封装与二进制查找
│  └─ scan.ts             # 目录递归扫描、抽帧命令拼装
├─ preload/index.ts       # contextBridge 暴露的类型化 API
├─ shared/                # 主进程与渲染端共用
│  ├─ types.ts            # 类型契约 + IPC 频道名
│  ├─ hash.ts             # dHash / 512bit 均值归一化结构指纹 / 颜色直方图
│  └─ framepack.ts        # 144 字节/帧的内存布局、打包与量化
└─ renderer/              # React 19 + Tailwind v4 界面
   └─ src/
      ├─ App.tsx
      ├─ hooks/useLibrary.ts        # 主状态 + 主进程事件订阅
      ├─ components/{Header,SearchView,LibraryView,SettingsPanel,StatusBar}.tsx
      └─ lib/format.ts
```

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发模式（渲染端热更新） |
| `pnpm typecheck` | 主进程 + 渲染端类型检查 |
| `pnpm build` | 类型检查并构建到 `out/` |
| `pnpm build:portable` | 打包绿色版目录 `release/WhichVideo-portable/`（免安装、免解压），并再拷一份到仓库上一级目录 |
| `pnpm build:win` | 打包 NSIS 安装包 `release/WhichVideo-<版本>-x64.exe` |
| `pnpm build:unpack` | 只出 `release/win-unpacked/`（不做安装包） |
| `pnpm fetch:ffmpeg` | 下载 ffmpeg/ffprobe 到 `resources/bin` |

## 配置项

界面「索引设置」里可调，持久化在 SQLite 的 `settings` 表：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `framesPerVideo` | 240 | 每视频抽帧数**上限**。实际帧数按时长策略决定（见「检索原理」的表），与本值取小。调到 16 会把 15 分钟以上的视频压到 16 帧。**调大它并不总能增加帧数**：分档表 1 小时折点已封顶 240 帧，上限设 300 或 400 拿到的都是 240 帧。另外超过约 48 帧后抽帧会自动切到更快的路径，提高上限不会明显拖慢索引 |
| `concurrency` | 2 | 并发解码数；机械硬盘用 1~2 |
| `minHashScore` | 0.6 | 帧级结构相似度下限，调低可召回更多弱匹配 |
| `maxResults` | 40 | 搜索结果条数上限 |
| `awaitWriteMs` | 1500 | 新文件写入稳定等待，避免把正在复制的文件入库 |
| `pruneOnDelete` | true | 文件被删除时自动清理索引记录 |

索引库位置：`%APPDATA%/WhichVideo/whichvideo.db`（界面里点「打开索引库位置」可直接跳转）。清空索引库只删数据库内容，不动视频文件。

## 常见问题

**搜不到明明存在的画面？**
先确认该视频状态是「已索引」，再点「重建全部索引」。
**最常见的原因其实是采样太稀**：一集剧约 720 个镜头（平均 5 秒一个），
1 小时抽 240 帧（间隔 15 秒）意味着每个镜头约 33% 的概率被采到——画面没被索引，搜再多也没用。
若你的素材镜头更长（访谈、录屏、静态图）这一项通常不是瓶颈；若仍是快切内容，
可继续上调 `FRAME_COUNT_TABLE`（改表，不是改设置项）。
匹配阈值也可从 0.6 调到 0.65 以减少误召回。
画面差异极大的情况（截图经过了裁剪、加字幕遮挡、强滤镜）会降低命中率，此时取视频中更完整的一帧作为查询图。

> 升级提示：结构指纹改为**全图等距抽样**（此前只编码了画面上半部分，字幕条、下三分之一构图
> 会被系统性低估），因此**已有索引库里的老指纹全部失效**，需点「重建全部索引」。
> 抽帧分档表也已整体上调（1 小时 56 → 240 帧，封顶 64 → 240），并新增"单次全片解码"
> 抽帧路径（帧数超约 48 帧时自动启用），所以索引时间没有随帧数线性增长。

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

> 注意：占用跟进程 exe 在哪**没有关系**。Sublime 装在 `D:\SublimeText`，但它的 `plugin_host`
> 进程只要把项目目录当作当前工作目录（CWD）或扫描了 `release`，就会锁住这里。

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
- **换目录**：复制到 `D:\test\` 或桌面再试（排除 E 盘权限 / OneDrive / 网络盘）

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
排查命令：`git status --ignored=matching --porcelain --untracked-files=all | findstr /v node_modules`。

**为什么相似度普遍 70%~80%？**
不同分辨率、不同压缩率的画面本身就会有几十个 bit 的结构差异，属正常范围。分数梯队（几乎确定 / 高度相似 / 可能匹配 / 弱匹配）比绝对值更有参考意义。

**支持哪些格式？**
mp4 / mkv / avi / mov / wmv / flv / webm / m4v / ts / m2ts / mpg / mpeg / rmvb / rm / 3gp，只要 ffmpeg 能解码即可。

**索引库能有多大？**
每帧指纹 144 字节，1 小时视频 240 帧（约 34KB）、半小时 96 帧（约 14KB）。
按 1 万个平均 45 分钟的剧集算约 96 万帧、内存索引 132MB；10 万帧量级时 14MB、
全量扫描约 20ms。搜索是纯内存位运算，库再大几个数量级也只是扫描时间线性增长。

## License

MIT
