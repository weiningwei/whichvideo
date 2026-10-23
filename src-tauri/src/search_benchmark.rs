//! 离线图像检索评测：直接调用生产查询预处理与 FrameSearchIndex，无窗口和 IPC。

#[cfg(test)]
mod tests {
    use crate::{commands, db, framepack, media, search};
    use serde::{Deserialize, Serialize};
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::time::Instant;

    #[derive(Deserialize)]
    struct GalleryItem {
        id: String,
        family: String,
        path: PathBuf,
    }

    #[derive(Deserialize)]
    struct QueryItem {
        id: String,
        path: PathBuf,
        #[serde(rename = "expectedId")]
        expected_id: Option<String>,
        family: String,
        variant: String,
    }

    #[derive(Deserialize)]
    struct Manifest {
        version: u32,
        profile: String,
        seed: u32,
        gallery: Vec<GalleryItem>,
        queries: Vec<QueryItem>,
    }

    #[derive(Serialize)]
    struct Row {
        id: String,
        family: String,
        variant: String,
        expected_id: Option<String>,
        rank: usize,
        search_ms: u128,
        preprocess_ms: u128,
        top_five: Vec<(String, f64)>,
    }

    fn query_vector(path: &PathBuf) -> search::QueryVector {
        let image = image::open(path).unwrap_or_else(|e| panic!("无法解码 {}：{e}", path.display()));
        let (pixels, width, height) = media::prepare_query_pixels(image)
            .unwrap_or_else(|e| panic!("无法预处理 {}：{e}", path.display()));
        commands::build_query_vector(&pixels, width, height)
    }

    fn append_frame(matrix: &mut db::FrameMatrix, video_id: i64, vector: &search::QueryVector) {
        let start = matrix.buffer.len();
        matrix.buffer.extend_from_slice(&vector.dhash.to_le_bytes());
        matrix.buffer.extend_from_slice(&vector.struct_hash);
        matrix.buffer.extend_from_slice(&vector.color);
        matrix.buffer.extend_from_slice(&vector.spatial);
        matrix.buffer.extend_from_slice(&0u32.to_le_bytes());
        matrix.buffer.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(matrix.buffer.len() - start, framepack::FRAME_STRIDE);
        matrix.video_ids.push(video_id);
    }

    fn summary(rows: &[&Row]) -> serde_json::Value {
        let positives: Vec<&Row> = rows.iter().copied().filter(|row| row.expected_id.is_some()).collect();
        let negatives: Vec<&Row> = rows.iter().copied().filter(|row| row.expected_id.is_none()).collect();
        serde_json::json!({
            "count": rows.len(),
            "positive_count": positives.len(),
            "top1": positives.iter().filter(|row| row.rank == 1).count(),
            "top5": positives.iter().filter(|row| (1..=5).contains(&row.rank)).count(),
            "missing": positives.iter().filter(|row| row.rank == 0).count(),
            "negative_count": negatives.len(),
            "false_positive": negatives.iter().filter(|row| !row.top_five.is_empty()).count(),
        })
    }

    #[test]
    #[ignore = "由 pnpm test:search 生成数据并显式运行"]
    fn benchmark() {
        let manifest_path = PathBuf::from(std::env::var("WHICHVIDEO_SEARCH_BENCHMARK_MANIFEST")
            .expect("请通过 pnpm test:search 运行"));
        let manifest: Manifest = serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        assert!(!manifest.gallery.is_empty() && !manifest.queries.is_empty(), "评测数据不能为空");
        let mut matrix = db::FrameMatrix { buffer: Vec::new(), video_ids: Vec::new() };
        let mut ids = BTreeMap::new();
        for (position, item) in manifest.gallery.iter().enumerate() {
            let video_id = (position + 1) as i64;
            assert!(ids.insert(item.id.clone(), video_id).is_none(), "重复图库 ID");
            append_frame(&mut matrix, video_id, &query_vector(&item.path));
        }
        let index = search::FrameSearchIndex::from_matrix(matrix);
        let options = search::SearchOptions { min_hash_score: db::default_settings().min_hash_score, max_results: 40 };
        let mut rows = Vec::with_capacity(manifest.queries.len());
        for item in &manifest.queries {
            let started = Instant::now();
            let vector = query_vector(&item.path);
            let preprocess_ms = started.elapsed().as_millis();
            let started = Instant::now();
            let (hits, _) = index.search(&vector, &options);
            let search_ms = started.elapsed().as_millis();
            let rank = item.expected_id.as_ref().and_then(|id| {
                let expected = ids[id];
                hits.iter().position(|hit| hit.video_id == expected).map(|i| i + 1)
            }).unwrap_or(0);
            let top_five = hits.iter().take(5).map(|hit| {
                (manifest.gallery[(hit.video_id - 1) as usize].id.clone(), hit.score)
            }).collect();
            rows.push(Row {
                id: item.id.clone(), family: item.family.clone(), variant: item.variant.clone(),
                expected_id: item.expected_id.clone(), rank, search_ms, preprocess_ms, top_five,
            });
        }
        let mut by_family = BTreeMap::new();
        for family in manifest.gallery.iter().map(|item| &item.family) {
            let subset: Vec<&Row> = rows.iter().filter(|row| &row.family == family).collect();
            by_family.insert(family.clone(), summary(&subset));
        }
        let mut by_variant = BTreeMap::new();
        for variant in manifest.queries.iter().map(|item| &item.variant) {
            let subset: Vec<&Row> = rows.iter().filter(|row| &row.variant == variant).collect();
            by_variant.insert(variant.clone(), summary(&subset));
        }
        let all: Vec<&Row> = rows.iter().collect();
        let exact: Vec<&Row> = rows.iter().filter(|row| row.variant == "exact").collect();
        let report = serde_json::json!({
            "version": manifest.version, "profile": manifest.profile, "seed": manifest.seed,
            "gallery_count": manifest.gallery.len(), "summary": summary(&all),
            "exact": summary(&exact), "by_family": by_family, "by_variant": by_variant,
            "failures": rows.iter().filter(|row| {
                row.expected_id.is_some() && row.rank != 1 || row.expected_id.is_none() && !row.top_five.is_empty()
            }).collect::<Vec<_>>(),
            "rows": rows,
        });
        let report_path = manifest_path.parent().unwrap().join("report.json");
        std::fs::write(&report_path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        println!("搜索评测：{}；完整报告：{}", report["summary"], report_path.display());
        assert_eq!(report["exact"]["top1"], report["exact"]["positive_count"], "原图查询必须全部排首位");
    }
}
