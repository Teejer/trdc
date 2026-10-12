//! Safe wrapper around the FreeRDP shim: one session = one FreeRDP thread +
//! one frame-ticker thread.
//!
//! The FreeRDP thread paints into the shared surface (BGRA) and marks a
//! dirty bounding box; the ticker wakes every ~16 ms, JPEG-encodes the
//! changed region and pushes it, plus pointer updates, into an unbounded
//! channel that the WebSocket bridge forwards to the webview. Input methods
//! are called from the bridge (tokio) thread; the shim serializes them.

use std::ffi::{c_int, c_void, CString};
use std::os::raw::c_char;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder};
use tokio::sync::mpsc::UnboundedSender;

use super::ffi::*;
use super::keyboard::{Input as KbdInput, Keyboard};

/// Quality of the on-wire screen tiles. 80 keeps text legible at a fraction
/// of PNG's bandwidth; a lossless toggle is a UI feature for later.
const JPEG_QUALITY: u8 = 80;

/// Frame coalescing interval. FreeRDP batches its own updates; 16 ms keeps
/// us at ~60 ticks/s while letting bursts collapse into one encode.
const TICK: std::time::Duration = std::time::Duration::from_millis(16);

/// Events streamed to the webview over the bridge.
#[derive(Debug)]
pub enum ServerEvent {
    Ready { width: u32, height: u32 },
    Resize { width: u32, height: u32 },
    /// An encoded screen tile (JPEG).
    Frame { x: u32, y: u32, w: u32, h: u32, data: Vec<u8> },
    /// A cursor shape (PNG, with alpha).
    CursorPng { hotx: i32, hoty: i32, w: u32, h: u32, data: Vec<u8> },
    SystemCursor { name: String },
    CursorHide,
    CursorPos { x: i32, y: i32 },
    /// The session ended (server closed, connect failed, or we stopped it).
    Closed { error: Option<String> },
}

struct Surface {
    width: u32,
    height: u32,
    /// BGRA pixels, tightly packed at width*4 stride.
    pixels: Vec<u8>,
    /// Pending damage as (x, y, w, h) in surface coordinates, or None.
    dirty: Option<(u32, u32, u32, u32)>,
    /// Set when the surface was (re)allocated: the next frame goes out
    /// whole, so the webview starts from a consistent picture.
    full: bool,
}

impl Surface {
    fn new() -> Self {
        Surface { width: 0, height: 0, pixels: Vec::new(), dirty: None, full: false }
    }

    fn resize(&mut self, width: u32, height: u32) {
        self.width = width;
        self.height = height;
        self.pixels
            .resize((width as usize) * (height as usize) * 4, 0);
        self.dirty = None;
        self.full = true;
    }

    /// Copy a region out of FreeRDP's GDI buffer (its own stride may differ
    /// from ours) and union it into the damage box.
    fn paint(&mut self, src: *const u8, stride: usize, x: u32, y: u32, w: u32, h: u32) {
        if self.pixels.is_empty() || w == 0 || h == 0 {
            return;
        }
        let dst_stride = (self.width as usize) * 4;
        for row in 0..h as usize {
            let sy = y as usize + row;
            let dy = sy * dst_stride;
            if sy >= self.height as usize || dy + (x as usize) * 4 + (w as usize) * 4 > self.pixels.len() {
                break;
            }
            unsafe {
                let s = src.add(sy * stride + (x as usize) * 4);
                let d = self.pixels.as_mut_ptr().add(dy + (x as usize) * 4);
                ptr::copy_nonoverlapping(s, d, (w as usize) * 4);
            }
        }
        self.dirty = Some(union_dirty(self.dirty, (x, y, w, h), self.width, self.height));
    }

    /// Take the pending damage, encoding the region to JPEG. Returns None
    /// when there is nothing to send. Runs off the FreeRDP thread.
    fn take_frame(&mut self) -> Option<ServerEvent> {
        let region = if self.full {
            if self.width == 0 || self.height == 0 {
                return None;
            }
            self.full = false;
            (0, 0, self.width, self.height)
        } else {
            match self.dirty.take() {
                Some(r) => r,
                None => return None,
            }
        };
        let (x, y, w, h) = region;
        let mut rgb = Vec::with_capacity((w as usize) * (h as usize) * 3);
        let dst_stride = (self.width as usize) * 4;
        for row in 0..h as usize {
            let base = ((y as usize + row) * dst_stride + (x as usize) * 4) as usize;
            let src = &self.pixels[base..base + (w as usize) * 4];
            for px in src.chunks_exact(4) {
                // BGRA -> RGB
                rgb.extend_from_slice(&[px[2], px[1], px[0]]);
            }
        }
        let mut out = Vec::new();
        {
            let mut enc = JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
            if enc.encode(&rgb, w, h, ExtendedColorType::Rgb8).is_err() {
                return None;
            }
        }
        Some(ServerEvent::Frame { x, y, w, h, data: out })
    }
}

fn union_dirty(
    cur: Option<(u32, u32, u32, u32)>,
    add: (u32, u32, u32, u32),
    width: u32,
    height: u32,
) -> (u32, u32, u32, u32) {
    let (x, y, w, h) = add;
    let (ax, ay) = (x.min(width), y.min(height));
    let (bx, by) = (x.saturating_add(w).min(width), y.saturating_add(h).min(height));
    match cur {
        Some((cx, cy, cw, ch)) if cw > 0 && ch > 0 => {
            let cx2 = cx.saturating_add(cw).min(width);
            let cy2 = cy.saturating_add(ch).min(height);
            let nx = cx.min(ax);
            let ny = cy.min(ay);
            (nx, ny, bx.max(cx2) - nx, by.max(cy2) - ny)
        }
        _ => (ax, ay, bx - ax, by - ay),
    }
}

struct Shared {
    surface: Mutex<Surface>,
    events: UnboundedSender<ServerEvent>,
    /// Cleared when the session is stopping; the ticker polls it.
    running: AtomicBool,
}

/// The `user` cookie handed to the shim. Kept alive (leaked) for exactly as
/// long as the FreeRDP thread may call back; RunningSession::drop reclaims
/// it after joining the thread.
struct Holder {
    shared: Arc<Shared>,
}

extern "C" fn cb_on_frame(
    user: *mut c_void,
    bgra: *const u8,
    stride: c_int,
    x: c_int,
    y: c_int,
    w: c_int,
    h: c_int,
) {
    let holder = unsafe { &*(user as *const Holder) };
    if !holder.shared.running.load(Ordering::Relaxed) {
        return;
    }
    let mut surface = match holder.shared.surface.lock() {
        Ok(s) => s,
        Err(_) => return,
    };
    surface.paint(bgra, stride as usize, x as u32, y as u32, w as u32, h as u32);
}

extern "C" fn cb_on_resize(user: *mut c_void, width: c_int, height: c_int) {
    let holder = unsafe { &*(user as *const Holder) };
    {
        let mut surface = match holder.shared.surface.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        surface.resize(width as u32, height as u32);
    }
    let _ = holder
        .shared
        .events
        .send(ServerEvent::Resize { width: width as u32, height: height as u32 });
}

extern "C" fn cb_on_cursor(
    user: *mut c_void,
    rgba: *const u8,
    width: c_int,
    height: c_int,
    hotx: c_int,
    hoty: c_int,
) {
    let holder = unsafe { &*(user as *const Holder) };
    let (w, h) = (width as u32, height as u32);
    if w == 0 || h == 0 {
        return;
    }
    let pixels =
        unsafe { std::slice::from_raw_parts(rgba, (w as usize) * (h as usize) * 4).to_vec() };
    let mut out = Vec::new();
    {
        let enc = PngEncoder::new(&mut out);
        if enc.write_image(&pixels, w, h, ExtendedColorType::Rgba8).is_err() {
            return;
        }
    }
    let _ = holder.shared.events.send(ServerEvent::CursorPng {
        hotx: hotx as i32,
        hoty: hoty as i32,
        w,
        h,
        data: out,
    });
}

extern "C" fn cb_on_system_cursor(user: *mut c_void, name: *const c_char) {
    let holder = unsafe { &*(user as *const Holder) };
    let name = if name.is_null() {
        "default".to_string()
    } else {
        unsafe { std::ffi::CStr::from_ptr(name) }
            .to_string_lossy()
            .into_owned()
    };
    let _ = holder
        .shared
        .events
        .send(ServerEvent::SystemCursor { name });
}

extern "C" fn cb_on_cursor_hide(user: *mut c_void) {
    let holder = unsafe { &*(user as *const Holder) };
    let _ = holder.shared.events.send(ServerEvent::CursorHide);
}

extern "C" fn cb_on_cursor_pos(user: *mut c_void, x: c_int, y: c_int) {
    let holder = unsafe { &*(user as *const Holder) };
    let _ = holder
        .shared
        .events
        .send(ServerEvent::CursorPos { x: x as i32, y: y as i32 });
}

extern "C" fn cb_on_connected(user: *mut c_void, width: c_int, height: c_int) {
    let holder = unsafe { &*(user as *const Holder) };
    {
        let mut surface = match holder.shared.surface.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        surface.resize(width as u32, height as u32);
    }
    let _ = holder
        .shared
        .events
        .send(ServerEvent::Ready { width: width as u32, height: height as u32 });
}

extern "C" fn cb_on_disconnect(user: *mut c_void, _code: c_int, msg: *const c_char) {
    let holder = unsafe { &*(user as *const Holder) };
    let msg = if msg.is_null() {
        None
    } else {
        let s = unsafe { std::ffi::CStr::from_ptr(msg) }.to_string_lossy().into_owned();
        if s.is_empty() || s == "disconnected" {
            None
        } else {
            Some(s)
        }
    };
    eprintln!("[rdp] session closed: {}", msg.as_deref().unwrap_or("clean disconnect"));
    let _ = holder.shared.events.send(ServerEvent::Closed { error: msg });
}

fn callbacks(user: *mut c_void) -> TrdcCallbacks {
    TrdcCallbacks {
        user,
        on_frame: cb_on_frame,
        on_resize: cb_on_resize,
        on_cursor: cb_on_cursor,
        on_system_cursor: cb_on_system_cursor,
        on_cursor_hide: cb_on_cursor_hide,
        on_cursor_pos: cb_on_cursor_pos,
        on_connected: cb_on_connected,
        on_disconnect: cb_on_disconnect,
    }
}

/// Parameters for one RDP connection.
pub struct ConnectParams {
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: String,
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    pub layout: String,
}

/// Send wrapper for the opaque trdc_session*. The shim's input entry points
/// are thread-safe; the event loop itself runs on our dedicated thread.
struct SendPtr(*mut c_void);
unsafe impl Send for SendPtr {}

impl SendPtr {
    /// Accessor. Closures must go through this method: Rust 2021 disjoint
    /// capture would otherwise grab the raw `.0` field (not Send) instead of
    /// the wrapper (Send).
    fn get(&self) -> *mut c_void {
        self.0
    }
}

/// A live (or finished) RDP session. Drop stops the FreeRDP loop, joins the
/// thread, and frees the shim session and holder.
pub struct RunningSession {
    session: SendPtr,
    holder: *mut Holder,
    freerdp_thread: Option<JoinHandle<()>>,
    keyboard: Keyboard,
}

unsafe impl Send for RunningSession {}

impl RunningSession {
    /// Connect (blocking on the network handshake on a dedicated thread)
    /// and spin up the event plumbing. A failed connect surfaces as
    /// ServerEvent::Closed rather than an error from this function.
    pub fn start(params: ConnectParams, events: UnboundedSender<ServerEvent>) -> Self {
        let shared = Arc::new(Shared {
            surface: Mutex::new(Surface::new()),
            events,
            running: AtomicBool::new(true),
        });
        let holder: *mut Holder = Box::into_raw(Box::new(Holder { shared: Arc::clone(&shared) }));

        let session = unsafe { trdc_session_new(callbacks(holder as *mut c_void)) };
        assert!(!session.is_null(), "trdc_session_new failed");

        let c_host = CString::new(params.hostname.as_str()).unwrap_or_default();
        let c_user = CString::new(params.username.as_str()).unwrap_or_default();
        let c_pass = CString::new(params.password.as_str()).unwrap_or_default();
        let c_domain = CString::new(params.domain.as_str()).unwrap_or_default();
        let client_name = std::env::var("HOSTNAME").unwrap_or_else(|_| "trdc".to_string());
        let c_name = CString::new(client_name).unwrap_or_default();
        let port = params.port as i32;
        let (w, h, dpi) = (params.width.max(64) as i32, params.height.max(64) as i32, params.dpi as i32);
        let layout = params.layout.clone();

        let thread_shared = Arc::clone(&shared);
        let session_arg = SendPtr(session);
        let freerdp_thread = std::thread::spawn(move || {
            unsafe {
                trdc_connect(
                    session_arg.get(),
                    c_host.as_ptr(),
                    port,
                    c_user.as_ptr(),
                    c_pass.as_ptr(),
                    c_domain.as_ptr(),
                    c_name.as_ptr(),
                    w,
                    h,
                    dpi,
                );
            }
            thread_shared.running.store(false, Ordering::Relaxed);
        });

        RunningSession {
            session: SendPtr(session),
            holder,
            freerdp_thread: Some(freerdp_thread),
            keyboard: Keyboard::new(&layout),
        }
    }

    /// Forward ServerEvents... the ticker runs as a detached poller over the
    /// shared surface while the session is running.
    pub fn start_ticker(&self) {
        let shared = unsafe { &*self.holder }.shared.clone();
        std::thread::spawn(move || {
            while shared.running.load(Ordering::Relaxed) {
                std::thread::sleep(TICK);
                let frame = shared.surface.lock().ok().and_then(|mut s| s.take_frame());
                if let Some(f) = frame {
                    if shared.events.send(f).is_err() {
                        break; // webview gone; the bridge will stop us
                    }
                }
            }
        });
    }

    fn live(&self) -> bool {
        unsafe { &*self.holder }.shared.running.load(Ordering::Relaxed)
    }

    /// Move / click with the Guacamole button mask (1=L 2=R 4=M 8=wheel+ 16=wheel-).
    pub fn mouse(&self, x: i32, y: i32, mask: i32) {
        if self.live() {
            unsafe { trdc_mouse(self.session.0, x, y, mask) };
        }
    }

    /// Press/release an X11 keysym through the layout engine.
    pub fn keysym(&mut self, keysym: i32, pressed: bool) {
        if !self.live() {
            return;
        }
        let session = self.session.0;
        self.keyboard.client_keysym(keysym, pressed, &mut |ev| match ev {
            KbdInput::Key { scancode, flags, down } => unsafe {
                trdc_key(session, scancode as i32, flags as i32, down as i32)
            },
            KbdInput::Unicode(cp) => unsafe { trdc_unicode(session, cp as u32) },
            KbdInput::Sync(flags) => unsafe { trdc_kbd_sync(session, flags as i32) },
        });
    }

    /// Align the server's lock LEDs with a fresh local reading.
    pub fn sync_locks(&mut self, flags: u32) {
        if !self.live() {
            return;
        }
        let session = self.session.0;
        self.keyboard.sync_locks(flags, &mut |ev| match ev {
            KbdInput::Sync(flags) => unsafe { trdc_kbd_sync(session, flags as i32) },
            _ => {}
        });
    }
}

impl Drop for RunningSession {
    fn drop(&mut self) {
        unsafe {
            trdc_stop(self.session.0);
        }
        if let Some(t) = self.freerdp_thread.take() {
            let _ = t.join();
        }
        unsafe {
            trdc_session_free(self.session.0);
            drop(Box::from_raw(self.holder));
        }
    }
}
