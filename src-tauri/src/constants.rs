//! 跨模块共享的魔法数字、前后端契约枚举与运行参数，集中在此避免散落。

use std::time::Duration;

/// 抽帧、缩略图和查询图统一缩放到的宽度。
/// 索引侧每一帧、查询侧查询图都按此宽度归一化，保证双方走完全相同的重采样路径。
#[allow(dead_code)]
pub const EXTRACT_WIDTH: u32 = 320;

/// ffprobe 探测缩略图的最大宽度（M6 现场解码用 EXTRACT_WIDTH，本常量留待后续探测能力）。
#[allow(dead_code)]
pub const PROBE_MAX_WIDTH: u32 = 320;

/// 帧数封顶的兜底上限（用户设置 framesPerVideo 也是封顶，与策略值取小）。
pub const DEFAULT_FRAME_BUDGET: usize = 240;

/**
 * 两条抽帧路径的成本交叉点（帧数）：逐点 seek 约 25 ms/帧线性增长，全片解码
 * 成本与帧数无关只随时长；实测 600 秒视频 40 帧时两者都是 1.1 秒，取 48 略保守。
 */
pub const SEEK_VS_FULLSCAN_CROSSOVER: usize = 48;

/// 场景采样：镜头长度达到该值（秒）才补中点帧 —— 过短镜头的中点贴近场景点，无意义。
pub const SCENE_MIDPOINT_MIN_GAP: f64 = 2.0;

/// 每视频抽帧数：按时长插值的分档表（时长秒 → 帧数），之间线性插值再取整到偶数。
pub const FRAME_COUNT_TABLE: &[(f64, usize)] = &[
    (0.0, 8),
    (30.0, 10),
    (60.0, 12),
    (300.0, 24),
    (900.0, 48),
    (1800.0, 96),
    (3600.0, 240),
    (7200.0, 240),
];

/// 递归扫描最大深度。
pub const MAX_SCAN_DEPTH: usize = 24;

/// 日志超过 512 KiB 时轮转为 whichvideo.log.1，避免长期运行无限增长。
pub const MAX_LOG_BYTES: u64 = 512 * 1024;

/// 默认跳过的目录名（系统目录 + 构建产物 + VCS）。
pub const DEFAULT_SKIP_DIRS: &[&str] = &[
    "$recycle.bin",
    "system volume information",
    "node_modules",
    ".git",
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata",
];

/* ------------------------------------------------------------------ */
/* 前后端契约枚举                                                     */
/* ------------------------------------------------------------------ */

/// 可索引的视频扩展名（小写、不带点）。扫描、文件对话框与前端拖拽共用；
/// 前端同名单见 src/shared/types.ts 的 VIDEO_EXTENSIONS，契约测试校验两边一致。
pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts", "m2ts", "rmvb",
    "rm", "3gp", "vob", "ogv",
];

/// 后端事件通道名，必须与 src/shared/types.ts 的 IPC.eventChannel 一致。
pub const EVENT_CHANNEL: &str = "library_event";

/* ------------------------------------------------------------------ */
/* 运行参数：外部进程、网络与存储的时限和上限                         */
/* ------------------------------------------------------------------ */

/// ffmpeg 单次调用上限（抽帧、解码、场景检测）。损坏文件或卡死的网络盘兜底。
pub const FFMPEG_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// ffprobe 单次探测上限。
pub const FFPROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// 媒体工具版本探测上限（启动时执行一次 --version）。
pub const MEDIA_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// 等待媒体子进程退出的轮询间隔。
pub const MEDIA_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 场景检测等待 ffmpeg 的轮询间隔（输出更密集，放宽一档减少唤醒）。
pub const SCENE_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// SQLite 等锁上限，索引写入与其他连接并发时生效。
pub const DB_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// 网页取图（图片或 HTML 元数据）的单次请求上限。
pub const URL_FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// 网页取图最多跟随的重定向次数。
pub const URL_MAX_REDIRECTS: usize = 5;

/// 网页图片体积上限（10 MiB）。
pub const URL_MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

/// 网页 HTML 体积上限（2 MiB）。
pub const URL_MAX_HTML_BYTES: usize = 2 * 1024 * 1024;

/// 版本检查请求上限。
pub const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// 启动后延迟检查版本，避免与首次索引争抢 CPU 和网络。
pub const UPDATE_CHECK_DELAY: Duration = Duration::from_secs(3);
