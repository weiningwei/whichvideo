//! 感知哈希（perceptual hash）算法，与共享指纹格式保持一致。
//!
//! 一张图压成三部分指纹：
//!  1. 64bit dHash —— 9×8 灰度梯度，搜索时快速剪枝
//!  2. 1024bit 均值归一化结构指纹（128 字节）—— 16×16×4 通道全量，对分辨率/
//!     再压缩/亮度轻微变化稳定，且能把"纯色"与"有内容"明显分开
//!  3. 4×4×4 RGB 颜色直方图（64×f32）—— 区分"结构相同但颜色不同"
//!  4. 4×4 空间颜色布局（48 字节 u8）—— 补直方图丢掉的"颜色在哪"
//!
//! 索引器与搜索都依赖本模块：索引器把每帧算出四条指纹落库，搜索侧在内存里
//! 比对。本文件不含 I/O，纯计算，便于单测。

#![allow(dead_code)]

pub const COLOR_BINS: usize = 64;
pub const STRUCT_BYTES: usize = 128;
pub const DHASH_BYTES: usize = 8;
pub const SPATIAL_GRID: usize = 4;
pub const SPATIAL_BYTES: usize = SPATIAL_GRID * SPATIAL_GRID * 3;

const STRUCT_GRID: usize = 16;
const STRUCT_BITS: usize = STRUCT_BYTES * 8;
const CHANNELS_IN_HASH: usize = 4;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ChannelOrder {
    Rgb,
    Bgr,
}

/// 输入像素缓冲。channels=3(RGB 交错) 或 4(RGBA/BGRA 交错)。
pub struct ImageDataLike<'a> {
    pub width: u32,
    pub height: u32,
    pub channels: u8,
    pub order: ChannelOrder,
    pub data: &'a [u8],
}

/// 灰度图（盒式重采样后的 w×h 浮点亮度）。
pub struct GrayImage {
    pub w: usize,
    pub h: usize,
    pub g: Vec<f32>,
}

/// 一帧/一张图的完整指纹。
pub struct FrameSignature {
    pub dhash: u64,
    pub struct_hash: Vec<u8>,
    pub color: Vec<f32>,
    pub spatial: Vec<u8>,
    pub luma: f32,
}

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/// 字节数组之间的汉明距离（逐 4 字节展开，单字节回退）。
pub fn hamming_bytes(a: &[u8], a_off: usize, b: &[u8], b_off: usize, length: usize) -> usize {
    let mut dist = 0usize;
    let mut i = 0;
    while i + 4 <= length {
        let av = u32::from_le_bytes([
            a[a_off + i],
            a[a_off + i + 1],
            a[a_off + i + 2],
            a[a_off + i + 3],
        ]);
        let bv = u32::from_le_bytes([
            b[b_off + i],
            b[b_off + i + 1],
            b[b_off + i + 2],
            b[b_off + i + 3],
        ]);
        dist += (av ^ bv).count_ones() as usize;
        i += 4;
    }
    while i < length {
        dist += (a[a_off + i] ^ b[b_off + i]).count_ones() as usize;
        i += 1;
    }
    dist
}

/* ------------------------------------------------------------------ *
 * 像素取色辅助
 * ------------------------------------------------------------------ */

fn luma_at(img: &ImageDataLike, x: usize, y: usize) -> f32 {
    let idx = (y * img.width as usize + x) * img.channels as usize;
    let d = img.data;
    let (r, g, b) = match img.order {
        ChannelOrder::Rgb => (d[idx] as f32, d[idx + 1] as f32, d[idx + 2] as f32),
        ChannelOrder::Bgr => (d[idx + 2] as f32, d[idx + 1] as f32, d[idx] as f32),
    };
    0.299 * r + 0.587 * g + 0.114 * b
}

fn channel_at(img: &ImageDataLike, c: usize, x: usize, y: usize) -> f32 {
    let idx = (y * img.width as usize + x) * img.channels as usize;
    let d = img.data;
    let v = match c {
        0 => match img.order {
            ChannelOrder::Rgb => d[idx] as f32,
            ChannelOrder::Bgr => d[idx + 2] as f32,
        },
        1 => d[idx + 1] as f32,
        _ => match img.order {
            ChannelOrder::Rgb => d[idx + 2] as f32,
            ChannelOrder::Bgr => d[idx] as f32,
        },
    };
    v
}

/* ------------------------------------------------------------------ *
 * 采样与灰度
 * ------------------------------------------------------------------ */

/// 盒式滤波把源图重采样成 w×h 灰度图（均值而非最近邻，对缩放/分辨率变化鲁棒）。
pub fn to_gray(img: &ImageDataLike, w: usize, h: usize) -> GrayImage {
    let sw = img.width as usize;
    let sh = img.height as usize;
    let mut out = vec![0f32; w * h];
    let x_ratio = sw as f64 / w as f64;
    let y_ratio = sh as f64 / h as f64;
    for dy in 0..h {
        let sy0 = (dy as f64 * y_ratio).floor() as usize;
        let sy1 = (sh as f64).min((((dy + 1) as f64 * y_ratio).ceil()).max(sy0 as f64 + 1.0)) as usize;
        for dx in 0..w {
            let sx0 = (dx as f64 * x_ratio).floor() as usize;
            let sx1 = (sw as f64).min((((dx + 1) as f64 * x_ratio).ceil()).max(sx0 as f64 + 1.0)) as usize;
            let mut sum = 0f32;
            let mut count = 0usize;
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    sum += luma_at(img, sx, sy);
                    count += 1;
                }
            }
            out[dy * w + dx] = if count > 0 { sum / count as f32 } else { 0.0 };
        }
    }
    GrayImage { w, h, g: out }
}

/* ------------------------------------------------------------------ *
 * dHash：9×8 灰度，比较水平相邻像素
 * ------------------------------------------------------------------ */

pub fn compute_dhash(gray: &GrayImage) -> u64 {
    let w = gray.w;
    let h = gray.h;
    let mut lo = 0u64;
    let mut hi = 0u64;
    let mut bit = 0usize;
    for y in 0..h {
        let row = y * w;
        for x in 0..w - 1 {
            let on = if gray.g[row + x] < gray.g[row + x + 1] { 1u64 } else { 0u64 };
            if bit < 32 {
                lo |= on << bit;
            } else {
                hi |= on << (bit - 32);
            }
            bit += 1;
        }
    }
    (lo << 32) | hi
}

/* ------------------------------------------------------------------ *
 * 均值归一化结构指纹
 * ------------------------------------------------------------------ */

/// 计算 size×size 分块均值网格（块大小尽量均匀覆盖整幅图）。
fn cell_grid<F: Fn(usize, usize) -> f32>(w: usize, h: usize, size: usize, value: F) -> Vec<f32> {
    let mut out = vec![0f32; size * size];
    let x_ratio = w as f64 / size as f64;
    let y_ratio = h as f64 / size as f64;
    for j in 0..size {
        let y0 = (j as f64 * y_ratio).floor() as usize;
        let y1 = (((j + 1) as f64 * y_ratio).floor() as usize).max(y0 + 1);
        for i in 0..size {
            let x0 = (i as f64 * x_ratio).floor() as usize;
            let x1 = (((i + 1) as f64 * x_ratio).floor() as usize).max(x0 + 1);
            let mut sum = 0f32;
            let mut n = 0usize;
            for y in y0..y1 {
                for x in x0..x1 {
                    sum += value(x, y);
                    n += 1;
                }
            }
            out[j * size + i] = if n > 0 { sum / n as f32 } else { 0.0 };
        }
    }
    out
}

/// 单通道分块网格编码成比特：格子均值 ≥ 全局均值 → 1。
/// 返回写入的比特数。
fn encode_channel(grid: &[f32], out: &mut [u8], bit_offset: usize, max_bits: usize) -> usize {
    let sum: f32 = grid.iter().sum();
    let mean = if grid.is_empty() { 0.0 } else { sum / grid.len() as f32 };
    let bits = max_bits.min(grid.len());
    for bit in 0..bits {
        let i = if grid.len() == bits {
            bit
        } else {
            (bit * grid.len() / bits).min(grid.len() - 1)
        };
        if grid[i] >= mean {
            let pos = bit_offset + bit;
            out[pos >> 3] |= 1 << (pos & 7);
        }
    }
    bits
}

pub fn compute_struct_hash(img: &ImageDataLike) -> Vec<u8> {
    let w = img.width as usize;
    let h = img.height as usize;
    let mut out = vec![0u8; STRUCT_BYTES];
    let per_channel = STRUCT_BITS / CHANNELS_IN_HASH;
    let mut offset = 0usize;
    offset += encode_channel(
        &cell_grid(w, h, STRUCT_GRID, |x, y| luma_at(img, x, y)),
        &mut out,
        offset,
        per_channel,
    );
    for c in 0..3 {
        let c = c;
        offset += encode_channel(
            &cell_grid(w, h, STRUCT_GRID, |x, y| channel_at(img, c, x, y)),
            &mut out,
            offset,
            per_channel,
        );
    }
    out
}

/// 1024bit 结构相似度（0~1）。
pub fn struct_similarity(a: &[u8], a_off: usize, b: &[u8], b_off: usize) -> f64 {
    1.0 - hamming_bytes(a, a_off, b, b_off, STRUCT_BYTES) as f64 / STRUCT_BITS as f64
}

/* ------------------------------------------------------------------ *
 * 颜色直方图：4×4×4 RGB 分桶
 * ------------------------------------------------------------------ */

pub fn compute_color_histogram(img: &ImageDataLike) -> Vec<f32> {
    let mut hist = vec![0f32; COLOR_BINS];
    let w = img.width as usize;
    let h = img.height as usize;
    let step = (1.0f64).max(((w * h) as f64 / 65536.0).sqrt().floor()) as usize;
    let step = step.max(1);
    let mut total = 0usize;
    let d = img.data;
    let ch = img.channels as usize;
    for y in (0..h).step_by(step) {
        let mut idx = y * w * ch;
        for _ in (0..w).step_by(step) {
            let (r, g, b) = match img.order {
                ChannelOrder::Rgb => (d[idx] as f32, d[idx + 1] as f32, d[idx + 2] as f32),
                ChannelOrder::Bgr => (d[idx + 2] as f32, d[idx + 1] as f32, d[idx] as f32),
            };
            let bucket = (((r as u32) >> 6) << 4) | (((g as u32) >> 6) << 2) | ((b as u32) >> 6);
            hist[bucket as usize] += 1.0;
            total += 1;
            idx += ch * step;
        }
    }
    if total > 0 {
        for v in hist.iter_mut() {
            *v /= total as f32;
        }
    }
    hist
}

pub fn mean_luma(gray: &GrayImage) -> f32 {
    if gray.g.is_empty() {
        0.0
    } else {
        gray.g.iter().sum::<f32>() / gray.g.len() as f32
    }
}

/* ------------------------------------------------------------------ *
 * 空间颜色布局：4×4 网格每格 RGB 均值
 * ------------------------------------------------------------------ */

pub fn compute_spatial_layout(img: &ImageDataLike) -> Vec<u8> {
    let w = img.width as usize;
    let h = img.height as usize;
    let mut out = vec![0u8; SPATIAL_BYTES];
    let mut o = 0usize;
    for c in 0..3 {
        let grid = cell_grid(w, h, SPATIAL_GRID, |x, y| channel_at(img, c, x, y));
        for v in grid.iter() {
            out[o] = if *v < 0.0 {
                0
            } else if *v > 255.0 {
                255
            } else {
                v.round() as u8
            };
            o += 1;
        }
    }
    out
}

/* ------------------------------------------------------------------ *
 * 像素级结构相似度（SSIM）—— 二阶段验证重排用
 * ------------------------------------------------------------------ */

const SSIM_C1: f64 = (0.01 * 255.0) * (0.01 * 255.0);
const SSIM_C2: f64 = (0.03 * 255.0) * (0.03 * 255.0);

/// 两幅图像素级相似度（0~1，SSIM）：重采样成 w×h 灰度后 8×8 滑窗。
pub fn ssim_similarity(a: &ImageDataLike, b: &ImageDataLike, w: usize, h: usize) -> f64 {
    let ga = to_gray(a, w, h).g;
    let gb = to_gray(b, w, h).g;
    let win = 8;
    let mut ssim_sum = 0f64;
    let mut win_count = 0usize;
    let mut wi = 0;
    while wi + win <= h {
        let mut wj = 0;
        while wj + win <= w {
            let mut ma = 0f64;
            let mut mb = 0f64;
            let mut y = wi;
            while y < wi + win {
                let row = y * w;
                let mut x = wj;
                while x < wj + win {
                    ma += ga[row + x] as f64;
                    mb += gb[row + x] as f64;
                    x += 1;
                }
                y += 1;
            }
            let n = win * win;
            ma /= n as f64;
            mb /= n as f64;
            let mut va = 0f64;
            let mut vb = 0f64;
            let mut cov = 0f64;
            let mut y = wi;
            while y < wi + win {
                let row = y * w;
                let mut x = wj;
                while x < wj + win {
                    let da = ga[row + x] as f64 - ma;
                    let db = gb[row + x] as f64 - mb;
                    va += da * da;
                    vb += db * db;
                    cov += da * db;
                    x += 1;
                }
                y += 1;
            }
            let nm1 = (n - 1) as f64;
            va /= nm1;
            vb /= nm1;
            cov /= nm1;
            let num = (2.0 * ma * mb + SSIM_C1) * (2.0 * cov + SSIM_C2);
            let den = (ma * ma + mb * mb + SSIM_C1) * (va + vb + SSIM_C2);
            ssim_sum += if den > 0.0 { num / den } else { 0.0 };
            win_count += 1;
            wj += win;
        }
        wi += win;
    }
    if win_count > 0 {
        (ssim_sum / win_count as f64).max(0.0)
    } else {
        0.0
    }
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/// 计算一帧/一张图的完整指纹。
pub fn compute_signature(img: &ImageDataLike) -> FrameSignature {
    let gray98 = to_gray(img, 9, 8);
    FrameSignature {
        dhash: compute_dhash(&gray98),
        struct_hash: compute_struct_hash(img),
        color: compute_color_histogram(img),
        spatial: compute_spatial_layout(img),
        luma: mean_luma(&gray98),
    }
}

/// 颜色权重上下界：结构分与颜色分加权时，颜色越鲜明权重越高。
pub const COLOR_WEIGHT_MIN: f64 = 0.3;
pub const COLOR_WEIGHT_MAX: f64 = 0.7;
/// 颜色分内部：空间布局相似度占比（直方图相交占 1 - 该值）。
pub const SPATIAL_WEIGHT: f64 = 0.35;

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一张 32×32 纯色像素缓冲（RGB 交错）。
    fn solid(color: [u8; 3]) -> Vec<u8> {
        let w = 32;
        let h = 32;
        let mut data = vec![0u8; w * h * 3];
        for px in data.chunks_mut(3) {
            px[0] = color[0];
            px[1] = color[1];
            px[2] = color[2];
        }
        data
    }

    /// 从像素缓冲派生出测试用 ImageDataLike 视图。
    fn view(data: &[u8]) -> ImageDataLike<'_> {
        ImageDataLike {
            width: 32,
            height: 32,
            channels: 3,
            order: ChannelOrder::Rgb,
            data,
        }
    }

    #[test]
    fn struct_self_similarity_is_one() {
        let data = solid([120, 60, 30]);
        let img = view(&data);
        let a = compute_struct_hash(&img);
        assert!((struct_similarity(&a, 0, &a, 0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn color_histogram_sums_to_one() {
        let data = solid([10, 200, 90]);
        let img = view(&data);
        let hist = compute_color_histogram(&img);
        let sum: f32 = hist.iter().sum();
        assert!((sum - 1.0).abs() < 1e-6);
        // 纯色只落一个桶
        let nonzero = hist.iter().filter(|v| **v > 0.0).count();
        assert_eq!(nonzero, 1);
    }

    #[test]
    fn dhash_deterministic() {
        let data = solid([200, 200, 200]);
        let img = view(&data);
        let g = to_gray(&img, 9, 8);
        let h1 = compute_dhash(&g);
        let h2 = compute_dhash(&g);
        assert_eq!(h1, h2);
    }
}
