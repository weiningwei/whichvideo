//! 每帧的紧凑指纹布局（镜像 Electron src/shared/framepack.ts）。
//!
//! 内存布局（M9 常驻内存比对用）：
//!   0   : 8 字节  64bit dHash
//!   8   : 128 字节 1024bit 均值归一化结构指纹
//!   136 : 64 字节 颜色直方图（4x4x4 RGB 分桶，量化为 u8）
//!   200 : 48 字节 空间颜色布局（4x4 网格每格 RGB 均值，u8）
//!   248 : 4 字节  frameIndex (u32)
//!   252 : 4 字节  timeMs (u32)
//! 合计 256 字节/帧。
//!
//! search.rs 的 FrameSearchIndex 与 db.load_frame_matrix 都按这套偏移拼装/解析。

#![allow(dead_code)]

/// dHash 字节数（64bit）。
pub const DHASH_OFFSET: usize = 0;
pub const DHASH_BYTES: usize = 8;
/// 结构指纹偏移与字节数（128 字节 = 1024bit）。
pub const STRUCT_OFFSET: usize = DHASH_OFFSET + DHASH_BYTES;
pub const STRUCT_BYTES: usize = 128;
/// 颜色直方图偏移与字节数（4×4×4，量化为 u8）。
pub const COLOR_OFFSET: usize = STRUCT_OFFSET + STRUCT_BYTES;
pub const COLOR_BYTES: usize = 64;
/// 空间颜色布局偏移与字节数（4×4×RGB，u8）。
pub const SPATIAL_OFFSET: usize = COLOR_OFFSET + COLOR_BYTES;
pub const SPATIAL_BYTES: usize = 48;
/// 元信息：frameIndex (u32) + timeMs (u32)。
pub const META_OFFSET: usize = SPATIAL_OFFSET + SPATIAL_BYTES;
/// 单帧总字节数。
pub const FRAME_STRIDE: usize = META_OFFSET + 8;

/// Float32 颜色直方图（和为 1）→ u8 量化。统一按 255 直接取整（量化误差 ≤1/255）。
/// 索引器落库与查询图量化共用。
pub fn quantize_color(hist: &[f32]) -> Vec<u8> {
    let mut out = vec![0u8; COLOR_BYTES];
    for i in 0..COLOR_BYTES {
        let v = if i < hist.len() {
            (hist[i] * 255.0).round()
        } else {
            0.0
        };
        out[i] = if v < 0.0 { 0 } else if v > 255.0 { 255 } else { v as u8 };
    }
    out
}

/// 量化后的直方图相交相似度，避免搜索时还原 Float32（镜像 framepack.ts）。
/// a 为量化直方图；b 为库侧缓冲，b_off 起 64 字节为本帧颜色。
pub fn quantized_histogram_similarity(a: &[u8], b: &[u8], b_off: usize) -> f64 {
    let mut sum = 0u32;
    for i in 0..COLOR_BYTES {
        let av = a[i] as u32;
        let bv = b[b_off + i] as u32;
        sum += av.min(bv);
    }
    (sum as f64 / 255.0).min(1.0)
}

/// 从量化直方图推断颜色鲜明度（主导分桶占比，0~1）。
pub fn quantized_colorfulness(color: &[u8]) -> f64 {
    let mut max = 0u8;
    for i in 0..COLOR_BYTES {
        if color[i] > max {
            max = color[i];
        }
    }
    max as f64 / 255.0
}

/// 空间颜色布局相似度（0~1）：48 字节（16 格 × RGB）的归一化 L1 距离。
/// 与直方图相交相似度互补 —— 直方图判"颜色组成"，这里判"颜色摆在哪"。
pub fn spatial_similarity(a: &[u8], b: &[u8], b_off: usize) -> f64 {
    let mut diff = 0u32;
    for i in 0..SPATIAL_BYTES {
        let d = (a[i] as i32 - b[b_off + i] as i32).abs() as u32;
        diff += d;
    }
    (1.0 - diff as f64 / (SPATIAL_BYTES as f64 * 255.0)).max(0.0)
}
