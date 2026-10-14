/**
 * NativeSession - one live remote-desktop connection.
 *
 * Talks to trdc's built-in RDP engine over the local session bridge (one WS
 * connection = one FreeRDP session in the Rust process). The Rust side paints
 * nothing: it JPEG-encodes the changed region of the FreeRDP GDI surface and
 * ships binary tiles that we draw onto a canvas here; keyboard events travel
 * as X11 keysyms and become RDP scancodes on the Rust side (guacamole's
 * keymap engine), so both the human (DOM handlers) and the AI (explicit
 * methods) drive the same remote cursor.
 */
import Guacamole from 'guacamole-common-js';
import type { ConnectionProfile, SessionStatus } from '../types';
import { getProtocol } from '../protocols';

export interface SessionCallbacks {
  onStatus?: (status: SessionStatus, error?: string) => void;
  onSize?: (width: number, height: number) => void;
  onAiActivity?: (active: boolean) => void;
}

/** Map a Unicode character to an X11 keysym (the scheme Guacamole uses). */
export function charToKeysym(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0xff) return code; // Latin-1 keysyms equal their code points
  if (code >= 0x100) return 0x01000000 + code; // Unicode plane keysym
  return 0;
}

const NAMED_KEYS: Record<string, number> = {
  enter: 0xff0d, return: 0xff0d, tab: 0xff09, space: 0x20, escape: 0xff1b, esc: 0xff1b,
  // ISO_Left_Tab: real Shift+Tab on X11 hosts (a plain Tab + Shift modifier
  // often gets swallowed; krdc-ai learned this the hard way).
  backtab: 0xfe20, shifttab: 0xfe20,
  pageup: 0xff55, prior: 0xff55, pagedown: 0xff56, next: 0xff56,
  home: 0xff50, end: 0xff57, insert: 0xff63,
  delete: 0xffff, del: 0xffff, backspace: 0xff08,
  up: 0xff52, down: 0xff54, left: 0xff51, right: 0xff53,
  win: 0xffeb, super: 0xffeb, meta: 0xffeb, cmd: 0xffeb,
  ctrl: 0xffe3, control: 0xffe3, shift: 0xffe1, alt: 0xffe9, option: 0xffe9,
  capslock: 0xffe5, numlock: 0xff7f, printscreen: 0xff61,
  f1: 0xffbe, f2: 0xffbf, f3: 0xffc0, f4: 0xffc1, f5: 0xffc2, f6: 0xffc3,
  f7: 0xffc4, f8: 0xffc5, f9: 0xffc6, f10: 0xffc7, f11: 0xffc8, f12: 0xffc9,
};

export function keyNameToKeysym(name: string): number | null {
  const key = name.trim().toLowerCase();
  if (NAMED_KEYS[key] !== undefined) return NAMED_KEYS[key];
  if (/^f\d{1,2}$/.test(key)) {
    const n = parseInt(key.slice(1), 10);
    if (n >= 1 && n <= 24) return 0xffbe + (n - 1);
  }
  if (key.length === 1) return charToKeysym(key);
  return null;
}

type MouseButton = 'left' | 'middle' | 'right' | 'up' | 'down';

/** Bridge button mask bits (guacamole's convention, mirrored in shim.c). */
const MASK_LEFT = 1;
const MASK_RIGHT = 2;
const MASK_MIDDLE = 4;
const MASK_WHEEL_UP = 8;
const MASK_WHEEL_DOWN = 16;

/** CSS cursor for the RDP "system cursor" PDU names. */
const SYSTEM_CURSORS: Record<string, string> = {
  default: 'default',
  arrow: 'default',
  busy: 'progress',
  progress: 'progress',
  none: 'none',
  text: 'text',
  pointer: 'pointer',
};

export class NativeSession {
  readonly profile: ConnectionProfile;
  readonly id: string;

  private ws: WebSocket | null = null;
  private container: HTMLElement | null = null;
  private wrapper: HTMLElement | null = null;
  private viewport: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private keyboard: any = null;
  private resizeObserver: ResizeObserver | null = null;

  /** Serializes tile draws so out-of-order JPEG decodes land in send order. */
  private drawChain: Promise<void> = Promise.resolve();
  /** Received screen tiles (kind 1), for TRDC_RDP_DEBUG reporting. */
  private tilesIn = 0;
  /** Echo a line to the trdc process stderr (debug builds only). */
  private debug(msg: string): void {
    this.send({ t: 'debug', msg: `${this.id.slice(0, 4)} ${msg}` });
  }
  /** Human pointer button mask, live. */
  private humanMask = 0;
  private status: SessionStatus = 'connecting';
  private aiActive = false;
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  /** Current display scale factor (1 = 1:1). */
  scale = 1;
  /** Client-side dark-mode filter state (CSS invert on the display element). */
  private dark = false;
  private disconnecting = false;

  callbacks: SessionCallbacks = {};
  /**
   * Connect-time password, held in memory only (the store prompts for it;
   * it is never part of profile.params on disk).
   */
  password = '';

  constructor(profile: ConnectionProfile, id: string) {
    this.profile = profile;
    this.id = id;
  }

  getStatus() {
    return this.status;
  }

  private setStatus(status: SessionStatus, error?: string) {
    this.status = status;
    this.callbacks.onStatus?.(status, error);
  }

  /** Build the bridge open message from a connection profile. */
  private buildOpenMessage(): Record<string, unknown> {
    const proto = getProtocol(this.profile.protocol);
    const msg: Record<string, unknown> = {
      t: 'open',
      protocol: this.profile.protocol,
      hostname: this.profile.hostname,
      port: 3389,
      username: '',
      password: '',
      domain: '',
      width: 1280,
      height: 800,
      dpi: 96,
      layout: 'en-us-qwerty',
      ...(proto?.extraArgs ?? {}),
    };
    if (proto) {
      for (const field of proto.fields) {
        const value = this.profile.params[field.name];
        if (value !== undefined && value !== '') msg[field.name] = value;
        else if (field.default !== undefined) msg[field.name] = field.default;
      }
    }
    // Merge any extra unknown params verbatim.
    Object.assign(msg, this.profile.params);
    // No explicit desktop size in the profile? Start the remote desktop at
    // the middle pane's pixel size so Fit mode is 1:1 sharp from frame one
    // (and later pane changes resize the desktop live, see requestResize).
    if (!this.sizePinned()) {
      const pane = this.paneSize();
      msg.width = pane.width;
      msg.height = pane.height;
    }
    // The runtime password wins over anything (legacy) in params.
    msg.password = this.password;
    return msg;
  }

  /** True when the profile pins an explicit desktop width/height. */
  private sizePinned(): boolean {
    return (
      this.profile.params.width !== undefined &&
      this.profile.params.width !== '' &&
      this.profile.params.height !== undefined &&
      this.profile.params.height !== ''
    );
  }

  /**
   * Middle pane size in remote device pixels (CSS px x devicePixelRatio),
   * rounded to even (encoders prefer it) and clamped to what Windows RDP
   * accepts. Falls back to a window-based estimate when the pane has not
   * been attached yet (connect races mount).
   */
  private paneSize(): { width: number; height: number } {
    let cw = 0;
    let ch = 0;
    if (this.container) {
      cw = this.container.clientWidth;
      ch = this.container.clientHeight;
    }
    if (!cw || !ch) {
      // Titlebar + tab bar + toolbar + sidebar + AI panel, roughly.
      cw = Math.max(640, window.innerWidth - 460);
      ch = Math.max(480, window.innerHeight - 120);
    }
    const dpr = window.devicePixelRatio || 1;
    const even = (v: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, Math.round((v * dpr) / 2) * 2));
    return { width: even(cw, 800, 3840), height: even(ch, 600, 2160) };
  }

  /* Live resolution change while connected is deliberately NOT attempted:
   * the legacy Monitor Layout PDU mid-session is a protocol violation that
   * resets Windows RDP connections (observed: transport reset + wedged
   * listener on two hosts). Real live resize needs the MS-RDPEDYC disp DVC
   * channel, which the shim does not load; until then pane changes are
   * Fit-scaled and a true resolution change is a reconnect. */

  /** Connect using the given bridge WebSocket URL. */
  connect(bridgeUrl: string): Promise<void> {
    if (this.ws) return Promise.resolve();
    this.setStatus('connecting');
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(bridgeUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let settled = false;

      ws.onopen = () => {
        ws.send(JSON.stringify(this.buildOpenMessage()));
        // One-shot credential: the Rust bridge has it for the handshake and
        // nothing in the webview needs it again. Drop our copy immediately
        // so no live session object holds a plaintext password.
        this.password = '';
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === 'string') {
          let msg: any;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            return;
          }
          if (msg.t === 'ready' && !settled) {
            settled = true;
            this.debug(`ready ${msg.width}x${msg.height} createImageBitmap=${typeof createImageBitmap}`);
            this.setStatus('connected');
            this.setRemoteSize(msg.width, msg.height);
            this.callbacks.onSize?.(msg.width, msg.height);
            this.applyScale();
            resolve();
          } else if (msg.t === 'resize') {
            this.handleResize(msg.width, msg.height);
          } else if (msg.t === 'cursor-pos') {
            // The CSS cursor rides the real mouse; a server-side position
            // PDU needs no action here.
          } else if (msg.t === 'cursor-hide') {
            // Server hid its pointer; show the local cursor again so the
            // user is never pointer-blind.
            if (this.wrapper) this.wrapper.style.cursor = 'default';
          } else if (msg.t === 'system-cursor') {
            this.applySystemCursor(msg.name);
          } else if (msg.t === 'closed') {
            if (!this.disconnecting) {
              this.setStatus(msg.error ? 'error' : 'disconnected', msg.error ?? undefined);
            }
          }
        } else {
          this.handleBinary(ev.data as ArrayBuffer);
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Could not reach the local RDP engine.'));
        }
      };
      ws.onclose = () => {
        if (!this.disconnecting && this.status === 'connected') this.setStatus('disconnected');
        if (!settled) {
          settled = true;
          reject(new Error('The local RDP engine closed the connection.'));
        }
      };
    });
  }

  /**
   * Remote display size as announced by the server (ready/resize). The
   * canvas is created lazily in attach(), which can run before OR after
   * the ready message, so the size has to live on the session, not the
   * canvas: sizing the canvas from the canvas (screenSize) before the
   * first frame used to leave a permanent 1x1 canvas that swallowed every
   * tile and crushed mouse coordinates to (0,0).
   */
  private remoteW = 0;
  private remoteH = 0;
  private setRemoteSize(width: number, height: number): void {
    if (!width || !height) return;
    this.remoteW = width;
    this.remoteH = height;
    if (this.canvas && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    }
  }

  /** Attach the display to a container and start handling human input. */
  attach(container: HTMLElement) {
    this.container = container;
    this.buildDom();
    if (this.wrapper && this.wrapper.parentElement !== container) {
      container.appendChild(this.wrapper);
    }

    this.resizeObserver = new ResizeObserver(() => this.applyScale());
    this.resizeObserver.observe(container);

    this.applyScale();
    this.applyDarkMode();
  }

  /**
   * The display DOM (wrapper/viewport/canvas + input listeners) is built
   * once per session and *kept* between attach/detach: switching tabs only
   * removes it from the DOM. That preserves the last painted frame — the
   * server sends dirty rectangles only, so a canvas rebuilt on every attach
   * would show black until the remote host happened to repaint. It also
   * stops re-adding window keyboard listeners on every tab switch.
   */
  private buildDom(): void {
    if (this.wrapper) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'native-display';
    // Inner box sized exactly to the (scaled) canvas.
    const viewport = document.createElement('div');
    viewport.className = 'native-viewport';
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, this.remoteW);
    canvas.height = Math.max(1, this.remoteH);
    viewport.appendChild(canvas);
    wrapper.appendChild(viewport);

    this.wrapper = wrapper;
    this.viewport = viewport;
    this.canvas = canvas;
    // willReadFrequently keeps the canvas in a software backing store. On
    // WebKitGTK's accelerated canvas, drawImage updates land in the backing
    // store (getImageData sees them) but the GPU compositor keeps showing a
    // stale texture — the remote screen visibly freezes on the first frame.
    this.ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });

    // Human pointer -> remote. Coordinates map through the canvas rect so
    // fit-scaling is transparent.
    const remotePoint = (e: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / Math.max(1, rect.width);
      const sy = canvas.height / Math.max(1, rect.height);
      return {
        x: Math.round((e.clientX - rect.left) * sx),
        y: Math.round((e.clientY - rect.top) * sy),
      };
    };
    const sendPointer = (e: PointerEvent) => {
      const p = remotePoint(e);
      this.send({ t: 'mouse', x: p.x, y: p.y, mask: this.humanMask });
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.humanMask |= MASK_LEFT;
      if (e.button === 1) this.humanMask |= MASK_MIDDLE;
      if (e.button === 2) this.humanMask |= MASK_RIGHT;
      canvas.setPointerCapture(e.pointerId);
      canvas.focus();
      sendPointer(e);
    });
    canvas.addEventListener('pointerup', (e) => {
      this.humanMask &= ~(e.button === 0 ? MASK_LEFT : e.button === 1 ? MASK_MIDDLE : MASK_RIGHT);
      sendPointer(e);
    });
    canvas.addEventListener('pointermove', sendPointer);
    canvas.addEventListener('pointercancel', () => {
      this.humanMask = 0;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = remotePoint(e);
      const direction = e.deltaY > 0 ? MASK_WHEEL_DOWN : MASK_WHEEL_UP;
      // One wheel PDU per notch; the shim emits on the press edge only.
      const notches = Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 100)));
      for (let i = 0; i < notches; i++) {
        this.send({ t: 'mouse', x: p.x, y: p.y, mask: this.humanMask | direction });
      }
    });

    // Human keyboard -> remote (only while this session is focused/visible).
    const keyboard = new Guacamole.Keyboard(window);
    this.keyboard = keyboard;
    // guac calls preventDefault whenever the handler returns false, so we
    // must return TRUE for anything that isn't remote-bound typing: trdc's
    // own inputs (settings modal, search box, chat) and unfocused sessions.
    // Returning false everywhere used to make trdc's own text fields
    // untypeable and leaked session keys to the remote host.
    const editableTarget = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        (el as HTMLElement).isContentEditable
      );
    };
    keyboard.onkeydown = (keysym: number) => {
      if (!this.isFocused() || editableTarget()) return true;
      this.send({ t: 'key', keysym, down: 1 });
      return false;
    };
    keyboard.onkeyup = (keysym: number) => {
      if (!this.isFocused() || editableTarget()) return true;
      this.send({ t: 'key', keysym, down: 0 });
      return false;
    };
    // (ResizeObserver + initial scaling happen in attach(): the observer
    // watches the *container*, which only exists once we are mounted.)
  }

  detach() {
    this.keyboard?.reset();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.wrapper && this.container && this.wrapper.parentElement === this.container) {
      this.container.removeChild(this.wrapper);
    }
    // The display DOM (and the last painted frame inside it) survives
    // detach: buildDom() keeps it, attach() re-mounts it. Only the
    // container binding goes away — isFocused() reads it through
    // container?.isConnected, so a detached session stops sending input.
    this.container = null;
  }

  private focused = true;
  setFocused(focused: boolean) {
    this.focused = focused;
    if (!focused) this.keyboard?.reset();
  }
  private isFocused() {
    return this.focused && !!this.container?.isConnected;
  }

  /** Fit the remote display to the container, or render 1:1. */
  setFitEnabled(enabled: boolean) {
    this.fit = enabled;
    this.applyScale();
  }
  private fit = true;

  /** Fit mode never scrolls; 1:1 mode gets scrollbars for big screens. */
  private applyOverflow() {
    if (this.container) this.container.style.overflow = this.fit ? 'hidden' : 'auto';
  }

  /**
   * Client-side "dark mode": the remote OS decides its own colors, so for
   * hosts/apps without dark mode we invert the picture where we render it.
   * `invert + hue-rotate` keeps hues sensible (blue stays blue) instead of
   * producing complementary garbage.
   *
   * Note: this only affects what the *user* sees. screenshot() reads the raw
   * canvas pixels, which CSS filters do not touch, so the model always sees
   * the true (un-inverted) colors and never gets confused by the toggle.
   */
  setDarkMode(enabled: boolean) {
    this.dark = enabled;
    this.applyDarkMode();
  }

  private applyDarkMode() {
    if (!this.wrapper) return;
    this.wrapper.style.filter = this.dark
      ? 'invert(0.93) hue-rotate(180deg) contrast(0.96)'
      : '';
  }

  private applyScale() {
    if (!this.canvas || !this.container) return;
    this.applyOverflow();
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!w || !h) return;
    if (!this.fit) {
      this.scale = 1;
    } else {
      const cw = this.container.clientWidth;
      const ch = this.container.clientHeight;
      if (!cw || !ch) return;
      this.scale = Math.min(cw / w, ch / h);
    }
    this.canvas.style.width = `${Math.round(w * this.scale)}px`;
    this.canvas.style.height = `${Math.round(h * this.scale)}px`;
    if (this.viewport) {
      this.viewport.style.width = this.canvas.style.width;
      this.viewport.style.height = this.canvas.style.height;
    }
    // The CSS cursor (installCursorShape) rides at its native size; the
    // browser positions it, so there is nothing sprite-like to rescale.
  }

  // ---- wire handling ----------------------------------------------------

  private send(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private handleResize(width: number, height: number): void {
    if (!width || !height) return;
    this.setRemoteSize(width, height);
    this.callbacks.onSize?.(width, height);
    this.applyScale();
  }

  /**
   * Binary server frames: [u8 kind][i32le x][i32le y][i32le w][i32le h][payload].
   * kind 1 = JPEG screen tile, kind 2 = PNG cursor shape (x/y = hotspot).
   */
  /**
   * Decode a tile image without ever wedging the draw chain: WebKitGTK's
   * createImageBitmap has been observed to hand out promises that never
   * settle for some JPEG blobs, which used to silently stop every later
   * tile (cursor shapes ride a different path and kept working). Race each
   * decode against a watchdog and fall back to an <img> decode, which uses
   * WebKit's regular image pipeline.
   */
  async decodeImage(blob: Blob): Promise<HTMLImageElement | ImageBitmap | null> {
    type Decoded = HTMLImageElement | ImageBitmap | null;
    const useBitmap = !this.decodeWedge && typeof createImageBitmap === 'function';
    if (useBitmap) {
      const raced: ImageBitmap | 'wedged' | null = await Promise.race([
        createImageBitmap(blob).catch(() => null),
        new Promise<'wedged'>((resolve) => setTimeout(() => resolve('wedged'), 3000)),
      ]);
      if (raced && raced !== 'wedged') return raced as ImageBitmap;
      if (raced === 'wedged') {
        this.decodeWedge++;
        this.debug(`decode watchdog fired (#${this.decodeWedge}) -> img fallback`);
      }
    }
    // Fallback: classic object-URL <img> decode via WebKit's image pipeline.
    const viaImg: Decoded = await new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      const t = setTimeout(() => {
        URL.revokeObjectURL(url);
        resolve(null);
      }, 4000);
      img.onload = () => {
        clearTimeout(t);
        resolve(img);
      };
      img.onerror = () => {
        clearTimeout(t);
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
    return viaImg;
  }
  private decodeWedge = 0;

  private handleBinary(buffer: ArrayBuffer): void {
    const view = new DataView(buffer);
    if (buffer.byteLength < 17) return;
    const kind = view.getUint8(0);
    if (this.tilesIn === 0 && kind !== 1) this.debug(`bin kind=${kind} ${buffer.byteLength}B`);
    const x = view.getInt32(1, true);
    const y = view.getInt32(5, true);
    const w = view.getInt32(9, true);
    const h = view.getInt32(13, true);
    const payload = buffer.slice(17);
    if (kind === 1) {
      const mime = this.isPng(payload) ? 'image/png' : 'image/jpeg';
      const blob = new Blob([payload], { type: mime });
      const n = ++this.tilesIn;
      if (n <= 8) this.debug(`tile #${n} ${w}x${h} ${payload.byteLength}B ${mime} ctx=${!!this.ctx}`);
      // Chain draws: decodes resolve asynchronously, and tiles must land
      // in the order the server sent them. decodeImage never wedges.
      this.drawChain = this.drawChain
        .then(async () => {
          const img = await this.decodeImage(blob);
          if (!this.ctx || !this.canvas) {
            if (n <= 8) this.debug(`tile no-ctx #${n}`);
            if (img && 'close' in img) img.close();
            return;
          }
          if (!img) {
            this.debug(`tile FAILED #${n}: undecodable`);
            return;
          }
          this.ctx.drawImage(img, x, y);
          if ('close' in img) img.close();
          // WebKitGTK non-standard: force the accelerated canvas to push its
          // backing store to the compositor (without this, draws can stay
          // invisible on some GPU paths).
          (this.canvas as HTMLCanvasElement & { requestPaint?: () => void }).requestPaint?.();
          if (n <= 8) {
            const px = this.ctx.getImageData(
              Math.min(x + (w >> 1), this.canvas.width - 1),
              Math.min(y + (h >> 1), this.canvas.height - 1),
              1,
              1,
            ).data;
            this.debug(`tile drawn #${n} via ${'close' in img ? 'bitmap' : 'img'} px=(${px[0]},${px[1]},${px[2]},${px[3]})`);
          }
        })
        .catch(() => {});
    } else if (kind === 2) {
      // A cursor *shape* PDU: install it as a CSS cursor with a baked
      // outline. Windows with cached pointers sends the shape once and
      // stops sending positions — the client is expected to draw it at the
      // local pointer position, which a CSS cursor does natively (perfect
      // tracking, honoured hotspot, nothing to skip or vanish).
      void this.installCursorShape(new Blob([payload], { type: 'image/png' }), x, y);
    }
  }

  private isPng(buf: ArrayBuffer): boolean {
    const v = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    return v.length === 4 && v[0] === 0x89 && v[1] === 0x50;
  }

  /**
   * Bake a solid outline in the opposite luminance of the cursor's own
   * pixels (white arrow -> black ring, black I-beam -> white ring) into a
   * padded copy of the shape, then install it as the wrapper's CSS cursor.
   */
  private async installCursorShape(blob: Blob, hotx: number, hoty: number): Promise<void> {
    try {
      const bmp = await createImageBitmap(blob);
      const pad = 2;
      const c = document.createElement('canvas');
      c.width = bmp.width + pad * 2;
      c.height = bmp.height + pad * 2;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        if ('close' in bmp) bmp.close();
        return;
      }
      ctx.drawImage(bmp, pad, pad);
      // Mean luminance of the opaque pixels picks the ring color.
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 128) {
          sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          n++;
        }
      }
      const ring = n > 0 && sum / n <= 127 ? '255,255,255' : '0,0,0';
      // Silhouette in the ring color, stamped in 8 directions around the
      // shape = solid 1px outline that follows every contour.
      const sil = document.createElement('canvas');
      sil.width = c.width;
      sil.height = c.height;
      const sctx = sil.getContext('2d');
      if (!sctx) {
        if ('close' in bmp) bmp.close();
        return;
      }
      sctx.drawImage(bmp, pad, pad);
      sctx.globalCompositeOperation = 'source-in';
      sctx.fillStyle = `rgb(${ring})`;
      sctx.fillRect(0, 0, sil.width, sil.height);
      ctx.clearRect(0, 0, c.width, c.height);
      for (const dx of [-1, 0, 1])
        for (const dy of [-1, 0, 1]) if (dx || dy) ctx.drawImage(sil, dx, dy);
      ctx.drawImage(bmp, pad, pad);
      if ('close' in bmp) bmp.close();
      const url = c.toDataURL('image/png');
      if (this.wrapper)
        this.wrapper.style.cursor = `url(${url}) ${Math.max(0, hotx) + pad} ${Math.max(0, hoty) + pad}, auto`;
    } catch {
      if (this.wrapper) this.wrapper.style.cursor = 'default';
    }
  }

  private applySystemCursor(name: string): void {
    if (!this.wrapper) return;
    this.wrapper.style.cursor = SYSTEM_CURSORS[name] ?? 'default';
  }

  // ---- Screenshot (for AI vision) ---------------------------------------

  /** True pixel size of the remote display (0x0 before the server says ready). */
  screenSize(): { width: number; height: number } {
    if (this.remoteW && this.remoteH) return { width: this.remoteW, height: this.remoteH };
    if (!this.canvas) return { width: 0, height: 0 };
    return { width: this.canvas.width, height: this.canvas.height };
  }

  /**
   * Crop of the current screen with red crosshairs on the given points, for
   * the AI approval preview — the same ground-truth idea as krdc-ai: the user
   * sees exactly where a pending click lands, not just the model's claim.
   * Points are in true display pixels. Returns a PNG data URL or null.
   */
  approvalPreview(points: { x: number; y: number }[]): string | null {
    if (!this.canvas || !points.length) return null;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!w || !h) return null;
    const full = this.canvas;

    // Bounds holding every marked point with margin (drags show both ends).
    const margin = 90;
    let minX = Math.min(...points.map((p) => p.x));
    let minY = Math.min(...points.map((p) => p.y));
    let maxX = Math.max(...points.map((p) => p.x));
    let maxY = Math.max(...points.map((p) => p.y));
    minX = Math.max(0, minX - margin);
    minY = Math.max(0, minY - margin);
    maxX = Math.min(w - 1, maxX + margin);
    maxY = Math.min(h - 1, maxY + margin);
    const cw = Math.max(1, maxX - minX + 1);
    const ch = Math.max(1, maxY - minY + 1);

    // Cap the crop so a huge drag doesn't shrink the target to nothing;
    // never upscale.
    const cap = Math.min(1, 220 / cw, 165 / ch);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cw * cap));
    canvas.height = Math.max(1, Math.round(ch * cap));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(full, minX, minY, cw, ch, 0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#ff2d2d';
    ctx.lineWidth = Math.max(1.5, cap * 2);
    for (const p of points) {
      const px = (p.x - minX) * cap;
      const py = (p.y - minY) * cap;
      const r = 12;
      ctx.beginPath();
      ctx.moveTo(px - r, py);
      ctx.lineTo(px + r, py);
      ctx.moveTo(px, py - r);
      ctx.lineTo(px, py + r);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, r * 0.55, 0, Math.PI * 2);
      ctx.stroke();
    }
    return canvas.toDataURL('image/png');
  }

  /** Render the remote screen to a PNG data URL, capped to maxWidth. */
  screenshot(maxWidth = 1280): { dataUrl: string; width: number; height: number } | null {
    if (!this.canvas) return null;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!w || !h) return null;

    const outW = Math.min(maxWidth, w);
    const outH = Math.round((outW / w) * h);
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(this.canvas, 0, 0, outW, outH);
    return { dataUrl: canvas.toDataURL('image/png'), width: outW, height: outH };
  }

  // ---- AI input injection -----------------------------------------------

  private markAiActive() {
    if (!this.aiActive) {
      this.aiActive = true;
      this.callbacks.onAiActivity?.(true);
    }
    if (this.aiTimer) clearTimeout(this.aiTimer);
    this.aiTimer = setTimeout(() => {
      this.aiActive = false;
      this.callbacks.onAiActivity?.(false);
    }, 2000);
  }

  private sendMouse(x: number, y: number, buttons: Partial<Record<MouseButton, boolean>>) {
    let mask = 0;
    if (buttons.left) mask |= MASK_LEFT;
    if (buttons.right) mask |= MASK_RIGHT;
    if (buttons.middle) mask |= MASK_MIDDLE;
    if (buttons.up) mask |= MASK_WHEEL_UP;
    if (buttons.down) mask |= MASK_WHEEL_DOWN;
    this.send({ t: 'mouse', x: Math.round(x), y: Math.round(y), mask });
    this.markAiActive();
  }

  async moveMouse(x: number, y: number): Promise<void> {
    this.sendMouse(x, y, {});
  }

  async click(x: number, y: number, button: MouseButton = 'left', double = false): Promise<void> {
    const buttons = { [button]: true } as Partial<Record<MouseButton, boolean>>;
    this.sendMouse(x, y, {});
    await delay(20);
    this.sendMouse(x, y, buttons);
    await delay(40);
    this.sendMouse(x, y, {});
    if (double) {
      await delay(80);
      this.sendMouse(x, y, buttons);
      await delay(40);
      this.sendMouse(x, y, {});
    }
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, button: MouseButton = 'left'): Promise<void> {
    const buttons = { [button]: true } as Partial<Record<MouseButton, boolean>>;
    this.sendMouse(fromX, fromY, {});
    await delay(20);
    this.sendMouse(fromX, fromY, buttons);
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const x = fromX + ((toX - fromX) * i) / steps;
      const y = fromY + ((toY - fromY) * i) / steps;
      this.sendMouse(x, y, buttons);
      await delay(12);
    }
    this.sendMouse(toX, toY, {});
  }

  async scroll(x: number, y: number, amount: number): Promise<void> {
    const button: MouseButton = amount > 0 ? 'up' : 'down';
    const clicks = Math.max(1, Math.min(10, Math.abs(Math.round(amount))));
    for (let i = 0; i < clicks; i++) {
      this.sendMouse(x, y, { [button]: true } as Partial<Record<MouseButton, boolean>>);
      await delay(30);
      this.sendMouse(x, y, {});
      await delay(40);
    }
  }

  async keyDown(keysym: number): Promise<void> {
    this.send({ t: 'key', keysym, down: 1 });
    this.markAiActive();
  }

  async keyUp(keysym: number): Promise<void> {
    this.send({ t: 'key', keysym, down: 0 });
    this.markAiActive();
  }

  /** Press and release a single keysym. */
  async pressKey(keysym: number): Promise<void> {
    await this.keyDown(keysym);
    await delay(25);
    await this.keyUp(keysym);
  }

  /** Press a chord like ["ctrl","alt","delete"] in order, release reversed. */
  async pressChord(keyNames: string[]): Promise<void> {
    const keysyms: number[] = [];
    for (const name of keyNames) {
      const ks = keyNameToKeysym(name);
      if (ks === null) continue;
      keysyms.push(ks);
      await this.keyDown(ks);
      await delay(15);
    }
    await delay(40);
    for (const ks of [...keysyms].reverse()) {
      await this.keyUp(ks);
      await delay(15);
    }
  }

  /** Type a string as individual keysym presses. */
  async typeText(text: string): Promise<void> {
    for (const char of text) {
      if (char === '\n') {
        await this.pressKey(0xff0d);
        continue;
      }
      if (char === '\t') {
        await this.pressKey(0xff09);
        continue;
      }
      const keysym = charToKeysym(char);
      if (!keysym) continue;
      await this.pressKey(keysym);
      await delay(18);
    }
  }

  /**
   * Send the Windows secure attention sequence. Over RDP a plain
   * Ctrl+Alt+Del scancode chord is what unlocks the server's lock screen
   * (which otherwise ignores every other keystroke). Uses the keysym engine
   * so the scancodes get the same treatment as human typing.
   */
  async sendCtrlAltDel(): Promise<void> {
    this.debug(`sendCtrlAltDel ws=${this.ws?.readyState}`);
    const chord = [0xffe3, 0xffe9, 0xffff]; // ctrl, alt, del
    for (const ks of chord) {
      await this.keyDown(ks);
      await delay(25);
    }
    await delay(80);
    for (const ks of [...chord].reverse()) {
      await this.keyUp(ks);
      await delay(25);
    }
  }

  /** Clipboard redirection is not wired into the native engine yet. */
  sendClipboardText(_text: string): boolean {
    return false;
  }

  disconnect() {
    this.disconnecting = true;
    if (this.aiTimer) clearTimeout(this.aiTimer);
    this.detach();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.setStatus('disconnected');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
