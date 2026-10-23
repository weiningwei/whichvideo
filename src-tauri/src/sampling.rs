//! 抽帧采样策略：决定「抽多少帧、抽哪些时间点」。纯函数，无 ffmpeg / 文件 IO 依赖，
//! 与 media.rs（二进制查找 + 进程执行 + 抽帧）解耦，可独立测试。
//!
//! 场景采样计划：framesForDuration → plannedFrameCount → 时间点计划。

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

/**
 * 场景采样计划：场景切换点优先 + 每镜头中点帧 + 长镜头内部均匀补充，总数不超过 frameBudget。
 * 生成场景感知的时间点计划。
 */
pub fn plan_scene_timestamps(scene_times: &[f64], duration: Option<f64>, frame_budget: usize, interval_seconds: usize) -> Vec<f64> {
    let mut ordered: Vec<f64> = scene_times.iter().copied().filter(|t| t.is_finite()).collect();
    ordered.sort_by(|a, b| a.total_cmp(b));
    if ordered.is_empty() {
        return plan_timestamps(duration, interval_seconds);
    }
    let budget = if frame_budget == 0 { DEFAULT_FRAME_BUDGET } else { frame_budget };
    let d = match duration {
        Some(v) if v > 0.5 => v,
        _ => ordered[ordered.len() - 1] + 5.0,
    };

    // 场景点：排序 + 去重（0.5s 内的密集切换视为同一处）
    let mut scenes: Vec<f64> = Vec::new();
    for &raw in &ordered {
        let t = (raw.max(0.05)).min((d - 0.05).max(0.05));
        if scenes.is_empty() || t - scenes[scenes.len() - 1] > 0.5 {
            scenes.push(t);
        }
    }

    // 镜头切换数可能远超用户上限（如快剪视频），不能无界启动 seek。
    // 此时保留首尾并按场景序号均匀选代表点；不再分配补充帧。
    if scenes.len() >= budget {
        if budget == 1 {
            return vec![scenes[scenes.len() / 2]];
        }
        return (0..budget)
            .map(|k| {
                let idx = k * (scenes.len() - 1) / (budget - 1);
                scenes[idx]
            })
            .collect();
    }

    let ideal_gap = d / budget as f64;
    let min_gap = (2.0 * ideal_gap).max(8.0);

    let mut fills: Vec<f64> = Vec::new();
    let head_boundaries: Vec<f64> = if !scenes.is_empty() {
        let mut v = vec![0.0];
        v.extend_from_slice(&scenes);
        v
    } else {
        scenes.clone()
    };
    for i in 0..head_boundaries.len() {
        let cur = head_boundaries[i];
        let next = if i + 1 < head_boundaries.len() {
            head_boundaries[i + 1]
        } else {
            d.max(cur + 1.0)
        };
        let gap = next - cur;
        let extra = (gap / min_gap).floor() as i64 - 1;
        for k in 1..=extra {
            fills.push(cur + gap * (k as f64) / ((extra + 1) as f64));
        }
        if gap >= SCENE_MIDPOINT_MIN_GAP && (extra < 0 || extra % 2 == 0) {
            fills.push(cur + gap / 2.0);
        }
    }

    // 场景点未超额时只裁补充点，均匀丢弃以保持覆盖。
    let over = (scenes.len() + fills.len()) as i64 - budget as i64;
    if over > 0 && !fills.is_empty() {
        let keep_count = (fills.len() as i64 - over).max(0) as usize;
        let mut kept: Vec<f64> = Vec::with_capacity(keep_count);
        for k in 0..keep_count {
            kept.push(fills[k * fills.len() / keep_count.max(1)]);
        }
        fills = kept;
    }

    let mut combined: Vec<f64> = scenes;
    combined.extend(fills);
    combined.sort_by(|a, b| a.partial_cmp(b).unwrap());
    combined
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dense_scenes_stay_within_budget_and_cover_ends() {
        let scenes: Vec<f64> = (1..=1000).map(|i| i as f64).collect();
        let plan = plan_scene_timestamps(&scenes, Some(1001.0), 48, 15);
        assert_eq!(plan.len(), 48);
        assert_eq!(plan.first(), Some(&1.0));
        assert_eq!(plan.last(), Some(&1000.0));
        assert!(plan.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn sparse_scenes_keep_cuts_and_fill_remaining_budget() {
        let plan = plan_scene_timestamps(&[90.0, 10.0, 50.0], Some(100.0), 12, 15);
        assert!(plan.len() <= 12);
        assert!(plan.contains(&10.0) && plan.contains(&50.0) && plan.contains(&90.0));
    }

    #[test]
    fn non_finite_scene_times_do_not_break_planning() {
        let plan = plan_scene_timestamps(&[f64::NAN, 2.0, f64::INFINITY], Some(10.0), 1, 15);
        assert_eq!(plan, vec![2.0]);
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
