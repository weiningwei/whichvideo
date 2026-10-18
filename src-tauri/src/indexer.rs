//! 索引器：把待处理视频抽帧、算指纹、写库，并对外播报进度。
//!
//! 镜像 Electron src/main/indexer.ts 的队列 + 处理模型，但状态保存在 AppState
//! （共享受 Mutex 保护）。每条视频在独立线程里处理（ffmpeg 阻塞调用），并发数
//! 受 settings.concurrency 限制。处理前后通过 Tauri 事件通道（library_event）
//! 广播 status / stats / video-updated，供渲染端动态刷新。

use crate::constants;
use crate::db;
use crate::events::{ImportResult, LibraryEvent};
use crate::framepack;
use crate::hash;
use crate::logger;
use crate::media;
use crate::sampling;
use crate::state::AppState;
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Emitter, Manager};

/// 索引器队列与实时状态。
pub struct IndexerState {
    pub queue: Vec<i64>,
    pub queued: HashSet<i64>,
    pub active: usize,
    pub done: u64,
    pub failed: u64,
    pub current_path: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub last_error: Option<String>,
    /// 单视频帧进度：video_id -> (done, total, phase)
    pub frame_progress: HashMap<i64, (i64, i64, Option<String>)>,
}

impl Default for IndexerState {
    fn default() -> Self {
        IndexerState {
            queue: Vec::new(),
            queued: HashSet::new(),
            active: 0,
            done: 0,
            failed: 0,
            current_path: None,
            started_at: None,
            finished_at: None,
            last_error: None,
            frame_progress: HashMap::new(),
        }
    }
}

impl IndexerState {
    /// 当前索引器状态（供 library_status 命令）。
    pub fn status(&self) -> db::IndexerStatus {
        let total = (self.done + self.failed) as i64 + self.queue.len() as i64 + self.active as i64;
        db::IndexerStatus {
            running: self.active > 0 || !self.queue.is_empty(),
            active: self.active as i64,
            queued: self.queue.len() as i64,
            total,
            done: self.done as i64,
            failed: self.failed as i64,
            current_path: self.current_path.clone(),
            started_at: self.started_at,
            finished_at: self.finished_at,
            last_error: self.last_error.clone(),
        }
    }
}

/* ------------------------------------------------------------------ */
/* 事件广播辅助                                                        */
/* ------------------------------------------------------------------ */

const EVENT_CHANNEL: &str = "library_event";

fn emit(app: &AppHandle, event: LibraryEvent) {
    let _ = app.emit(EVENT_CHANNEL, event);
}

fn broadcast_status(app: &AppHandle) {
    let state = app.state::<AppState>();
    let status = {
        let idx = state.indexer.lock().unwrap();
        idx.status()
    };
    emit(app, LibraryEvent::Status { status });
}

fn broadcast_stats(app: &AppHandle) {
    let state = app.state::<AppState>();
    let stats = {
        let mut guard = state.db.lock().unwrap();
        match guard.as_mut() {
            Some(c) => db::stats(c).ok(),
            None => None,
        }
    };
    if let Some(stats) = stats {
        emit(app, LibraryEvent::Stats { stats });
    }
}

fn emit_video_updated(app: &AppHandle, id: i64) {
    let state = app.state::<AppState>();
    let video = {
        let mut guard = state.db.lock().unwrap();
        match guard.as_mut() {
            Some(c) => db::get_video(c, id).ok().flatten(),
            None => None,
        }
    };
    if let Some(video) = video {
        emit(app, LibraryEvent::VideoUpdated { video });
    }
}

fn set_current_path(app: &AppHandle, path: String) {
    let state = app.state::<AppState>();
    let mut idx = state.indexer.lock().unwrap();
    idx.current_path = Some(path);
}

fn set_frame_progress(app: &AppHandle, video_id: i64, done: i64, total: i64, phase: Option<&str>) {
    let state = app.state::<AppState>();
    let mut idx = state.indexer.lock().unwrap();
    idx.frame_progress
        .insert(video_id, (done, total, phase.map(|s| s.to_string())));
}

fn clear_frame_progress(app: &AppHandle, video_id: i64) {
    let state = app.state::<AppState>();
    let mut idx = state.indexer.lock().unwrap();
    idx.frame_progress.remove(&video_id);
}

/// 查询单视频帧进度（供 videos.frameProgress 命令）。
pub fn get_frame_progress(app: &AppHandle, video_id: i64) -> Option<crate::events::FrameProgress> {
    let state = app.state::<AppState>();
    let idx = state.indexer.lock().unwrap();
    idx.frame_progress.get(&video_id).map(|(done, total, phase)| crate::events::FrameProgress {
        video_id,
        done: *done,
        total: *total,
        phase: phase.clone(),
    })
}

/* ------------------------------------------------------------------ */
/* 队列与泵                                                            */
/* ------------------------------------------------------------------ */

/// 把视频加入索引队列（去重：已在队列中则跳过）。force 仅在未入队时生效。
pub fn enqueue(app: AppHandle, video_id: i64, _force: bool) {
    let already = {
        let state = app.state::<AppState>();
        let mut idx = state.indexer.lock().unwrap();
        if idx.queued.contains(&video_id) {
            true
        } else {
            idx.queued.insert(video_id);
            idx.queue.push(video_id);
            if idx.started_at.is_none() {
                idx.started_at = Some(db::now_ms());
            }
            idx.finished_at = None;
            false
        }
    };
    if already {
        return;
    }
    {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        if let Some(c) = guard.as_mut() {
            let _ = db::set_video_status(c, video_id, "pending", None);
        }
    }
    emit_video_updated(&app, video_id);
    broadcast_status(&app);
    pump(app);
}

/// 从队列取任务并发处理，直到达到并发上限。
pub fn pump(app: AppHandle) {
    let concurrency = {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        match guard.as_mut() {
            Some(c) => db::get_settings(c)
                .map(|s| (s.concurrency.max(1)) as usize)
                .unwrap_or(2),
            None => 2,
        }
    };
    loop {
        let id = {
            let state = app.state::<AppState>();
            let mut idx = state.indexer.lock().unwrap();
            if idx.active >= concurrency || idx.queue.is_empty() {
                break;
            }
            let id = idx.queue.remove(0);
            idx.queued.remove(&id);
            idx.active += 1;
            id
        };
        let app2 = app.clone();
        std::thread::spawn(move || {
            process_video(app2, id);
        });
    }
    broadcast_status(&app);
}

/// 任务结束的收尾：更新计数、播报、继续泵队列。
fn finish(app: AppHandle, ok: bool) {
    {
        let state = app.state::<AppState>();
        let mut idx = state.indexer.lock().unwrap();
        idx.active = idx.active.saturating_sub(1);
        if ok {
            idx.done += 1;
        } else {
            idx.failed += 1;
        }
        if idx.active == 0 && idx.queue.is_empty() {
            if idx.finished_at.is_none() {
                idx.finished_at = Some(db::now_ms());
            }
            idx.current_path = None;
        }
    }
    broadcast_status(&app);
    broadcast_stats(&app);
    pump(app);
}

fn fail(app: AppHandle, video_id: i64, error: &str) {
    {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        if let Some(c) = guard.as_mut() {
            let _ = db::set_video_status(c, video_id, "failed", Some(error));
        }
    }
    rebuild_search_index(&app);
    emit_video_updated(&app, video_id);
    emit(
        &app,
        LibraryEvent::Notice {
            level: "error".to_string(),
            message: format!("索引失败：{error}"),
        },
    );
    finish(app, false);
}

fn rebuild_search_index(app: &AppHandle) {
    let state = app.state::<AppState>();
    let rebuilt = {
        let guard = state.db.lock().unwrap();
        guard
            .as_ref()
            .map(crate::search::FrameSearchIndex::rebuild_from_db)
    };
    if let Some(index) = rebuilt {
        *state.search_index.lock().unwrap() = index;
    }
}

fn finish_ready(app: AppHandle, video_id: i64) {
    rebuild_search_index(&app);
    emit_video_updated(&app, video_id);
    finish(app, true);
}

/* ------------------------------------------------------------------ */
/* 单视频处理                                                          */
/* ------------------------------------------------------------------ */

fn process_video(app: AppHandle, video_id: i64) {
    let settings = {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        match guard.as_mut() {
            Some(c) => db::get_settings(c).unwrap_or_else(|_| db::default_settings()),
            None => db::default_settings(),
        }
    };

    let video = {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        match guard.as_mut() {
            Some(c) => db::get_video(c, video_id).ok().flatten(),
            None => None,
        }
    };
    let video = match video {
        Some(v) => v,
        None => {
            finish(app, false);
            return;
        }
    };

    set_current_path(&app, video.path.clone());
    {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        if let Some(c) = guard.as_mut() {
            let _ = db::set_video_status(c, video_id, "indexing", None);
        }
    }
    emit_video_updated(&app, video_id);

    if !std::path::Path::new(&video.path).exists() {
        fail(app, video_id, "文件已不存在");
        return;
    }

    // 缺时长则探测
    let (duration, width, height, _codec) = if video.duration.is_none() {
        match media::probe_video(&video.path) {
            Ok(p) => {
                let input = db::UpsertVideoInput {
                    path: video.path.clone(),
                    size: video.size,
                    mtime_ms: video.mtime_ms,
                    duration: p.duration,
                    width: p.width,
                    height: p.height,
                    video_codec: p.video_codec.clone(),
                    folder_id: video.folder_id,
                    file_hash: video.file_hash.clone(),
                };
                {
                    let state = app.state::<AppState>();
                    let mut guard = state.db.lock().unwrap();
                    if let Some(c) = guard.as_mut() {
                        let _ = db::upsert_video(c, &input);
                    }
                }
                (p.duration, p.width, p.height, p.video_codec)
            }
            Err(e) => {
                fail(app, video_id, &format!("探测失败：{e}"));
                return;
            }
        }
    } else {
        (video.duration, video.width, video.height, video.video_codec.clone())
    };

    // 采样计划：视频级覆盖优先，否则全局设置；并把实际使用的模式固化到记录。
    let effective = video
        .sampling_override
        .clone()
        .unwrap_or_else(|| settings.sampling_mode.clone());
    set_sampling_override(&app, &[video_id], &effective);
    let force_seek = effective == "scene";

    let timestamps = if force_seek {
        set_frame_progress(&app, video_id, 0, duration.unwrap_or(0.0).round() as i64, Some("detecting"));
        match media::detect_scenes(&video.path, 0.3) {
            Ok(scenes) => sampling::plan_scene_timestamps(&scenes, duration, settings.frames_per_video as usize),
            Err(e) => {
                log(&format!("场景检测失败，退回均匀采样：{e}"));
                set_sampling_override(&app, &[video_id], "uniform");
                sampling::plan_timestamps(duration, settings.frames_per_video as usize)
            }
        }
    } else {
        sampling::plan_timestamps(duration, settings.frames_per_video as usize)
    };

    let processed: Vec<i64> = video.processed_timestamps.clone();
    let start_index = processed.len().min(timestamps.len());
    if start_index >= timestamps.len() {
        // 已完成
        finish_ready(app, video_id);
        return;
    }
    // 全新跑才清旧帧图/帧数据，断点续传不清（保留已落库帧）
    if start_index == 0 {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        if let Some(c) = guard.as_mut() {
            let _ = db::clear_frames(c, &[video_id]);
        }
    }
    set_frame_progress(
        &app,
        video_id,
        start_index as i64,
        timestamps.len() as i64,
        Some("extracting"),
    );

    let uses_full_scan =
        !force_seek && sampling::should_use_full_scan(timestamps.len(), width, height);
    let batch_size = if uses_full_scan {
        timestamps.len() - start_index
    } else {
        32
    };
    let mut current_processed = processed.clone();

    let mut bi = start_index;
    while bi < timestamps.len() {
        let batch_end = (bi + batch_size).min(timestamps.len());
        let batch_ts: Vec<f64> = timestamps[bi..batch_end].to_vec();
        let started = std::time::Instant::now();
        let frames = match media::extract_and_hash_frames(
            &video.path,
            &batch_ts,
            duration,
            width,
            height,
            force_seek,
        ) {
            Ok(f) => f,
            Err(e) => {
                fail(app, video_id, &format!("抽帧失败：{e}"));
                return;
            }
        };
        let elapsed = started.elapsed().as_millis() as i64;

        if !frames.is_empty() {
            let mut new_frames = Vec::with_capacity(frames.len());
            for (i, fr) in frames.iter().enumerate() {
                let img = hash::ImageDataLike {
                    width: fr.width,
                    height: fr.height,
                    channels: 3,
                    order: hash::ChannelOrder::Rgb,
                    data: &fr.rgb,
                };
                let sig = hash::compute_signature(&img);
                let color = framepack::quantize_color(&sig.color);
                new_frames.push(db::NewFrame {
                    dhash: sig.dhash as i64,
                    struct_hash: sig.struct_hash,
                    color,
                    spatial: sig.spatial,
                    frame_index: (bi + i) as i64,
                    time_ms: (fr.time * 1000.0).round() as i64,
                });
            }
            {
                let state = app.state::<AppState>();
                let mut guard = state.db.lock().unwrap();
                if let Some(c) = guard.as_mut() {
                    let _ = db::upsert_frames_incremental(c, video_id, &new_frames);
                    let _ = db::add_processed_ms(c, video_id, elapsed);
                }
            }
            current_processed.extend(
                batch_ts.iter().map(|t| (t * 1000.0).round() as i64),
            );
            {
                let state = app.state::<AppState>();
                let mut guard = state.db.lock().unwrap();
                if let Some(c) = guard.as_mut() {
                    let _ = db::update_processed_timestamps(c, video_id, &current_processed);
                    let _ = db::set_video_status(c, video_id, "indexing", None);
                }
            }
            set_frame_progress(
                &app,
                video_id,
                current_processed.len() as i64,
                timestamps.len() as i64,
                Some("extracting"),
            );
            emit_video_updated(&app, video_id);
        }
        bi = batch_end;
    }

    // 缩略图（兜底：失败也标记完成）
    let thumb_time = duration
        .map(|d| d * 0.12)
        .unwrap_or_else(|| timestamps.first().copied().unwrap_or(0.0));
    let thumb = media::make_thumbnail(&video.path, thumb_time, constants::EXTRACT_WIDTH);
    {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        if let Some(c) = guard.as_mut() {
            let _ = db::set_ready_with_thumbnail(c, video_id, thumb.as_deref());
        }
    }
    clear_frame_progress(&app, video_id);
    finish_ready(app, video_id);
}

/* ------------------------------------------------------------------ */
/* 导入 / 扫描                                                         */
/* ------------------------------------------------------------------ */

fn set_sampling_override(app: &AppHandle, ids: &[i64], mode: &str) {
    let state = app.state::<AppState>();
    let mut guard = state.db.lock().unwrap();
    if let Some(c) = guard.as_mut() {
        let _ = db::set_sampling_override(c, ids, mode);
    }
}

fn stat_file(path: &str) -> (i64, i64) {
    match std::fs::metadata(path) {
        Ok(m) => (
            m.len() as i64,
            m.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        ),
        Err(_) => (0, 0),
    }
}

pub fn is_video_file(name: &str) -> bool {
    let dot = match name.rfind('.') {
        Some(d) => d,
        None => return false,
    };
    let ext = &name[dot..];
    matches!(
        ext.to_lowercase().as_str(),
        ".mp4" | ".mkv" | ".avi" | ".mov" | ".wmv" | ".flv" | ".webm" | ".m4v" | ".mpg"
            | ".mpeg" | ".ts" | ".m2ts" | ".rmvb" | ".rm" | ".3gp" | ".vob" | ".ogv"
    )
}

fn scan_video_files(root: &str, recursive: bool) -> Vec<String> {
    let mut out = Vec::new();
    walk(root, 0, recursive, &mut out);
    out
}

fn walk(dir: &str, depth: usize, recursive: bool, out: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let pstr = path.to_string_lossy().to_string();
        if path.is_dir() {
            if recursive && depth < crate::constants::MAX_SCAN_DEPTH {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if !crate::constants::DEFAULT_SKIP_DIRS.contains(&name.as_str()) {
                    walk(&pstr, depth + 1, recursive, out);
                }
            }
        } else if path.is_file() {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_video_file(&name) {
                out.push(pstr);
            }
        }
    }
}

/// 注册单个文件并加入索引队列，更新 result 计数。
fn register_and_enqueue(app: &AppHandle, path: String, folder_id: Option<i64>, result: &mut ImportResult) {
    let state = app.state::<AppState>();
    result.scanned += 1;
    if !std::path::Path::new(&path).exists() {
        result.skipped += 1;
        return;
    }
    let probe = {
        let mut guard = state.db.lock().unwrap();
        match guard.as_mut() {
            Some(c) => db::find_by_path(c, &path)
                .ok()
                .flatten()
                .filter(|v| v.duration.is_some())
                .map(|v| (v.duration, v.width, v.height, v.video_codec)),
            None => None,
        }
    };
    let (duration, width, height, codec) = match probe {
        Some(p) => p,
        None => match media::probe_video(&path) {
            Ok(p) => (p.duration, p.width, p.height, p.video_codec),
            Err(_) => {
                result.skipped += 1;
                return;
            }
        },
    };
    let file_hash = media::sha256_of_file(&path).ok();
    let (size, mtime) = stat_file(&path);
    let input = db::UpsertVideoInput {
        path: path.clone(),
        size,
        mtime_ms: mtime,
        duration,
        width,
        height,
        video_codec: codec,
        folder_id,
        file_hash,
    };
    let (video, created, changed) = {
        let mut guard = state.db.lock().unwrap();
        match guard.as_mut() {
            Some(c) => match db::upsert_video(c, &input) {
                Ok(r) => r,
                Err(_) => {
                    result.skipped += 1;
                    return;
                }
            },
            None => {
                result.skipped += 1;
                return;
            }
        }
    };
    if created || changed {
        result.added += 1;
    } else if video.status == "ready" {
        result.duplicates += 1;
        return;
    }
    emit_video_updated(app, video.id);
    enqueue(app.clone(), video.id, false);
}

/// 导入若干视频文件（来自文件对话框或 watcher）。
pub fn import_files(app: AppHandle, files: Vec<String>, folder_id: Option<i64>) -> ImportResult {
    let mut result = ImportResult::default();
    for raw in &files {
        let path = db::normalize_path(raw);
        register_and_enqueue(&app, path, folder_id, &mut result);
    }
    broadcast_stats(&app);
    result
}

/// 导入并持续监听一个目录（递归扫描视频文件）。
pub fn import_folder(
    app: AppHandle,
    dir_path: String,
    pinned: bool,
    recursive: bool,
) -> Result<(ImportResult, i64), String> {
    let folder = {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        match guard.as_mut() {
            Some(c) => db::insert_folder(c, &dir_path, pinned, recursive).map_err(|e| e.to_string())?,
            None => return Err("数据库未初始化".to_string()),
        }
    };
    let mut result = ImportResult::default();
    result.folders = 1;
    let files = scan_video_files(&folder.path, recursive);
    for file in files {
        register_and_enqueue(&app, file, Some(folder.id), &mut result);
    }
    {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        if let Some(c) = guard.as_mut() {
            let _ = db::mark_folder_scanned(c, folder.id);
            let _ = db::update_folder_state(c, folder.id, "watching", None);
        }
    }
    let refreshed = {
        let state = app.state::<AppState>();
        let guard = state.db.lock().unwrap();
        guard
            .as_ref()
            .and_then(|c| db::get_folder(c, folder.id).ok())
            .flatten()
    };
    if let Some(f) = refreshed {
        emit(&app, LibraryEvent::FolderUpdated { folder: f });
    }
    broadcast_stats(&app);
    Ok((result, folder.id))
}

/// 重建索引：按各视频当前记录的模式重抽（mode 仅指定时写入覆盖）。
pub fn reindex(app: AppHandle, video_ids: Option<Vec<i64>>, mode: Option<String>) -> i64 {
    let targets: Vec<i64> = {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        match guard.as_mut() {
            Some(c) => match &video_ids {
                Some(ids) => ids
                    .iter()
                    .filter_map(|id| db::get_video(c, *id).ok().flatten().map(|v| v.id))
                    .collect(),
                None => db::list_videos(c, &db::VideoQuery::default())
                    .map(|p| p.items.iter().map(|v| v.id).collect())
                    .unwrap_or_default(),
            },
            None => Vec::new(),
        }
    };
    if let Some(m) = &mode {
        let ids = targets.clone();
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        if let Some(c) = guard.as_mut() {
            let _ = db::set_sampling_override(c, &ids, m);
        }
    }
    if !targets.is_empty() {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        if let Some(c) = guard.as_mut() {
            let _ = db::clear_frames(c, &targets);
        }
    }
    for id in &targets {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        if let Some(c) = guard.as_mut() {
            let _ = db::update_processed_timestamps(c, *id, &[]);
            let _ = db::set_video_status(c, *id, "pending", None);
        }
        emit_video_updated(&app, *id);
        enqueue(app.clone(), *id, true);
    }
    targets.len() as i64
}

/// 启动恢复：把上次未完成（pending/indexing）的视频重新入队。
#[allow(dead_code)]
pub fn resume_pending(app: AppHandle) {
    if !media::tools_ready() {
        return;
    }
    let pending = {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap();
        match guard.as_mut() {
            Some(c) => db::list_pending_videos(c).unwrap_or_default(),
            None => Vec::new(),
        }
    };
    for v in &pending {
        if v.status == "indexing" {
            let state = app.state::<AppState>();
            let mut guard = state.db.lock().unwrap();
            if let Some(c) = guard.as_mut() {
                let _ = db::set_video_status(c, v.id, "pending", None);
            }
        }
        enqueue(app.clone(), v.id, true);
    }
    if !pending.is_empty() {
        log(&format!(
            "恢复索引队列：{} 个待处理视频",
            pending.len()
        ));
    }
}

fn log(msg: &str) {
    logger::log(&format!("[indexer] {msg}"));
}
