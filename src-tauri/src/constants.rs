//! 跨模块共享的魔法数字，集中在此避免散落。

/// 抽帧/缩略图统一缩放到的宽度（镜像 Electron src/main/constants.ts::EXTRACT_WIDTH）。
/// 索引侧每一帧、查询侧查询图都按此宽度归一化，保证双方走完全相同的重采样路径。
#[allow(dead_code)]
pub const EXTRACT_WIDTH: u32 = 320;
