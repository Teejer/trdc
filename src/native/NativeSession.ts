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
  private cursorImg: HTMLImageElement | null = null;
  private cursorUrl: string | null = null;
  private keyboard: any = null;
  private resizeObserver: ResizeObserver | null = null;

  /** Serializes tile draws so out-of-order JPEG decodes land in send order. */
  private drawChain: Promise<void> = Promise.resolve();
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
    // The runtime password wins over anything (legacy) in params.
    msg.password = this.password;
    return msg;
  }

  /** Connect using the given bridge WebSocket URL. */
  connect(bridgeUrl: string): Promise<void> {
    if (this.ws) return Promise.resolve();
    this.setStatus('connecting');
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(bridgeUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let settled = false;

      ws.onopen = () => ws.send(JSON.stringify(this.buildOpenMessage()));
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
            this.setStatus('connected');
            this.callbacks.onSize?.(msg.width, msg.height);
            this.applyScale();
            resolve();
          } else if (msg.t === 'resize') {
            this.handleResize(msg.width, msg.height);
          } else if (msg.t === 'cursor-pos') {
            this.moveCursorSprite(msg.x, msg.y);
          } else if (msg.t === 'cursor-hide') {
            if (this.cursorImg) this.cursorImg.style.display = 'none';
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

  /** Attach the display to a container and start handling human input. */
  attach(container: HTMLElement) {
    this.container = container;

    const wrapper = document.createElement('div');
    wrapper.className = 'native-display';
    // Inner box sized exactly to the (scaled) canvas so the cursor sprite's
    // left/top map 1:1 to remote pixels; the wrapper flex-centers it.
    const viewport = document.createElement('div');
    viewport.className = 'native-viewport';
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, this.screenSize().width || 1);
    canvas.height = Math.max(1, this.screenSize().height || 1);
    const cursor = document.createElement('img');
    cursor.className = 'native-cursor';
    cursor.style.display = 'none';
    cursor.draggable = false;
    viewport.appendChild(canvas);
    viewport.appendChild(cursor);
    wrapper.appendChild(viewport);
    container.appendChild(wrapper);

    this.wrapper = wrapper;
    this.viewport = viewport;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cursorImg = cursor;

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
    keyboard.onkeydown = (keysym: number) => {
      if (!this.isFocused()) return false;
      this.send({ t: 'key', keysym, down: 1 });
      return false;
    };
    keyboard.onkeyup = (keysym: number) => {
      if (!this.isFocused()) return false;
      this.send({ t: 'key', keysym, down: 0 });
      return false;
    };

    this.resizeObserver = new ResizeObserver(() => this.applyScale());
    this.resizeObserver.observe(container);

    this.applyScale();
    this.applyDarkMode();
  }

  detach() {
    this.keyboard?.reset();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.wrapper && this.container && this.wrapper.parentElement === this.container) {
      this.container.removeChild(this.wrapper);
    }
    this.keyboard = null;
    this.wrapper = null;
    this.viewport = null;
    this.canvas = null;
    this.ctx = null;
    this.cursorImg = null;
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
    // Rescale the cursor sprite with the picture.
    if (this.cursorImg && this.cursorImg.dataset.w) {
      const cw = Number(this.cursorImg.dataset.w);
      const chh = Number(this.cursorImg.dataset.h);
      this.cursorImg.style.width = `${Math.round(cw * this.scale)}px`;
      this.cursorImg.style.height = `${Math.round(chh * this.scale)}px`;
    }
  }

  // ---- wire handling ----------------------------------------------------

  private send(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private handleResize(width: number, height: number): void {
    if (!this.canvas || !width || !height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.callbacks.onSize?.(width, height);
    this.applyScale();
  }

  /**
   * Binary server frames: [u8 kind][i32le x][i32le y][i32le w][i32le h][payload].
   * kind 1 = JPEG screen tile, kind 2 = PNG cursor shape (x/y = hotspot).
   */
  private handleBinary(buffer: ArrayBuffer): void {
    const view = new DataView(buffer);
    if (buffer.byteLength < 17) return;
    const kind = view.getUint8(0);
    const x = view.getInt32(1, true);
    const y = view.getInt32(5, true);
    const w = view.getInt32(9, true);
    const h = view.getInt32(13, true);
    const payload = buffer.slice(17);
    if (kind === 1) {
      const mime = this.isPng(payload) ? 'image/png' : 'image/jpeg';
      const blob = new Blob([payload], { type: mime });
      // Chain draws: createImageBitmap resolves asynchronously, and tiles
      // must land in the order the server sent them.
      this.drawChain = this.drawChain
        .then(async () => {
          try {
            const bmp = await createImageBitmap(blob);
            this.ctx?.drawImage(bmp, x, y);
            bmp.close();
          } catch {
            /* undecodable tile; the next frame boundary repaints over it */
          }
        })
        .catch(() => {});
    } else if (kind === 2) {
      const blob = new Blob([payload], { type: 'image/png' });
      if (this.cursorUrl) URL.revokeObjectURL(this.cursorUrl);
      this.cursorUrl = URL.createObjectURL(blob);
      const img = this.cursorImg;
      if (img) {
        img.src = this.cursorUrl;
        img.dataset.w = String(w);
        img.dataset.h = String(h);
        img.dataset.hotx = String(x);
        img.dataset.hoty = String(y);
        img.style.width = `${Math.round(w * this.scale)}px`;
        img.style.height = `${Math.round(h * this.scale)}px`;
        img.style.display = '';
        // The new shape becomes the visible cursor centered on the last
        // known position; a cursor-pos PDU follows if the server moves it.
        if (this.wrapper) this.wrapper.style.cursor = 'none';
      }
    }
  }

  private isPng(buf: ArrayBuffer): boolean {
    const v = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    return v.length === 4 && v[0] === 0x89 && v[1] === 0x50;
  }

  private moveCursorSprite(x: number, y: number): void {
    const img = this.cursorImg;
    if (!img || !this.wrapper) return;
    const hotx = Number(img.dataset.hotx ?? 0);
    const hoty = Number(img.dataset.hoty ?? 0);
    img.style.left = `${Math.round((x - hotx) * this.scale)}px`;
    img.style.top = `${Math.round((y - hoty) * this.scale)}px`;
    img.style.display = '';
    this.wrapper.style.cursor = 'none';
  }

  private applySystemCursor(name: string): void {
    if (!this.wrapper) return;
    if (this.cursorImg) this.cursorImg.style.display = 'none';
    this.wrapper.style.cursor = SYSTEM_CURSORS[name] ?? 'default';
  }

  // ---- Screenshot (for AI vision) ---------------------------------------

  /** True pixel size of the remote display (0x0 before first frame). */
  screenSize(): { width: number; height: number } {
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
    if (this.cursorUrl) {
      URL.revokeObjectURL(this.cursorUrl);
      this.cursorUrl = null;
    }
    this.setStatus('disconnected');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
