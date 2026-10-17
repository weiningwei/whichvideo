use crate::db;
use crate::state::AppState;
use std::process::Command;
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

/// 登记一个被监听的文件夹（仅入库，扫描/索引由 indexer 模块完成）。
#[tauri::command]
pub fn folders_add_path(
    state: State<AppState>,
    dir_path: String,
) -> Result<db::WatchedFolder, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::insert_folder(conn, &dir_path, true, true).map_err(|e| e.to_string())
}

/// 删除一个被监听的文件夹记录（视频记录保留，folder_id 自动置空）。
#[tauri::command]
pub fn folders_remove(state: State<AppState>, folder_id: i64) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::remove_folder(conn, folder_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// 启用/停用文件夹监听，返回更新后的记录。
#[tauri::command]
pub fn folders_set_enabled(
    state: State<AppState>,
    folder_id: i64,
    enabled: bool,
) -> Result<db::WatchedFolder, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::set_folder_enabled(conn, folder_id, enabled).map_err(|e| e.to_string())?;
    db::get_folder(conn, folder_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "文件夹不存在".to_string())
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

/// 删除视频记录（帧级联删除）。
#[tauri::command]
pub fn videos_remove(state: State<AppState>, video_id: i64) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::remove_video(conn, video_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// 在资源管理器中定位文件。
#[tauri::command]
pub fn videos_reveal(state: State<AppState>, video_id: i64) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let video = db::get_video(conn, video_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "视频不存在".to_string())?;
    let _ = Command::new("explorer.exe")
        .arg(format!("/select,\"{}\"", video.path))
        .spawn();
    Ok(())
}

/// 打开视频文件（默认播放器；带时间戳定位由 M5 媒体探测补齐）。
#[tauri::command]
pub fn videos_open(
    state: State<AppState>,
    video_id: i64,
    #[allow(unused_variables)] at_seconds: Option<f64>,
) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let video = db::get_video(conn, video_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "视频不存在".to_string())?;
    let _ = Command::new("explorer.exe").arg(&video.path).spawn();
    Ok(())
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

/// 更新用户设置，返回合并后的完整设置。
#[tauri::command]
pub fn library_update_settings(
    state: State<AppState>,
    patch: db::SettingsPatch,
) -> Result<db::AppSettings, String> {
    let mut guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_mut()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::update_settings(conn, &patch).map_err(|e| e.to_string())
}

/// 重置索引库（清空视频/帧/文件夹，保留设置）。
#[tauri::command]
pub fn library_reset(state: State<AppState>) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::clear_all(conn).map_err(|e| e.to_string())
}

/// 打开数据目录（含 whichvideo.db）。
#[tauri::command]
pub fn library_open_database_folder() -> Result<String, String> {
    let dir = db::data_dir();
    let dir_str = dir.to_string_lossy().to_string();
    let _ = Command::new("explorer.exe").arg(&dir_str).spawn();
    Ok(dir_str)
}

/// 运行时数据目录信息（toolsReady 在 M5 媒体探测后补全）。
#[tauri::command]
pub fn library_data_dir() -> Result<db::DataDirInfo, String> {
    Ok(db::data_dir_info(false))
}

/// 索引器实时状态（M7 接入真实索引器前返回闲置态）。
#[tauri::command]
pub fn library_status() -> Result<db::IndexerStatus, String> {
    Ok(db::idle_indexer_status())
}
