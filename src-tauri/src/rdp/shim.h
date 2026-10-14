/* trdc FreeRDP shim: opaque session handle over the FreeRDP 3.x client API.
 *
 * The Rust side never touches FreeRDP structs: it registers a callback table,
 * calls trdc_connect (which blocks running the FreeRDP winpr event loop), and
 * receives paint/pointer/lifecycle events on the FreeRDP thread. Input calls
 * are thread-safe (FreeRDP queues them internally).
 */
#ifndef TRDC_SHIM_H
#define TRDC_SHIM_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct trdc_session trdc_session;

/* All callbacks run on the FreeRDP event-loop thread except where noted.
 * Buffers are only valid for the duration of the call. */
typedef struct {
    void *user;

    /* The primary surface region (x,y,w,h) was just painted. bgra points at
     * FreeRDP's GDI buffer with the given stride (bytes/pixel=4). */
    void (*on_frame)(void *user, const uint8_t *bgra, int stride, int x, int y, int w, int h);

    /* Server changed the desktop size. */
    void (*on_resize)(void *user, int width, int height);

    /* Decoded color pointer shape: RGBA8888, row-major. */
    void (*on_cursor)(void *user, const uint8_t *rgba, int width, int height, int hotx, int hoty);

    /* System (named) cursor requested; name is a WinPR constant string. */
    void (*on_system_cursor)(void *user, const char *name);

    /* Null pointer (hidden) requested. */
    void (*on_cursor_hide)(void *user);

    /* Pointer moved (server-side cursor). */
    void (*on_cursor_pos)(void *user, int x, int y);

    /* Connection established; desktop size known. Called once. */
    void (*on_connected)(void *user, int width, int height);

    /* Event loop has exited; code 0 = clean, else FreeRDP error. msg is
     * UTF-8 and valid only during the call. */
    void (*on_disconnect)(void *user, int code, const char *msg);
} trdc_callbacks;

/* Allocate a session. The callbacks table is copied. */
trdc_session *trdc_session_new(trdc_callbacks cb);

/* Set the desired desktop size/DPI and credentials, then connect and run the
 * event loop until disconnect or trdc_stop. Returns 0 on a clean session that
 * at least connected, non-zero on failure (use trdc_session_error()).
 * Blocks; call from a dedicated thread. */
int trdc_connect(trdc_session *s, const char *hostname, int port, const char *username,
                 const char *password, const char *domain, const char *client_name, int width,
                 int height, int dpi);

/* Ask the event loop to exit; thread-safe. */
void trdc_stop(trdc_session *s);

/* Last error text (valid until next error). Thread-unsafe; read after
 * trdc_connect returns. */
const char *trdc_session_error(trdc_session *s);

void trdc_session_free(trdc_session *s);

/* ---- input (thread-safe) ----
 * mask is the Guacamole button mask: 1=left 2=right 4=middle 8=wheel-up
 * 16=wheel-down. The shim diffs against the last mask and emits the RDP
 * mouse PDUs (move/press/release/wheel) that produce that state. */
void trdc_mouse(trdc_session *s, int x, int y, int mask);

/* Raw scancode event: flags are RDP KBD_FLAGS_* (extended etc). */
void trdc_key(trdc_session *s, int scancode, int flags, int down);

/* Unicode keyboard event (UTF-16 code unit). */
void trdc_unicode(trdc_session *s, unsigned codepoint);

/* Keyboard lock synchronization (KBD_SYNC_* flags). */
void trdc_kbd_sync(trdc_session *s, int flags);

/* Live desktop resolution change. Currently inert: the legacy Monitor
 * Layout PDU is only legal during capabilities exchange, and sending it
 * mid-session resets Windows RDP connections. Real live resize needs the
 * disp DVC channel. Always returns 0. */
int trdc_resize(trdc_session *s, int width, int height);

#ifdef __cplusplus
}
#endif

#endif /* TRDC_SHIM_H */
