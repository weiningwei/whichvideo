use crate::db;
use crate::events;
use crate::framepack;
use crate::frames_store;
use crate::hash;
use crate::indexer;
use crate::media;
use crate::process_ext::CommandNoWindow;
use crate::search;
use crate::state::AppState;
use crate::watcher;
use base64::Engine;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashSet;
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
    let picked = pick_folder_dialog("选择要加入资料库并持续监视的文件夹")
        .ok_or_else(|| "未选择文件夹".to_string())?;
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
    frames_store::remove_video(video_id);
    let rebuilt = search::FrameSearchIndex::rebuild_from_db(conn);
    *state.search_index.lock().map_err(|e| e.to_string())? = rebuilt;
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
        .no_window()
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
                let _ = Command::new(&player.exe).no_window().args(&args).spawn();
                return Ok(());
            }
        }
    }
    let _ = Command::new("explorer.exe").no_window().arg(&video.path).spawn();
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicatePair {
    pub video_a: db::VideoRecord,
    pub video_b: db::VideoRecord,
    pub score: f64,
    pub hash_score: f64,
    pub color_score: f64,
    pub time_seconds: f64,
    pub identical_file: bool,
}

struct RoughDuplicateHit {
    id_a: i64,
    id_b: i64,
    hash_score: f64,
    color_score: f64,
    time_seconds: f64,
    score: f64,
}

fn pair_key(a: i64, b: i64) -> (i64, i64) {
    if a < b { (a, b) } else { (b, a) }
}

fn ensure_file_hash(app: &AppHandle, video_id: i64) -> Result<Option<String>, String> {
    let video = {
        let state = app.state::<AppState>();
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
        db::get_video(conn, video_id).map_err(|e| e.to_string())?
    };
    let Some(video) = video else { return Ok(None) };
    if let Some(hash) = video.file_hash {
        return Ok(Some(hash));
    }
    let hash = media::sha256_of_file(&video.path)?;
    let state = app.state::<AppState>();
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
    db::set_file_hash(conn, video_id, &hash).map_err(|e| e.to_string())?;
    Ok(Some(hash))
}

fn find_duplicates_sync(app: &AppHandle, min_score: Option<f64>) -> Result<Vec<DuplicatePair>, String> {
    let threshold = min_score.filter(|v| *v > 0.0).unwrap_or(0.88);
    let identical_candidates = {
        let state = app.state::<AppState>();
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
        db::find_identical_file_pairs(conn).map_err(|e| e.to_string())?
    };
    let mut pairs = Vec::new();
    let mut seen = HashSet::new();

    for (id_a, id_b) in identical_candidates {
        let hashes = ensure_file_hash(app, id_a).and_then(|a| {
            ensure_file_hash(app, id_b).map(|b| (a, b))
        });
        let (hash_a, hash_b) = match hashes {
            Ok(value) => value,
            Err(error) => {
                let _ = app.emit(
                    "library_event",
                    events::LibraryEvent::Notice {
                        level: "warn".to_string(),
                        message: format!("文件指纹计算失败：{error}"),
                    },
                );
                continue;
            }
        };
        if hash_a.is_none() || hash_a != hash_b {
            continue;
        }
        let key = pair_key(id_a, id_b);
        seen.insert(key);
        let videos = {
            let state = app.state::<AppState>();
            let guard = state.db.lock().map_err(|e| e.to_string())?;
            let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
            (
                db::get_video(conn, id_a).map_err(|e| e.to_string())?,
                db::get_video(conn, id_b).map_err(|e| e.to_string())?,
            )
        };
        if let (Some(video_a), Some(video_b)) = videos {
            pairs.push(DuplicatePair {
                video_a,
                video_b,
                score: 1.0,
                hash_score: 1.0,
                color_score: 1.0,
                time_seconds: 0.0,
                identical_file: true,
            });
        }
    }

    let rough_hits = {
        let state = app.state::<AppState>();
        let index = state.search_index.lock().map_err(|e| e.to_string())?;
        let ids = index.list_video_ids();
        let total = ids.len() as i64;
        let mut rough = Vec::new();
        for (position, id) in ids.into_iter().enumerate() {
            if let Some(vector) = index.video_query_vector(id) {
                let (results, _) = index.search(
                    &vector,
                    &search::SearchOptions { min_hash_score: threshold, max_results: 8 },
                );
                if let Some(hit) = results.into_iter().find(|result| result.video_id != id) {
                    let key = pair_key(id, hit.video_id);
                    if seen.insert(key) {
                        let vectors = index.video_frame_vectors(id, 8);
                        let mut matched = 0usize;
                        let mut sum = 0.0;
                        for frame in &vectors {
                            let (deep, _) = index.search(
                                frame,
                                &search::SearchOptions { min_hash_score: threshold, max_results: 50 },
                            );
                            if let Some(to_b) = deep.into_iter().find(|item| item.video_id == hit.video_id) {
                                matched += 1;
                                sum += to_b.score;
                            }
                        }
                        let coverage = if vectors.is_empty() { 0.0 } else { matched as f64 / vectors.len() as f64 };
                        let average = if matched == 0 { 0.0 } else { sum / matched as f64 };
                        rough.push(RoughDuplicateHit {
                            id_a: id,
                            id_b: hit.video_id,
                            hash_score: hit.hash_score,
                            color_score: hit.color_score,
                            time_seconds: hit.time_seconds,
                            score: average * (0.5 + 0.5 * coverage),
                        });
                    }
                }
            }
            let done = position as i64 + 1;
            if done % 16 == 0 || done == total {
                let _ = app.emit(
                    "library_event",
                    events::LibraryEvent::DuplicateScanProgress { done, total },
                );
            }
        }
        if total == 0 {
            let _ = app.emit(
                "library_event",
                events::LibraryEvent::DuplicateScanProgress { done: 0, total: 0 },
            );
        }
        rough
    };

    {
        let state = app.state::<AppState>();
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
        for hit in rough_hits {
            if let (Some(video_a), Some(video_b)) = (
                db::get_video(conn, hit.id_a).map_err(|e| e.to_string())?,
                db::get_video(conn, hit.id_b).map_err(|e| e.to_string())?,
            ) {
                pairs.push(DuplicatePair {
                    video_a,
                    video_b,
                    score: hit.score,
                    hash_score: hit.hash_score,
                    color_score: hit.color_score,
                    time_seconds: hit.time_seconds,
                    identical_file: false,
                });
            }
        }
    }
    pairs.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    Ok(pairs)
}

/// 库内查重：先以 size/duration + SHA-256 确认 bit 级副本，再以帧覆盖率筛相似视频。
#[tauri::command]
pub async fn videos_find_duplicates(
    app: AppHandle,
    min_score: Option<f64>,
) -> Result<Vec<DuplicatePair>, String> {
    tauri::async_runtime::spawn_blocking(move || find_duplicates_sync(&app, min_score))
        .await
        .map_err(|e| e.to_string())?
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
    Ok(indexer::import_files(app, files, None))
}

/// 递归导入一个文件夹，但不把它登记为监听目录。
#[tauri::command]
pub fn videos_import_folder_once(app: AppHandle) -> Result<events::ImportResult, String> {
    let Some(dir) = pick_folder_dialog("选择要一次性导入的文件夹（不会持续监视）") else {
        return Ok(events::ImportResult::default());
    };
    Ok(indexer::import_folder_once(app, dir.trim().to_string(), true))
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
pub fn library_update_settings(app: AppHandle, patch: db::SettingsPatch) -> Result<db::AppSettings, String> {
    let state = app.state::<AppState>();
    let mut guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_mut()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let previous = db::get_settings(conn).map_err(|e| e.to_string())?;
    let updated = db::update_settings(conn, &patch).map_err(|e| e.to_string())?;
    if let Some(mode) = patch.sampling_mode.as_deref() {
        if mode != previous.sampling_mode {
            db::migrate_sampling_on_global_change(conn, &previous.sampling_mode, mode)
                .map_err(|e| e.to_string())?;
        }
    }
    drop(guard);
    if patch.keep_frame_images == Some(false) && previous.keep_frame_images {
        if frames_store::remove_all() {
            let _ = app.emit(
                "library_event",
                events::LibraryEvent::Notice {
                    level: "info".to_string(),
                    message: "已清空全部索引帧图片".to_string(),
                },
            );
        }
    }
    let _ = watcher::sync_all(&app);
    let _ = app.emit(
        "library_event",
        events::LibraryEvent::SettingsUpdated { settings: updated.clone() },
    );
    Ok(updated)
}

/// 重置索引库（清空视频/帧/文件夹，保留设置）。
#[tauri::command]
pub fn library_reset(state: State<AppState>) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::clear_all(conn).map_err(|e| e.to_string())?;
    frames_store::remove_all();
    *state.search_index.lock().map_err(|e| e.to_string())? = search::FrameSearchIndex::new();
    Ok(())
}

/// 打开数据目录（含 whichvideo.db）。
#[tauri::command]
pub fn library_open_database_folder() -> Result<String, String> {
    let dir = db::data_dir();
    let dir_str = dir.to_string_lossy().to_string();
    let _ = Command::new("explorer.exe").no_window().arg(&dir_str).spawn();
    Ok(dir_str)
}

/// 运行时数据目录信息（toolsReady 由媒体探测结果决定）。
#[tauri::command]
pub fn library_data_dir() -> Result<db::DataDirInfo, String> {
    Ok(db::data_dir_info(media::tools_ready()))
}

/* ================================================================== */
/* 图片检索：byPath / byDataUrl / byClipboard / byUrl                 */
/* ================================================================== */

const RERANK_TOP_K: usize = 8;
const RERANK_WEIGHT: f64 = 0.3;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchQuery {
    width: u32,
    height: u32,
    color_score_hint: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    video: db::VideoRecord,
    score: f64,
    hash_score: f64,
    color_score: f64,
    time_seconds: f64,
    frame_index: i64,
    hash_distance: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    query: SearchQuery,
    match_count: usize,
    compared_frames: usize,
    elapsed_ms: i64,
    found: bool,
    matches: Vec<SearchMatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    query_image_url: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSearchResult {
    data_url: Option<String>,
    response: SearchResponse,
}

fn round4(x: f64) -> f64 {
    (x * 10000.0).round() / 10000.0
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// 统一的失败响应，四条检索入口共用同一结构。
fn fail_response(code: &str, message: &str) -> SearchResponse {
    SearchResponse {
        query: SearchQuery {
            width: 0,
            height: 0,
            color_score_hint: 0.0,
        },
        match_count: 0,
        compared_frames: 0,
        elapsed_ms: 0,
        found: false,
        matches: Vec::new(),
        error: Some(message.to_string()),
        error_code: Some(code.to_string()),
        query_image_url: None,
    }
}

/// 把一张已解码的图归一化到 EXTRACT_WIDTH 宽、偶数高（与索引帧路径完全对称），
/// 返回 RGB24 像素缓冲。查询图若保留原尺寸（尤其小图），toGray 盒式重采样与
/// 直方图抽样都会和索引侧错开；放大到 320 不引入新信息，但让双方走完全相同的重采样路径。
fn prepare_query_image(img: image::DynamicImage) -> Option<(Vec<u8>, u32, u32)> {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return None;
    }
    let tw = crate::constants::EXTRACT_WIDTH;
    let th = ((2.0 * (h as f64 * tw as f64 / (2.0 * w as f64)).round()) as u32).max(2);
    let resized = img.resize_exact(tw, th, image::imageops::FilterType::Triangle);
    let rgb = resized.to_rgb8();
    let (rw, rh) = (rgb.width(), rgb.height());
    Some((rgb.into_raw(), rw, rh))
}

/// 由归一化后的 RGB24 缓冲计算查询向量。
fn build_query_vector(buf: &[u8], w: u32, h: u32) -> search::QueryVector {
    let ild = hash::ImageDataLike {
        width: w,
        height: h,
        channels: 3,
        order: hash::ChannelOrder::Rgb,
        data: buf,
    };
    let sig = hash::compute_signature(&ild);
    let color = framepack::quantize_color(&sig.color);
    let colorfulness = framepack::quantized_colorfulness(&color);
    search::QueryVector {
        dhash: sig.dhash,
        struct_hash: sig.struct_hash,
        color,
        spatial: sig.spatial,
        colorfulness,
    }
}

/// data URL → 解码字节（仅支持 base64 形态）。
fn decode_data_url(data_url: &str) -> Option<Vec<u8>> {
    let comma = data_url.find(',')?;
    let meta = &data_url[..comma];
    if !meta.contains("base64") {
        return None;
    }
    let b64 = &data_url[comma + 1..];
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// 二阶段验证重排：对粗召回的前 RERANK_TOP_K 个命中解码其命中帧，做像素级 SSIM，
/// 与粗打分凸组合后重排。解码失败（文件已删/时间点越界）保持原分数不惩罚。
fn rerank_matches(conn: &Connection, qild: &hash::ImageDataLike, hits: &mut [search::IndexedHit]) {
    if hits.len() <= 1 {
        return;
    }
    let head_len = hits.len().min(RERANK_TOP_K);
    for i in 0..head_len {
        let (vid, t, old_score) = (hits[i].video_id, hits[i].time_seconds, hits[i].score);
        let video = match db::get_video(conn, vid).ok().flatten() {
            Some(v) => v,
            None => continue,
        };
        let frames = match media::extract_and_hash_frames(
            &video.path,
            &[t],
            video.duration,
            video.width,
            video.height,
            true,
        ) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let frame = match frames.first() {
            Some(f) => f,
            None => continue,
        };
        let fild = hash::ImageDataLike {
            width: frame.width,
            height: frame.height,
            channels: 3,
            order: hash::ChannelOrder::Rgb,
            data: &frame.rgb,
        };
        let ssim = hash::ssim_similarity(qild, &fild, 48, 48);
        let new_score = old_score * (1.0 - RERANK_WEIGHT) + ssim * RERANK_WEIGHT;
        hits[i].score = new_score;
    }
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

/// 命中时间精修：粗召回命中的是采样帧，显示时间 = 该采样帧的时间，与截图帧天然差半个
/// 采样间隔以内。围绕命中时间按局部采样密度并行补采候选帧（逐点 seek），用与粗召回
/// 相同的打分公式选最优；优于命中点自身才改写 timeSeconds。
fn refine_hit_time(qv: &search::QueryVector, video: &db::VideoRecord, hit: &mut search::IndexedHit) {
    let candidates = search::refine_candidate_times(video.duration, video.frame_count as usize, hit.time_seconds);
    if candidates.len() <= 1 {
        return;
    }
    let frames = match media::extract_and_hash_frames(
        &video.path,
        &candidates,
        video.duration,
        video.width,
        video.height,
        true,
    ) {
        Ok(f) => f,
        Err(_) => return,
    };
    let mut best_score = -1.0f64;
    let mut best_time: Option<f64> = None;
    for (i, t) in candidates.iter().enumerate() {
        let fr = match frames.get(i) {
            Some(f) => f,
            None => continue,
        };
        let ild = hash::ImageDataLike {
            width: fr.width,
            height: fr.height,
            channels: 3,
            order: hash::ChannelOrder::Rgb,
            data: &fr.rgb,
        };
        let score = search::score_raw_frame(qv, &ild);
        if score > best_score {
            best_score = score;
            best_time = Some(*t);
        }
    }
    if let Some(bt) = best_time {
        if (bt - hit.time_seconds).abs() > 0.01 {
            hit.time_seconds = round2(bt);
        }
    }
}

/// 检索编排：重建索引 → 粗召回 → SSIM 重排 → 命中时间精修 → 构造响应。
fn perform_search(
    conn: &Connection,
    index: &search::FrameSearchIndex,
    qv: &search::QueryVector,
    qild: &hash::ImageDataLike,
    qw: u32,
    qh: u32,
) -> SearchResponse {
    let started = std::time::SystemTime::now();
    let settings = db::get_settings(conn).unwrap_or_default();
    let candidate_limit = (settings.max_results as usize).max(RERANK_TOP_K);

    let (mut results, compared) = index.search(
        qv,
        &search::SearchOptions {
            min_hash_score: settings.min_hash_score,
            max_results: candidate_limit,
        },
    );

    rerank_matches(conn, qild, &mut results);

    // 命中时间精修：只对最佳命中做（补采 2×4+1 帧逐点 seek），把显示时间从
    // 「最近采样帧」对准到「真实截图帧」。
    if let Some(top) = results.first_mut() {
        if let Some(video) = db::get_video(conn, top.video_id).ok().flatten() {
            refine_hit_time(qv, &video, top);
        }
    }

    let matches: Vec<SearchMatch> = results
        .iter()
        .take(settings.max_results as usize)
        .filter_map(|hit| {
            let video = db::get_video(conn, hit.video_id).ok()??;
            Some(SearchMatch {
                video,
                score: round4(hit.score),
                hash_score: round4(hit.hash_score),
                color_score: round4(hit.color_score),
                time_seconds: round2(hit.time_seconds),
                frame_index: hit.frame_index as i64,
                hash_distance: hit.hash_distance as i64,
            })
        })
        .collect();

    let color_hint = matches.first().map(|m| m.color_score).unwrap_or(0.0);
    let elapsed = started
        .elapsed()
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    SearchResponse {
        query: SearchQuery {
            width: qw,
            height: qh,
            color_score_hint: color_hint,
        },
        match_count: matches.len(),
        compared_frames: compared,
        elapsed_ms: elapsed,
        found: !matches.is_empty(),
        matches,
        error: None,
        error_code: None,
        query_image_url: None,
    }
}

/// 从文件检索。
#[tauri::command]
pub fn search_path(state: State<AppState>, file_path: String) -> Result<SearchResponse, String> {
    let img = match image::open(&file_path) {
        Ok(i) => i,
        Err(e) => return Ok(fail_response("decode-failed", &format!("无法读取图片：{e}"))),
    };
    let (source_width, source_height) = (img.width(), img.height());
    let (buf, w, h) = match prepare_query_image(img) {
        Some(v) => v,
        None => return Ok(fail_response("decode-failed", "图片无法转成位图")),
    };
    let qv = build_query_vector(&buf, w, h);
    let ild = hash::ImageDataLike {
        width: w,
        height: h,
        channels: 3,
        order: hash::ChannelOrder::Rgb,
        data: &buf,
    };
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let index = state.search_index.lock().map_err(|e| e.to_string())?;
    Ok(perform_search(
        conn,
        &index,
        &qv,
        &ild,
        source_width,
        source_height,
    ))
}

/// 从 data URL 检索（拖入/粘贴的 base64 图片）。
#[tauri::command]
pub fn search_data_url(state: State<AppState>, data_url: String) -> Result<SearchResponse, String> {
    let bytes = match decode_data_url(&data_url) {
        Some(b) => b,
        None => return Ok(fail_response("decode-failed", "无法解析图片数据")),
    };
    let img = match image::load_from_memory(&bytes) {
        Ok(i) => i,
        Err(e) => return Ok(fail_response("decode-failed", &format!("无法解码图片：{e}"))),
    };
    let (source_width, source_height) = (img.width(), img.height());
    let (buf, w, h) = match prepare_query_image(img) {
        Some(v) => v,
        None => return Ok(fail_response("decode-failed", "图片无法转成位图")),
    };
    let qv = build_query_vector(&buf, w, h);
    let ild = hash::ImageDataLike {
        width: w,
        height: h,
        channels: 3,
        order: hash::ChannelOrder::Rgb,
        data: &buf,
    };
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let index = state.search_index.lock().map_err(|e| e.to_string())?;
    Ok(perform_search(
        conn,
        &index,
        &qv,
        &ild,
        source_width,
        source_height,
    ))
}

/// 从系统剪贴板检索。剪贴板无图片时返回 null（调用方据此显示空态）。
#[tauri::command]
pub fn search_clipboard(state: State<AppState>) -> Result<Option<ClipboardSearchResult>, String> {
    let png = match read_clipboard_image_png() {
        Some(p) => p,
        None => return Ok(None),
    };
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );
    let img = match image::load_from_memory(&png) {
        Ok(i) => i,
        Err(e) => return Ok(Some(ClipboardSearchResult {
            data_url: Some(data_url),
            response: fail_response("decode-failed", &format!("无法解码剪贴板图片：{e}")),
        })),
    };
    let (source_width, source_height) = (img.width(), img.height());
    let (buf, w, h) = match prepare_query_image(img) {
        Some(v) => v,
        None => return Ok(Some(ClipboardSearchResult {
            data_url: Some(data_url),
            response: fail_response("decode-failed", "剪贴板图片无法转成位图"),
        })),
    };
    let qv = build_query_vector(&buf, w, h);
    let ild = hash::ImageDataLike {
        width: w,
        height: h,
        channels: 3,
        order: hash::ChannelOrder::Rgb,
        data: &buf,
    };
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let index = state.search_index.lock().map_err(|e| e.to_string())?;
    let response = perform_search(
        conn,
        &index,
        &qv,
        &ild,
        source_width,
        source_height,
    );
    Ok(Some(ClipboardSearchResult {
        data_url: Some(data_url),
        response,
    }))
}

/// 从 http(s) 链接检索（图片直链或普通网页里解析出的主图）。失败时 error 字段说明原因。
#[tauri::command]
pub fn search_url(state: State<AppState>, url: String) -> Result<SearchResponse, String> {
    let (bytes, final_url) = match fetch_image_from_url(&url) {
        Ok(v) => v,
        Err((code, msg)) => return Ok(fail_response(&code, &msg)),
    };
    let img = match image::load_from_memory(&bytes) {
        Ok(i) => i,
        Err(e) => {
            return Ok(fail_response(
                "decode-failed",
                &format!("图片已下载但无法解码：{e}"),
            ))
        }
    };
    let (source_width, source_height) = (img.width(), img.height());
    let (buf, w, h) = match prepare_query_image(img) {
        Some(v) => v,
        None => return Ok(fail_response("decode-failed", "下载的图片无法转成位图")),
    };
    let qv = build_query_vector(&buf, w, h);
    let ild = hash::ImageDataLike {
        width: w,
        height: h,
        channels: 3,
        order: hash::ChannelOrder::Rgb,
        data: &buf,
    };
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let index = state.search_index.lock().map_err(|e| e.to_string())?;
    let mut response = perform_search(
        conn,
        &index,
        &qv,
        &ild,
        source_width,
        source_height,
    );
    response.query_image_url = Some(final_url);
    Ok(response)
}

/* ================================================================== */
/* 系统对话框（依赖 PowerShell，Windows 平台）                         */
/* ================================================================== */

#[cfg(windows)]
fn run_powershell(script: &str) -> Option<String> {
    let out = Command::new("powershell")
        .no_window()
        .args(["-NoProfile", "-STA", "-Command", script])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(windows)]
fn pick_folder_dialog(description: &str) -> Option<String> {
    let script = format!("Add-Type -AssemblyName System.windows.forms; \
        $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
        $d.Description = '{}'; \
        if ($d.ShowDialog() -eq 'OK') {{ $d.SelectedPath }}",
        description.replace('\'', "''")
    );
    run_powershell(&script)
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
fn pick_folder_dialog(_description: &str) -> Option<String> {
    None
}

#[cfg(not(windows))]
fn pick_files_dialog(_title: &str, _filter_name: &str, _exts: &[&str]) -> Vec<String> {
    Vec::new()
}

/* ================================================================== */
/* 剪贴板 / 网络图片取图（依赖 PowerShell，Windows 平台）              */
/* ================================================================== */

/// 读取系统剪贴板里的图片，返回 PNG 字节（base64 解码后）。无图片返回 None。
#[cfg(windows)]
fn read_clipboard_image_png() -> Option<Vec<u8>> {
    let script = "Add-Type -AssemblyName System.Windows.Forms; \
        Add-Type -AssemblyName System.Drawing; \
        if ([System.Windows.Forms.Clipboard]::ContainsImage()) { \
            $img = [System.Windows.Forms.Clipboard]::GetImage(); \
            $ms = New-Object System.IO.MemoryStream; \
            $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); \
            [System.Convert]::ToBase64String($ms.ToArray()) \
        } else { 'NONE' }";
    let out = run_powershell(script)?;
    let trimmed = out.trim();
    if trimmed.is_empty() || trimmed == "NONE" {
        return None;
    }
    base64::engine::general_purpose::STANDARD
        .decode(trimmed)
        .ok()
}

#[cfg(not(windows))]
fn read_clipboard_image_png() -> Option<Vec<u8>> {
    None
}

/// 从 http(s) 链接取图：直链直接下载；普通网页依次尝试 og:image / twitter:image /
/// image_src / 首个 <img>。成功返回 (图片字节, 最终取图地址)；失败返回 (错误码, 文案)。
/// 为避免大体积 base64 走 stdout，PowerShell 把图片落到临时文件，Rust 读出后删除。
#[cfg(windows)]
fn fetch_image_from_url(url: &str) -> Result<(Vec<u8>, String), (String, String)> {
    const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
    let input = url.trim();
    if input.is_empty() {
        return Err(("invalid-input".to_string(), "请输入图片链接".to_string()));
    }
    let lower = input.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err((
            "unsupported-protocol".to_string(),
            "只支持 http / https 开头的链接".to_string(),
        ));
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(input.as_bytes());
    let template = " \
        $ErrorActionPreference = 'Stop'; \
        $b = [System.Convert]::FromBase64String('__B64__'); \
        $url = [System.Text.Encoding]::UTF8.GetString($b); \
        $tmpHtml = Join-Path $env:TEMP ('wv_html_' + [guid]::NewGuid().ToString('N') + '.bin'); \
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15 -MaximumRedirection 5 -UserAgent 'WhichVideo/0.1 (local image search)' -OutFile $tmpHtml; \
        $final = if ($r.BaseResponse -and $r.BaseResponse.ResponseUri) { $r.BaseResponse.ResponseUri.AbsoluteUri } else { $url }; \
        $ct = $r.Headers['Content-Type']; \
        if ($ct -match 'image/') { \
            'OK|' + $tmpHtml + '|' + $final \
        } else { \
            $html = [System.IO.File]::ReadAllText($tmpHtml); \
            $imgUrl = $null; \
            if ($html -match 'property=\"og:image\" content=\"([^\"]+)\"') { $imgUrl = $matches[1] } \
            elseif ($html -match 'property=\"twitter:image\" content=\"([^\"]+)\"') { $imgUrl = $matches[1] } \
            elseif ($html -match 'name=\"image_src\" content=\"([^\"]+)\"') { $imgUrl = $matches[1] } \
            elseif ($html -match '<img[^>]+src=\"([^\"]+)\"') { $imgUrl = $matches[1] } \
            if ($imgUrl) { \
                if ($imgUrl.StartsWith('//')) { $u = [System.Uri]$url; $imgUrl = $u.Scheme + ':' + $imgUrl } \
                elseif ($imgUrl.StartsWith('/')) { $u = [System.Uri]$url; $imgUrl = $u.Scheme + '://' + $u.Host + $imgUrl } \
                $tmpImg = Join-Path $env:TEMP ('wv_img_' + [guid]::NewGuid().ToString('N') + '.bin'); \
                try { Invoke-WebRequest -Uri $imgUrl -UseBasicParsing -TimeoutSec 15 -MaximumRedirection 5 -UserAgent 'WhichVideo/0.1 (local image search)' -OutFile $tmpImg; 'OK|' + $tmpImg + '|' + $imgUrl } \
                catch { 'ERR|no-image|无法下载网页中的图片' }; \
                Remove-Item $tmpHtml -ErrorAction SilentlyContinue \
            } else { \
                Remove-Item $tmpHtml -ErrorAction SilentlyContinue; \
                'ERR|no-image|网页里没找到图片' \
            } \
        }";
    let script = template.replace("__B64__", &b64);
    let out = match run_powershell(&script) {
        Some(o) => o,
        None => return Err(("network".to_string(), "无法执行网络请求".to_string())),
    };
    let line = out.trim();
    if let Some(rest) = line.strip_prefix("OK|") {
        let mut parts = rest.splitn(3, '|');
        let path = parts.next().unwrap_or("").to_string();
        let final_url = parts.next().unwrap_or("").to_string();
        if std::fs::metadata(&path)
            .map(|m| m.len() > MAX_IMAGE_BYTES)
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(&path);
            return Err((
                "too-large".to_string(),
                "图片过大（超过 10 MB 上限）".to_string(),
            ));
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                return Err(("decode-failed".to_string(), format!("读取下载图片失败：{e}")))
            }
        };
        let _ = std::fs::remove_file(&path);
        Ok((bytes, final_url))
    } else if let Some(rest) = line.strip_prefix("ERR|") {
        let mut parts = rest.splitn(2, '|');
        let code = parts.next().unwrap_or("internal").to_string();
        let msg = parts.next().unwrap_or("").to_string();
        Err((code, msg))
    } else {
        Err(("internal".to_string(), "未知响应".to_string()))
    }
}

#[cfg(not(windows))]
fn fetch_image_from_url(_url: &str) -> Result<(Vec<u8>, String), (String, String)> {
    Err((
        "unsupported-protocol".to_string(),
        "当前平台不支持链接检索".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_pair_key_is_order_independent() {
        assert_eq!(pair_key(7, 3), (3, 7));
        assert_eq!(pair_key(3, 7), (3, 7));
    }

    #[test]
    fn query_image_is_resized_to_exact_ffmpeg_dimensions() {
        let image = image::DynamicImage::new_rgb8(1000, 333);
        let (pixels, width, height) = prepare_query_image(image).unwrap();
        assert_eq!((width, height), (crate::constants::EXTRACT_WIDTH, 106));
        assert_eq!(pixels.len(), width as usize * height as usize * 3);
    }

    #[cfg(windows)]
    #[test]
    fn url_search_rejects_empty_and_non_http_inputs_before_fetching() {
        assert_eq!(fetch_image_from_url("  ").unwrap_err().0, "invalid-input");
        assert_eq!(
            fetch_image_from_url("file:///C:/secret.png").unwrap_err().0,
            "unsupported-protocol"
        );
    }
}
