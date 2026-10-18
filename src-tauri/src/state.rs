use crate::db;
use crate::indexer::IndexerState;
use crate::logger;
use crate::media;
use crate::search::FrameSearchIndex;
use crate::watcher::WatcherMap;
use rusqlite::Connection;
use std::sync::Mutex;

/// 应用级状态：持有一个 SQLite 连接（打开失败时为 None，命令需容错）。
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
    pub fn new() -> Self {
        match db::open_db() {
            Ok(conn) => {
                let ffmpeg_dir = db::get_ffmpeg_dir(&conn).unwrap_or(None);
                media::initialize(ffmpeg_dir);
                let tools = media::tools_status();
                logger::log(&format!("FFmpeg 检测：{}（source={}）", tools.message, tools.source));
                let search_index = FrameSearchIndex::rebuild_from_db(&conn);
                AppState {
                    db: Mutex::new(Some(conn)),
                    indexer: Mutex::new(IndexerState::default()),
                    search_index: Mutex::new(search_index),
                    watcher: Mutex::new(WatcherMap::new()),
                }
            }
            Err(e) => {
                logger::log(&format!("[ERROR] 数据库初始化失败：{e}"));
                media::initialize(None);
                AppState {
                    db: Mutex::new(None),
                    indexer: Mutex::new(IndexerState::default()),
                    search_index: Mutex::new(FrameSearchIndex::new()),
                    watcher: Mutex::new(WatcherMap::new()),
                }
            }
        }
    }
}
