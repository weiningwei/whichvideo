use crate::db;
use crate::state::AppState;
use tauri::State;

/// 库统计：视频/帧/文件夹计数。复用现有 whichvideo.db。
#[tauri::command]
pub fn library_stats(state: State<AppState>) -> Result<db::LibraryStats, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::stats(conn).map_err(|e| e.to_string())
}

/// 监听文件夹列表。
#[tauri::command]
pub fn folders_list(state: State<AppState>) -> Result<Vec<db::WatchedFolder>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::list_folders(conn).map_err(|e| e.to_string())
}

/// 单个视频记录。
#[tauri::command]
pub fn videos_get(state: State<AppState>, video_id: i64) -> Result<Option<db::VideoRecord>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::get_video(conn, video_id).map_err(|e| e.to_string())
}

/// 视频分页列表（支持 keyword/folderId/status 过滤、排序、分页）。
#[tauri::command]
pub fn videos_list(state: State<AppState>, query: db::VideoQuery) -> Result<db::VideoPage, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::list_videos(conn, &query).map_err(|e| e.to_string())
}

/// 视频缩略图（data:image/jpeg;base64,...），无则 null。
#[tauri::command]
pub fn videos_thumbnail(
    state: State<AppState>,
    video_id: i64,
) -> Result<Option<String>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::get_thumbnail(conn, video_id).map_err(|e| e.to_string())
}

/// 视频全部索引帧清单（按帧序号升序）。
#[tauri::command]
pub fn videos_frame_manifest(
    state: State<AppState>,
    video_id: i64,
) -> Result<Vec<db::FrameManifestEntry>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::list_frame_manifest(conn, video_id).map_err(|e| e.to_string())
}

/// 用户设置（合并默认值）。
#[tauri::command]
pub fn library_settings(state: State<AppState>) -> Result<db::AppSettings, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::get_settings(conn).map_err(|e| e.to_string())
}
