use crate::db;
use crate::frames_store;
use crate::indexer::IndexerState;
use crate::logger;
use crate::media;
use crate::search::FrameSearchIndex;
use crate::watcher::WatcherMap;
use rusqlite::Connection;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

/// 应用级状态：持有一个 SQLite 连接。打开失败会在启动阶段提示后退出，
/// 因此运行期连接始终存在，不再让各模块重复处理“不可能的未初始化”分支。
pub struct AppState {
    db: Mutex<Connection>,
    /// 索引器队列与实时进度（M7）。
    pub indexer: Mutex<IndexerState>,
    /// 全量帧指纹常驻内存索引；只在帧数据发生变化后重建。
    pub search_index: Mutex<FrameSearchIndex>,
    /// 常驻索引是否已从数据库构建完成。启动时在后台线程构建：百万帧的库在
    /// 主线程里同步读会白屏数秒。未就绪时搜索明确回报「加载中」，
    /// 而不是把空索引当成「没找到」。
    pub search_ready: AtomicBool,
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
        logger::info(
            logger::Module::Media,
            "tools_detected",
            &format!("ready={} source={} message={}", tools.ready, tools.source, tools.message),
        );
        // 抽帧并发上限只在启动和设置变更时读一次库，pump 用缓存值。
        let settings = db::get_settings(&conn).unwrap_or_else(|_| db::default_settings());
        let concurrency = settings.concurrency.clamp(1, 8) as usize;
        frames_store::configure_enabled(settings.keep_frame_images);
        Ok(AppState {
            db: Mutex::new(conn),
            indexer: Mutex::new(IndexerState {
                concurrency,
                ..Default::default()
            }),
            // 索引留空，由启动流程在后台线程里 rebuild_search_index() 填。
            search_index: Mutex::new(FrameSearchIndex::new()),
            search_ready: AtomicBool::new(false),
            watcher: Mutex::new(WatcherMap::new()),
        })
    }

    /// 命令和可失败流程使用的数据库入口。锁中毒统一作为错误向上传播。
    pub fn db(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.db.lock().map_err(|_| "数据库状态锁已损坏".to_string())
    }

    /// 后台索引任务不能因某个工作线程 panic 永久停摆；恢复锁的同时留下诊断日志。
    pub fn db_recover(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|poisoned| {
            logger::error(logger::Module::Library, "database_lock_recovered", "");
            poisoned.into_inner()
        })
    }

    /// 帧数据被批量删除或增量更新失败时，从数据库恢复内存搜索索引。
    ///
    /// 只在锁内读取快照，构建放到锁外；并且先放数据库锁再取搜索索引锁，
    /// 避免与搜索、索引任务形成锁顺序反转。
    pub fn rebuild_search_index(&self) {
        let matrix = self.db().ok().and_then(|conn| db::load_frame_matrix(&conn).ok());
        if let Some(matrix) = matrix {
            let rebuilt = FrameSearchIndex::from_matrix(matrix);
            if let Ok(mut current) = self.search_index.lock() {
                *current = rebuilt;
            }
        }
        // 读取失败时保持空索引继续跑（与旧启动路径一致），但不能把 ready
        // 卡在 false —— 那样搜索永远报「加载中」、索引器也永远不开工。
        self.search_ready.store(true, Ordering::Release);
    }
}
