mod ai_proxy;
mod bridge;
mod config;
mod rdp;

use std::sync::Arc;

use bridge::BridgeState;
use tauri::{Manager, State};

struct AppState {
    bridge: Arc<BridgeState>,
}

#[tauri::command]
fn bridge_port(state: State<AppState>) -> u16 {
    *state.bridge.ws_port.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(config::init())
        .invoke_handler(tauri::generate_handler![
            bridge_port,
            ai_proxy::ai_request,
            config::read_config,
            config::write_config
        ])
        .setup(|app| {
            let bridge_state = Arc::new(BridgeState::new());
            let port = tauri::async_runtime::block_on(bridge::start_bridge(Arc::clone(&bridge_state)))
                .map_err(|e| format!("bridge failed to start: {e}"))?;
            log::info!("session bridge listening on 127.0.0.1:{port}");

            app.manage(AppState {
                bridge: bridge_state,
            });

            // RDP sessions are owned by their WebSocket connection and torn
            // down with it, so a plain SIGTERM needs no sidecar cleanup —
            // just make `kill <pid>` exit promptly and cleanly.
            tauri::async_runtime::spawn(async move {
                use tokio::signal::unix::{signal, SignalKind};
                match signal(SignalKind::terminate()) {
                    Ok(mut sig) => {
                        sig.recv().await;
                        std::process::exit(0);
                    }
                    Err(_) => log::warn!("could not install SIGTERM handler"),
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building trdc")
        .run(|_app, _event| {});
}
