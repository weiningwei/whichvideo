use crate::db;
use crate::events;
use crate::indexer;
use crate::media;
use crate::state::AppState;
use crate::watcher;
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager, State};

/// 库统计：视频/帧/文件夹计数。复用现有 whichvideo.db。
#[tauri::command]
pub fn library_stats(state: State<AppState>) -> Result<db::LibraryStats, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::stats(conn).map_err(|e| e.to_string())
}

/// 索引器实时状态（取自共享受保护的状态）。
#[tauri::command]
pub fn library_status(state: State<AppState>) -> Result<db::IndexerStatus, String> {
    let idx = state.indexer.lock().map_err(|e| e.to_string())?;
    Ok(idx.status())
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
    app: AppHandle,
    dir_path: String,
) -> Result<db::WatchedFolder, String> {
    let state = app.state::<AppState>();
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let folder = db::insert_folder(conn, &dir_path, true, true).map_err(|e| e.to_string())?;
    let _ = watcher::sync_all(&app);
    Ok(folder)
}

/// 通过系统文件夹选择对话框登记监听目录（多选退化为逐个）。
#[tauri::command]
pub fn folders_add_dialog(app: AppHandle) -> Result<Vec<db::WatchedFolder>, String> {
    let picked = pick_folder_dialog().ok_or_else(|| "未选择文件夹".to_string())?;
    let mut folders = Vec::new();
    for line in picked.lines() {
        let dir = line.trim();
        if dir.is_empty() {
            continue;
        }
        match indexer::import_folder(app.clone(), dir.to_string(), true, true) {
            Ok((_, id)) => {
                let state = app.state::<AppState>();
                let g = state.db.lock().map_err(|e| e.to_string())?;
                if let Some(c) = g.as_ref() {
                    if let Ok(Some(f)) = db::get_folder(c, id) {
                        folders.push(f);
                    }
                }
            }
            Err(_) => {}
        }
    }
    let _ = watcher::sync_all(&app);
    Ok(folders)
}

/// 删除一个被监听的文件夹记录（视频记录保留，folder_id 自动置空）。
#[tauri::command]
pub fn folders_remove(app: AppHandle, folder_id: i64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::remove_folder(conn, folder_id).map_err(|e| e.to_string())?;
    let _ = watcher::stop(&app, folder_id);
    let _ = watcher::sync_all(&app);
    Ok(())
}

/// 重新扫描文件夹（folderId 缺省则全部），返回聚合结果。
#[tauri::command]
pub fn folders_rescan(
    app: AppHandle,
    folder_id: Option<i64>,
) -> Result<events::ImportResult, String> {
    let targets: Vec<db::WatchedFolder> = {
        let state = app.state::<AppState>();
        let g = state.db.lock().map_err(|e| e.to_string())?;
        let conn = g.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
        match folder_id {
            Some(id) => db::get_folder(conn, id).map_err(|e| e.to_string())?.into_iter().collect(),
            None => db::list_folders(conn).map_err(|e| e.to_string())?,
        }
    };
    let mut total = events::ImportResult::default();
    for folder in &targets {
        if !std::path::Path::new(&folder.path).exists() {
            let state = app.state::<AppState>();
            let g = state.db.lock().map_err(|e| e.to_string())?;
            if let Some(c) = g.as_ref() {
                let _ = db::update_folder_state(c, folder.id, "missing", Some("目录不存在"));
                if let Ok(Some(f)) = db::get_folder(c, folder.id) {
                    let _ = app.emit("library_event", events::LibraryEvent::FolderUpdated { folder: f });
                }
            }
            continue;
        }
        if let Ok((result, _)) =
            indexer::import_folder(app.clone(), folder.path.clone(), folder.pinned, folder.recursive)
        {
            total.added += result.added;
            total.duplicates += result.duplicates;
            total.skipped += result.skipped;
            total.scanned += result.scanned;
            total.folders += result.folders;
        }
    }
    let _ = watcher::sync_all(&app);
    Ok(total)
}

/// 启用/停用文件夹监听，返回更新后的记录。
#[tauri::command]
pub fn folders_set_enabled(
    app: AppHandle,
    folder_id: i64,
    enabled: bool,
) -> Result<db::WatchedFolder, String> {
    let state = app.state::<AppState>();
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::set_folder_enabled(conn, folder_id, enabled).map_err(|e| e.to_string())?;
    let folder = db::get_folder(conn, folder_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "文件夹不存在".to_string())?;
    let _ = watcher::sync_all(&app);
    Ok(folder)
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

/// 打开视频文件；带时间戳时优先用支持定位起播的播放器（mpv/PotPlayer/VLC）。
#[tauri::command]
pub fn videos_open(
    state: State<AppState>,
    video_id: i64,
    at_seconds: Option<f64>,
) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let video = db::get_video(conn, video_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "视频不存在".to_string())?;
    if let Some(t) = at_seconds {
        if t > 0.0 {
            if let Some(player) = media::find_seekable_player(&video.path) {
                let args = (player.args)(&video.path, t);
                let _ = Command::new(&player.exe).args(&args).spawn();
                return Ok(());
            }
        }
    }
    let _ = Command::new("explorer.exe").arg(&video.path).spawn();
    Ok(())
}

/// 命中时间点预览：现场解码一帧 JPEG dataUrl。失败返回 null（调用方回退缩略图）。
#[tauri::command]
pub fn videos_match_frame(
    state: State<AppState>,
    video_id: i64,
    time_ms: i64,
) -> Result<Option<String>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let video = db::get_video(conn, video_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "视频不存在".to_string())?;
    if time_ms < 0 {
        return Ok(None);
    }
    Ok(media::decode_frame_at(&video.path, time_ms, crate::constants::EXTRACT_WIDTH))
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

/// 单视频帧级进度（抽帧进行中实时回报）。
#[tauri::command]
pub fn videos_frame_progress(
    app: AppHandle,
    video_id: i64,
) -> Result<Option<events::FrameProgress>, String> {
    Ok(indexer::get_frame_progress(&app, video_id))
}

/// 通过系统文件选择对话框导入视频文件，返回聚合结果。
#[tauri::command]
pub fn videos_import(app: AppHandle) -> Result<events::ImportResult, String> {
    let files = pick_files_dialog(
        "选择视频文件（可多选）",
        "视频",
        &["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "mpg", "mpeg", "rmvb", "3gp"],
    );
    if files.is_empty() {
        return Ok(events::ImportResult::default());
    }
    let result = indexer::import_files(app.clone(), files.clone(), None);
    // 把所选文件所在目录也纳入监听，保证后续动态更新。
    let mut dirs: Vec<String> = files
        .iter()
        .filter_map(|f| {
            std::path::Path::new(f)
                .parent()
                .map(|p| db::normalize_path(&p.to_string_lossy()))
        })
        .collect();
    dirs.sort();
    dirs.dedup();
    for d in dirs {
        let _ = indexer::import_folder(app.clone(), d, true, true);
    }
    Ok(result)
}

/// 通过系统文件选择对话框选择要搜索的图片，返回归一化路径列表（不入库）。
#[tauri::command]
pub fn videos_import_images() -> Result<Vec<String>, String> {
    let files = pick_files_dialog(
        "选择要搜索的图片",
        "图片",
        &["jpg", "jpeg", "png", "webp", "bmp", "gif", "avif"],
    );
    Ok(files
        .into_iter()
        .map(|f| db::normalize_path(&f))
        .collect())
}

/// 重建索引：按各视频当前记录的模式重抽（mode 仅指定时写入覆盖）。返回待处理视频数。
#[tauri::command]
pub fn videos_reindex(
    app: AppHandle,
    video_ids: Option<Vec<i64>>,
    mode: Option<String>,
) -> Result<i64, String> {
    Ok(indexer::reindex(app, video_ids, mode))
}

/// 同步文件夹监听（启动/停止各目录的磁盘监听以匹配启用状态）。
#[tauri::command]
pub fn watcher_sync(app: AppHandle) -> Result<(), String> {
    watcher::sync_all(&app)
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

/// 运行时数据目录信息（toolsReady 由媒体探测结果决定）。
#[tauri::command]
pub fn library_data_dir() -> Result<db::DataDirInfo, String> {
    Ok(db::data_dir_info(media::tools_ready()))
}

/* ================================================================== */
/* 系统对话框（依赖 PowerShell，Windows 平台）                         */
/* ================================================================== */

#[cfg(windows)]
fn run_powershell(script: &str) -> Option<String> {
    let out = Command::new("powershell")
        .args(["-NoProfile", "-STA", "-Command", script])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(windows)]
fn pick_folder_dialog() -> Option<String> {
    let script = "Add-Type -AssemblyName System.windows.forms; \
        $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
        $d.Description = '选择要导入并持续监听的文件夹'; \
        if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }";
    run_powershell(script)
}

#[cfg(windows)]
fn pick_files_dialog(title: &str, filter_name: &str, exts: &[&str]) -> Vec<String> {
    let filter = format!(
        "{}|{}|全部文件|*.*",
        filter_name,
        exts.iter()
            .map(|e| format!("*.{}", e))
            .collect::<Vec<_>>()
            .join(";")
    );
    let script = format!(
        "Add-Type -AssemblyName System.windows.forms; \
         $d = New-Object System.Windows.Forms.OpenFileDialog; \
         $d.Multiselect = $true; $d.Title = '{}'; $d.Filter = '{}'; \
         if ($d.ShowDialog() -eq 'OK') {{ $d.FileNames }}",
        title.replace('\'', "''"),
        filter.replace('\'', "''")
    );
    match run_powershell(&script) {
        Some(out) => out
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        None => Vec::new(),
    }
}

#[cfg(not(windows))]
fn pick_folder_dialog() -> Option<String> {
    None
}

#[cfg(not(windows))]
fn pick_files_dialog(_title: &str, _filter_name: &str, _exts: &[&str]) -> Vec<String> {
    Vec::new()
}
