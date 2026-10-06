/**
 * 主进程 <-> 渲染进程共享的类型定义。
 * 这里只放纯类型，不能 import electron / node 模块，渲染端也要用。
 */
import type { ErrorCode } from './result'

/** 视频文件生命周期状态 */
export type VideoStatus =
  /** 已入库，等待抽帧建索引 */
  | 'pending'
  /** 正在抽帧建索引 */
  | 'indexing'
  /** 索引完成，可参与图片搜索 */
  | 'ready'
  /** 索引失败（解码错误等） */
  | 'failed'

export interface VideoRecord {
  id: number
  /** 绝对路径（Windows 反斜杠） */
  path: string
  /** 小写路径，用于去重比较 */
  pathKey: string
  name: string
  dir: string
  ext: string
  size: number
  mtimeMs: number
  /** 秒，未知为 null */
  duration: number | null
  width: number | null
  height: number | null
  videoCodec: string | null
  /** 已建立的帧指纹数量 */
  frameCount: number
  status: VideoStatus
  error: string | null
  /** 加入索引的时间 */
  addedAt: number
  indexedAt: number | null
  /** 该文件来自哪个被监听的文件夹 */
  folderId: number | null
  /** 已处理的时间点索引数组（断点续传用） */
  processedTimestamps: number[]
  /** 累计已处理毫秒数（断点续传跨会话累计） */
  processedMs: number
}

/** 文件夹监听状态 */
export type FolderWatchState = 'watching' | 'idle' | 'missing' | 'error'

export interface WatchedFolder {
  id: number
  path: string
  pathKey: string
  name: string
  /** 用户手动添加（true）还是递归扫描时自动登记（false） */
  pinned: boolean
  enabled: boolean
  /** 是否递归监听子目录 */
  recursive: boolean
  watchState: FolderWatchState
  message: string | null
  addedAt: number
  lastScanAt: number | null
}

export interface LibraryStats {
  videos: number
  indexedVideos: number
  pendingVideos: number
  failedVideos: number
  frames: number
  totalBytes: number
  folders: number
  watching: number
}

/** 运行时数据目录信息（便携模式相关） */
export interface DataDirInfo {
  /** 索引库、缓存、日志所在目录 */
  dir: string
  /** 是否便携模式（数据写在 exe 旁边，整个目录拷走即可迁移） */
  portable: boolean
  /** 便携模式的判定来源 */
  source: 'env' | 'portable-launcher' | 'default'
  /** ffmpeg 是否可用 */
  toolsReady: boolean
}

/** 索引器（后台队列）实时状态 */
export interface IndexerStatus {
  running: boolean
  /** 当前并发中的任务数 */
  active: number
  /** 队列里等待的任务数 */
  queued: number
  total: number
  done: number
  failed: number
  currentPath: string | null
  startedAt: number | null
  finishedAt: number | null
  /** 最近一次失败原因 */
  lastError: string | null
}

/** 单视频帧级进度（并发时每个视频独立） */
export interface FrameProgress {
  videoId: number
  done: number
  total: number
}

/** 一次搜索中命中的视频 */
export interface SearchMatch {
  video: VideoRecord
  /** 0~1，越高越像 */
  score: number
  /** 0~1，感知哈希相似度（dHash/pHash 融合） */
  hashScore: number
  /** 0~1，颜色分布相似度 */
  colorScore: number
  /** 命中的帧在视频中的位置（秒） */
  timeSeconds: number
  /** 命中帧序号 */
  frameIndex: number
  /** 命中的是第几个关键帧（用于排序展示） */
  hashDistance: number
}

export interface SearchResponse {
  query: {
    width: number
    height: number
    /** 查询图片整体主色，便于结果解释 */
    colorScoreHint: number
  }
  matchCount: number
  /** 参与比对的帧总数 */
  comparedFrames: number
  /** 耗时毫秒 */
  elapsedMs: number
  /** 是否存在分数可接受的匹配 */
  found: boolean
  matches: SearchMatch[]
  /** 检索失败时的原因（成功时无此字段）。四条输入路径失败都会带上 */
  error?: string
  /**
   * 失败原因的机器可读分类（与 error 成对出现），
   * 供测试断言与界面分支使用，定义见 shared/result.ts。
   */
  errorCode?: ErrorCode
  /**
   * 链接输入时记录实际取图的地址（可能与用户贴的不同：跟随过重定向，
   * 或从网页里解析出了主图）。界面用它显示"正在搜：https://…"，便于核对来源。
   */
  queryImageUrl?: string
}

/**
 * 剪贴板检索的返回。
 *
 * 除了结果还要带一份图片预览（dataUrl）：渲染端的查询图框要显示"刚才搜的是哪张图"，
 * 否则剪贴板搜索完成后左边那格一直是空的，用户看不出搜了什么。
 */
export interface ClipboardSearchResult {
  /** 剪贴板图片的 PNG dataUrl，用于界面预览 */
  dataUrl: string
  response: SearchResponse
}

export interface VideoQuery {
  keyword?: string
  folderId?: number | null
  status?: VideoStatus | 'all'
  limit?: number
  offset?: number
  sort?: 'added' | 'name' | 'size' | 'duration'
  order?: 'asc' | 'desc'
}

export interface VideoPage {
  total: number
  items: VideoRecord[]
}

/** 每次索引进度变化都推给渲染端，UI 依赖它做“动态更新”提示 */
export type LibraryEvent =
  | { type: 'status'; status: IndexerStatus }
  | { type: 'video-updated'; video: VideoRecord }
  | { type: 'video-removed'; videoId: number; path: string }
  | { type: 'folder-updated'; folder: WatchedFolder }
  | { type: 'folder-removed'; folderId: number }
  | { type: 'stats'; stats: LibraryStats }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'settings-updated'; settings: AppSettings }
  | { type: 'duplicate-scan-progress'; done: number; total: number }

/** 库内查重的一个相似对（代表帧跨视频互搜的命中） */
export interface DuplicatePair {
  videoA: VideoRecord
  videoB: VideoRecord
  /** 综合相似度 0~1（完全相同文件恒为 1；其余 = 平均帧分 × 覆盖率加权） */
  score: number
  hashScore: number
  colorScore: number
  /** A 的代表帧命中在 B 中的位置（秒） */
  timeSeconds: number
  /** 文件大小与时长完全一致 —— bit 级副本的强信号 */
  identicalFile: boolean
}

export interface ImportResult {
  added: number
  duplicates: number
  skipped: number
  scanned: number
  folders: number
}

export interface VideoProbeInfo {
  duration: number | null
  width: number | null
  height: number | null
  videoCodec: string | null
}

export interface AppSettings {
  /**
   * 每个视频抽取的关键帧数量**上限**。
   * 实际帧数按时长策略决定（见 src/main/media.ts 的 framesForDuration）：
   * 短视频少抽、长视频多抽，再与本值取小。填 16 会把 15 分钟以上的视频压到 16 帧。
   *
   * 注意两点：
   * 1. 调大本值并不总能增加帧数——分档表 1 小时折点已封顶 240 帧。
   * 2. 帧数越过约 48 帧后，抽帧会自动从"逐点 seek"切到"单次全片解码"
   *    （成本与帧数无关），所以提高上限不会线性拖慢索引。
   */
  framesPerVideo: number
  /** 抽帧并发数 */
  concurrency: number
  /** 单帧比对阈值：哈希相似度低于该值直接丢弃 */
  minHashScore: number
  /** 结果条数上限 */
  maxResults: number
  /** 新文件写入稳定后再入库的等待时间(ms) */
  awaitWriteMs: number
  /** 文件被删除后是否从库中清除 */
  pruneOnDelete: boolean
  /**
   * 抽帧采样模式：
   * - 'uniform'：均匀采样（默认）—— 每 gap=时长/帧数 拍一张，抽帧快
   *   （长视频走单次全片解码），但镜头时长不均匀时短镜头可能整段漏采
   *   （1 小时 240 帧的单镜头命中率约 33%）。
   * - 'scene'：场景检测采样 —— ffmpeg 场景切换点 + 长镜头内部补充，
   *   每个镜头至少一帧，召回显著更高；代价是额外一次场景检测解码 +
   *   逐点 seek 抽帧，索引更慢。更改后需重建索引才对已索引视频生效。
   */
  samplingMode: 'uniform' | 'scene'
  /** 启动时检查新版本（查 GitHub Releases，仅一次、失败静默） */
  updateCheck: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  // 默认值 128 → 240：帧数越过成本交叉点后（media.ts::SEEK_VS_FULLSCAN_CROSSOVER），
  // 抽帧自动改走"单次全片解码"，成本与帧数无关，只随时长。于是每加一帧只多付指纹
  // 计算（实测 2.5 ms/帧）：1 小时 240 帧约 0.6 秒指纹 + 1.1 秒解码，与 96 帧同量级，
  // 帧数却翻 2.5 倍。一集剧约 720 个镜头，96 帧时单个镜头命中率仅 13%，
  // 240 帧（间隔 15 秒）提高到约 33%——"明明有却搜不到"多半是这个原因。
  framesPerVideo: 240,
  concurrency: 2,
  minHashScore: 0.6,
  maxResults: 40,
  awaitWriteMs: 1500,
  pruneOnDelete: true,
  samplingMode: 'uniform',
  updateCheck: true
}

export const VIDEO_EXTENSIONS = [
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  '.mpg',
  '.mpeg',
  '.ts',
  '.m2ts',
  '.rmvb',
  '.rm',
  '.3gp'
] as const

export function isVideoFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return false
  return (VIDEO_EXTENSIONS as readonly string[]).includes(filePath.slice(dot).toLowerCase())
}

export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif'] as const

export function isImageFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return false
  return (IMAGE_EXTENSIONS as readonly string[]).includes(filePath.slice(dot).toLowerCase())
}

/** 把路径统一成 Windows 原生形式并生成比较用的 key */
export function normalizePath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '')
}

export function pathKeyOf(p: string): string {
  return normalizePath(p).toLowerCase()
}

export interface WhichVideoApi {
  library: {
    stats(): Promise<LibraryStats>
    status(): Promise<IndexerStatus>
    settings(): Promise<AppSettings>
    updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
    dataDir(): Promise<DataDirInfo>
    openDatabaseFolder(): Promise<string>
    reset(): Promise<void>
  }
  folders: {
    list(): Promise<WatchedFolder[]>
    addFromDialog(): Promise<WatchedFolder[]>
    addPath(dirPath: string): Promise<WatchedFolder>
    remove(folderId: number): Promise<void>
    rescan(folderId?: number): Promise<ImportResult>
    setEnabled(folderId: number, enabled: boolean): Promise<WatchedFolder>
  }
  videos: {
    list(query: VideoQuery): Promise<VideoPage>
    get(videoId: number): Promise<VideoRecord | null>
    remove(videoId: number): Promise<void>
    reindex(videoIds?: number[]): Promise<number>
    findDuplicates(minScore?: number): Promise<DuplicatePair[]>
    importFiles(): Promise<ImportResult>
    importImages(): Promise<string[]>
    openFile(videoId: number, atSeconds?: number): Promise<void>
    revealFile(videoId: number): Promise<void>
    thumbnail(videoId: number): Promise<string | null>
    frameProgress(videoId: number): Promise<FrameProgress | null>
  }
  search: {
    byPath(filePath: string): Promise<SearchResponse>
    byDataUrl(dataUrl: string): Promise<SearchResponse>
    /** 剪贴板里没有图片时返回 null；否则返回图片预览 + 检索结果 */
    byClipboard(): Promise<ClipboardSearchResult | null>
    /**
     * 从 http(s) 链接取图并检索。支持图片直链，也支持普通网页
     * （依次尝试 og:image、twitter:image、link[rel=image_src]、首个 <img>）。
     * 失败时 error 字段说明原因（协议不支持 / 超时 / 体积超限 / 网页里没图等）。
     */
    byUrl(url: string): Promise<SearchResponse>
  }
  events: {
    /** 订阅库变化事件；返回取消订阅函数 */
    subscribe(listener: (event: LibraryEvent) => void): () => void
  }
}

export const IPC = {
  libraryStats: 'library:stats',
  libraryStatus: 'library:status',
  librarySettings: 'library:settings',
  libraryDataDir: 'library:data-dir',
  libraryUpdateSettings: 'library:update-settings',
  libraryOpenDb: 'library:open-database-folder',
  libraryReset: 'library:reset',
  foldersList: 'folders:list',
  foldersAddDialog: 'folders:add-dialog',
  foldersAddPath: 'folders:add-path',
  foldersRemove: 'folders:remove',
  foldersRescan: 'folders:rescan',
  foldersSetEnabled: 'folders:set-enabled',
  videosList: 'videos:list',
  videosGet: 'videos:get',
  videosRemove: 'videos:remove',
  videosReindex: 'videos:reindex',
  videosFindDuplicates: 'videos:find-duplicates',
  videosImport: 'videos:import',
  videosImportImages: 'videos:import-images',
  videosOpen: 'videos:open',
  videosReveal: 'videos:reveal',
  videosThumbnail: 'videos:thumbnail',
  videosFrameProgress: 'videos:frame-progress',
  searchPath: 'search:path',
  searchDataUrl: 'search:data-url',
  searchClipboard: 'search:clipboard',
  searchUrl: 'search:url',
  eventChannel: 'library:event'
} as const
