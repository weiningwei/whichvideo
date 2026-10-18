//! 内存帧索引与搜索打分。
//!
//! 帧指纹（8 字节 dHash + 128 字节结构 + 64 字节颜色 + 48 字节空间 + 8 字节元信息）
//! 全量常驻内存，图片搜索 = 纯内存扫描：先用 64bit dHash 剪枝，再做 1024bit 结构
//! 距离与颜色分。
//!
//! 打分公式（颜色权重上下界见 hash::COLOR_WEIGHT_MIN/MAX）：
//!   颜色越鲜明的查询图，颜色直方图权重越高（0.3 → 0.7），因为纯色/少色画面的结构
//!   指纹会退化，必须靠颜色区分。
//!
//! dHash 与结构指纹剪枝阈值。

use crate::db;
use crate::framepack;
use crate::hash;
use rusqlite::Connection;

/// 64bit dHash 汉明距离超过该值直接丢弃（剪枝）。
pub const DHASH_PRUNE_BITS: usize = 24;
/// 1024bit 结构距离超过该值直接丢弃（剪枝）。
pub const STRUCT_PRUNE_BITS: usize = 448;

const STRUCT_BITS: f64 = (framepack::STRUCT_BYTES * 8) as f64;

/* ------------------------------------------------------------------ *
 * 查询向量与命中
 * ------------------------------------------------------------------ */

/// 查询图的计算结果（检索时一次性算出，热循环内只读）。
#[derive(Clone)]
pub struct QueryVector {
    pub dhash: u64,
    /// 128 字节结构指纹
    pub struct_hash: Vec<u8>,
    /// 64 字节量化颜色直方图
    pub color: Vec<u8>,
    /// 48 字节空间颜色布局
    pub spatial: Vec<u8>,
    /// 颜色鲜明度，决定结构与颜色的权重
    pub colorfulness: f64,
}

/// 单条命中（视频级聚合后的结果）。
#[derive(Clone)]
pub struct IndexedHit {
    pub video_id: i64,
    pub frame_index: u32,
    pub time_seconds: f64,
    pub score: f64,
    pub hash_score: f64,
    pub color_score: f64,
    pub hash_distance: usize,
}

/// 搜索选项。
pub struct SearchOptions {
    /// 结构相似度低于该值的帧直接丢弃
    pub min_hash_score: f64,
    /// 返回条数上限
    pub max_results: usize,
}

/// 索引元信息（命中时间精修、查重等会用到）。
#[derive(Clone, Default)]
#[allow(dead_code)]
pub struct FrameIndexInfo {
    pub frames: usize,
    pub videos: usize,
    pub bytes: usize,
    pub built_at: i64,
}

/* ------------------------------------------------------------------ *
 * 命中时间精修（二阶段）
 * ------------------------------------------------------------------ */

/// 精修补采时命中点每一侧的候选数（含命中点共 2×该值+1 个解码点）。
pub const REFINE_POINTS_PER_SIDE: usize = 4;

/// 命中时间精修的候选时间点（秒，含命中点本身，升序去重）。
///
/// 窗口 = 局部采样间隔（时长/帧数）的一半，夹到 [1, 15] 秒；每侧均匀取
/// REFINE_POINTS_PER_SIDE 个点。时长/帧数未知时按 10s 间隔兜底。
/// 候选点夹到 [0, 时长] 内，0.05s 内视为同点去重。
pub fn refine_candidate_times(
    duration_seconds: Option<f64>,
    frame_count: usize,
    hit_time_seconds: f64,
) -> Vec<f64> {
    let gap = match (duration_seconds, frame_count) {
        (Some(d), n) if n > 0 && d > 0.0 => d / n as f64,
        _ => 10.0,
    };
    let window = (gap / 2.0).max(1.0).min(15.0);
    let step = window / REFINE_POINTS_PER_SIDE as f64;
    let mut raw = vec![hit_time_seconds];
    for k in 1..=REFINE_POINTS_PER_SIDE {
        raw.push(hit_time_seconds - step * k as f64);
        raw.push(hit_time_seconds + step * k as f64);
    }
    let upper = match duration_seconds {
        Some(d) if d > 0.0 => d,
        _ => f64::INFINITY,
    };
    let mut out: Vec<f64> = Vec::new();
    for t in raw {
        let clamped = t.max(0.0).min(upper);
        if !out.iter().any(|x| (x - clamped).abs() < 0.05) {
            out.push(clamped);
        }
    }
    out
}

/* ------------------------------------------------------------------ *
 * 打分
 * ------------------------------------------------------------------ */

/// 用主搜索相同的公式给单帧指纹打分（不剪枝）：
/// score = 结构相似度 × (1-颜色权重) + 颜色分 × 颜色权重。
/// 只用于精修候选帧的比对 —— 候选是个位数帧，无需 dHash/结构剪枝。
pub fn score_signature(
    qv: &QueryVector,
    sig_struct: &[u8],
    sig_color: &[u8],
    sig_spatial: &[u8],
) -> f64 {
    let weight = hash::COLOR_WEIGHT_MIN
        + (hash::COLOR_WEIGHT_MAX - hash::COLOR_WEIGHT_MIN) * qv.colorfulness.max(0.0).min(1.0);
    let hash_score = 1.0
        - hash::hamming_bytes(&qv.struct_hash, 0, sig_struct, 0, framepack::STRUCT_BYTES) as f64
            / STRUCT_BITS;
    let histogram_score = framepack::quantized_histogram_similarity(&qv.color, sig_color, 0);
    let spatial_score = framepack::spatial_similarity(&qv.spatial, sig_spatial, 0);
    let color_score =
        histogram_score * (1.0 - hash::SPATIAL_WEIGHT) + spatial_score * hash::SPATIAL_WEIGHT;
    hash_score * (1.0 - weight) + color_score * weight
}

/// 直接与原始像素帧（RawFrame.rgb 形态的 ImageDataLike）打分，供精修候选帧比对。
pub fn score_raw_frame(qv: &QueryVector, ild: &hash::ImageDataLike) -> f64 {
    let sig = hash::compute_signature(ild);
    let color = framepack::quantize_color(&sig.color);
    score_signature(qv, &sig.struct_hash, &color, &sig.spatial)
}

/* ------------------------------------------------------------------ *
 * 内存帧索引
 * ------------------------------------------------------------------ */

/// 全量常驻内存的帧指纹索引。
///
/// buffer 按 256 字节/帧紧凑排列；words 是其小端 u32 视图，热循环里免算偏移。
pub struct FrameSearchIndex {
    buffer: Vec<u8>,
    video_ids: Vec<i64>,
    words: Vec<u32>,
    built_at: i64,
}

/// search() 内部用的「最佳帧 + 次佳帧」聚合结构。
struct HitAgg {
    video_id: i64,
    frame_index: u32,
    time_seconds: f64,
    score: f64,
    hash_score: f64,
    color_score: f64,
    hash_distance: usize,
    second_best: Option<f64>,
}

impl FrameSearchIndex {
    /// 空索引。
    pub fn new() -> Self {
        FrameSearchIndex {
            buffer: Vec::new(),
            video_ids: Vec::new(),
            words: Vec::new(),
            built_at: 0,
        }
    }

    /// 全量重建（启动、删除或增量更新失败时调用）。
    pub fn rebuild_from_db(conn: &Connection) -> Self {
        let (buffer, video_ids) = match db::load_frame_matrix(conn) {
            Ok(m) => (m.buffer, m.video_ids),
            Err(_) => (Vec::new(), Vec::new()),
        };
        let words = buffer
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        FrameSearchIndex {
            buffer,
            video_ids,
            words,
            built_at: db::now_ms(),
        }
    }

    /// 索引完成时只更新对应视频的帧，避免批量导入中反复从 SQLite 重建全库索引。
    /// 新视频直接追加；重建已有视频时才压实移除旧帧。
    pub fn replace_video_frames(&mut self, video_id: i64, frames: db::FrameMatrix) {
        if !self.video_ids.contains(&video_id) {
            self.append_frames(frames);
            return;
        }

        let retained = self.video_ids.iter().filter(|&&id| id != video_id).count();
        let mut buffer = Vec::with_capacity(retained * framepack::FRAME_STRIDE + frames.buffer.len());
        let mut video_ids = Vec::with_capacity(retained + frames.video_ids.len());
        for (index, &id) in self.video_ids.iter().enumerate() {
            if id == video_id {
                continue;
            }
            let offset = index * framepack::FRAME_STRIDE;
            buffer.extend_from_slice(&self.buffer[offset..offset + framepack::FRAME_STRIDE]);
            video_ids.push(id);
        }
        buffer.extend_from_slice(&frames.buffer);
        video_ids.extend(frames.video_ids);
        self.buffer = buffer;
        self.video_ids = video_ids;
        self.rebuild_words();
    }

    fn append_frames(&mut self, frames: db::FrameMatrix) {
        self.words.extend(
            frames
                .buffer
                .chunks_exact(4)
                .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])),
        );
        self.buffer.extend(frames.buffer);
        self.video_ids.extend(frames.video_ids);
        self.built_at = db::now_ms();
    }

    fn rebuild_words(&mut self) {
        self.words = self
            .buffer
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        self.built_at = db::now_ms();
    }

    /// 索引元信息。
    #[allow(dead_code)]
    pub fn info(&self) -> FrameIndexInfo {
        let mut set = std::collections::HashSet::new();
        for &id in &self.video_ids {
            set.insert(id);
        }
        FrameIndexInfo {
            frames: self.video_ids.len(),
            videos: set.len(),
            bytes: self.buffer.len(),
            built_at: self.built_at,
        }
    }

    /// 索引中的所有视频 id（按帧首次出现顺序去重）。
    #[allow(dead_code)]
    pub fn list_video_ids(&self) -> Vec<i64> {
        let mut seen = Vec::new();
        let mut set = std::collections::HashSet::new();
        for &id in &self.video_ids {
            if set.insert(id) {
                seen.push(id);
            }
        }
        seen
    }

    /// 某视频的代表帧查询向量：取该视频在索引中时间居中的那一帧。
    /// 查重场景没有外部查询图，因此使用库内帧作为查询样本。
    #[allow(dead_code)]
    pub fn video_query_vector(&self, video_id: i64) -> Option<QueryVector> {
        self.video_frame_vectors(video_id, 1).into_iter().next()
    }

    /// 某视频的均匀采样帧向量（最多 maxCount 个，覆盖该视频在索引中的整个区间）。
    #[allow(dead_code)]
    pub fn video_frame_vectors(&self, video_id: i64, max_count: usize) -> Vec<QueryVector> {
        if self.words.is_empty() || max_count < 1 {
            return Vec::new();
        }
        let count = self.video_ids.len();
        let mut first: Option<usize> = None;
        let mut last = 0usize;
        for i in 0..count {
            if self.video_ids[i] == video_id {
                if first.is_none() {
                    first = Some(i);
                }
                last = i;
            }
        }
        let first = match first {
            Some(f) => f,
            None => return Vec::new(),
        };
        let span = last - first + 1;
        let n = max_count.min(span);
        let mut vecs = Vec::with_capacity(n);
        for k in 0..n {
            let mid = first + (((k * (span - 1)) as f64 / (n - 1).max(1) as f64).round() as usize);
            let off = mid * framepack::FRAME_STRIDE;
            let color = self.buffer[off + framepack::COLOR_OFFSET
                ..off + framepack::COLOR_OFFSET + framepack::COLOR_BYTES]
                .to_vec();
            let w_base = (mid * framepack::FRAME_STRIDE) >> 2;
            let d_lo = self.words[w_base];
            let d_hi = self.words[w_base + 1];
            let dhash = ((d_hi as u64) << 32) | (d_lo as u64);
            let struct_hash = self.buffer[off + framepack::STRUCT_OFFSET
                ..off + framepack::STRUCT_OFFSET + framepack::STRUCT_BYTES]
                .to_vec();
            let spatial = self.buffer[off + framepack::SPATIAL_OFFSET
                ..off + framepack::SPATIAL_OFFSET + framepack::SPATIAL_BYTES]
                .to_vec();
            let colorfulness = framepack::quantized_colorfulness(&color);
            vecs.push(QueryVector {
                dhash,
                struct_hash,
                color,
                spatial,
                colorfulness,
            });
        }
        vecs
    }

    /// 视频级结果：score = 最佳帧(0.75) + 次佳帧(0.25)。
    pub fn search(&self, qv: &QueryVector, options: &SearchOptions) -> (Vec<IndexedHit>, usize) {
        let count = self.video_ids.len();
        if self.buffer.is_empty() || self.words.is_empty() || count == 0 {
            return (Vec::new(), 0);
        }
        let weight = hash::COLOR_WEIGHT_MIN
            + (hash::COLOR_WEIGHT_MAX - hash::COLOR_WEIGHT_MIN) * qv.colorfulness.max(0.0).min(1.0);
        let struct_weight = 1.0 - weight;
        let q_dhash_hi = (qv.dhash >> 32) as u32;
        let q_dhash_lo = (qv.dhash & 0xFFFF_FFFF) as u32;
        let q_struct_u32: Vec<u32> = qv
            .struct_hash
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();

        let min_hash = options.min_hash_score;
        let mut best: std::collections::HashMap<i64, HitAgg> = std::collections::HashMap::new();

        for i in 0..count {
            let w_base = (i * framepack::FRAME_STRIDE) >> 2;
            let d_lo = self.words[w_base];
            let d_hi = self.words[w_base + 1];
            let dist_d = (d_lo ^ q_dhash_lo).count_ones() as usize
                + (d_hi ^ q_dhash_hi).count_ones() as usize;
            if dist_d > DHASH_PRUNE_BITS {
                continue;
            }
            let s_base = w_base + (framepack::STRUCT_OFFSET >> 2);
            let mut struct_distance = 0usize;
            for j in 0..(framepack::STRUCT_BYTES >> 2) {
                struct_distance += (self.words[s_base + j] ^ q_struct_u32[j]).count_ones() as usize;
            }
            if struct_distance > STRUCT_PRUNE_BITS {
                continue;
            }
            let hash_score = 1.0 - struct_distance as f64 / STRUCT_BITS;
            if hash_score < min_hash {
                continue;
            }

            let off = i * framepack::FRAME_STRIDE;
            let hist = framepack::quantized_histogram_similarity(
                &qv.color,
                &self.buffer,
                off + framepack::COLOR_OFFSET,
            );
            let spatial = framepack::spatial_similarity(
                &qv.spatial,
                &self.buffer,
                off + framepack::SPATIAL_OFFSET,
            );
            let color_score = hist * (1.0 - hash::SPATIAL_WEIGHT) + spatial * hash::SPATIAL_WEIGHT;
            let score = hash_score * struct_weight + color_score * weight;

            let frame_index = self.words[w_base + (framepack::META_OFFSET >> 2)];
            let time_ms = self.words[w_base + (framepack::META_OFFSET >> 2) + 1];
            let time_seconds = time_ms as f64 / 1000.0;
            let video_id = self.video_ids[i];

            match best.get_mut(&video_id) {
                None => {
                    best.insert(
                        video_id,
                        HitAgg {
                            video_id,
                            frame_index,
                            time_seconds,
                            score,
                            hash_score,
                            color_score,
                            hash_distance: struct_distance,
                            second_best: None,
                        },
                    );
                }
                Some(cur) => {
                    if score > cur.score {
                        cur.second_best = Some(cur.score);
                        cur.frame_index = frame_index;
                        cur.time_seconds = time_seconds;
                        cur.score = score;
                        cur.hash_score = hash_score;
                        cur.color_score = color_score;
                        cur.hash_distance = struct_distance;
                    } else if cur.second_best.is_none_or(|second| score > second) {
                        cur.second_best = Some(score);
                    }
                }
            }
        }

        let mut results: Vec<IndexedHit> = best
            .into_values()
            .map(|v| IndexedHit {
                video_id: v.video_id,
                frame_index: v.frame_index,
                time_seconds: v.time_seconds,
                score: v.score * 0.75 + v.second_best.unwrap_or(v.score) * 0.25,
                hash_score: v.hash_score,
                color_score: v.color_score,
                hash_distance: v.hash_distance,
            })
            .collect();
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if results.len() > options.max_results {
            results.truncate(options.max_results);
        }
        (results, count)
    }
}

impl Default for FrameSearchIndex {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn append_frame(
        buffer: &mut Vec<u8>,
        video_ids: &mut Vec<i64>,
        video_id: i64,
        frame_index: u32,
        time_ms: u32,
        struct_hash: &[u8],
        color: &[u8],
        spatial: &[u8],
    ) {
        let off = buffer.len();
        buffer.resize(off + framepack::FRAME_STRIDE, 0);
        buffer[off + framepack::STRUCT_OFFSET
            ..off + framepack::STRUCT_OFFSET + framepack::STRUCT_BYTES]
            .copy_from_slice(struct_hash);
        buffer
            [off + framepack::COLOR_OFFSET..off + framepack::COLOR_OFFSET + framepack::COLOR_BYTES]
            .copy_from_slice(color);
        buffer[off + framepack::SPATIAL_OFFSET
            ..off + framepack::SPATIAL_OFFSET + framepack::SPATIAL_BYTES]
            .copy_from_slice(spatial);
        buffer[off + framepack::META_OFFSET..off + framepack::META_OFFSET + 4]
            .copy_from_slice(&frame_index.to_le_bytes());
        buffer[off + framepack::META_OFFSET + 4..off + framepack::META_OFFSET + 8]
            .copy_from_slice(&time_ms.to_le_bytes());
        video_ids.push(video_id);
    }

    #[test]
    fn replacing_video_frames_keeps_other_videos_and_removes_stale_frames() {
        let struct_hash = vec![0_u8; framepack::STRUCT_BYTES];
        let color = vec![0_u8; framepack::COLOR_BYTES];
        let spatial = vec![0_u8; framepack::SPATIAL_BYTES];
        let mut buffer = Vec::new();
        let mut video_ids = Vec::new();
        append_frame(&mut buffer, &mut video_ids, 1, 0, 1000, &struct_hash, &color, &spatial);
        append_frame(&mut buffer, &mut video_ids, 2, 0, 2000, &struct_hash, &color, &spatial);
        let mut index = FrameSearchIndex {
            words: buffer
                .chunks_exact(4)
                .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect(),
            buffer,
            video_ids,
            built_at: 0,
        };

        let mut replacement = Vec::new();
        let mut replacement_ids = Vec::new();
        append_frame(
            &mut replacement,
            &mut replacement_ids,
            1,
            9,
            9000,
            &struct_hash,
            &color,
            &spatial,
        );
        index.replace_video_frames(1, db::FrameMatrix {
            buffer: replacement,
            video_ids: replacement_ids,
        });

        assert_eq!(index.video_ids, vec![2, 1]);
        assert_eq!(index.buffer.len(), 2 * framepack::FRAME_STRIDE);
        assert_eq!(index.words.len(), index.buffer.len() / 4);
        let replacement_offset = framepack::FRAME_STRIDE + framepack::META_OFFSET;
        assert_eq!(
            u32::from_le_bytes(index.buffer[replacement_offset..replacement_offset + 4].try_into().unwrap()),
            9
        );
    }

    #[test]
    fn exact_frames_rank_first_and_preserve_metadata() {
        let query_struct = vec![0_u8; framepack::STRUCT_BYTES];
        let mut query_color = vec![0_u8; framepack::COLOR_BYTES];
        query_color[0] = 255;
        let query_spatial = vec![32_u8; framepack::SPATIAL_BYTES];
        let query = QueryVector {
            dhash: 0,
            struct_hash: query_struct.clone(),
            color: query_color.clone(),
            spatial: query_spatial.clone(),
            colorfulness: 1.0,
        };

        let mut buffer = Vec::new();
        let mut video_ids = Vec::new();
        append_frame(
            &mut buffer,
            &mut video_ids,
            10,
            4,
            1250,
            &query_struct,
            &query_color,
            &query_spatial,
        );
        append_frame(
            &mut buffer,
            &mut video_ids,
            10,
            5,
            2500,
            &query_struct,
            &query_color,
            &query_spatial,
        );
        append_frame(
            &mut buffer,
            &mut video_ids,
            20,
            9,
            9000,
            &vec![0xff; framepack::STRUCT_BYTES],
            &vec![0; framepack::COLOR_BYTES],
            &vec![255; framepack::SPATIAL_BYTES],
        );
        let words = buffer
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        let index = FrameSearchIndex {
            buffer,
            video_ids,
            words,
            built_at: 0,
        };

        let (hits, compared) = index.search(
            &query,
            &SearchOptions {
                min_hash_score: 0.0,
                max_results: 10,
            },
        );
        assert_eq!(compared, 3);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].video_id, 10);
        assert_eq!(hits[0].frame_index, 4);
        assert_eq!(hits[0].time_seconds, 1.25);
        assert!((hits[0].score - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn single_exact_frame_keeps_full_score() {
        let struct_hash = vec![0_u8; framepack::STRUCT_BYTES];
        let mut color = vec![0_u8; framepack::COLOR_BYTES];
        color[0] = 255;
        let spatial = vec![32_u8; framepack::SPATIAL_BYTES];
        let query = QueryVector {
            dhash: 0,
            struct_hash: struct_hash.clone(),
            color: color.clone(),
            spatial: spatial.clone(),
            colorfulness: 1.0,
        };
        let mut buffer = Vec::new();
        let mut video_ids = Vec::new();
        append_frame(&mut buffer, &mut video_ids, 10, 0, 1000, &struct_hash, &color, &spatial);
        let words = buffer
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        let index = FrameSearchIndex { buffer, video_ids, words, built_at: 0 };
        let (hits, _) = index.search(&query, &SearchOptions { min_hash_score: 0.6, max_results: 10 });
        assert_eq!(hits.len(), 1);
        assert!((hits[0].score - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn refine_candidates_are_clamped_and_deduplicated() {
        let times = refine_candidate_times(Some(6.0), 2, 0.0);
        assert_eq!(times.len(), 5);
        assert_eq!(times[0], 0.0);
        assert!(times.iter().all(|t| *t >= 0.0 && *t <= 6.0));
        assert!(times.iter().any(|t| (*t - 1.5).abs() < f64::EPSILON));
    }

    #[test]
    fn identical_signature_scores_one() {
        let query = QueryVector {
            dhash: 0,
            struct_hash: vec![0x55; framepack::STRUCT_BYTES],
            color: vec![4; framepack::COLOR_BYTES],
            spatial: vec![127; framepack::SPATIAL_BYTES],
            colorfulness: 4.0 / 255.0,
        };
        let score = score_signature(&query, &query.struct_hash, &query.color, &query.spatial);
        assert!((score - 1.0).abs() < 1e-12);
    }
}
