use crate::{db, framepack, hash, media, search};
use crate::state::AppState;
use base64::Engine;
use std::collections::HashMap;

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
    pub(crate) query_image_url: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSearchResult {
    pub(crate) data_url: String,
    pub(crate) response: SearchResponse,
}

fn round4(x: f64) -> f64 {
    (x * 10000.0).round() / 10000.0
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// 统一的失败响应，四条检索入口共用同一结构。
pub(crate) fn fail_response(code: &str, message: &str) -> SearchResponse {
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

/// 查询图与视频帧使用同一 FFmpeg RGB24 转换和缩放滤镜。
pub(crate) fn prepare_query_image(img: image::DynamicImage) -> Result<(Vec<u8>, u32, u32), String> {
    media::prepare_query_pixels(img)
}

/// 由归一化后的 RGB24 缓冲计算查询向量。
pub(crate) fn build_query_vector(buf: &[u8], w: u32, h: u32) -> search::QueryVector {
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
pub(crate) fn decode_data_url(data_url: &str) -> Option<Vec<u8>> {
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
fn rerank_matches(
    videos: &HashMap<i64, db::VideoRecord>,
    qild: &hash::ImageDataLike,
    hits: &mut [search::IndexedHit],
) -> HashMap<i64, media::RawFrame> {
    let mut decoded = HashMap::new();
    if hits.len() <= 1 {
        return decoded;
    }
    let query_gray = hash::to_gray(qild, 48, 48);
    let head_len = hits.len().min(RERANK_TOP_K);
    for hit in hits.iter_mut().take(head_len) {
        let (vid, t, old_score) = (hit.video_id, hit.time_seconds, hit.score);
        let video = match videos.get(&vid) {
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
        let frame = match frames.into_iter().next() {
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
        let ssim = hash::ssim_gray_similarity(&query_gray, &hash::to_gray(&fild, 48, 48));
        let new_score = old_score * (1.0 - RERANK_WEIGHT) + ssim * RERANK_WEIGHT;
        hit.score = new_score;
        decoded.insert(vid, frame);
    }
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    decoded
}

fn refinement_decode_times(candidates: &[f64], cached_center: bool) -> &[f64] {
    if cached_center { &candidates[1..] } else { candidates }
}

fn refinement_center_matches_hit(candidates: &[f64], hit_time: f64) -> bool {
    candidates.first().is_some_and(|time| (time - hit_time).abs() < 0.001)
}

fn score_refinement_frame(qv: &search::QueryVector, frame: &media::RawFrame) -> f64 {
    let ild = hash::ImageDataLike {
        width: frame.width,
        height: frame.height,
        channels: 3,
        order: hash::ChannelOrder::Rgb,
        data: &frame.rgb,
    };
    search::score_raw_frame(qv, &ild)
}

/// 命中时间精修：粗召回命中的是采样帧，显示时间 = 该采样帧的时间，与截图帧天然差半个
/// 采样间隔以内。围绕命中时间按局部采样密度并行补采候选帧（逐点 seek），用与粗召回
/// 相同的打分公式选最优；优于命中点自身才改写 timeSeconds。
fn refine_hit_time(
    qv: &search::QueryVector,
    video: &db::VideoRecord,
    hit: &mut search::IndexedHit,
    cached_center: Option<&media::RawFrame>,
) {
    let candidates = search::refine_candidate_times(video.duration, video.frame_count as usize, hit.time_seconds);
    if candidates.len() <= 1 {
        return;
    }
    let cached_center = cached_center.filter(|_| refinement_center_matches_hit(&candidates, hit.time_seconds));
    let decode_times = refinement_decode_times(&candidates, cached_center.is_some());
    let frames = match media::extract_and_hash_frames(
        &video.path,
        decode_times,
        video.duration,
        video.width,
        video.height,
        true,
    ) {
        Ok(f) => f,
        Err(_) => return,
    };
    let mut best_score = cached_center.map(|frame| score_refinement_frame(qv, frame)).unwrap_or(-1.0);
    let mut best_time = cached_center.map(|_| candidates[0]);
    for (fr, t) in frames.iter().zip(decode_times.iter()) {
        let score = score_refinement_frame(qv, fr);
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
pub(crate) fn perform_search(
    state: &AppState,
    qv: &search::QueryVector,
    qild: &hash::ImageDataLike,
    qw: u32,
    qh: u32,
) -> Result<SearchResponse, String> {
    // 启动后的头几秒常驻索引还在后台构建，空索引会给出「没找到」的错误结论。
    if !state.search_ready.load(std::sync::atomic::Ordering::Acquire) {
        return Err("正在加载索引，请稍候再试".to_string());
    }
    let started = std::time::SystemTime::now();
    let settings = {
        let guard = state.db()?;
        let conn = &*guard;
        db::get_settings(conn).unwrap_or_else(|_| db::default_settings())
    };
    let candidate_limit = (settings.max_results as usize).max(RERANK_TOP_K);

    let (mut results, compared) = {
        let index = state.search_index.lock().map_err(|e| e.to_string())?;
        index.search(
            qv,
            &search::SearchOptions {
                min_hash_score: settings.min_hash_score,
                max_results: candidate_limit,
            },
        )
    };

    // 后续重排/精修会多次启动 FFmpeg，先把候选视频快照出来，绝不能在这些
    // 外部进程运行期间持有全局 SQLite 互斥锁。
    let videos: HashMap<i64, db::VideoRecord> = {
        let guard = state.db()?;
        let conn = &*guard;
        results
            .iter()
            .filter_map(|hit| {
                db::get_video(conn, hit.video_id)
                    .ok()
                    .flatten()
                    .map(|video| (video.id, video))
            })
            .collect()
    };

    let decoded = rerank_matches(&videos, qild, &mut results);

    // 命中时间精修：只对最佳命中做（补采 2×4+1 帧逐点 seek），把显示时间从
    // 「最近采样帧」对准到「真实截图帧」。
    if let Some(top) = results.first_mut() {
        if let Some(video) = videos.get(&top.video_id) {
            refine_hit_time(qv, video, top, decoded.get(&top.video_id));
        }
    }

    let matches: Vec<SearchMatch> = results
        .iter()
        .take(settings.max_results as usize)
        .filter_map(|hit| {
            let video = videos.get(&hit.video_id)?.clone();
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

    Ok(SearchResponse {
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_image_is_resized_to_exact_ffmpeg_dimensions() {
        if media::resolve_tools().is_none() { return; }
        let image = image::DynamicImage::new_rgb8(1000, 333);
        let (pixels, width, height) = prepare_query_image(image).unwrap();
        assert_eq!((width, height), (crate::constants::EXTRACT_WIDTH, 106));
        assert_eq!(pixels.len(), width as usize * height as usize * 3);
    }

    #[test]
    fn refinement_reuses_a_reranked_center_frame() {
        let candidates = [10.0, 9.5, 10.5];
        assert_eq!(refinement_decode_times(&candidates, true), &[9.5, 10.5]);
        assert_eq!(refinement_decode_times(&candidates, false), &candidates);
        assert!(refinement_center_matches_hit(&candidates, 10.0));
        assert!(!refinement_center_matches_hit(&candidates, 12.0));
    }
}

