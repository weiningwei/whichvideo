use crate::db;
use rusqlite::Connection;
use std::sync::Mutex;

/// 应用级状态：持有一个 SQLite 连接（打开失败时为 None，命令需容错）。
pub struct AppState {
    pub db: Mutex<Option<Connection>>,
}

impl AppState {
    pub fn new() -> Self {
        match db::open_db() {
            Ok(conn) => AppState {
                db: Mutex::new(Some(conn)),
            },
            Err(e) => {
                eprintln!("[whichvideo] 数据库初始化失败: {e}");
                AppState {
                    db: Mutex::new(None),
                }
            }
        }
    }
}
