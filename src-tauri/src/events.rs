//! 库事件统一类型（镜像 Electron shared/types.ts 的 LibraryEvent）。
//!
//! 经 Tauri 事件通道播给渲染端（`library_event`）。当前由 indexer（M7）与
//! 后续模块（M11 事件广播）产出；渲染端通过 listen(IPC.eventChannel) 订阅。

use crate::db::{AppSettings, IndexerStatus, LibraryStats, VideoRecord, WatchedFolder};
use serde::Serialize;

/// 单视频帧级进度（镜像 shared/types.ts::FrameProgress）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrameProgress {
    pub video_id: i64,
    pub done: i64,
    pub total: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

/// 一次导入/扫描的聚合结果（镜像 shared/types.ts::ImportResult）。
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub added: i64,
    pub duplicates: i64,
    pub skipped: i64,
    pub scanned: i64,
    pub folders: i64,
}

/// 重建索引返回（镜像 videos.reindex 的 { count }）。
#[allow(dead_code)]
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReindexResult {
    pub count: i64,
}

#[allow(dead_code)]
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum LibraryEvent {
    /// 索引器实时状态变化。
    Status { status: IndexerStatus },
    /// 单个视频记录变化（状态/帧数/缩略图/路径变更等）。
    VideoUpdated { video: VideoRecord },
    /// 视频被移除。
    VideoRemoved { video_id: i64, path: String },
    /// 文件夹变化（登记/扫描完成/状态变更）。
    FolderUpdated { folder: WatchedFolder },
    /// 文件夹被移除。
    FolderRemoved { folder_id: i64 },
    /// 库统计变化（视频/帧/文件夹计数）。
    Stats { stats: LibraryStats },
    /// 提示信息（info/warn/error）。
    Notice { level: String, message: String },
    /// 设置变更。
    SettingsUpdated { settings: AppSettings },
    /// 查重扫描进度。
    DuplicateScanProgress { done: i64, total: i64 },
}
