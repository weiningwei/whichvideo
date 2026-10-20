use crate::db;
use crate::indexer::IndexerState;
use crate::logger;
use crate::media;
use crate::search::FrameSearchIndex;
use crate::watcher::WatcherMap;
use rusqlite::Connection;
use std::sync::Mutex;

/// 应用级状态：持有一个 SQLite 连接。打开失败会在启动阶段提示后退出，
/// 连接仍用 Option 包一层以保持命令侧的防御性取值。
pub struct AppState {
    pub db: Mutex<Option<Connection>>,
    /// 索引器队列与实时进度（M7）。
    pub indexer: Mutex<IndexerState>,
    /// 全量帧指纹常驻内存索引；只在帧数据发生变化后重建。
    pub search_index: Mutex<FrameSearchIndex>,
    /// 文件夹监听句柄集合：key = folder_id，移除即停止该目录监听（M8）。
    pub watcher: Mutex<WatcherMap>,
}

impl AppState {
    /// 打开数据库并构建运行状态。失败时返回错误，由启动阶段提示后退出：
    /// 带着空库继续跑只会让所有命令都回「数据库未初始化」，用户看到一片空白。
    pub fn try_new() -> Result<Self, String> {
        let conn = db::open_db().map_err(|e| format!("数据库无法打开：{e}"))?;
        let ffmpeg_dir = db::get_ffmpeg_dir(&conn).unwrap_or(None);
        media::initialize(ffmpeg_dir);
        let tools = media::tools_status();
        logger::log(&format!("FFmpeg 检测：{}（source={}）", tools.message, tools.source));
        let search_index = FrameSearchIndex::rebuild_from_db(&conn);
        // 抽帧并发上限只在启动和设置变更时读一次库，pump 用缓存值。
        let concurrency = db::get_settings(&conn)
            .map(|settings| settings.concurrency.clamp(1, 8) as usize)
            .unwrap_or(2);
        Ok(AppState {
            db: Mutex::new(Some(conn)),
            indexer: Mutex::new(IndexerState {
                concurrency,
                ..Default::default()
            }),
            search_index: Mutex::new(search_index),
            watcher: Mutex::new(WatcherMap::new()),
        })
    }

    /// 帧数据被批量删除或增量更新失败时，从数据库恢复内存搜索索引。
    ///
    /// 只在锁内读取快照，构建放到锁外；并且先放数据库锁再取搜索索引锁，
    /// 避免与搜索、索引任务形成锁顺序反转。
    pub fn rebuild_search_index(&self) {
        let matrix = self.db.lock().ok().and_then(|guard| {
            guard
                .as_ref()
                .and_then(|conn| db::load_frame_matrix(conn).ok())
        });
        if let Some(matrix) = matrix {
            let rebuilt = FrameSearchIndex::from_matrix(matrix);
            if let Ok(mut current) = self.search_index.lock() {
                *current = rebuilt;
            }
        }
    }
}
