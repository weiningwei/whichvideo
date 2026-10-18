//! ffmpeg / ffprobe 定位与可定位播放器探测（镜像 Electron src/main/media.ts）。
//!
//! 仅含「探测」能力：工具路径解析、toolsReady、findSeekablePlayer。
//! 实际的抽帧/解码/探测命令由后续模块（M6 的 decodeFrameAt、M7 的 indexer）复用这里的 helpers。

use crate::sampling::should_use_full_scan;

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::ExtendedColorType;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

#[derive(Clone)]
#[allow(dead_code)]
pub struct ToolPaths {
    pub ffmpeg: String,
    pub ffprobe: String,
}

static TOOLS: OnceLock<Option<ToolPaths>> = OnceLock::new();

/// 读取一个注册表 REG_SZ 值；键不存在或类型不符返回 None。
#[cfg(windows)]
fn reg_query_string(key: &str, value_name: Option<&str>) -> Option<String> {
    let mut args = vec!["query".to_string(), key.to_string()];
    match value_name {
        Some(v) => {
            args.push("/v".to_string());
            args.push(v.to_string());
        }
        None => args.push("/ve".to_string()),
    }
    let out = std::process::Command::new("reg")
        .args(&args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let m = text.trim().lines().find_map(|line| {
        let m = line.trim().match_indices("REG_SZ").next()?;
        Some(line[m.0 + 6..].trim().to_string())
    })?;
    if m.is_empty() { None } else { Some(m) }
}

#[cfg(not(windows))]
fn reg_query_string(_key: &str, _value_name: Option<&str>) -> Option<String> {
    None
}

/// 在 PATH 中查找可执行文件（Windows 下尝试 .exe/.cmd/.bat 后缀）。
fn which(name: &str) -> Option<String> {
    let path_env = std::env::var("PATH").unwrap_or_default();
    let exts: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ".bat", ""]
    } else {
        &[""]
    };
    for dir in path_env.split(if cfg!(windows) { ';' } else { ':' }) {
        if dir.is_empty() {
            continue;
        }
        for ext in exts {
            let candidate = PathBuf::from(dir).join(format!("{}{}", name, ext));
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// 候选目录：打包资源目录 resources/bin、环境变量、常见安装位置。
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(bin_dir) = std::env::var("WHICHVIDEO_BIN_DIR").ok() {
        dirs.push(PathBuf::from(bin_dir));
    }
    // 资源目录：exe 同级 resources/bin（Tauri 打包后）；开发态沿祖先向上找仓库 resources/bin。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for ancestor in parent.ancestors().take(5) {
                dirs.push(ancestor.join("resources").join("bin"));
            }
        }
    }
    if cfg!(windows) {
        dirs.push(PathBuf::from("C:\\ffmpeg\\bin"));
        dirs.push(PathBuf::from("C:\\Program Files\\ffmpeg\\bin"));
        if let Some(local) = std::env::var("LOCALAPPDATA").ok() {
            dirs.push(PathBuf::from(local).join("Microsoft\\WinGet\\Links"));
        }
        if let Some(user) = std::env::var("USERPROFILE").ok() {
            dirs.push(PathBuf::from(user).join("scoop\\shims"));
        }
        if let Some(programdata) = std::env::var("ProgramData").ok() {
            dirs.push(PathBuf::from(programdata).join("chocolatey\\bin"));
        }
    }
    dirs
}

/// 解析 ffmpeg / ffprobe 路径；结果缓存（与 Electron 行为一致）。
pub fn resolve_tools() -> Option<&'static ToolPaths> {
    TOOLS
        .get_or_init(|| {
            let names = if cfg!(windows) {
                ("ffmpeg.exe", "ffprobe.exe")
            } else {
                ("ffmpeg", "ffprobe")
            };
            let dirs = candidate_dirs();
            let mut ffmpeg: Option<String> = std::env::var("WHICHVIDEO_FFMPEG")
                .ok()
                .filter(|p| PathBuf::from(p).exists());
            let mut ffprobe: Option<String> = std::env::var("WHICHVIDEO_FFPROBE")
                .ok()
                .filter(|p| PathBuf::from(p).exists());

            for dir in &dirs {
                if ffmpeg.is_none() {
                    let c = dir.join(names.0);
                    if c.exists() {
                        ffmpeg = Some(c.to_string_lossy().to_string());
                    }
                }
                if ffprobe.is_none() {
                    let c = dir.join(names.1);
                    if c.exists() {
                        ffprobe = Some(c.to_string_lossy().to_string());
                    }
                }
            }
            if ffmpeg.is_none() {
                ffmpeg = which(names.0);
            }
            if ffprobe.is_none() {
                ffprobe = which(names.1);
            }
            match (ffmpeg, ffprobe) {
                (Some(f), Some(p)) => Some(ToolPaths {
                    ffmpeg: f,
                    ffprobe: p,
                }),
                _ => None,
            }
        })
        .as_ref()
}

/// ffmpeg/ffprobe 是否可用。
pub fn tools_ready() -> bool {
    resolve_tools().is_some()
}

/// 支持「从指定时间点起播」的播放器。
#[allow(dead_code)]
pub struct SeekablePlayer {
    pub exe: String,
    pub name: String,
    pub args: fn(video_path: &str, start_seconds: f64) -> Vec<String>,
}

fn known_seekable() -> &'static [(&'static str, &'static str, fn(&str, f64) -> Vec<String>)] {
    &[
        (
            "mpv.exe",
            "mpv",
            |p: &str, s: f64| vec!["--start=".to_string() + &s.floor().to_string(), p.to_string()],
        ),
        (
            "potplayermini64.exe",
            "PotPlayer",
            |p: &str, s: f64| vec![p.to_string(), "/new".to_string(), "/seek=".to_string() + &s.floor().to_string()],
        ),
        (
            "potplayermini.exe",
            "PotPlayer",
            |p: &str, s: f64| vec![p.to_string(), "/new".to_string(), "/seek=".to_string() + &s.floor().to_string()],
        ),
        (
            "vlc.exe",
            "VLC",
            |p: &str, s: f64| vec!["--start-time=".to_string() + &s.floor().to_string(), p.to_string()],
        ),
    ]
}

fn basename(path: &str) -> String {
    let p = path.replace('\\', "/");
    p.rsplit('/').next().unwrap_or(path).to_lowercase()
}

/// 从文件关联命令模板解析 exe 路径（拒绝含未展开环境变量的模板）。
#[cfg(windows)]
fn exe_from_command_template(cmd: &str) -> Option<String> {
    let without_placeholders = cmd.replace("%1", "").replace("%*", "");
    // 仍含 % 说明存在未展开的环境变量（如 %SystemRoot%），放弃。
    if without_placeholders.contains('%') {
        return None;
    }
    let quoted = cmd.trim().strip_prefix('"').and_then(|rest| {
        let end = rest.find('"')?;
        Some(rest[..end].to_string())
    });
    let exe = quoted.unwrap_or_else(|| cmd.trim().split_whitespace().next().unwrap_or("").to_string());
    if exe.to_lowercase().ends_with(".exe") {
        Some(exe)
    } else {
        None
    }
}

/// 读系统对某扩展名的默认打开方式，命中受支持播放器则复用。
#[cfg(windows)]
fn player_from_default_association(video_ext: &str) -> Option<SeekablePlayer> {
    let ext = video_ext.trim_start_matches('.').to_lowercase();
    if ext.is_empty() {
        return None;
    }
    let prog_id = reg_query_string(
        &format!(
            "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.{}\\UserChoice",
            ext
        ),
        Some("ProgId"),
    )
    .or_else(|| reg_query_string(&format!("HKCR\\.{}", ext), None))?;
    let cmd = reg_query_string(&format!("HKCR\\{}\\shell\\open\\command", prog_id), None)?;
    let exe = exe_from_command_template(&cmd)?;
    let known = known_seekable()
        .iter()
        .find(|(name, _, _)| *name == basename(&exe))?;
    Some(SeekablePlayer {
        exe,
        name: known.1.to_string(),
        args: known.2,
    })
}

fn pick_existing(candidates: &[&str]) -> Option<String> {
    for c in candidates {
        if !c.is_empty() && PathBuf::from(c).exists() {
            return Some(c.to_string());
        }
    }
    None
}

fn find_potplayer_from_registry() -> Option<String> {
    let keys = [
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer64bit",
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer64bit",
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer",
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer",
        "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer",
    ];
    for key in keys {
        for value in ["DisplayIcon", "InstallLocation"] {
            let out = std::process::Command::new("reg")
                .args(["query", key, "/v", value])
                .output()
                .ok()?;
            if !out.status.success() {
                continue;
            }
            let text = String::from_utf8_lossy(&out.stdout);
            let m = text.lines().find_map(|line| {
                let idx = line.trim().find("REG_SZ")?;
                Some(line.trim()[idx + 6..].trim().to_string())
            })?;
            let mut p = m;
            if value == "DisplayIcon" {
                // DisplayIcon 形如 "...PotPlayerMini64.exe,0"
                p = p.replace(",0", "");
            } else {
                p = PathBuf::from(&p)
                    .join("PotPlayerMini64.exe")
                    .to_string_lossy()
                    .to_string();
            }
            if PathBuf::from(&p).exists() {
                return Some(p);
            }
            let alt32 = p.replace("PotPlayerMini64.exe", "PotPlayerMini.exe");
            if PathBuf::from(&alt32).exists() {
                return Some(alt32);
            }
        }
    }
    None
}

/// 找一个支持时间点起播的本地播放器：默认关联 > PATH > 常见安装位置。
/// 都找不到返回 None（调用方退化为系统默认播放器）。
pub fn find_seekable_player(video_path: &str) -> Option<SeekablePlayer> {
    let ext = video_path
        .rsplit('.')
        .next()
        .map(|e| format!(".{}", e))
        .unwrap_or_default();

    #[cfg(windows)]
    {
        if let Some(p) = player_from_default_association(&ext) {
            return Some(p);
        }
    }

    if let Some(mpv) =
        which("mpv").or(pick_existing(&["C:\\Program Files\\mpv\\mpv.exe", "C:\\Program Files (x86)\\mpv\\mpv.exe"]))
    {
        return Some(SeekablePlayer {
            exe: mpv,
            name: "mpv".to_string(),
            args: known_seekable()[0].2,
        });
    }

    let potplayer = pick_existing(&[
        "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe",
        "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini.exe",
        "C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe",
    ])
    .or_else(find_potplayer_from_registry);
    if let Some(p) = potplayer {
        return Some(SeekablePlayer {
            exe: p,
            name: "PotPlayer".to_string(),
            args: known_seekable()[1].2,
        });
    }

    if let Some(vlc) = which("vlc").or(pick_existing(&[
        "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
        "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe",
    ])) {
        return Some(SeekablePlayer {
            exe: vlc,
            name: "VLC".to_string(),
            args: known_seekable()[3].2,
        });
    }

    None
}

/**
 * 解码单个时间点的一帧（RGB24 裸像素），转 JPEG dataUrl 返回。
 * 用于搜索结果命中帧预览 / 查看索引帧弹层。失败（文件已删/时间点越界/解码错误）
 * 返回 None，调用方回退到缩略图。逻辑镜像 Electron media.decodeFrameAt + rgb24ToJpegDataUrl。
 *
 * ffmpeg 用 `-ss` 前置快速定位 + `-frames:v 1` 取一帧，scale 到 EXTRACT_WIDTH 宽、
 * h=-2 偶数高，输出 rawvideo（rgb24）。rawvideo 无头，高度由字节数反推：
 * height = len / (width*3)，整除校验保证未缺字节。
 */
#[allow(dead_code)]
pub fn decode_frame_at(file_path: &str, time_ms: i64, width: u32) -> Option<String> {
    let tools = resolve_tools()?;
    let secs = (time_ms as f64 / 1000.0).max(0.0);
    let args = [
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-ss",
        &format!("{:.3}", secs),
        "-i",
        file_path,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        &format!("scale={}:-2", width),
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "-an",
        "-sn",
        "-dn",
        "pipe:1",
    ];
    let out = Command::new(&tools.ffmpeg).args(&args).output().ok()?;
    if !out.status.success() || out.stdout.is_empty() {
        return None;
    }
    let w = width as usize;
    if out.stdout.len() % (w * 3) != 0 {
        return None;
    }
    let h = out.stdout.len() / (w * 3);
    if h == 0 {
        return None;
    }
    let mut buf = Vec::new();
    let mut enc = JpegEncoder::new_with_quality(&mut buf, 80);
    enc.encode(&out.stdout, width, h as u32, ExtendedColorType::Rgb8).ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&buf)
    ))
}

/* ================================================================== */
/* 索引器所需的探测 / 抽帧 / 哈希能力（镜像 Electron src/main/media.ts） */
/* ================================================================== */

/// ffmpeg 单次调用的同步结果。
pub struct FfmpegOutput {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// 同步跑一次 ffmpeg，收集 stdout / stderr。失败（进程无法启动）返回 Err。
pub fn run_ffmpeg(args: &[String]) -> Result<FfmpegOutput, String> {
    let tools = resolve_tools().ok_or_else(|| "未找到 ffmpeg".to_string())?;
    let out = Command::new(&tools.ffmpeg)
        .args(args)
        .output()
        .map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;
    Ok(FfmpegOutput {
        success: out.status.success(),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

/// 同步跑一次 ffprobe。
pub fn run_ffprobe(args: &[String]) -> Result<FfmpegOutput, String> {
    let tools = resolve_tools().ok_or_else(|| "未找到 ffprobe".to_string())?;
    let out = Command::new(&tools.ffprobe)
        .args(args)
        .output()
        .map_err(|e| format!("启动 ffprobe 失败：{e}"))?;
    Ok(FfmpegOutput {
        success: out.status.success(),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

/// 探测到的视频基础信息（镜像 VideoProbeInfo）。
#[derive(Clone, Debug, Default)]
pub struct VideoProbeInfo {
    pub duration: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub video_codec: Option<String>,
}

/// 用 ffprobe 解析视频时长/分辨率/编码。镜像 probeVideo。
pub fn probe_video(file_path: &str) -> Result<VideoProbeInfo, String> {
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-print_format".to_string(),
        "json".to_string(),
        "-show_format".to_string(),
        "-show_streams".to_string(),
        "-select_streams".to_string(),
        "v:0".to_string(),
        file_path.to_string(),
    ];
    let out = run_ffprobe(&args)?;
    if !out.success {
        return Err(format!("ffprobe 失败：{}", out.stderr.trim()));
    }
    let parsed: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("ffprobe 输出无法解析：{e}"))?;
    let stream = parsed.get("streams").and_then(|s| s.get(0));
    let duration_raw = stream
        .and_then(|s| s.get("duration").and_then(|d| d.as_str()))
        .or_else(|| {
            parsed
                .get("format")
                .and_then(|f| f.get("duration"))
                .and_then(|d| d.as_str())
        });
    let duration = duration_raw
        .and_then(|d| d.parse::<f64>().ok())
        .filter(|d| d.is_finite());
    let width = stream.and_then(|s| s.get("width").and_then(|w| w.as_i64()));
    let height = stream.and_then(|s| s.get("height").and_then(|h| h.as_i64()));
    let codec = stream
        .and_then(|s| s.get("codec_name").and_then(|c| c.as_str()))
        .map(|c| c.to_string());
    Ok(VideoProbeInfo {
        duration,
        width,
        height,
        video_codec: codec,
    })
}

/// 抽帧后的一帧原始像素（RGB24）。
pub struct RawFrame {
    pub time: f64,
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

/// 检测场景切换时间点（秒，升序）。镜像 detectScenes。
///
/// 关键结构：split 两路 + nullsink。
///   [d] select(场景点) + showinfo → nullsink  ← 只命中场景切换的帧
///   [p] 全帧 + showinfo → null muxer            ← 进度用（每帧一行）
/// 这里只取 [d] 路（Parsed_showinfo_0）的 pts_time 作为场景点；[p] 路每帧都报，
/// 若一并收集会被当成"每 0.5s 一个场景"，彻底破坏场景采样语义。
pub fn detect_scenes(file_path: &str, threshold: f64) -> Result<Vec<f64>, String> {
    let args = vec![
        "-hide_banner".to_string(),
        "-v".to_string(),
        "info".to_string(),
        "-nostdin".to_string(),
        "-hwaccel".to_string(),
        "auto".to_string(),
        "-i".to_string(),
        file_path.to_string(),
        "-filter_complex".to_string(),
        format!(
            "[0:v]split=2[d][p];[d]scale=w=160:h=-2,select='gt(scene,{})',showinfo,nullsink;[p]scale=w=160:h=-2,showinfo[prog]",
            threshold
        ),
        "-map".to_string(),
        "[prog]".to_string(),
        "-an".to_string(),
        "-sn".to_string(),
        "-dn".to_string(),
        "-f".to_string(),
        "null".to_string(),
        "-".to_string(),
    ];
    let out = run_ffmpeg(&args)?;
    if !out.success {
        return Err(format!(
            "场景检测失败（退出码非 0）：{}",
            out.stderr.trim().chars().take(200).collect::<String>()
        ));
    }
    let mut times: Vec<f64> = Vec::new();
    for line in out.stderr.lines() {
        // 只取场景选择那一路（实例 0）的 showinfo 行
        if !line.contains("[Parsed_showinfo_0 @") || !line.contains("pts_time:") {
            continue;
        }
        if let Some(m) = line.split("pts_time:").nth(1) {
            if let Some(v) = m
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<f64>().ok())
            {
                if v.is_finite() {
                    times.push(v);
                }
            }
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Ok(times)
}

/**
 * 抽帧路径 A：逐点 seek。每个时间点一个 `-ss/-i` 输入，各取第一帧后 concat 成单流
 * 输出（帧序由滤镜图拓扑保证，对齐计划时间点）。镜像 scan.ts::extractAndHashBySeek。
 * 旧 ffmpeg 无 `-fps_mode` 时回退到 concat 后接 setpts（保持 passthrough 语义）。
 */
fn extract_frames_seek(
    file_path: &str,
    timestamps: &[f64],
    width: u32,
) -> Result<Vec<RawFrame>, String> {
    let count = timestamps.len();
    if count == 0 {
        return Ok(Vec::new());
    }
    let w = width;
    let mut inputs: Vec<String> = Vec::with_capacity(count * 4);
    let mut parts: Vec<String> = Vec::with_capacity(count + 1);
    let mut labels: Vec<String> = Vec::with_capacity(count);
    for i in 0..count {
        inputs.push("-hwaccel".to_string());
        inputs.push("auto".to_string());
        inputs.push("-ss".to_string());
        inputs.push(format!("{:.3}", timestamps[i]));
        inputs.push("-i".to_string());
        inputs.push(file_path.to_string());
        parts.push(format!("[{}:v]trim=end_frame=1,scale=w={}:h=-2:flags=fast_bilinear[s{}]", i, w, i));
        labels.push(format!("[s{}]", i));
    }
    parts.push(format!("{}concat=n={}:v=1:a=0[out]", labels.join(""), count));
    let filter = parts.join(";");

    let mut args: Vec<String> = vec![
        "-hide_banner".to_string(),
        "-v".to_string(),
        "info".to_string(),
        "-nostdin".to_string(),
    ];
    args.append(&mut inputs);
    args.push("-filter_complex".to_string());
    args.push(filter.clone());
    args.push("-map".to_string());
    args.push("[out]".to_string());
    args.push("-fps_mode".to_string());
    args.push("passthrough".to_string());
    args.push("-pix_fmt".to_string());
    args.push("rgb24".to_string());
    args.push("-f".to_string());
    args.push("rawvideo".to_string());
    args.push("-an".to_string());
    args.push("-sn".to_string());
    args.push("-dn".to_string());
    args.push("pipe:1".to_string());

    let mut out = run_ffmpeg(&args)?;
    // 旧 ffmpeg 回退：去掉 -fps_mode，concat 后接 setpts 重排成单调帧号网格。
    if !out.success {
        let mut retry = args[..args.iter().position(|a| a == "-filter_complex").unwrap()].to_vec();
        let mut fb = parts.clone();
        let last = fb.len() - 1;
        fb[last] = format!(
            "{}concat=n={}:v=1:a=0,setpts=N/FRAME_RATE/TB[out]",
            labels.join(""),
            count
        );
        retry.push("-filter_complex".to_string());
        retry.push(fb.join(";"));
        retry.push("-map".to_string());
        retry.push("[out]".to_string());
        retry.push("-pix_fmt".to_string());
        retry.push("rgb24".to_string());
        retry.push("-f".to_string());
        retry.push("rawvideo".to_string());
        retry.push("-an".to_string());
        retry.push("-sn".to_string());
        retry.push("-dn".to_string());
        retry.push("pipe:1".to_string());
        out = run_ffmpeg(&retry)?;
    }
    if out.stdout.is_empty() {
        return Err(format!("抽帧失败：{}", out.stderr.trim()));
    }

    let row_bytes = (w as usize) * 3;
    if out.stdout.len() % count != 0 {
        return Err(format!(
            "抽帧失败：收到 {} 字节，无法均分为 {} 帧",
            out.stdout.len(),
            count
        ));
    }
    let frame_size = out.stdout.len() / count;
    if frame_size == 0 || frame_size % row_bytes != 0 {
        return Err(format!(
            "抽帧失败：单帧 {frame_size} 字节不是 {w} 宽 RGB24 的整数倍"
        ));
    }
    let height = frame_size / row_bytes;

    let mut frames = Vec::with_capacity(count);
    for i in 0..count {
        let start = i * frame_size;
        let end = start + frame_size;
        let rgb = out.stdout[start..end].to_vec();
        frames.push(RawFrame {
            time: timestamps[i],
            width: w,
            height: height as u32,
            rgb,
        });
    }
    Ok(frames)
}

/**
 * 抽帧路径 B：单次全片解码 + `fps=N/时长` 均匀采样，成本与帧数无关。
 * 镜像 media.ts::extractFrames：用 showinfo 拿真实输出帧的 w/h 与 pts_time。
 */
fn extract_frames_full_scan(
    file_path: &str,
    timestamps: &[f64],
    duration: Option<f64>,
    width: u32,
) -> Result<Vec<RawFrame>, String> {
    let count = timestamps.len();
    if count == 0 {
        return Ok(Vec::new());
    }
    let dur = duration.unwrap_or_else(|| timestamps[count - 1] * 2.0).max(0.001);
    let rate = count as f64 / dur;
    let args = vec![
        "-hide_banner".to_string(),
        "-v".to_string(),
        "info".to_string(),
        "-nostdin".to_string(),
        "-hwaccel".to_string(),
        "auto".to_string(),
        "-i".to_string(),
        file_path.to_string(),
        "-vf".to_string(),
        format!("fps={:.8},scale=w='min({},{})':h=-2,showinfo", rate, width, width),
        "-frames:v".to_string(),
        count.to_string(),
        "-pix_fmt".to_string(),
        "rgb24".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-an".to_string(),
        "-sn".to_string(),
        "-dn".to_string(),
        "pipe:1".to_string(),
    ];
    let out = run_ffmpeg(&args)?;
    if !out.success && out.stdout.is_empty() {
        return Err(format!("ffmpeg 抽帧失败：{}", out.stderr.trim()));
    }

    // showinfo 行形如：... pts_time:277 ... w:320 h:180 ...（真实输出帧顺序）
    let mut real_times: Vec<f64> = Vec::new();
    let mut last_w = 0u32;
    let mut last_h = 0u32;
    for line in out.stderr.lines() {
        if line.contains("pts_time:") {
            if let Some(m) = line.split("pts_time:").nth(1) {
                if let Some(v) = m.split_whitespace().next().and_then(|s| s.parse::<f64>().ok()) {
                    if v.is_finite() {
                        real_times.push(v);
                    }
                }
            }
        }
        if let Some(m) = line.split(" w:").nth(1) {
            if let Some(rest) = m.split(' ').next() {
                if let Some(h) = m.split(" h:").nth(1).and_then(|s| s.split(' ').next()) {
                    if let (Ok(w), Ok(hh)) = (rest.parse::<u32>(), h.parse::<u32>()) {
                        last_w = w;
                        last_h = hh;
                    }
                }
            }
        }
    }

    let (mut width, mut height) = (last_w, last_h);
    if width == 0 || height == 0 {
        // 回退：所有帧尺寸一致，按 stdout 总字节数反推宽度（上限已知）。
        let total = out.stdout.len();
        let w0 = (width as usize).max(2);
        let mut found = false;
        for w in (2..=w0).rev().step_by(2) {
            let pixels_per_frame = total / 3 / count;
            let h = pixels_per_frame / w;
            let hh = (h / 2) * 2;
            if hh > 0 && w * hh * 3 * count == total {
                width = w as u32;
                height = hh as u32;
                found = true;
                break;
            }
        }
        if !found {
            return Ok(Vec::new());
        }
    }

    let frame_size = (width as usize) * (height as usize) * 3;
    if frame_size == 0 {
        return Ok(Vec::new());
    }
    let available = (out.stdout.len() / frame_size).min(count);
    let mut frames = Vec::with_capacity(available);
    for i in 0..available {
        let start = i * frame_size;
        let end = start + frame_size;
        let rgb = out.stdout[start..end].to_vec();
        let time = real_times.get(i).copied().unwrap_or(timestamps[i]);
        frames.push(RawFrame {
            time,
            width,
            height,
            rgb,
        });
    }
    Ok(frames)
}

/// 按帧数 / 时间点选择抽帧路径并抽取，返回带时间点的 RGB24 帧。
pub fn extract_and_hash_frames(
    file_path: &str,
    timestamps: &[f64],
    duration: Option<f64>,
    width: Option<i64>,
    height: Option<i64>,
    force_seek: bool,
) -> Result<Vec<RawFrame>, String> {
    if force_seek || !should_use_full_scan(timestamps.len(), width, height) {
        extract_frames_seek(file_path, timestamps, crate::constants::EXTRACT_WIDTH)
    } else {
        extract_frames_full_scan(file_path, timestamps, duration, crate::constants::EXTRACT_WIDTH)
    }
}

/// 生成缩略图（mjpeg 字节），失败时返回 None。time_seconds 为视频内位置。
pub fn make_thumbnail(file_path: &str, time_seconds: f64, width: u32) -> Option<Vec<u8>> {
    let args = vec![
        "-hide_banner".to_string(),
        "-v".to_string(),
        "error".to_string(),
        "-nostdin".to_string(),
        "-ss".to_string(),
        format!("{:.3}", time_seconds.max(0.0)),
        "-i".to_string(),
        file_path.to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        format!("scale={}:-2", width),
        "-q:v".to_string(),
        "6".to_string(),
        "-f".to_string(),
        "image2".to_string(),
        "-c:v".to_string(),
        "mjpeg".to_string(),
        "pipe:1".to_string(),
    ];
    let out = run_ffmpeg(&args).ok()?;
    if out.success && !out.stdout.is_empty() {
        Some(out.stdout)
    } else {
        None
    }
}

/// 文件 SHA-256（流式分块读取，大文件不全量进内存）。镜像 sha256OfFile。
pub fn sha256_of_file(file_path: &str) -> Result<String, String> {
    use std::fs::File;
    use std::io::BufReader;
    let file = File::open(file_path).map_err(|e| format!("打开文件失败：{e}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 4 * 1024 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("读取文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(format!("{:x}", digest))
}
