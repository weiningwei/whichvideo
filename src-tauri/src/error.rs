//! IPC failures are serialized and logged once at the command boundary.
//! Domain modules retain their native errors; recovery stays with the caller.
#[derive(Debug, serde::Serialize)]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
    pub operation: &'static str,
}

pub fn command_result<T>(operation: &'static str, result: Result<T, String>) -> Result<T, AppError> {
    result.map_err(|message| {
        let message = if message.trim().is_empty() { "操作失败，请重试".into() } else { message };
        crate::logger::error(command_module(operation), "command_failed", &format!("operation={operation} error={message}"));
        // Do not infer categories from localized error text.
        AppError { code: "internal", message, operation }
    })
}

fn command_module(operation: &str) -> crate::logger::Module {
    use crate::logger::Module;
    if operation.starts_with("search_") { Module::Search }
    else if operation.starts_with("videos_import") || operation.starts_with("folders_add") || operation == "folders_rescan" { Module::Import }
    else if operation.starts_with("videos_reindex") { Module::Indexer }
    else if operation.contains("media_tools") || operation.contains("ffmpeg") { Module::Media }
    else if operation.starts_with("watcher_") || operation.starts_with("folders_set_enabled") { Module::Watcher }
    else { Module::Library }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_failure_has_stable_wire_shape() {
        let error = command_result::<()>("videos_list", Err("读取失败".into())).unwrap_err();
        let json = serde_json::to_value(error).unwrap();
        assert_eq!(json, serde_json::json!({"code":"internal", "message":"读取失败", "operation":"videos_list"}));
        assert_eq!(command_result("videos_list", Ok(42)).unwrap(), 42);
        assert!(!command_result::<()>("videos_list", Err(" ".into())).unwrap_err().message.trim().is_empty());
        assert_eq!(command_module("search_url"), crate::logger::Module::Search);
        assert_eq!(command_module("videos_import_paths"), crate::logger::Module::Import);
        assert_eq!(command_module("library_select_media_tools_dir"), crate::logger::Module::Media);
        assert_eq!(command_module("videos_list"), crate::logger::Module::Library);
    }
}
