//! 抽帧采样策略：决定「抽多少帧、抽哪些时间点」。纯函数，无 ffmpeg / 文件 IO 依赖，
//! 与 media.rs（二进制查找 + 进程执行 + 抽帧）解耦，可独立测试。
//!
//! 均匀模式按固定时间间隔；场景模式在每个镜头内按同一间隔取样。

use crate::constants::*;

/// 短视频的抽帧路径启发式；索引器可为长视频或高采样密度强制分批 seek。
pub fn should_use_full_scan(frame_count: usize, width: Option<i64>, height: Option<i64>) -> bool {
    let is4k = width.unwrap_or(0) >= 3840 || height.unwrap_or(0) >= 2160;
    is4k || frame_count > SEEK_VS_FULLSCAN_CROSSOVER
}

/// 固定时间间隔取样；每段取中点，最后不足一个间隔的尾段也取一帧。
pub fn plan_timestamps(duration: Option<f64>, interval_seconds: usize) -> Vec<f64> {
    let d = duration.unwrap_or(0.0);
    if !matches!(d.partial_cmp(&0.5), Some(std::cmp::Ordering::Greater)) {
        return vec![0.0];
    }
    let interval = interval_seconds.max(1) as f64;
    let count = (d / interval).ceil() as usize;
    let mut list = Vec::with_capacity(count);
    for i in 0..count {
        let start = i as f64 * interval;
        let end = (start + interval).min(d);
        let t = (start + end) / 2.0;
        list.push((t.max(0.05)).min((d - 0.05).max(0.05)));
    }
    list
}

/// 每个镜头至少取一帧；长镜头按时间间隔分段，不再按整片帧数截断。
pub fn plan_scene_timestamps(scene_times: &[f64], duration: Option<f64>, interval_seconds: usize) -> Vec<f64> {
    let mut ordered: Vec<f64> = scene_times.iter().copied().filter(|t| t.is_finite()).collect();
    ordered.sort_by(|a, b| a.total_cmp(b));
    if ordered.is_empty() {
        return plan_timestamps(duration, interval_seconds);
    }
    let d = match duration {
        Some(v) if v.is_finite() && v > 0.5 => v,
        _ => ordered[ordered.len() - 1] + 5.0,
    };
    let interval = interval_seconds.max(1) as f64;
    let mut boundaries = vec![0.0];
    // 0.5 秒内的切换合并，避免产生重复或几乎重合的采样点。
    for &raw in &ordered {
        if raw > 0.05 && raw < d - 0.05 && raw - boundaries[boundaries.len() - 1] > 0.5 {
            boundaries.push(raw);
        }
    }
    boundaries.push(d);
    let mut plan = Vec::new();
    for pair in boundaries.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        let count = ((end - start) / interval).ceil().max(1.0) as usize;
        for i in 0..count {
            plan.push(start + (i as f64 + 0.5) * (end - start) / count as f64);
        }
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dense_scenes_keep_each_shot_without_a_global_cap() {
        let scenes: Vec<f64> = (1..=1000).map(|i| i as f64).collect();
        let plan = plan_scene_timestamps(&scenes, Some(1001.0), 15);
        assert_eq!(plan.len(), 1001);
        assert_eq!(plan.first(), Some(&0.5));
        assert_eq!(plan.last(), Some(&1000.5));
        assert!(plan.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn sparse_scenes_get_a_frame_per_shot_and_fill_long_shots() {
        let plan = plan_scene_timestamps(&[90.0, 10.0, 50.0], Some(100.0), 15);
        assert_eq!(plan.len(), 8);
        assert!(plan.iter().any(|&t| t > 10.0 && t < 50.0));
        assert!(plan.iter().any(|&t| t > 50.0 && t < 90.0));
    }

    #[test]
    fn non_finite_scene_times_do_not_break_planning() {
        let plan = plan_scene_timestamps(&[f64::NAN, 2.0, f64::INFINITY], Some(10.0), 15);
        assert_eq!(plan, vec![1.0, 6.0]);
    }

    #[test]
    fn uniform_sampling_keeps_the_interval_on_long_videos() {
        let plan = plan_timestamps(Some(7200.0), 15);
        assert_eq!(plan.len(), 480);
        assert_eq!(plan[0], 7.5);
        assert_eq!(plan[1], 22.5);
        assert_eq!(plan[479], 7192.5);
        assert_eq!(plan_timestamps(Some(32.0), 15), vec![7.5, 22.5, 31.0]);
    }
}
