use crate::db;
use crate::indexer::IndexerState;
use crate::watcher::WatcherMap;
use rusqlite::Connection;
use std::sync::Mutex;

/// 应用级状态：持有一个 SQLite 连接（打开失败时为 None，命令需容错）。
pub struct AppState {
    pub db: Mutex<Option<Connection>>,
    /// 索引器队列与实时进度（M7）。
    pub indexer: Mutex<IndexerState>,
    /// 文件夹监听句柄集合：key = folder_id，移除即停止该目录监听（M8）。
    pub watcher: Mutex<WatcherMap>,
}

impl AppState {
    pub fn new() -> Self {
        match db::open_db() {
            Ok(conn) => AppState {
                db: Mutex::new(Some(conn)),
                indexer: Mutex::new(IndexerState::default()),
                watcher: Mutex::new(WatcherMap::new()),
            },
            Err(e) => {
                eprintln!("[whichvideo] 数据库初始化失败: {e}");
                AppState {
                    db: Mutex::new(None),
                    indexer: Mutex::new(IndexerState::default()),
                    watcher: Mutex::new(WatcherMap::new()),
                }
            }
        }
    }
}
