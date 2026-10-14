//! Raw FFI to the FreeRDP C shim (shim.c, compiled by build.rs).
//! Everything here is opaque pointers and primitives; see shim.h for the
//! callback threading contract.

use std::os::raw::{c_char, c_int, c_uint, c_void};

#[repr(C)]
pub struct TrdcCallbacks {
    pub user: *mut c_void,
    pub on_frame: extern "C" fn(*mut c_void, *const u8, c_int, c_int, c_int, c_int, c_int),
    pub on_resize: extern "C" fn(*mut c_void, c_int, c_int),
    pub on_cursor: extern "C" fn(*mut c_void, *const u8, c_int, c_int, c_int, c_int),
    pub on_system_cursor: extern "C" fn(*mut c_void, *const c_char),
    pub on_cursor_hide: extern "C" fn(*mut c_void),
    pub on_cursor_pos: extern "C" fn(*mut c_void, c_int, c_int),
    pub on_connected: extern "C" fn(*mut c_void, c_int, c_int),
    pub on_disconnect: extern "C" fn(*mut c_void, c_int, *const c_char),
}

unsafe impl Send for TrdcCallbacks {}

#[allow(dead_code)]
extern "C" {
    pub fn trdc_session_new(cb: TrdcCallbacks) -> *mut c_void;
    pub fn trdc_connect(
        s: *mut c_void,
        hostname: *const c_char,
        port: c_int,
        username: *const c_char,
        password: *const c_char,
        domain: *const c_char,
        client_name: *const c_char,
        width: c_int,
        height: c_int,
        dpi: c_int,
    ) -> c_int;
    pub fn trdc_stop(s: *mut c_void);
    pub fn trdc_session_error(s: *mut c_void) -> *const c_char;
    pub fn trdc_session_free(s: *mut c_void);
    pub fn trdc_mouse(s: *mut c_void, x: c_int, y: c_int, mask: c_int);
    pub fn trdc_key(s: *mut c_void, scancode: c_int, flags: c_int, down: c_int);
    pub fn trdc_unicode(s: *mut c_void, codepoint: c_uint);
    pub fn trdc_kbd_sync(s: *mut c_void, flags: c_int);
    pub fn trdc_resize(s: *mut c_void, width: c_int, height: c_int) -> c_int;
}
