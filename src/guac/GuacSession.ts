/**
 * GuacSession - one live remote-desktop connection.
 *
 * Owns a Guacamole.Client over our WsTunnel, renders into a container
 * element, and exposes an input-injection + screenshot API that both the
 * human (via Guacamole.Mouse / Guacamole.Keyboard attached to the element)
 * and the AI (via the explicit methods) share. The remote host has a single
 * cursor, so whichever side sends input last simply moves it - exactly like
 * two humans sharing a machine.
 */
import Guacamole from 'guacamole-common-js';
import { WsTunnel } from './WsTunnel';
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
  backspace: 0xff08, delete: 0xffff, insert: 0xff63, home: 0xff50, end: 0xff57,
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

export class GuacSession {
  readonly profile: ConnectionProfile;
  readonly id: string;

  private client: any = null;
  private tunnel: WsTunnel | null = null;
  private container: HTMLElement | null = null;
  mouse: any = null;
  private keyboard: any = null;

  /** Shared synthetic mouse state used for AI-driven input. */
  private aiMouseState: any;
  private status: SessionStatus = 'connecting';
  private aiActive = false;
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  /** Current display scale factor (1 = 1:1). */
  scale = 1;
  /** Client-side dark-mode filter state (CSS invert on the display element). */
  private dark = false;

  callbacks: SessionCallbacks = {};

  constructor(profile: ConnectionProfile, id: string) {
    this.profile = profile;
    this.id = id;
    this.aiMouseState = new Guacamole.Mouse.State({ x: 0, y: 0 });
  }

  getStatus() {
    return this.status;
  }

  private setStatus(status: SessionStatus, error?: string) {
    this.status = status;
    this.callbacks.onStatus?.(status, error);
  }

  /** Build the guacamole parameter map from a connection profile. */
  private buildParameters(): Record<string, string> {
    const proto = getProtocol(this.profile.protocol);
    const params: Record<string, string> = {
      hostname: this.profile.hostname,
      ...(proto?.extraArgs ?? {}),
    };
    if (proto) {
      for (const field of proto.fields) {
        const value = this.profile.params[field.name];
        if (value !== undefined && value !== '') params[field.name] = value;
        else if (field.default !== undefined) params[field.name] = field.default;
      }
    }
    // Merge any extra unknown params verbatim.
    Object.assign(params, this.profile.params);
    return params;
  }

  /** Connect using the given bridge WebSocket URL. */
  async connect(bridgeUrl: string): Promise<void> {
    if (this.client) return;
    this.setStatus('connecting');

    const tunnel = new WsTunnel();
    this.tunnel = tunnel;
    const client = new Guacamole.Client(tunnel as any);
    this.client = client;

    client.onstatechange = (state: number) => {
      // Guacamole.Client.State values.
      switch (state) {
        case Guacamole.Client.State.CONNECTED:
          this.setStatus('connected');
          this.callbacks.onSize?.(
            client.getDisplay().getWidth(),
            client.getDisplay().getHeight(),
          );
          break;
        case Guacamole.Client.State.DISCONNECTED:
          this.setStatus('disconnected');
          break;
        default:
          break;
      }
    };

    client.onerror = (status: any) => {
      this.setStatus('error', status.message || 'The remote host reported an error.');
    };

    client.ondisplayresize = (width: number, height: number) => {
      this.callbacks.onSize?.(width, height);
      this.applyScale();
    };

    // Client.connect() drives the tunnel handshake and the keep-alive loop;
    // our tunnel reads the target (bridge URL + params) out of this argument.
    client.connect({ url: bridgeUrl, protocol: this.profile.protocol, parameters: this.buildParameters() });
    this.applyDarkMode();
  }

  /** Attach the display to a container and start handling human input. */
  attach(container: HTMLElement) {
    this.container = container;
    if (!this.client) return;
    const display = this.client.getDisplay();
    const element = display.getElement();
    element.style.position = 'absolute';
    element.style.inset = '0';
    container.appendChild(element);

    // Human mouse -> remote. sendMouseState with applyDisplayScale=true so
    // scaled (fit-to-window) coordinates map back to real pixels.
    const mouse = new Guacamole.Mouse(element);
    this.mouse = mouse;
    mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (state: any) => {
      display.sendMouseState(state, true);
    };

    // Human keyboard -> remote (only while this session is focused/visible).
    const keyboard = new Guacamole.Keyboard(window);
    this.keyboard = keyboard;
    keyboard.onkeydown = (keysym: number) => {
      if (!this.isFocused()) return false;
      display.sendKeyEvent(1, keysym);
      return false;
    };
    keyboard.onkeyup = (keysym: number) => {
      if (!this.isFocused()) return false;
      display.sendKeyEvent(0, keysym);
      return false;
    };

    this.applyScale();
    this.applyDarkMode();
  }

  detach() {
    this.keyboard?.reset();
    if (this.container && this.client) {
      const el = this.client.getDisplay().getElement();
      if (el.parentElement === this.container) this.container.removeChild(el);
    }
    this.mouse = null;
    this.container = null;
  }

  private focused = true;
  setFocused(focused: boolean) {
    this.focused = focused;
    if (!focused) this.keyboard?.reset();
  }
  private isFocused() {
    return this.focused && this.container?.isConnected;
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
   * Note: this only affects what the *user* sees. The AI's screenshot() reads
   * the raw layer canvas, which CSS filters do not touch, so the model always
   * sees the true (un-inverted) colors and never gets confused by the toggle.
   */
  setDarkMode(enabled: boolean) {
    this.dark = enabled;
    this.applyDarkMode();
  }

  private applyDarkMode() {
    if (!this.client) return;
    const element = this.client.getDisplay().getElement() as HTMLElement | null;
    if (!element) return;
    element.style.filter = this.dark
      ? 'invert(0.93) hue-rotate(180deg) contrast(0.96)'
      : '';
  }

  private applyScale() {
    if (!this.client || !this.container) return;
    const display = this.client.getDisplay();
    const w = display.getWidth();
    const h = display.getHeight();
    if (!w || !h) return;
    if (!this.fit) {
      display.scale(1);
      this.scale = 1;
      return;
    }
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    if (!cw || !ch) return;
    const scale = Math.min(cw / w, ch / h);
    this.scale = scale;
    display.scale(scale);
  }

  // ---- Screenshot (for AI vision) -------------------------------------

  /** True pixel size of the remote display (0x0 before first frame). */
  screenSize(): { width: number; height: number } {
    if (!this.client) return { width: 0, height: 0 };
    const display = this.client.getDisplay();
    return { width: display.getWidth(), height: display.getHeight() };
  }

  /**
   * Crop of the current screen with red crosshairs on the given points, for
   * the AI approval preview — the same ground-truth idea as krdc-ai: the user
   * sees exactly where a pending click lands, not just the model's claim.
   * Points are in true display pixels. Returns a PNG data URL or null.
   */
  approvalPreview(points: { x: number; y: number }[]): string | null {
    if (!this.client || !points.length) return null;
    const display = this.client.getDisplay();
    const w = display.getWidth();
    const h = display.getHeight();
    if (!w || !h) return null;
    const full = display.getDefaultLayer().toCanvas();

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
    if (!this.client) return null;
    const display = this.client.getDisplay();
    const w = display.getWidth();
    const h = display.getHeight();
    if (!w || !h) return null;

    const layer = display.getDefaultLayer();
    const source = layer.toCanvas();

    const outW = Math.min(maxWidth, w);
    const outH = Math.round((outW / w) * h);
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, outW, outH);
    return { dataUrl: canvas.toDataURL('image/png'), width: outW, height: outH };
  }

  // ---- AI input injection ---------------------------------------------

  private get display(): any | null {
    return this.client ? this.client.getDisplay() : null;
  }

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
    const display = this.display;
    if (!display) return;
    const state = this.aiMouseState;
    state.x = Math.round(x);
    state.y = Math.round(y);
    state.left = !!buttons.left;
    state.middle = !!buttons.middle;
    state.right = !!buttons.right;
    state.up = !!buttons.up;
    state.down = !!buttons.down;
    display.sendMouseState(state, false);
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
    this.display?.sendKeyEvent(1, keysym);
    this.markAiActive();
  }

  async keyUp(keysym: number): Promise<void> {
    this.display?.sendKeyEvent(0, keysym);
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

  /** Send text via the clipboard (more reliable for complex/unicode text). */
  sendClipboardText(text: string): void {
    if (!this.client) return;
    try {
      const stream = this.client.createClipboardStream('text/plain');
      const writer = new Guacamole.StringWriter(stream);
      writer.sendText(text);
      writer.sendEnd();
    } catch {
      /* clipboard stream unsupported */
    }
  }

  disconnect() {
    if (this.aiTimer) clearTimeout(this.aiTimer);
    this.detach();
    try {
      this.client?.disconnect();
    } catch {
      /* already closed */
    }
    this.tunnel?.disconnect();
    this.client = null;
    this.tunnel = null;
    this.setStatus('disconnected');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
