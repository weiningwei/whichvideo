//! 可选的索引帧 JPEG 存储：<dataDir>/frames/<videoId>/<timeMs>.jpg。

use crate::{logger, paths};
use image::codecs::jpeg::JpegEncoder;
use image::ExtendedColorType;
use std::fs;
use std::path::PathBuf;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

#[derive(Clone, Copy)]
pub struct FrameWriteToken {
    video_id: i64,
    generation: u64,
}

#[derive(Default)]
struct WriteState {
    next_generation: u64,
    enabled: bool,
    active: HashMap<i64, u64>,
}

static WRITE_STATE: LazyLock<Mutex<WriteState>> = LazyLock::new(|| Mutex::new(WriteState::default()));

/// 每个索引任务取得独立写入代次。删除视频、清库或关闭帧图保存会撤销代次，
/// 使任务早先读取的设置无法在清理完成后重新创建目录。
pub fn configure_enabled(enabled: bool) {
    let mut state = WRITE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.enabled = enabled;
    if !enabled {
        state.active.clear();
    }
}

pub fn begin_video_write(video_id: i64) -> Option<FrameWriteToken> {
    let mut state = WRITE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !state.enabled {
        return None;
    }
    state.next_generation = state.next_generation.wrapping_add(1).max(1);
    let generation = state.next_generation;
    state.active.insert(video_id, generation);
    Some(FrameWriteToken { video_id, generation })
}

fn token_is_current(state: &WriteState, token: FrameWriteToken) -> bool {
    state.active.get(&token.video_id) == Some(&token.generation)
}

fn revoke_video(state: &mut WriteState, video_id: i64) {
    state.active.remove(&video_id);
}

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

pub fn save(token: FrameWriteToken, time_ms: i64, rgb: &[u8], width: u32, height: u32) -> bool {
    // JPEG 编码不接触磁盘，放在锁外；编码结束后再次核对代次。
    let bytes = match encode_jpeg(rgb, width, height) {
        Ok(bytes) => bytes,
        Err(error) => {
            logger::log(&format!("[WARN] 保存帧图失败：video={} timeMs={time_ms}：{error}", token.video_id));
            return false;
        }
    };
    let state = WRITE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !token_is_current(&state, token) {
        return false;
    }
    let result = (|| -> Result<(), String> {
        let dir = video_dir(token.video_id);
        fs::create_dir_all(&dir).map_err(|e| format!("创建帧图目录失败：{e}"))?;
        fs::write(dir.join(format!("{time_ms}.jpg")), bytes)
            .map_err(|e| format!("写入帧图失败：{e}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        logger::log(&format!(
            "[WARN] 保存帧图失败：video={} timeMs={time_ms}：{error}", token.video_id
        ));
        return false;
    }
    true
}

pub fn remove_video(video_id: i64) {
    let mut state = WRITE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    revoke_video(&mut state, video_id);
    let dir = video_dir(video_id);
    if dir.exists() {
        if let Err(error) = fs::remove_dir_all(&dir) {
            logger::log(&format!("[WARN] 删除帧图目录失败：{}：{error}", dir.display()));
        }
    }
}

pub fn remove_all() -> bool {
    let mut state = WRITE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.active.clear();
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

    #[test]
    fn cleanup_revokes_stale_frame_writers() {
        let video_id = i64::MAX - 17;
        configure_enabled(true);
        let old = begin_video_write(video_id).unwrap();
        {
            let state = WRITE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(token_is_current(&state, old));
        }
        {
            let mut state = WRITE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            revoke_video(&mut state, video_id);
            assert!(!token_is_current(&state, old));
        }
        let replacement = begin_video_write(video_id).unwrap();
        let state = WRITE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(!token_is_current(&state, old));
        assert!(token_is_current(&state, replacement));
        drop(state);
        configure_enabled(false);
        assert!(begin_video_write(video_id).is_none());
    }
}
