mod ai_proxy;
mod bridge;
mod config;
mod guacd;

use std::sync::Arc;

use bridge::BridgeState;
use guacd::{GuacdProcess, GuacdStatus};
use tauri::{Manager, State};

struct AppState {
    bridge: Arc<BridgeState>,
    guacd: GuacdProcess,
}

#[tauri::command]
fn bridge_port(state: State<AppState>) -> u16 {
    *state.bridge.ws_port.lock().unwrap_or_else(|p| p.into_inner())
}

#[tauri::command]
fn guacd_status(state: State<AppState>) -> GuacdStatus {
    guacd::status(&state.guacd)
}

#[tauri::command]
fn start_guacd(app: tauri::AppHandle, state: State<AppState>, path: Option<String>) -> Result<GuacdStatus, String> {
    guacd::start(&app, &state.guacd, &state.bridge, path.as_deref())
}

#[tauri::command]
fn stop_guacd(state: State<AppState>) {
    guacd::stop(&state.guacd);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(config::init())
        .invoke_handler(tauri::generate_handler![
            bridge_port,
            guacd_status,
            start_guacd,
            stop_guacd,
            ai_proxy::ai_request,
            config::read_config,
            config::write_config
        ])
        .setup(|app| {
            let bridge_state = Arc::new(BridgeState::new());
            let port = tauri::async_runtime::block_on(bridge::start_bridge(Arc::clone(&bridge_state)))
                .map_err(|e| format!("bridge failed to start: {e}"))?;
            log::info!("websocket bridge listening on 127.0.0.1:{port}");

            app.manage(AppState {
                bridge: bridge_state,
                guacd: GuacdProcess::new(),
            });

            // Auto-launch the guacd sidecar; failures are surfaced in the UI
            // (settings banner) rather than being fatal.
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            if let Err(e) = guacd::start(&handle, &state.guacd, &state.bridge, None) {
                log::warn!("guacd auto-start failed: {e}");
            }
            // Also reap the sidecar on plain SIGTERM (kill <pid>).
            let term_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tokio::signal::unix::{signal, SignalKind};
                match signal(SignalKind::terminate()) {
                    Ok(mut sig) => {
                        sig.recv().await;
                        let state = term_handle.state::<AppState>();
                        guacd::stop(&state.guacd);
                        std::process::exit(0);
                    }
                    Err(_) => log::warn!("could not install SIGTERM handler"),
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building trdc")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app.state::<AppState>();
                guacd::stop(&state.guacd);
            }
        });
}
