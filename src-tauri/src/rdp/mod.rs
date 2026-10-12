//! Native RDP backend: FreeRDP 3.x linked directly into trdc.
//!
//! - `shim.c` (built by build.rs): owns the freerdp event loop, GDI paint
//!   hooks and pointer decoding; reports out through a plain C callback
//!   table.
//! - `session.rs`: safe wrapper; per-connection FreeRDP thread + frame
//!   ticker that JPEG-encodes the dirty region for the webview.
//! - `keymap.rs` (generated) + `keyboard.rs`: X11 keysym -> RDP scancode
//!   engine, ported from guacamole-server's keyboard.c.

pub mod ffi;
pub mod keyboard;
#[allow(clippy::all)]
pub mod keymap;
pub mod session;

pub use session::{ConnectParams, RunningSession, ServerEvent};
