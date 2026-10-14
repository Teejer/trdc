// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's Wayland dmabuf renderer crashes some drivers/GPU combos
    // (NVIDIA especially) with "Error 71 (Protocol error) dispatching to
    // Wayland display" when the web process initializes. Falling back to the
    // classic buffer path costs nothing on working setups; users who want
    // dmabuf back can export WEBKIT_DISABLE_DMABUF_RENDERER=0.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    // Second, nastier GPU-path bug seen on this stack: canvas contents draw
    // fine into the backing store (getImageData proves it) but the
    // compositor shows a stale black texture — the screen never updates.
    // Software compositing costs a little GPU offload and shows the truth.
    if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
    trdc_lib::run()
}
