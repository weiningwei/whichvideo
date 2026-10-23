//! 跨模块共享的魔法数字、前后端契约枚举与运行参数，集中在此避免散落。

use std::time::Duration;

/// 抽帧、缩略图和查询图统一缩放到的宽度。
/// 索引侧每一帧、查询侧查询图都按此宽度归一化，保证双方走完全相同的重采样路径。
#[allow(dead_code)]
pub const EXTRACT_WIDTH: u32 = 320;

/// ffprobe 探测缩略图的最大宽度（M6 现场解码用 EXTRACT_WIDTH，本常量留待后续探测能力）。
#[allow(dead_code)]
pub const PROBE_MAX_WIDTH: u32 = 320;

/// 场景模式未指定预算时的兜底帧数；均匀模式由时间间隔控制。
pub const DEFAULT_FRAME_BUDGET: usize = 240;

/**
 * 两条抽帧路径的历史成本交叉点（帧数）；长视频或高采样密度由索引器优先分批 seek，
 * 避免单次全片解码的内存和超时风险。
 */
pub const SEEK_VS_FULLSCAN_CROSSOVER: usize = 48;

/// 场景采样：镜头长度达到该值（秒）才补中点帧 —— 过短镜头的中点贴近场景点，无意义。
pub const SCENE_MIDPOINT_MIN_GAP: f64 = 2.0;

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

/// 常见的视频扩展名（小写、不带点）。文件对话框优先显示；扫描还会尝试未知扩展名。
/// 前端同名单见 src/shared/types.ts 的 VIDEO_EXTENSIONS，契约测试校验两边一致。
pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts", "m2ts", "rmvb",
    "rm", "3gp", "vob", "ogv", "m3u8",
];

/// 文件夹扫描时直接跳过明显不是视频的文件。未知扩展名仍交给 FFprobe 判断。
pub const NON_VIDEO_EXTENSIONS: &[&str] = &[
    "txt", "md", "log", "nfo", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "avif", "svg", "ico", "heic",
    "mp3", "wav", "flac", "aac", "ogg", "opus", "wma", "m4a", "cue",
    "srt", "ass", "ssa", "vtt", "sub", "idx", "lrc",
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso",
    "exe", "dll", "msi", "app", "deb", "rpm", "so", "dylib",
    "json", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "csv",
    "db", "sqlite", "sqlite3", "db-wal", "db-shm", "bak", "tmp", "part",
    "html", "htm", "css", "js", "jsx", "tsx", "py", "rs", "java", "c", "cpp", "h",
    "url", "lnk", "desktop",
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
