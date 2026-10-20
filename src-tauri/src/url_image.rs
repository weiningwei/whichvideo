//! Cross-platform, bounded URL image fetch for explicitly requested searches.

use crate::constants::{
    URL_FETCH_TIMEOUT, URL_MAX_HTML_BYTES, URL_MAX_IMAGE_BYTES, URL_MAX_REDIRECTS,
};
use regex::Regex;
use reqwest::blocking::Client;
use reqwest::header::CONTENT_TYPE;
use std::io::Read;
use url::Url;

type FetchError = (String, String);

fn error(code: &str, message: impl Into<String>) -> FetchError {
    (code.to_string(), message.into())
}

fn http_url(input: &str) -> Result<Url, FetchError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(error("invalid-input", "请输入图片链接"));
    }
    let url = Url::parse(input).map_err(|_| error("invalid-input", "图片链接格式无效"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(error(
            "unsupported-protocol",
            "只支持 http / https 开头的链接",
        ));
    }
    Ok(url)
}

fn image_link(html: &str, base: &Url) -> Option<Url> {
    let tag = Regex::new(r"(?is)<(?:meta|img)\b[^>]*>").ok()?;
    let attr = Regex::new(r#"(?is)([\w:-]+)\s*=\s*["']([^"']*)["']"#).ok()?;
    let mut first_img = None;
    for item in tag.find_iter(html) {
        let raw = item.as_str();
        let mut attrs = std::collections::HashMap::new();
        for match_ in attr.captures_iter(raw) {
            attrs.insert(match_[1].to_ascii_lowercase(), match_[2].to_string());
        }
        let target = if raw[..4].eq_ignore_ascii_case("<img") {
            attrs.get("src").or_else(|| attrs.get("data-src"))
        } else if matches!(
            attrs
                .get("property")
                .or_else(|| attrs.get("name"))
                .map(String::as_str),
            Some("og:image" | "twitter:image" | "image_src")
        ) {
            attrs.get("content")
        } else {
            None
        };
        if let Some(value) = target {
            let candidate = value.replace("&amp;", "&");
            if let Ok(url) = base.join(&candidate) {
                if matches!(url.scheme(), "http" | "https") {
                    if raw[..4].eq_ignore_ascii_case("<img") {
                        first_img.get_or_insert(url);
                    } else {
                        return Some(url);
                    }
                }
            }
        }
    }
    first_img
}

fn read_limited(response: impl Read, limit: usize) -> Result<Vec<u8>, FetchError> {
    let mut bytes = Vec::new();
    response
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| error("network", format!("读取链接内容失败：{e}")))?;
    if bytes.len() > limit {
        return Err(error("too-large", "图片或网页超过大小上限"));
    }
    Ok(bytes)
}

pub fn fetch(input: &str) -> Result<(Vec<u8>, String), FetchError> {
    let url = http_url(input)?;
    let client = Client::builder()
        .timeout(URL_FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(URL_MAX_REDIRECTS))
        .user_agent("WhichVideo/0.1 (local image search)")
        .build()
        .map_err(|e| error("network", e.to_string()))?;
    let response = client
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|e| error("network", format!("无法访问图片链接：{e}")))?;
    let final_url = response.url().clone();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.starts_with("image/") {
        return Ok((
            read_limited(response, URL_MAX_IMAGE_BYTES)?,
            final_url.to_string(),
        ));
    }
    let html = String::from_utf8_lossy(&read_limited(response, URL_MAX_HTML_BYTES)?).to_string();
    let image_url =
        image_link(&html, &final_url).ok_or_else(|| error("no-image", "网页里没找到图片"))?;
    let image = client
        .get(image_url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|e| error("network", format!("无法下载网页中的图片：{e}")))?;
    let final_image_url = image.url().to_string();
    Ok((read_limited(image, URL_MAX_IMAGE_BYTES)?, final_image_url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_web_schemes() {
        assert_eq!(http_url(" ").unwrap_err().0, "invalid-input");
        assert_eq!(
            http_url("file:///secret").unwrap_err().0,
            "unsupported-protocol"
        );
    }

    #[test]
    fn resolves_relative_og_image_even_when_attributes_are_reordered() {
        let base = Url::parse("https://example.org/articles/1").unwrap();
        assert_eq!(
            image_link(
                "<img src='fallback.png'><meta content='../poster.jpg' property='og:image'>",
                &base
            )
            .unwrap()
            .as_str(),
            "https://example.org/poster.jpg"
        );
    }
}
