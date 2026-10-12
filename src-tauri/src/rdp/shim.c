/* trdc FreeRDP shim implementation. See shim.h for the contract.
 *
 * Modeled on the lifecycle of the guacamole-server RDP plugin (gdi_init in
 * PreConnect, EndPaint dirty-rect extraction, custom rdpPointer subclass,
 * winpr event loop), adapted to the FreeRDP 3.32 API surface.
 */
#include "shim.h"

#include <freerdp/codec/color.h>
#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/graphics.h>
#include <freerdp/input.h>
#include <freerdp/settings.h>
#include <freerdp/update.h>
#include <freerdp/version.h>
#include <winpr/synch.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define TRDC_MAX_HANDLES 64

typedef struct trdc_session {
    trdc_callbacks cb;
    freerdp *inst;
    volatile int stop;
    int mouse_mask; /* Guacamole button mask state */
    rdpPointer pointer_proto; /* persistent pointer class prototype */
    char error[512];
} trdc_session;

/* Context extension so C callbacks can find the session. */
typedef struct {
    rdpContext base;
    trdc_session *session;
} trdc_context;

/* Pointer extension: our own RGBA decode of the AND/XOR masks. */
typedef struct {
    rdpPointer base;
    uint8_t *rgba;
} trdc_pointer;

static trdc_context *tctx(rdpContext *c) { return (trdc_context *)c; }
static trdc_context *tctx_inst(freerdp *i) { return (trdc_context *)i->context; }

/* ---------------------------------------------------------------- paint -- */

static BOOL trdc_begin_paint(rdpContext *context) {
    (void)context; /* damage tracking happens in the GDI primitives; this
                    * callback only marks the start of a paint batch. */
    return TRUE;
}

static BOOL trdc_end_paint(rdpContext *context) {
    trdc_session *s = tctx(context)->session;
    rdpGdi *gdi = context->gdi;

    if (gdi == NULL || gdi->suppressOutput)
        return TRUE;

    HGDI_RGN invalid = gdi->primary->hdc->hwnd->invalid;
    if (invalid == NULL || invalid->null)
        goto clear;

    if (s->cb.on_frame) {
        /* Clamp to the surface bounds (FreeRDP can overshoot on resize). */
        int x = invalid->x, y = invalid->y;
        int w = invalid->w, h = invalid->h;
        if (x < 0) { w += x; x = 0; }
        if (y < 0) { h += y; y = 0; }
        if (x + w > (int)gdi->width)  w = (int)gdi->width - x;
        if (y + h > (int)gdi->height) h = (int)gdi->height - y;
        if (w > 0 && h > 0)
            s->cb.on_frame(s->cb.user, gdi->primary_buffer, (int)gdi->stride, x, y, w, h);
    }

clear:
    /* Clear GDI damage state for the next batch. */
    if (invalid != NULL)
        invalid->null = TRUE;
    gdi->primary->hdc->hwnd->ninvalid = 0;
    return TRUE;
}

static BOOL trdc_desktop_resize(rdpContext *context) {
    trdc_session *s = tctx(context)->session;
    if (!gdi_resize(context->gdi,
                    freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth),
                    freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight)))
        return FALSE;
    if (s->cb.on_resize)
        s->cb.on_resize(s->cb.user, (int)context->gdi->width, (int)context->gdi->height);
    return TRUE;
}

/* Frame acknowledgement (RDP 8.1+ flow control) is handled by FreeRDP's own
 * gdi_surface_frame_marker once gdi_init has run, so we install no hook. */

/* --------------------------------------------------------------- input -- */

void trdc_mouse(trdc_session *s, int x, int y, int mask) {
    if (s->inst == NULL || s->inst->context == NULL)
        return;
    rdpInput *input = s->inst->context->input;
    int old = s->mouse_mask;

    if (mask == old && (mask & 0x18) == 0) {
        input->MouseEvent(input, PTR_FLAGS_MOVE, x, y);
        return;
    }

    int released = old & ~mask;
    int pressed = ~old & mask;

    /* Release buttons that just came up. */
    if (released & 0x07) {
        int flags = 0;
        if (released & 0x01) flags |= PTR_FLAGS_BUTTON1;
        if (released & 0x02) flags |= PTR_FLAGS_BUTTON3;
        if (released & 0x04) flags |= PTR_FLAGS_BUTTON2;
        input->MouseEvent(input, flags, x, y);
    }

    /* Move with current button state. */
    {
        int flags = PTR_FLAGS_MOVE;
        if (mask & 0x01) flags |= PTR_FLAGS_BUTTON1;
        if (mask & 0x02) flags |= PTR_FLAGS_BUTTON3;
        if (mask & 0x04) flags |= PTR_FLAGS_BUTTON2;
        input->MouseEvent(input, flags, x, y);
    }

    /* Press buttons that just went down. */
    if (pressed & 0x07) {
        int flags = PTR_FLAGS_DOWN;
        if (pressed & 0x01) flags |= PTR_FLAGS_BUTTON1;
        if (pressed & 0x02) flags |= PTR_FLAGS_BUTTON3;
        if (pressed & 0x04) flags |= PTR_FLAGS_BUTTON2;
        input->MouseEvent(input, flags, x, y);
    }

    /* Wheel clicks (transient, not part of the held mask). */
    if (pressed & 0x08)
        input->MouseEvent(input, PTR_FLAGS_WHEEL | 0x78, x, y);
    if (pressed & 0x10)
        input->MouseEvent(input, PTR_FLAGS_WHEEL | PTR_FLAGS_WHEEL_NEGATIVE | 0x88, x, y);

    s->mouse_mask = mask & 0x07;
}

void trdc_key(trdc_session *s, int scancode, int flags, int down) {
    if (s->inst == NULL || s->inst->context == NULL)
        return;
    s->inst->context->input->KeyboardEvent(
        s->inst->context->input, (UINT16)(flags | (down ? KBD_FLAGS_DOWN : KBD_FLAGS_RELEASE)),
        (UINT16)scancode);
}

void trdc_unicode(trdc_session *s, unsigned codepoint) {
    if (s->inst == NULL || s->inst->context == NULL)
        return;
    s->inst->context->input->UnicodeKeyboardEvent(s->inst->context->input, 0, (UINT16)codepoint);
}

void trdc_kbd_sync(trdc_session *s, int flags) {
    if (s->inst == NULL || s->inst->context == NULL)
        return;
    s->inst->context->input->SynchronizeEvent(s->inst->context->input, flags);
}

/* -------------------------------------------------------------- pointer --
 * The default update handlers (PointerPosition/PointerSystem/PointerNew)
 * dispatch into this class, so implementing the class covers every pointer
 * PDU: Set carries a decoded shape, SetNull/SetDefault the system cursors,
 * SetPosition the server-side cursor movement.
 */

static BOOL trdc_pointer_new(rdpContext *context, rdpPointer *pointer) {
    trdc_pointer *p = (trdc_pointer *)pointer;
    size_t sz = (size_t)pointer->width * pointer->height * 4;
    p->rgba = malloc(sz);
    if (p->rgba == NULL)
        return FALSE;
    memset(p->rgba, 0, sz);

    freerdp_image_copy_from_pointer_data(p->rgba, PIXEL_FORMAT_ARGB32, pointer->width * 4, 0, 0,
                                         pointer->width, pointer->height, pointer->xorMaskData,
                                         pointer->lengthXorMask, pointer->andMaskData,
                                         pointer->lengthAndMask, pointer->xorBpp,
                                         &context->gdi->palette);
    return TRUE;
}

static void trdc_pointer_free(rdpContext *context, rdpPointer *pointer) {
    (void)context;
    trdc_pointer *p = (trdc_pointer *)pointer;
    free(p->rgba);
    p->rgba = NULL;
}

static BOOL trdc_pointer_set(rdpContext *context, rdpPointer *pointer) {
    trdc_session *s = tctx(context)->session;
    trdc_pointer *p = (trdc_pointer *)pointer;
    if (s->cb.on_cursor && p->rgba)
        s->cb.on_cursor(s->cb.user, p->rgba, (int)pointer->width, (int)pointer->height,
                        (int)pointer->xPos, (int)pointer->yPos);
    return TRUE;
}

static BOOL trdc_pointer_set_null(rdpContext *context) {
    trdc_session *s = tctx(context)->session;
    if (s->cb.on_cursor_hide)
        s->cb.on_cursor_hide(s->cb.user);
    return TRUE;
}

static BOOL trdc_pointer_set_default(rdpContext *context) {
    trdc_session *s = tctx(context)->session;
    if (s->cb.on_system_cursor)
        s->cb.on_system_cursor(s->cb.user, "default");
    return TRUE;
}

static BOOL trdc_pointer_set_position(rdpContext *context, UINT32 x, UINT32 y) {
    trdc_session *s = tctx(context)->session;
    if (s->cb.on_cursor_pos)
        s->cb.on_cursor_pos(s->cb.user, (int)x, (int)y);
    return TRUE;
}

/* ----------------------------------------------------------- lifecycle -- */

static BOOL trdc_pre_connect(freerdp *instance) {
    rdpContext *context = instance->context;
    trdc_session *s = tctx_inst(instance)->session;

    /* Custom pointer class that decodes AND/XOR masks to RGBA for us. The
     * prototype must outlive the session, so it lives in the session struct
     * (guacamole registers a stack local here; we do not copy that bug).
     * Only pointer registration happens here: gdi_init needs the rdpCache
     * that the core creates during capability exchange, so it runs in
     * PostConnect (see the gdi_init() doc in FreeRDP 3.32 gdi.c; guacamole
     * still calls it in PreConnect and SEGVs on context->cache as of
     * 3.32 — do not copy that either). */
    rdpGraphics *graphics = context->graphics;
    rdpPointer *proto = &s->pointer_proto;
    *proto = *graphics->Pointer_Prototype;
    proto->size = sizeof(trdc_pointer);
    proto->New = trdc_pointer_new;
    proto->Free = trdc_pointer_free;
    proto->Set = trdc_pointer_set;
    proto->SetNull = trdc_pointer_set_null;
    proto->SetDefault = trdc_pointer_set_default;
    proto->SetPosition = trdc_pointer_set_position;
    graphics_register_pointer(graphics, proto);
    return TRUE;
}

static BOOL trdc_post_connect(freerdp *instance) {
    rdpContext *context = instance->context;
    trdc_session *s = tctx_inst(instance)->session;
    rdpUpdate *update = context->update;

    if (!gdi_init(instance, PIXEL_FORMAT_BGRX32))
        return FALSE;

    /* Install after gdi_init: it registers the library's own drawing/
     * surface handlers over the update table (and leaves Begin/EndPaint to
     * the client). Its gdi_surface_frame_marker already acknowledges frames
     * whenever FreeRDP_FrameAcknowledge > 0, so no SurfaceFrameMarker hook
     * is needed. */
    update->BeginPaint = trdc_begin_paint;
    update->EndPaint = trdc_end_paint;
    update->DesktopResize = trdc_desktop_resize;
    update->PlaySound = NULL; /* no beeps */
    update->SetKeyboardIndicators = NULL;

    if (s->cb.on_connected)
        s->cb.on_connected(s->cb.user, (int)context->gdi->width,
                           (int)context->gdi->height);
    return TRUE;
}

static DWORD trdc_verify_certificate(freerdp *instance, const char *host, UINT16 port,
                                     const char *common_name, const char *subject,
                                     const char *issuer, const char *fingerprint, DWORD flags) {
    (void)instance; (void)host; (void)port; (void)common_name; (void)subject; (void)issuer;
    (void)fingerprint; (void)flags;
    return 1; /* accept; certificate trust UI is a future milestone */
}

static void set_error(trdc_session *s, const char *what) {
    UINT32 code = 0;
    char buf[256];
    if (s->inst && s->inst->context) {
        code = freerdp_get_last_error(s->inst->context);
        snprintf(buf, sizeof(buf), "%s (FreeRDP error 0x%08x: %s)", what, code,
                 freerdp_get_last_error_string(code));
    } else {
        snprintf(buf, sizeof(buf), "%s", what);
    }
    snprintf(s->error, sizeof(s->error), "%s", buf);
}

trdc_session *trdc_session_new(trdc_callbacks cb) {
    trdc_session *s = calloc(1, sizeof(*s));
    if (s == NULL)
        return NULL;
    s->cb = cb;
    return s;
}

int trdc_connect(trdc_session *s, const char *hostname, int port, const char *username,
                 const char *password, const char *domain, const char *client_name, int width,
                 int height, int dpi) {
    int rc = 1;

    s->inst = freerdp_new();
    if (s->inst == NULL) {
        snprintf(s->error, sizeof(s->error), "freerdp_new failed");
        return 1;
    }
    s->inst->ContextSize = sizeof(trdc_context);
    if (!freerdp_context_new(s->inst)) {
        snprintf(s->error, sizeof(s->error), "freerdp_context_new failed");
        goto fail_inst;
    }
    tctx_inst(s->inst)->session = s;

    s->inst->PreConnect = trdc_pre_connect;
    s->inst->PostConnect = trdc_post_connect;
    s->inst->VerifyCertificateEx = trdc_verify_certificate;

    rdpSettings *settings = s->inst->context->settings;
    freerdp_settings_set_string(settings, FreeRDP_ServerHostname, hostname);
    freerdp_settings_set_uint32(settings, FreeRDP_ServerPort, (UINT32)port);
    if (username && *username)
        freerdp_settings_set_string(settings, FreeRDP_Username, username);
    if (password && *password)
        freerdp_settings_set_string(settings, FreeRDP_Password, password);
    if (domain && *domain)
        freerdp_settings_set_string(settings, FreeRDP_Domain, domain);
    if (client_name && *client_name)
        freerdp_settings_set_string(settings, FreeRDP_ClientHostname, client_name);

    freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, (UINT32)width);
    freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, (UINT32)height);
    freerdp_settings_set_uint32(settings, FreeRDP_DesktopScaleFactor,
                                (UINT32)(dpi > 0 ? dpi : 96));
    freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, 32);
    freerdp_settings_set_bool(settings, FreeRDP_SoftwareGdi, TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity, TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_RdpSecurity, TRUE); /* legacy fallback */
    freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity, TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_UnicodeInput, TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_FastPathOutput, TRUE);
    freerdp_settings_set_uint32(settings, FreeRDP_ConnectionType, 1); /* LAN */
    freerdp_settings_set_uint32(settings, FreeRDP_PerformanceFlags, 0);
    freerdp_settings_set_uint32(settings, FreeRDP_FrameAcknowledge, 2);

    if (!freerdp_connect(s->inst)) {
        set_error(s, "freerdp_connect failed");
        /* The connect handshake itself failed: report it like any other
         * disconnect so the Rust side gets its Closed event, then unwind. */
        if (s->cb.on_disconnect)
            s->cb.on_disconnect(s->cb.user, 1, s->error);
        goto fail_ctx;
    }

    rc = 0; /* connected */
    while (!s->stop && !freerdp_shall_disconnect_context(s->inst->context)) {
        HANDLE handles[TRDC_MAX_HANDLES];
        DWORD count = freerdp_get_event_handles(s->inst->context, handles, TRDC_MAX_HANDLES);
        if (count == 0) {
            set_error(s, "freerdp_get_event_handles failed");
            rc = 2;
            break;
        }
        WaitForMultipleObjects(count, handles, FALSE, 100);
        if (!freerdp_check_event_handles(s->inst->context)) {
            if (!s->stop)
                set_error(s, "freerdp_check_event_handles failed");
            rc = s->stop ? 0 : 3;
            break;
        }
    }

    freerdp_disconnect(s->inst);
    if (s->cb.on_disconnect)
        s->cb.on_disconnect(s->cb.user, rc, s->error[0] ? s->error : "disconnected");
    goto fail_ctx;

fail_ctx:
    /* gdi_init allocated context->gdi; freerdp_context_free does not free
     * it (NULL-safe, so fine when the connect failed before PostConnect). */
    gdi_free(s->inst);
    freerdp_context_free(s->inst);
fail_inst:
    freerdp_free(s->inst);
    s->inst = NULL;
    return rc;
}

void trdc_stop(trdc_session *s) { s->stop = 1; }

const char *trdc_session_error(trdc_session *s) { return s->error; }

void trdc_session_free(trdc_session *s) { free(s); }
