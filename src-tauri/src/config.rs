//! JSON file persistence for connection profiles and app settings.

use std::fs;
use std::path::PathBuf;

use tauri::Manager;

fn config_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    // Whitelist the file names we persist.
    const ALLOWED: &[&str] = &["connections.json", "settings.json"];
    if !ALLOWED.contains(&name) {
        return Err(format!("config file not allowed: {name}"));
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create config dir: {e}"))?;
    Ok(dir.join(name))
}

#[tauri::command]
pub fn read_config(app: tauri::AppHandle, name: String) -> Result<serde_json::Value, String> {
    let path = config_file(&app, &name)?;
    match fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => {
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
        }
        _ => Ok(serde_json::Value::Null),
    }
}

#[tauri::command]
pub fn write_config(app: tauri::AppHandle, name: String, contents: serde_json::Value) -> Result<(), String> {
    let path = config_file(&app, &name)?;
    let text = serde_json::to_string_pretty(&contents).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("cannot write config: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("cannot replace config: {e}"))?;
    Ok(())
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    // Commands are registered in the main invoke handler (see lib.rs); this
    // plugin shim is kept only for potential future hooks.
    tauri::plugin::Builder::<tauri::Wry>::new("trdc-config").build()
}
