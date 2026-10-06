/**
 * 主进程常量统一导出。
 *
 * 只收**主进程私有**的魔法数字与阈值；跨端共享的布局常量归 `@shared/framepack`
 * （FRAME_STRIDE / STRUCT_BYTES 等），颜色权重归 `@shared/hash`，数据目录文件名
 * 归 `datadir.ts` —— 同一个事实只允许有一个定义处，这里不重复导出。
 */

// ===== 抽帧策略 =====
/** 抽帧统一缩放到该宽度，兼顾速度与结构辨识度 */
export const EXTRACT_WIDTH = 320

/** ffprobe 探测缩略图的最大宽度 */
export const PROBE_MAX_WIDTH = 320

/**
 * 每视频抽帧数：按时长插值的分档表（时长秒 → 帧数），之间线性插值再取整到偶数。
 *
 * 为什么不用固定帧数：解码耗时只与视频时长有关、与帧数几乎无关，长视频"省帧"
 * 省不到时间，却显著牺牲召回。帧数是召回率的天花板——1 小时只给 56 帧时实测
 * 命中率仅约 8%。越过 SEEK_VS_FULLSCAN_CROSSOVER 后走全片解码，加帧只多付
 * 指纹计算，所以 1 小时给到 240 帧。帧数再多则内存与库体积线性增长、边际收益
 * 递减，故封顶 240。
 */
export const FRAME_COUNT_TABLE: ReadonlyArray<readonly [seconds: number, frames: number]> = [
  [0, 8],
  [30, 10],
  [60, 12],
  [300, 24],
  [900, 48],
  [1800, 96],
  [3600, 240],
  [7200, 240]
]

/**
 * 两条抽帧路径的成本交叉点（帧数）：逐点 seek 约 25 ms/帧线性增长，全片解码
 * 成本与帧数无关只随时长；实测 600 秒视频 40 帧时两者都是 1.1 秒，取 48 略保守。
 */
export const SEEK_VS_FULLSCAN_CROSSOVER = 48

/** 帧数封顶的兜底上限（用户设置 `framesPerVideo` 也是封顶，与策略值取小） */
export const DEFAULT_FRAME_BUDGET = 240

// ===== 指纹与检索 =====
/** dHash 剪枝阈值：超过该距离的帧不可能成为好匹配 */
export const DHASH_PRUNE_BITS = 24

/** 结构距离上限：超过则直接丢弃（512bit 中 224bit 不同） */
export const STRUCT_PRUNE_BITS = 224

// ===== 网络请求（仅 url-image.ts 链接取图） =====
/** 单个响应体上限（字节，10 MB） */
export const MAX_BYTES = 10 * 1024 * 1024

/** 整体超时（毫秒） */
export const TIMEOUT_MS = 15_000

/** 最多跟随的重定向跳数 */
export const MAX_REDIRECTS = 5

/** 抓网页时，解析出的图片地址最多再请求几层（1 = 只解析当前页） */
export const MAX_IMAGE_FETCHES = 2

/** 请求头 UA：只表明工具身份，不带本机任何标识（见 test:network） */
export const USER_AGENT = 'WhichVideo/0.1 (local image search)'

// ===== 文件扫描 =====
/** 递归扫描最大深度 */
export const MAX_SCAN_DEPTH = 24

/** 默认跳过的目录名（系统目录 + 构建产物 + VCS） */
export const DEFAULT_SKIP_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'node_modules',
  '.git',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'appdata'
])

// ===== 日志 =====
/** 日志文件最大字节，超过则轮转截断 */
export const MAX_LOG_BYTES = 512 * 1024

// ===== 版本检查 =====
/** GitHub Releases 最新版查询地址（updateCheck 开启时启动后检查一次） */
export const UPDATE_CHECK_URL = 'https://api.github.com/repos/weiningwei/whichvideo/releases/latest'
/** 版本检查超时（ms）：后台静默检查，绝不拖慢启动 */
export const UPDATE_CHECK_TIMEOUT_MS = 5000
