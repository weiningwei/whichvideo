//! 可选的索引帧 JPEG 存储：<dataDir>/frames/<videoId>/<timeMs>.jpg。

use crate::{logger, paths};
use image::codecs::jpeg::JpegEncoder;
use image::ExtendedColorType;
use std::fs;
use std::path::PathBuf;

fn video_dir(video_id: i64) -> PathBuf {
    paths::video_frames_dir(video_id)
}

pub fn encode_jpeg(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    if rgb.len() != width as usize * height as usize * 3 {
        return Err(format!(
            "rgb 长度 {} != {}x{}x3",
            rgb.len(), width, height
        ));
    }
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 85)
        .encode(rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|e| format!("JPEG 编码失败：{e}"))?;
    Ok(bytes)
}

pub fn save(video_id: i64, time_ms: i64, rgb: &[u8], width: u32, height: u32) -> bool {
    let result = (|| -> Result<(), String> {
        let dir = video_dir(video_id);
        fs::create_dir_all(&dir).map_err(|e| format!("创建帧图目录失败：{e}"))?;
        let bytes = encode_jpeg(rgb, width, height)?;
        fs::write(dir.join(format!("{time_ms}.jpg")), bytes)
            .map_err(|e| format!("写入帧图失败：{e}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        logger::log(&format!(
            "[WARN] 保存帧图失败：video={video_id} timeMs={time_ms}：{error}"
        ));
        return false;
    }
    true
}

pub fn remove_video(video_id: i64) {
    let dir = video_dir(video_id);
    if dir.exists() {
        if let Err(error) = fs::remove_dir_all(&dir) {
            logger::log(&format!("[WARN] 删除帧图目录失败：{}：{error}", dir.display()));
        }
    }
}

pub fn remove_all() -> bool {
    let dir = paths::frames_dir();
    if !dir.exists() {
        return false;
    }
    match fs::remove_dir_all(&dir) {
        Ok(()) => true,
        Err(error) => {
            logger::log(&format!("[WARN] 清空帧图目录失败：{}：{error}", dir.display()));
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jpeg_encoder_rejects_bad_rgb_and_writes_jpeg_signature() {
        assert!(encode_jpeg(&[0; 5], 2, 1).is_err());
        let encoded = encode_jpeg(&[255, 0, 0, 0, 255, 0], 2, 1).unwrap();
        assert_eq!(&encoded[..2], &[0xff, 0xd8]);
        assert_eq!(&encoded[encoded.len() - 2..], &[0xff, 0xd9]);
    }
}
