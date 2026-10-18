//! 跨模块共享的魔法数字，集中在此避免散落。

/// 抽帧/缩略图统一缩放到的宽度（镜像 Electron src/main/constants.ts::EXTRACT_WIDTH）。
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
