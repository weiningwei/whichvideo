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
//! M7 仅需 quantize_color（Float32 直方图 → u8 量化）供落库；其余布局常量在 M9 使用。

#![allow(dead_code)]

/// 颜色直方图量化后的字节数（4×4×4）。与 @shared/framepack 的 COLOR_BYTES 一致。
pub const COLOR_BYTES: usize = 64;
/// 空间颜色布局字节数（4×4×RGB）。与 SPATIAL_BYTES 一致。
pub const SPATIAL_BYTES: usize = 48;

/// Float32 颜色直方图（和为 1）→ u8 量化。统一按 255 直接取整（量化误差 ≤1/255）。
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
