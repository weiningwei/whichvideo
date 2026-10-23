//! 库事件统一类型，与前端 `LibraryEvent` 契约保持一致。
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
    pub failed: i64,
    pub scanned: i64,
    pub folders: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_error: Option<String>,
    pub failures: Vec<ImportFailure>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub path: String,
    pub reason: String,
    pub folder_id: Option<i64>,
}

/// 重建索引返回（镜像 videos.reindex 的 { count }）。
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReindexResult {
    pub count: i64,
}

#[allow(dead_code)]
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum LibraryEvent {
    /// 索引器实时状态变化。
    Status { status: IndexerStatus },
    /// 单个视频记录变化（状态/帧数/缩略图/路径变更等）。
    VideoUpdated { video: Box<VideoRecord> },
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
    /// 批量导入进度。total = 0 表示仍在遍历目录（processed 为已发现文件数）；
    /// finished = true 时前端清空进度显示。
    ImportProgress {
        id: u64,
        processed: i64,
        total: i64,
        added: i64,
        skipped: i64,
        failed: i64,
        finished: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::{ImportFailure, ImportResult, LibraryEvent};

    /// 事件字段名必须与 shared/types.ts 的 LibraryEvent 一致。枚举上的
    /// rename_all 只改变体名，结构体变体的字段要靠 rename_all_fields 才会驼峰；
    /// 少了它前端读到的是 video_id / folder_id，事件会静默失效。
    #[test]
    fn event_fields_match_shared_types() {
        let removed =
            serde_json::to_value(LibraryEvent::VideoRemoved { video_id: 2, path: "a.mp4".into() })
                .unwrap();
        assert_eq!(removed["type"], "video-removed");
        assert_eq!(removed["videoId"], 2);

        let folder = serde_json::to_value(LibraryEvent::FolderRemoved { folder_id: 3 }).unwrap();
        assert_eq!(folder["type"], "folder-removed");
        assert_eq!(folder["folderId"], 3);

        let progress = serde_json::to_value(LibraryEvent::ImportProgress {
            id: 1,
            processed: 5,
            total: 10,
            added: 2,
            skipped: 1,
            failed: 0,
            finished: false,
        })
        .unwrap();
        assert_eq!(progress["type"], "import-progress");
        assert_eq!(progress["processed"], 5);
        assert_eq!(progress["total"], 10);
        assert_eq!(progress["finished"], false);
    }

    #[test]
    fn import_report_serializes_retry_context() {
        let result = ImportResult {
            failed: 1,
            failures: vec![ImportFailure {
                path: "video.mp4".into(), reason: "探测失败".into(), folder_id: Some(7),
            }],
            ..Default::default()
        };
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["failures"][0]["folderId"], 7);
        assert_eq!(json["failures"][0]["reason"], "探测失败");
    }
}
