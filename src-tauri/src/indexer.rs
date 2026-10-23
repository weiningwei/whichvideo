//! 索引器：把待处理视频抽帧、算指纹、写库，并对外播报进度。
//!
//! 索引队列与处理模型，状态保存在 AppState
//! （共享受 Mutex 保护）。每条视频在独立线程里处理（ffmpeg 阻塞调用），并发数
//! 受 settings.concurrency 限制。处理前后通过 Tauri 事件通道（library_event）
//! 广播 status / stats / video-updated，供渲染端动态刷新。

use crate::constants;
use crate::db;
use crate::events::{ImportResult, LibraryEvent};
use crate::framepack;
use crate::frames_store;
use crate::hash;
use crate::logger;
use crate::media;
use crate::sampling;
use crate::state::AppState;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 索引器队列与实时状态。
#[derive(Default)]
pub struct IndexerState {
    pub queue: VecDeque<i64>,
    pub queued: HashSet<i64>,
    pub active_ids: HashSet<i64>,
    pub cancelled: HashSet<i64>,
    /// 需要在真正开始处理时清空旧索引的视频。这样正在处理的视频可以安全地
    /// 排队重建，而不会提前删掉当前工作线程仍在使用的数据。
    pub reset_before_run: HashSet<i64>,
    pub active: usize,
    /// 抽帧并发上限。缓存设置值，避免每次 `pump` 都去读一次数据库（导入几千
    /// 个文件时，每次入队一次 `get_settings` 会和扫描、UI 查询抢同一把库锁）。
    pub concurrency: usize,
    pub done: u64,
    pub failed: u64,
    pub current_path: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub last_error: Option<String>,
    /// 单视频帧进度：video_id -> (done, total, phase)
    pub frame_progress: HashMap<i64, (i64, i64, Option<String>)>,
}

impl IndexerState {
    /// 新批次从独立的进度与错误状态开始，避免上一次任务的结果污染状态栏。
    fn start_new_batch(&mut self) {
        self.done = 0;
        self.failed = 0;
        self.current_path = None;
        self.started_at = Some(db::now_ms());
        self.finished_at = None;
        self.last_error = None;
    }

    fn schedule(&mut self, video_id: i64, force: bool) -> Option<bool> {
        if force {
            self.reset_before_run.insert(video_id);
        }
        if self.queued.contains(&video_id) || (self.active_ids.contains(&video_id) && !force) {
            return None;
        }
        let deferred = self.active_ids.contains(&video_id);
        self.queued.insert(video_id);
        self.queue.push_back(video_id);
        Some(deferred)
    }

    fn take_next(&mut self, concurrency: usize) -> Option<(i64, bool)> {
        if self.active >= concurrency {
            return None;
        }
        // 大批量导入的常规路径从队首 O(1) 取出；只有活动视频被强制重建、
        // 其待办项挡在队首时，才查找后面可运行的任务并保留原有顺序。
        let id = match self.queue.front().copied()? {
            front if !self.active_ids.contains(&front) => self.queue.pop_front()?,
            _ => {
                let position = self
                    .queue
                    .iter()
                    .position(|id| !self.active_ids.contains(id))?;
                self.queue.remove(position)?
            }
        };
        self.queued.remove(&id);
        self.active_ids.insert(id);
        self.active += 1;
        Some((id, self.reset_before_run.remove(&id)))
    }

    fn cancel_one(&mut self, video_id: i64) {
        self.queue.retain(|id| *id != video_id);
        self.queued.remove(&video_id);
        self.reset_before_run.remove(&video_id);
        self.frame_progress.remove(&video_id);
        if self.active_ids.contains(&video_id) {
            self.cancelled.insert(video_id);
        }
    }

    fn cancel_all_jobs(&mut self) {
        self.queue.clear();
        self.queued.clear();
        self.reset_before_run.clear();
        self.frame_progress.clear();
        self.cancelled.extend(self.active_ids.iter().copied());
    }

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

fn emit(app: &AppHandle, event: LibraryEvent) {
    let _ = app.emit(constants::EVENT_CHANNEL, event);
}

fn broadcast_status(app: &AppHandle) {
    let state = app.state::<AppState>();
    let status = {
        let idx = state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        idx.status()
    };
    emit(app, LibraryEvent::Status { status });
}

const STATUS_BROADCAST_INTERVAL: Duration = Duration::from_millis(200);
static LAST_STATUS_AT: Mutex<Option<Instant>> = Mutex::new(None);

fn broadcast_status_throttled(app: &AppHandle) {
    let now = Instant::now();
    {
        let mut last = LAST_STATUS_AT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if last.is_some_and(|at| now.saturating_duration_since(at) < STATUS_BROADCAST_INTERVAL) {
            return;
        }
        *last = Some(now);
    }
    broadcast_status(app);
}

/// 统计事件节流：`finish` 每个视频都会调一次，而 `db::stats` 要扫 frames 全表
/// （百万行是几十毫秒级）。原来每完成一个视频算一次，库越大索引越慢。
const STATS_BROADCAST_INTERVAL: Duration = Duration::from_millis(500);
static LAST_STATS_AT: Mutex<Option<Instant>> = Mutex::new(None);

/// 节流判定（纯函数，便于测试）。
fn should_broadcast_stats(last: Option<Instant>, now: Instant) -> bool {
    match last {
        Some(last) => now.saturating_duration_since(last) >= STATS_BROADCAST_INTERVAL,
        None => true,
    }
}

/// 把数量变化折算成事件，供渲染端更新顶栏与状态栏。
fn broadcast_stats(app: &AppHandle) {
    let now = Instant::now();
    {
        let mut last = LAST_STATS_AT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !should_broadcast_stats(*last, now) {
            return;
        }
        *last = Some(now);
    }
    emit_stats(app);
}

/// 批次收尾必须给出最终计数，不能被节流吞掉。
pub(crate) fn broadcast_stats_now(app: &AppHandle) {
    *LAST_STATS_AT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Instant::now());
    emit_stats(app);
}

fn emit_stats(app: &AppHandle) {
    let state = app.state::<AppState>();
    let stats = {
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_mut() {
            Some(c) => db::get_video(c, id).ok().flatten(),
            None => None,
        }
    };
    if let Some(video) = video {
        emit(app, LibraryEvent::VideoUpdated { video: Box::new(video) });
    }
}

fn set_current_path(app: &AppHandle, path: String) {
    let state = app.state::<AppState>();
    let mut idx = state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    idx.current_path = Some(path);
}

fn set_frame_progress(app: &AppHandle, video_id: i64, done: i64, total: i64, phase: Option<&str>) {
    let state = app.state::<AppState>();
    let mut idx = state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    idx.frame_progress
        .insert(video_id, (done, total, phase.map(|s| s.to_string())));
}

fn clear_frame_progress(app: &AppHandle, video_id: i64) {
    let state = app.state::<AppState>();
    let mut idx = state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    idx.frame_progress.remove(&video_id);
}

/// 查询单视频帧进度（供 videos.frameProgress 命令）。
pub fn get_frame_progress(app: &AppHandle, video_id: i64) -> Option<crate::events::FrameProgress> {
    let state = app.state::<AppState>();
    let idx = state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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

/// 把视频加入索引队列。同一视频不会并发处理；force 会把活动任务之后的重建请求
/// 保留在队列中，并在它真正开始时才清空旧索引。
pub fn enqueue(app: AppHandle, video_id: i64, force: bool) {
    let scheduled = {
        let state = app.state::<AppState>();
        let mut idx = state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let was_idle = idx.active == 0 && idx.queue.is_empty();
        let scheduled = idx.schedule(video_id, force);
        if scheduled.is_some() && was_idle {
            idx.start_new_batch();
        }
        scheduled
    };
    let Some(deferred) = scheduled else {
        return;
    };
    if !deferred {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(c) = guard.as_mut() {
            let _ = db::set_video_status(c, video_id, "pending", None);
        }
    }
    emit_video_updated(&app, video_id);
    pump(app);
}

/// 批量入队（重建索引、启动恢复、整库重抽）。
///
/// 逐条走 `enqueue` 时每个视频都会发一条 `video-updated` + 一条 `status`，几千
/// 个就是上万条事件压到事件通道和前端列表上；这里只播报一次状态与统计，
/// 行状态交给索引开始/结束时的那条单条事件自然更新。
pub fn enqueue_many(app: AppHandle, video_ids: &[i64], force: bool) {
    let scheduled: Vec<i64> = {
        let state = app.state::<AppState>();
        let mut idx = state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let was_idle = idx.active == 0 && idx.queue.is_empty();
        let mut fresh = Vec::new();
        for &id in video_ids {
            if let Some(deferred) = idx.schedule(id, force) {
                if !deferred {
                    fresh.push(id);
                }
            }
        }
        if !fresh.is_empty() && was_idle {
            idx.start_new_batch();
        }
        fresh
    };
    if scheduled.is_empty() {
        return;
    }
    {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(c) = guard.as_mut() {
            let _ = db::set_videos_status_pending(c, &scheduled);
        }
    }
    broadcast_status(&app);
    broadcast_stats(&app);
    pump(app);
}

/// 取消一个视频的待处理任务，并通知已经运行的工作线程尽快退出。
pub fn cancel(app: &AppHandle, video_id: i64) {
    let state = app.state::<AppState>();
    state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).cancel_one(video_id);
    broadcast_status(app);
}

/// 批量取消（删除整个文件夹时用）：只播报一次状态，避免一个 id 一条事件。
pub fn cancel_many(app: &AppHandle, video_ids: &[i64]) {
    {
        let state = app.state::<AppState>();
        let mut idx = state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for id in video_ids {
            idx.cancel_one(*id);
        }
    }
    broadcast_status(app);
}

/// 清空全部待处理任务；活动任务会在当前外部进程返回后的检查点退出。
pub fn cancel_all(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).cancel_all_jobs();
    broadcast_status(app);
}

fn is_cancelled(app: &AppHandle, video_id: i64) -> bool {
    let state = app.state::<AppState>();
    let cancelled = state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).cancelled.contains(&video_id);
    cancelled
}

/// 从队列取任务并发处理，直到达到并发上限。
pub fn pump(app: AppHandle) {
    let state = app.state::<AppState>();
    // 启动时常驻索引还在后台构建：此时开工，增量写入的帧会被随后的重建覆盖。
    // 构建完成的线程会再 pump 一次，队列里的任务不会丢。
    if !state.search_ready.load(Ordering::Acquire) {
        return;
    }
    // 并发上限缓存在 IndexerState 里：设置变更时同步更新，pump 不再读库。
    let concurrency = {
        let idx = state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        idx.concurrency.max(1)
    };
    loop {
        let job = {
            let state = app.state::<AppState>();
            let mut idx = state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            idx.take_next(concurrency)
        };
        let Some((id, reset_before_run)) = job else {
            break;
        };
        let app2 = app.clone();
        std::thread::spawn(move || {
            process_video(app2, id, reset_before_run);
        });
    }
    broadcast_status_throttled(&app);
}

/// 任务结束的收尾：更新计数、播报、继续泵队列。
fn finish(app: AppHandle, video_id: i64, outcome: Option<bool>) {
    let idle = {
        let state = app.state::<AppState>();
        let mut idx = state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        idx.active_ids.remove(&video_id);
        idx.cancelled.remove(&video_id);
        idx.active = idx.active.saturating_sub(1);
        match outcome {
            Some(true) => idx.done += 1,
            Some(false) => idx.failed += 1,
            None => {}
        }
        let idle = idx.active == 0 && idx.queue.is_empty();
        if idle {
            if idx.finished_at.is_none() {
                idx.finished_at = Some(db::now_ms());
            }
            idx.current_path = None;
        }
        idle
    };
    broadcast_status(&app);
    // 批次结束时的计数是最终值，不能被节流吞掉。
    if idle {
        broadcast_stats_now(&app);
    } else {
        broadcast_stats(&app);
    }
    pump(app);
}

fn finish_cancelled(app: AppHandle, video_id: i64) {
    clear_frame_progress(&app, video_id);
    update_search_index_for_video(&app, video_id);
    finish(app, video_id, None);
}

fn fail(app: AppHandle, video_id: i64, error: &str, frames_changed: bool) {
    log(&format!("视频 {video_id} 索引失败：{error}"));
    {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(c) = guard.as_mut() {
            if let Err(write_error) = db::set_video_status(c, video_id, "failed", Some(error)) {
                log(&format!("视频 {video_id} 失败状态落库失败：{write_error}"));
            }
        }
    }
    {
        let state = app.state::<AppState>();
        state.indexer.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).last_error = Some(error.to_string());
    }
    // 失败前若未动过帧，内存索引已经与数据库一致；若已清空或写入部分帧，
    // 只同步这个视频。单视频读取失败时由该函数回退到全量恢复。
    if frames_changed {
        update_search_index_for_video(&app, video_id);
    }
    emit_video_updated(&app, video_id);
    emit(
        &app,
        LibraryEvent::Notice {
            level: "error".to_string(),
            message: format!("索引失败：{error}"),
        },
    );
    finish(app, video_id, Some(false));
}

fn update_search_index_for_video(app: &AppHandle, video_id: i64) {
    let state = app.state::<AppState>();
    let frames = {
        let guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .as_ref()
            .and_then(|conn| db::load_video_frame_matrix(conn, video_id).ok())
    };
    if let Some(frames) = frames {
        state.search_index.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).replace_video_frames(video_id, frames);
    } else {
        // 读取增量帧失败时回退全量重建，优先保持搜索结果与数据库一致。
        state.rebuild_search_index();
    }
}

fn finish_ready(app: AppHandle, video_id: i64) {
    update_search_index_for_video(&app, video_id);
    emit_video_updated(&app, video_id);
    finish(app, video_id, Some(true));
}

/* ------------------------------------------------------------------ */
/* 单视频处理                                                          */
/* ------------------------------------------------------------------ */

const THUMBNAIL_REUSE_WINDOW_SECONDS: f64 = 2.0;

fn consider_thumbnail_frame(
    candidate: &mut Option<media::RawFrame>,
    frame: &media::RawFrame,
    target_time: f64,
    reuse_window: f64,
) {
    let distance = (frame.time - target_time).abs();
    if distance > reuse_window
        || candidate.as_ref().is_some_and(|saved| (saved.time - target_time).abs() <= distance)
    {
        return;
    }
    *candidate = Some(media::RawFrame {
        time: frame.time,
        width: frame.width,
        height: frame.height,
        // 缩略图候选会跨批次保留；只复制这一帧，及时释放上一批的缓冲区。
        rgb: frame.rgb.to_vec().into(),
    });
}

fn thumbnail_reuse_window(duration: Option<f64>, sample_count: usize, scene_seek: bool) -> f64 {
    if scene_seek || sample_count == 0 {
        return THUMBNAIL_REUSE_WINDOW_SECONDS;
    }
    // 均匀采样的最近一帧最多相差约半个采样间隔；额外留 1 秒给时间戳取整。
    duration
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .map(|duration| (duration / sample_count as f64 / 2.0 + 1.0).max(THUMBNAIL_REUSE_WINDOW_SECONDS))
        .unwrap_or(THUMBNAIL_REUSE_WINDOW_SECONDS)
}

fn process_video(app: AppHandle, video_id: i64, reset_before_run: bool) {
    if is_cancelled(&app, video_id) {
        finish_cancelled(app, video_id);
        return;
    }
    let settings = {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_mut() {
            Some(c) => db::get_settings(c).unwrap_or_else(|_| db::default_settings()),
            None => db::default_settings(),
        }
    };

    let mut frames_changed = false;
    if reset_before_run {
        let reset_result = {
            let state = app.state::<AppState>();
            let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.as_mut()
                .ok_or_else(|| "数据库未初始化".to_string())
                .and_then(|c| db::reset_frame_index_progress(c, video_id).map_err(|e| e.to_string()))
        };
        match reset_result {
            Ok(removed) => frames_changed = removed > 0,
            Err(error) => {
                fail(app, video_id, &format!("重置索引进度失败：{error}"), false);
                return;
            }
        }
        frames_store::remove_video(video_id);
    }

    let video = {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_mut() {
            Some(c) => db::get_video(c, video_id).ok().flatten(),
            None => None,
        }
    };
    let video = match video {
        Some(v) => v,
        None => {
            if is_cancelled(&app, video_id) {
                finish_cancelled(app, video_id);
            } else {
                fail(app, video_id, "视频记录不存在", frames_changed);
            }
            return;
        }
    };

    set_current_path(&app, video.path.clone());
    let status_result = {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.as_mut()
            .ok_or_else(|| "数据库未初始化".to_string())
            .and_then(|c| db::set_video_status(c, video_id, "indexing", None).map_err(|e| e.to_string()))
    };
    if let Err(error) = status_result {
        fail(app, video_id, &format!("索引状态写入失败：{error}"), frames_changed);
        return;
    }
    emit_video_updated(&app, video_id);

    if !std::path::Path::new(&video.path).exists() {
        fail(app, video_id, "文件已不存在", frames_changed);
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
                    let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    if let Some(c) = guard.as_mut() {
                        let _ = db::upsert_video(c, &input);
                    }
                }
                (p.duration, p.width, p.height, p.video_codec)
            }
            Err(e) => {
                if is_cancelled(&app, video_id) {
                    finish_cancelled(app, video_id);
                    return;
                }
                fail(app, video_id, &format!("探测失败：{e}"), frames_changed);
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
    let (timestamps, mut force_seek) = if effective == "scene" {
        set_frame_progress(&app, video_id, 0, duration.unwrap_or(0.0).round() as i64, Some("detecting"));
        match media::detect_scenes(&video.path, 0.3, || is_cancelled(&app, video_id)) {
            Ok(scenes) => plan_detected_scenes(&scenes, duration, settings.frames_per_video as usize, settings.uniform_interval_seconds as usize),
            Err(e) => {
                if is_cancelled(&app, video_id) {
                    finish_cancelled(app, video_id);
                    return;
                }
                log(&format!("场景检测失败，退回均匀采样：{e}"));
                set_sampling_override(&app, &[video_id], "uniform");
                (sampling::plan_timestamps(duration, settings.uniform_interval_seconds as usize), false)
            }
        }
    } else {
        (sampling::plan_timestamps(duration, settings.uniform_interval_seconds as usize), false)
    };
    // 长视频按 32 帧一批逐点 seek，可在批次间保存进度并限制原始像素缓冲。
    if duration.is_some_and(|seconds| seconds > 1800.0) || timestamps.len() > 400 {
        force_seek = true;
    }
    if is_cancelled(&app, video_id) {
        finish_cancelled(app, video_id);
        return;
    }

    let uses_full_scan =
        !force_seek && sampling::should_use_full_scan(timestamps.len(), width, height);
    let mut processed: Vec<i64> = video.processed_timestamps.clone();
    let mut start_index = resume_start_index(&processed, &timestamps, uses_full_scan);
    if start_index > 0 {
        let prefix_result = {
            let state = app.state::<AppState>();
            let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.as_mut()
                .ok_or_else(|| "数据库未初始化".to_string())
                .and_then(|c| db::frame_prefix_is_complete(c, video_id, start_index).map_err(|e| e.to_string()))
        };
        match prefix_result {
            Ok(true) => {}
            Ok(false) => {
                log(&format!("视频 {video_id} 的续传帧不完整，从头重建"));
                start_index = 0;
            }
            Err(error) => {
                fail(app, video_id, &format!("检查索引进度失败：{error}"), frames_changed);
                return;
            }
        }
    }
    if start_index == 0 && !reset_before_run {
        processed.clear();
    }
    if start_index >= timestamps.len() {
        // 最后一个批次已写入，可能在标记 ready 前退出；恢复时补齐缩略图和状态。
        let thumb_time = duration
            .map(|d| d * 0.12)
            .unwrap_or_else(|| timestamps.first().copied().unwrap_or(0.0));
        let thumbnail = media::make_thumbnail(&video.path, thumb_time, constants::EXTRACT_WIDTH);
        let ready_result = {
            let state = app.state::<AppState>();
            let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.as_mut()
                .ok_or_else(|| "数据库未初始化".to_string())
                .and_then(|c| db::set_ready_with_thumbnail(c, video_id, thumbnail.as_deref()).map_err(|e| e.to_string()))
        };
        if let Err(error) = ready_result {
            fail(app, video_id, &format!("完成索引状态写入失败：{error}"), frames_changed);
            return;
        }
        finish_ready(app, video_id);
        return;
    }
    // 全新跑或无法安全续传时清旧帧与进度；强制重建已在开始时清过一次。
    if start_index == 0 && !reset_before_run {
        let reset_result = {
            let state = app.state::<AppState>();
            let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.as_mut()
                .ok_or_else(|| "数据库未初始化".to_string())
                .and_then(|c| db::reset_frame_index_progress(c, video_id).map_err(|e| e.to_string()))
        };
        match reset_result {
            Ok(removed) => frames_changed |= removed > 0,
            Err(e) => {
                fail(app, video_id, &format!("重置索引进度失败：{e}"), frames_changed);
                return;
            }
        }
        frames_store::remove_video(video_id);
    }
    set_frame_progress(
        &app,
        video_id,
        start_index as i64,
        timestamps.len() as i64,
        Some("extracting"),
    );

    let batch_size = if uses_full_scan {
        timestamps.len() - start_index
    } else {
        32
    };
    let mut current_processed = processed.clone();
    let thumb_time = duration
        .map(|d| d * 0.12)
        .unwrap_or_else(|| timestamps.first().copied().unwrap_or(0.0));
    let thumb_window = thumbnail_reuse_window(duration, timestamps.len(), force_seek);
    let mut thumbnail_candidate = None;

    let mut bi = start_index;
    while bi < timestamps.len() {
        let batch_end = (bi + batch_size).min(timestamps.len());
        let batch_ts: Vec<f64> = timestamps[bi..batch_end].to_vec();
        let progress_app = app.clone();
        let batch_len = batch_ts.len();
        let total_frames = timestamps.len() as i64;
        let highest_decoded = std::sync::atomic::AtomicUsize::new(0);
        let on_decoded: media::FrameProgressCallback = std::sync::Arc::new(move |decoded| {
            let decoded = decoded.min(batch_len);
            // 旧版 FFmpeg 可能先失败再重试；第二次的计数从零开始，界面不应倒退。
            if decoded <= highest_decoded.fetch_max(decoded, std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            set_frame_progress(
                &progress_app,
                video_id,
                (bi + decoded) as i64,
                total_frames,
                Some("extracting"),
            );
        });
        let started = std::time::Instant::now();
        let frames = match media::extract_and_hash_frames_with_progress(
            &video.path,
            &batch_ts,
            duration,
            width,
            height,
            force_seek,
            Some(on_decoded),
        ) {
            Ok(f) => f,
            Err(e) => {
                if is_cancelled(&app, video_id) {
                    finish_cancelled(app, video_id);
                    return;
                }
                fail(app, video_id, &format!("抽帧失败：{e}"), frames_changed);
                return;
            }
        };
        let elapsed = started.elapsed().as_millis() as i64;

        if is_cancelled(&app, video_id) {
            finish_cancelled(app, video_id);
            return;
        }

        if frames.len() != batch_ts.len() {
            fail(
                app,
                video_id,
                &format!("抽帧数量不足：计划 {} 帧，实际 {} 帧", batch_ts.len(), frames.len()),
                frames_changed,
            );
            return;
        }

        if !frames.is_empty() {
            let mut new_frames = Vec::with_capacity(frames.len());
            for (i, fr) in frames.iter().enumerate() {
                consider_thumbnail_frame(&mut thumbnail_candidate, fr, thumb_time, thumb_window);
                let img = hash::ImageDataLike {
                    width: fr.width,
                    height: fr.height,
                    channels: 3,
                    order: hash::ChannelOrder::Rgb,
                    data: &fr.rgb,
                };
                let sig = hash::compute_signature(&img);
                let color = framepack::quantize_color(&sig.color);
                let time_ms = (fr.time * 1000.0).round() as i64;
                new_frames.push(db::NewFrame {
                    dhash: sig.dhash as i64,
                    struct_hash: sig.struct_hash,
                    color,
                    spatial: sig.spatial,
                    frame_index: (bi + i) as i64,
                    time_ms,
                });
            }
            let mut next_processed = current_processed.clone();
            next_processed.extend(batch_ts.iter().map(|t| (t * 1000.0).round() as i64));
            let write_result = {
                let state = app.state::<AppState>();
                let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.as_mut()
                    .ok_or_else(|| "数据库未初始化".to_string())
                    .and_then(|c| db::commit_frame_batch(c, video_id, &new_frames, &next_processed, elapsed).map_err(|e| e.to_string()))
            };
            if let Err(error) = write_result {
                fail(app, video_id, &format!("保存索引帧失败：{error}"), frames_changed);
                return;
            }
            frames_changed = true;
            current_processed = next_processed;
            if settings.keep_frame_images {
                for fr in &frames {
                    frames_store::save(video_id, (fr.time * 1000.0).round() as i64, &fr.rgb, fr.width, fr.height);
                }
            }
            if is_cancelled(&app, video_id) {
                finish_cancelled(app, video_id);
                return;
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
    if is_cancelled(&app, video_id) {
        finish_cancelled(app, video_id);
        return;
    }
    let thumb = thumbnail_candidate
        .as_ref()
        .and_then(|frame| frames_store::encode_jpeg(&frame.rgb, frame.width, frame.height).ok())
        .or_else(|| media::make_thumbnail(&video.path, thumb_time, constants::EXTRACT_WIDTH));
    if is_cancelled(&app, video_id) {
        finish_cancelled(app, video_id);
        return;
    }
    let ready_result = {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.as_mut()
            .ok_or_else(|| "数据库未初始化".to_string())
            .and_then(|c| db::set_ready_with_thumbnail(c, video_id, thumb.as_deref()).map_err(|e| e.to_string()))
    };
    if let Err(error) = ready_result {
        fail(app, video_id, &format!("完成索引状态写入失败：{error}"), frames_changed);
        return;
    }
    clear_frame_progress(&app, video_id);
    finish_ready(app, video_id);
}

/// 只有逐点 seek 的旧进度与新计划完全对齐时才能按时间点续传。
/// 全片解码始终从片头开始，不能用剩余帧数重新计算 fps。
fn resume_start_index(processed: &[i64], timestamps: &[f64], uses_full_scan: bool) -> usize {
    if uses_full_scan || processed.len() > timestamps.len() {
        return 0;
    }
    if processed.iter().zip(timestamps).all(|(saved, planned)| {
        *saved == (planned * 1000.0).round() as i64
    }) {
        processed.len()
    } else {
        0
    }
}

fn plan_detected_scenes(scenes: &[f64], duration: Option<f64>, budget: usize, interval_seconds: usize) -> (Vec<f64>, bool) {
    if scenes.is_empty() {
        (sampling::plan_timestamps(duration, interval_seconds), false)
    } else {
        (sampling::plan_scene_timestamps(scenes, duration, budget, interval_seconds), true)
    }
}

/* ------------------------------------------------------------------ */
/* 导入 / 扫描                                                         */
/* ------------------------------------------------------------------ */

fn set_sampling_override(app: &AppHandle, ids: &[i64], mode: &str) {
    let state = app.state::<AppState>();
    let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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

/// 旧哈希只在文件元数据未变时可信：大小或修改时间一变，内容可能已经被替换，
/// 沿用旧值会让查重把两个不同的文件判成完全相同。
fn can_reuse_file_hash(stored_size: i64, stored_mtime: i64, size: i64, mtime: i64) -> bool {
    size > 0 && mtime > 0 && stored_size == size && stored_mtime == mtime
}

/// 自动扫描的候选规则：常见视频直接尝试，明显无关的文件跳过，未知格式交给 FFprobe。
pub fn is_video_file(name: &str) -> bool {
    let name = std::path::Path::new(name).file_name().and_then(|name| name.to_str()).unwrap_or("");
    if name.is_empty() || name.starts_with('.') { return false; }
    if ["readme", "license", "makefile", "changelog"].iter().any(|known| name.eq_ignore_ascii_case(known)) {
        return false;
    }
    let Some((_, ext)) = name.rsplit_once('.') else {
        return true;
    };
    if constants::VIDEO_EXTENSIONS
        .iter()
        .any(|candidate| ext.eq_ignore_ascii_case(candidate))
    { return true; }
    !constants::NON_VIDEO_EXTENSIONS
        .iter()
        .any(|candidate| ext.eq_ignore_ascii_case(candidate))
}

fn existing_file_key(path: &std::path::Path) -> Option<String> {
    std::fs::canonicalize(path).ok().map(|path| db::path_key(&path.to_string_lossy()))
}

fn playlist_parts(playlist: &std::path::Path) -> Vec<String> {
    let Ok(metadata) = std::fs::metadata(playlist) else { return Vec::new() };
    if metadata.len() > 2 * 1024 * 1024 { return Vec::new(); }
    let Ok(contents) = std::fs::read_to_string(playlist) else { return Vec::new() };
    if !contents.starts_with("#EXTM3U") { return Vec::new(); }
    let Some(parent) = playlist.parent() else { return Vec::new() };
    contents.lines().filter_map(|line| {
        let line = line.trim();
        let reference = if line.starts_with('#') {
            line.split("URI=\"").nth(1)?.split('"').next()?
        } else { line };
        if reference.is_empty() || reference.contains("://") || reference.starts_with("data:") || reference.starts_with('/') || reference.starts_with('\\') {
            return None;
        }
        existing_file_key(&parent.join(reference))
    }).collect()
}

/// 已由 HLS 播放列表引用的片段或子播放列表不作为独立视频导入。
pub fn is_playlist_part(path: &str, root: &str) -> bool {
    let Some(key) = existing_file_key(std::path::Path::new(path)) else { return false };
    let root_key = db::path_key(root);
    let separator = if cfg!(windows) { "\\" } else { "/" };
    let child_prefix = if root_key.ends_with(separator) { root_key.clone() } else { format!("{root_key}{separator}") };
    let mut dir = std::path::Path::new(path).parent();
    while let Some(current) = dir {
        let current_key = db::path_key(&current.to_string_lossy());
        if current_key != root_key && !current_key.starts_with(&child_prefix) { break; }
        let entries = match std::fs::read_dir(current) { Ok(entries) => entries, Err(_) => break };
        for entry in entries.flatten() {
            let candidate = entry.path();
            if candidate.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("m3u8"))
                && playlist_parts(&candidate).contains(&key) {
                return true;
            }
        }
        if current_key == root_key { break; }
        dir = current.parent();
    }
    false
}

/// 带发现回调的扫描。每找到一个视频就回报累计数量，让遍历阶段（此时总数
/// 还未知）也能上报进度，而不是在状态栏里一动不动。
fn scan_video_files_with(
    root: &str,
    recursive: bool,
    mut on_found: impl FnMut(i64),
) -> Result<Vec<String>, String> {
    let root_path = std::path::Path::new(root);
    if !root_path.is_dir() {
        return Err("目录不存在或无法读取".to_string());
    }
    let mut out = Vec::new();
    walk(root_path, 0, recursive, &mut out, &mut on_found)?;
    // 普通视频目录无需做 HLS 片段排除；逐文件 canonicalize 在大目录或网络盘上代价很高。
    if !out.iter().any(|path| std::path::Path::new(path).extension().is_some_and(|ext| ext.eq_ignore_ascii_case("m3u8"))) {
        return Ok(out);
    }
    let referenced = out.iter()
        .filter(|path| path.to_ascii_lowercase().ends_with(".m3u8"))
        .flat_map(|path| playlist_parts(std::path::Path::new(path)))
        .collect::<std::collections::HashSet<_>>();
    out.retain(|path| existing_file_key(std::path::Path::new(path))
        .is_none_or(|key| !referenced.contains(&key)));
    Ok(out)
}

fn walk(
    dir: &std::path::Path,
    depth: usize,
    recursive: bool,
    out: &mut Vec<String>,
    on_found: &mut dyn FnMut(i64),
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("无法读取目录：{e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("无法读取目录项：{e}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("无法读取目录项类型：{e}"))?;
        // 不跟随链接目录，避免网络盘或错误链接导致的循环扫描。
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if recursive && depth < crate::constants::MAX_SCAN_DEPTH {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if !crate::constants::DEFAULT_SKIP_DIRS.contains(&name.as_str()) {
                    walk(&path, depth + 1, recursive, out, on_found)?;
                }
            }
        } else if file_type.is_file() {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_video_file(&name) {
                out.push(path.to_string_lossy().to_string());
                on_found(out.len() as i64);
            }
        }
    }
    Ok(())
}

/// 注册单个文件并加入索引队列，更新 result 计数。
fn register_and_enqueue(app: &AppHandle, path: String, folder_id: Option<i64>, result: &mut ImportResult) {
    let state = app.state::<AppState>();
    result.scanned += 1;
    if !std::path::Path::new(&path).exists() {
        result.skipped += 1;
        return;
    }
    if folder_id.is_some() && !is_video_file(std::path::Path::new(&path).file_name().and_then(|name| name.to_str()).unwrap_or("")) {
        result.skipped += 1;
        return;
    }
    let existing = {
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_mut() {
            Some(c) => match db::find_by_path(c, &path) {
                Ok(video) => video,
                Err(error) => {
                    record_import_failure(result, &path, "读取已有记录", &error.to_string(), folder_id);
                    return;
                }
            },
            None => {
                record_import_failure(result, &path, "读取数据库", "数据库未初始化", folder_id);
                return;
            }
        }
    };
    let (size, mtime) = stat_file(&path);
    let probe = existing.as_ref()
        .filter(|v| can_reuse_file_hash(v.size, v.mtime_ms, size, mtime) && v.duration.is_some())
        .map(|v| (v.duration, v.width, v.height, v.video_codec.clone()));
    let (duration, width, height, codec) = match probe {
        Some(p) => p,
        None => match media::probe_video(&path).and_then(|p| {
            if path.to_ascii_lowercase().ends_with(".m3u8") {
                media::verify_playlist_decode(&path)?;
            }
            Ok(p)
        }) {
            Ok(p) => (p.duration, p.width, p.height, p.video_codec),
            Err(error) => {
                record_import_failure(result, &path, "探测媒体", &error, folder_id);
                return;
            }
        },
    };
    // 导入阶段不读整文件算 SHA-256：导入线程的顺序读会和同时开工的抽帧线程抢
    // 同一块盘（机械盘上互相拖慢）。完全相同文件的判定本来就在查重时按需现算
    // （commands.rs::ensure_file_hash），这里只保留仍可信的旧值：文件被改过
    // （大小或修改时间不同）就把哈希丢掉，旧值已不代表当前内容。
    let file_hash = existing.as_ref()
        .filter(|v| can_reuse_file_hash(v.size, v.mtime_ms, size, mtime))
        .and_then(|v| v.file_hash.clone());
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
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_mut() {
            Some(c) => match db::upsert_video(c, &input) {
                Ok(r) => r,
                Err(error) => {
                    record_import_failure(result, &path, "保存资料库记录", &error.to_string(), folder_id);
                    return;
                }
            },
            None => {
                record_import_failure(result, &path, "保存资料库记录", "数据库未初始化", folder_id);
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
    // 内容或媒体资料变化时旧帧不再可信，必须在重抽前清空续传进度。
    // 若该视频正在索引，force 会把重抽安排在当前任务之后。
    enqueue(app.clone(), video.id, changed && !created);
}

/// 导入失败与主动跳过分开统计；详细原因保留在本次报告与本地日志。
fn record_import_failure(result: &mut ImportResult, path: &str, step: &str, error: &str, folder_id: Option<i64>) {
    result.failed += 1;
    let reason = if step == "探测媒体" && error.starts_with("ffprobe 失败") {
        "FFmpeg 无法读取该文件或其片段".to_string()
    } else { format!("{step}失败：{error}") };
    if result.first_error.is_none() { result.first_error = Some(reason.clone()); }
    result.failures.push(crate::events::ImportFailure { path: path.to_string(), reason, folder_id });
    log(&format!("导入失败（{step}）：{path}：{error}"));
}

/* ------------------------------------------------------------------ */
/* 导入进度                                                            */
/* ------------------------------------------------------------------ */

/// 目录里上千个文件时不能逐个广播：按时间节流，最后一个文件仍会强制上报。
const IMPORT_PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// 批次号单调递增，前端据此丢弃迟到的旧批次事件。
static IMPORT_BATCH_ID: AtomicU64 = AtomicU64::new(1);

/// 是否该在此时上报（纯函数，便于测试）。
fn should_emit_import_progress(last: Instant, now: Instant, processed: i64, total: i64) -> bool {
    if total > 0 && processed >= total {
        return true;
    }
    now.saturating_duration_since(last) >= IMPORT_PROGRESS_INTERVAL
}

/// 一次导入的进度上报：扫描阶段总数未知（total = 0），遍历完成后用
/// set_total 切成确定总数，之后按已处理的文件数上报。
struct ImportProgress {
    id: u64,
    total: i64,
    last_emit: Instant,
}

impl ImportProgress {
    fn start(app: &AppHandle) -> Self {
        let progress = Self {
            id: IMPORT_BATCH_ID.fetch_add(1, Ordering::Relaxed),
            total: 0,
            last_emit: Instant::now(),
        };
        progress.report(app, 0, 0, 0, 0, false);
        progress
    }

    /// 扫描结束：总数确定，立刻上报一条让用户看到规模。
    fn set_total(&mut self, app: &AppHandle, total: i64) {
        self.total = total;
        self.last_emit = Instant::now();
        self.report(app, 0, 0, 0, 0, false);
    }

    /// 遍历到第 discovered 个视频（此时总数还未知，total 保持 0）。
    fn tick_discovered(&mut self, app: &AppHandle, discovered: i64) {
        let now = Instant::now();
        if should_emit_import_progress(self.last_emit, now, discovered, 0) {
            self.last_emit = now;
            self.report(app, discovered, 0, 0, 0, false);
        }
    }

    fn tick(&mut self, app: &AppHandle, result: &ImportResult) {
        let now = Instant::now();
        if should_emit_import_progress(self.last_emit, now, result.scanned, self.total) {
            self.last_emit = now;
            self.report(app, result.scanned, result.added, result.skipped, result.failed, false);
        }
    }

    fn finish(&mut self, app: &AppHandle, result: &ImportResult) {
        self.report(app, result.scanned, result.added, result.skipped, result.failed, true);
    }

    fn report(&self, app: &AppHandle, processed: i64, added: i64, skipped: i64, failed: i64, finished: bool) {
        emit(
            app,
            LibraryEvent::ImportProgress {
                id: self.id,
                processed,
                total: self.total,
                added,
                skipped,
                failed,
                finished,
            },
        );
    }
}

/// 导入若干视频文件（来自文件对话框或 watcher）。
pub fn import_files(app: AppHandle, files: Vec<String>, folder_id: Option<i64>) -> ImportResult {
    import_files_tracked(app, files, folder_id, None)
}

/// progress 为 None 时按文件数决定是否上报：单个文件（watcher 的常规触发）
/// 不值得占用状态栏。
fn import_files_tracked(
    app: AppHandle,
    files: Vec<String>,
    folder_id: Option<i64>,
    progress: Option<ImportProgress>,
) -> ImportResult {
    let mut result = ImportResult::default();
    let mut progress = match progress {
        Some(progress) => Some(progress),
        None if files.len() > 1 => Some(ImportProgress::start(&app)),
        None => None,
    };
    if let Some(p) = progress.as_mut() {
        p.set_total(&app, files.len() as i64);
    }
    for raw in &files {
        let path = db::normalize_path(raw);
        register_and_enqueue(&app, path, folder_id, &mut result);
        if let Some(p) = progress.as_mut() {
            p.tick(&app, &result);
        }
    }
    if let Some(p) = progress.as_mut() {
        p.finish(&app, &result);
    }
    // 导入刚写入一批记录，计数必须立刻更新（不能被节流窗口吞掉）。
    broadcast_stats_now(&app);
    broadcast_status(&app);
    result
}

/// 递归导入目录内的视频，但不登记目录、不启动文件系统监听。
pub fn import_folder_once(app: AppHandle, dir_path: String, recursive: bool) -> Result<ImportResult, String> {
    let mut progress = ImportProgress::start(&app);
    let files = match scan_video_files_with(&dir_path, recursive, |found| {
        progress.tick_discovered(&app, found);
    }) {
        Ok(files) => files,
        Err(error) => {
            progress.finish(&app, &ImportResult::default());
            return Err(error);
        }
    };
    let folder = {
        let state = app.state::<AppState>();
        let guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let inserted = guard
            .as_ref()
            .ok_or_else(|| "数据库未初始化".to_string())
            .and_then(|conn| db::insert_imported_folder(conn, &dir_path, recursive).map_err(|e| e.to_string()));
        match inserted {
            Ok(folder) => folder,
            Err(error) => {
                // 提前失败也要收尾，否则状态栏会停在进度文案上。
                progress.finish(&app, &ImportResult::default());
                return Err(error);
            }
        }
    };
    let result = import_files_tracked(app.clone(), files, Some(folder.id), Some(progress));
    {
        let state = app.state::<AppState>();
        let guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(conn) = guard.as_ref() {
            let _ = db::mark_folder_scanned(conn, folder.id);
            if let Ok(Some(updated)) = db::get_folder(conn, folder.id) {
                emit(&app, LibraryEvent::FolderUpdated { folder: updated });
            }
        }
    }
    Ok(result)
}

/// 导入并持续监听一个目录（递归扫描视频文件）。
pub fn import_folder(
    app: AppHandle,
    dir_path: String,
    pinned: bool,
    recursive: bool,
) -> Result<(ImportResult, i64), String> {
    let mut progress = ImportProgress::start(&app);
    let files = match scan_video_files_with(&dir_path, recursive, |found| {
        progress.tick_discovered(&app, found);
    }) {
        Ok(files) => files,
        Err(error) => {
            progress.finish(&app, &ImportResult::default());
            return Err(error);
        }
    };
    let mut result = ImportResult {
        folders: 1,
        ..Default::default()
    };
    let folder = {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let inserted = match guard.as_mut() {
            Some(c) => db::insert_folder(c, &dir_path, pinned, recursive).map_err(|e| e.to_string()),
            None => Err("数据库未初始化".to_string()),
        };
        match inserted {
            Ok(folder) => folder,
            Err(error) => {
                // 提前失败也要收尾，否则状态栏会停在进度文案上。
                progress.finish(&app, &result);
                return Err(error);
            }
        }
    };
    progress.set_total(&app, files.len() as i64);
    for file in files {
        register_and_enqueue(&app, file, Some(folder.id), &mut result);
        progress.tick(&app, &result);
    }
    progress.finish(&app, &result);
    {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(c) = guard.as_mut() {
            let _ = db::mark_folder_scanned(c, folder.id);
                let _ = db::update_folder_state(c, folder.id, if folder.enabled { "watching" } else { "idle" }, None);
        }
    }
    let refreshed = {
        let state = app.state::<AppState>();
        let guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .as_ref()
            .and_then(|c| db::get_folder(c, folder.id).ok())
            .flatten()
    };
    if let Some(f) = refreshed {
        emit(&app, LibraryEvent::FolderUpdated { folder: f });
    }
    // 扫描结束的计数是最终值，直接播报。
    broadcast_stats_now(&app);
    broadcast_status(&app);
    Ok((result, folder.id))
}

/// 重建索引：按各视频当前记录的模式重抽（mode 仅指定时写入覆盖）。
pub fn reindex(app: AppHandle, video_ids: Option<Vec<i64>>, mode: Option<String>) -> i64 {
    let targets: Vec<i64> = {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(c) = guard.as_mut() {
            let _ = db::set_sampling_override(c, &ids, m);
        }
    }
    if targets.is_empty() {
        return 0;
    }
    log(&format!("重建索引入队：{} 个视频", targets.len()));
    enqueue_many(app, &targets, true);
    targets.len() as i64
}

/// 启动恢复：把上次未完成（pending/indexing）的视频重新入队。
#[allow(dead_code)]
pub fn resume_pending(app: AppHandle) {
    if !media::tools_ready() {
        return;
    }
    let pending: Vec<i64> = {
        let state = app.state::<AppState>();
        let mut guard = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_mut() {
            Some(c) => db::list_pending_videos(c)
                .unwrap_or_default()
                .into_iter()
                .map(|v| v.id)
                .collect(),
            None => Vec::new(),
        }
    };
    if pending.is_empty() {
        return;
    }
    log(&format!("恢复索引队列：{} 个待处理视频", pending.len()));
    // 一次入队；保留已提交批次，续传前会核验帧前缀是否完整。
    // 不为每个待处理视频各广播一条事件（启动瞬间的卡顿来源之一）。
    enqueue_many(app, &pending, false);
}

fn log(msg: &str) {
    logger::log(&format!("[indexer] {msg}"));
}

#[cfg(test)]
mod tests {
    use super::{
        can_reuse_file_hash, consider_thumbnail_frame, is_playlist_part, is_video_file, plan_detected_scenes, record_import_failure,
        resume_start_index, scan_video_files_with, should_broadcast_stats, thumbnail_reuse_window,
        should_emit_import_progress,
        IndexerState,
    };
    use crate::events::ImportResult;
    use crate::media::RawFrame;
    use std::fs;
    use std::time::{Duration, Instant};

    #[test]
    fn scan_candidates_include_playlists_and_unknown_formats_but_skip_obvious_non_videos() {
        assert!(is_video_file("clip.M3U8"));
        assert!(is_video_file("clip.customvideo"));
        assert!(is_video_file("clip"));
        assert!(!is_video_file("cover.jpg"));
        assert!(!is_video_file("subtitle.srt"));
        assert!(!is_video_file("notes.txt"));
        assert!(!is_video_file(".hidden"));
        assert!(!is_video_file("README"));
    }

    #[test]
    fn folder_scan_treats_hls_variants_and_segments_as_one_video() {
        let root = std::env::temp_dir().join(format!("whichvideo-hls-{}", crate::db::now_ms()));
        let variant_dir = root.join("variant");
        fs::create_dir_all(&variant_dir).unwrap();
        fs::write(root.join("master.m3u8"), b"#EXTM3U\nvariant/index.m3u8\n").unwrap();
        fs::write(variant_dir.join("index.m3u8"), b"#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n").unwrap();
        fs::write(variant_dir.join("segment.ts"), b"segment").unwrap();
        fs::write(root.join("other.mp4"), b"video").unwrap();
        let files = scan_video_files_with(&root.to_string_lossy(), true, |_| {}).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|path| path.ends_with("master.m3u8")));
        assert!(files.iter().any(|path| path.ends_with("other.mp4")));
        assert!(is_playlist_part(&variant_dir.join("segment.ts").to_string_lossy(), &root.to_string_lossy()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_scan_reports_missing_directories_and_finds_nested_videos() {
        let missing = std::env::temp_dir().join(format!("whichvideo-missing-{}", crate::db::now_ms()));
        assert_eq!(
            scan_video_files_with(&missing.to_string_lossy(), true, |_| {}).unwrap_err(),
            "目录不存在或无法读取"
        );

        let root = std::env::temp_dir().join(format!("whichvideo-scan-{}", crate::db::now_ms()));
        let nested = root.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(root.join("clip.mp4"), b"").unwrap();
        fs::write(nested.join("episode.MKV"), b"").unwrap();
        fs::write(nested.join("notes.txt"), b"").unwrap();
        fs::write(nested.join("unusual.video_blob"), b"").unwrap();
        let files = scan_video_files_with(&root.to_string_lossy(), true, |_| {}).unwrap();
        assert_eq!(files.len(), 3);
        assert!(files.iter().any(|path| path.ends_with("clip.mp4")));
        assert!(files.iter().any(|path| path.ends_with("episode.MKV")));
        assert!(files.iter().any(|path| path.ends_with("unusual.video_blob")));
        fs::remove_dir_all(root).unwrap();
    }

    /// 遍历阶段就要回报「已发现几个」，否则大目录扫描时状态栏长时间不动。
    #[test]
    fn folder_scan_reports_each_discovered_video() {
        let root = std::env::temp_dir().join(format!("whichvideo-discover-{}", crate::db::now_ms()));
        let nested = root.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(root.join("a.mp4"), b"").unwrap();
        fs::write(nested.join("b.mkv"), b"").unwrap();

        let mut discovered = Vec::new();
        let files = scan_video_files_with(&root.to_string_lossy(), true, |found| discovered.push(found)).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(discovered, vec![1, 2]);
        fs::remove_dir_all(root).unwrap();
    }

    /// 上千个文件不能逐个广播事件，但最后一个文件必须上报，否则进度停在
    /// 总数前一位；扫描阶段 total = 0 时只按时间节流。
    /// 统计事件按时间节流：每个视频索引完成都会触发一次，而 stats 要扫 frames
    /// 全表；批次收尾走 broadcast_stats_now，不受这里影响。
    #[test]
    fn stats_broadcast_is_throttled_by_time() {
        let start = Instant::now();
        assert!(should_broadcast_stats(None, start));
        assert!(!should_broadcast_stats(
            Some(start),
            start + Duration::from_millis(100)
        ));
        assert!(should_broadcast_stats(
            Some(start),
            start + Duration::from_millis(500)
        ));
    }

    #[test]
    fn import_progress_is_throttled_but_reports_the_last_file() {
        let start = Instant::now();
        assert!(!should_emit_import_progress(start, start + Duration::from_millis(10), 3, 1000));
        assert!(should_emit_import_progress(start, start + Duration::from_millis(200), 4, 1000));
        assert!(should_emit_import_progress(start, start + Duration::from_millis(1), 1000, 1000));
        assert!(!should_emit_import_progress(start, start + Duration::from_millis(50), 10, 0));
        assert!(should_emit_import_progress(start, start + Duration::from_millis(200), 10, 0));
    }

    #[test]
    fn import_failures_are_distinct_from_skipped_files() {
        let mut result = ImportResult::default();
        result.skipped += 1;
        record_import_failure(&mut result, "private-video.mp4", "探测媒体", "ffprobe 失败", None);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.failed, 1);
        assert_eq!(result.failures[0].path, "private-video.mp4");
    }

    #[test]
    fn thumbnail_reuses_only_the_closest_nearby_indexed_frame() {
        let frame = |time, value| RawFrame {
            time,
            width: 2,
            height: 2,
            rgb: vec![value; 12].into(),
        };
        let mut selected = None;
        consider_thumbnail_frame(&mut selected, &frame(8.0, 1), 12.0, 2.0);
        assert!(selected.is_none());
        consider_thumbnail_frame(&mut selected, &frame(10.5, 2), 12.0, 2.0);
        consider_thumbnail_frame(&mut selected, &frame(11.5, 3), 12.0, 2.0);
        consider_thumbnail_frame(&mut selected, &frame(13.0, 4), 12.0, 2.0);
        assert_eq!(&*selected.unwrap().rgb, vec![3; 12].as_slice());
    }

    #[test]
    fn uniform_long_video_reuses_nearby_sample_for_thumbnail() {
        let window = thumbnail_reuse_window(Some(3600.0), 240, false);
        let target = 3600.0 * 0.12;
        let frame = RawFrame { time: 427.5, width: 2, height: 2, rgb: vec![1; 12].into() };
        let mut selected = None;
        consider_thumbnail_frame(&mut selected, &frame, target, window);
        assert!(selected.is_some());

        let scene_window = thumbnail_reuse_window(Some(3600.0), 240, true);
        let mut scene_selected = None;
        consider_thumbnail_frame(&mut scene_selected, &frame, target, scene_window);
        assert!(scene_selected.is_none());
    }

    #[test]
    fn file_hash_is_reused_only_for_exact_file_metadata_match() {
        assert!(can_reuse_file_hash(100, 1234, 100, 1234));
        assert!(!can_reuse_file_hash(100, 1234, 101, 1234));
        assert!(!can_reuse_file_hash(100, 1234, 100, 1235));
        assert!(!can_reuse_file_hash(0, 0, 0, 0));
    }

    #[test]
    fn scene_detection_without_cuts_uses_uniform_extraction_path() {
        let (timestamps, force_seek) = plan_detected_scenes(&[], Some(3600.0), 240, 15);
        assert_eq!(timestamps.len(), 240);
        assert!(!force_seek);
        let (_, force_seek_with_cuts) = plan_detected_scenes(&[120.0], Some(3600.0), 240, 15);
        assert!(force_seek_with_cuts);
    }

    #[test]
    fn full_scan_restarts_instead_of_misaligning_partial_frames() {
        let timestamps = [1.0, 3.0, 5.0];
        assert_eq!(resume_start_index(&[1000], &timestamps, true), 0);
        assert_eq!(resume_start_index(&[1000], &timestamps, false), 1);
        assert_eq!(resume_start_index(&[2000], &timestamps, false), 0);
        assert_eq!(resume_start_index(&[1000, 3000, 5000, 7000], &timestamps, false), 0);
    }

    #[test]
    fn forced_reindex_waits_for_the_same_active_video() {
        let mut state = IndexerState::default();
        assert_eq!(state.schedule(7, false), Some(false));
        assert_eq!(state.take_next(2), Some((7, false)));

        assert_eq!(state.schedule(7, false), None);
        assert_eq!(state.schedule(7, true), Some(true));
        assert_eq!(state.take_next(2), None);

        state.active_ids.remove(&7);
        state.active = 0;
        assert_eq!(state.take_next(2), Some((7, true)));
    }

    #[test]
    fn deferred_reindex_keeps_its_place_while_other_jobs_can_run() {
        let mut state = IndexerState::default();
        state.schedule(7, false);
        assert_eq!(state.take_next(2), Some((7, false)));
        state.schedule(7, true);
        state.schedule(8, false);
        state.schedule(9, false);

        assert_eq!(state.take_next(2), Some((8, false)));
        state.active_ids.remove(&7);
        state.active = 1;
        assert_eq!(state.take_next(2), Some((7, true)));
        state.active_ids.remove(&8);
        state.active = 1;
        assert_eq!(state.take_next(2), Some((9, false)));
    }

    #[test]
    fn force_upgrades_an_already_queued_job() {
        let mut state = IndexerState::default();
        assert_eq!(state.schedule(3, false), Some(false));
        assert_eq!(state.schedule(3, true), None);
        assert_eq!(state.take_next(1), Some((3, true)));
    }

    #[test]
    fn cancellation_removes_queued_jobs_and_marks_active_jobs() {
        let mut state = IndexerState::default();
        state.schedule(1, false);
        state.schedule(2, false);
        assert_eq!(state.take_next(1), Some((1, false)));

        state.cancel_one(2);
        assert!(state.queue.is_empty());
        assert!(!state.cancelled.contains(&2));

        state.cancel_one(1);
        assert!(state.cancelled.contains(&1));
    }

    #[test]
    fn a_new_indexing_batch_resets_stale_progress_and_error() {
        let mut state = IndexerState {
            done: 8,
            failed: 2,
            current_path: Some("old.mp4".to_string()),
            started_at: Some(1),
            finished_at: Some(2),
            last_error: Some("旧错误".to_string()),
            ..Default::default()
        };
        state.start_new_batch();
        assert_eq!(state.done, 0);
        assert_eq!(state.failed, 0);
        assert!(state.current_path.is_none());
        assert!(state.started_at.is_some());
        assert!(state.finished_at.is_none());
        assert!(state.last_error.is_none());
    }
}
