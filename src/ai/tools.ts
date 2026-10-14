/**
 * The tools the AI uses to operate a remote desktop. Each tool acts on the
 * currently-active session, resolved lazily via the supplied provider so the
 * AI always targets whichever tab the user is looking at.
 */
import type { NativeSession } from '../native/NativeSession';
import { keyNameToKeysym } from '../native/NativeSession';
import type { AgentToolResult, ToolDefinition, ToolExecutor } from './openai';

export interface ToolContext {
  /** The session the AI should act on, or null if none is connected. */
  getActiveSession: () => NativeSession | null;
  /** Master switch from settings - when false, input tools are refused. */
  inputControlEnabled: () => boolean;
  /** Whether the attached model accepts images. */
  supportsVision: () => boolean;
  /**
   * Size of the last screenshot image sent to the model (its coordinate
   * space), or null if none yet. Pointer coordinates the model returns are
   * in this space and get mapped to display pixels before injection — the
   * model cannot be trusted with that arithmetic (krdc-ai lesson).
   */
  getSentImageSize: () => { width: number; height: number } | null;
  setSentImageSize: (size: { width: number; height: number } | null) => void;
}

const SCREENSHOT: ToolDefinition = {
  type: 'function',
  function: {
    name: 'screenshot',
    description:
      'Capture the current remote screen as an image so you can see what is on it. ' +
      'Call this before and after actions to orient yourself and verify results.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const SESSION_INFO: ToolDefinition = {
  type: 'function',
  function: {
    name: 'session_info',
    description:
      'Report the active session: connection name, protocol, status, and the exact ' +
      'pixel dimensions of the remote display. Call this first to learn the coordinate space.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const MOUSE_MOVE: ToolDefinition = {
  type: 'function',
  function: {
    name: 'mouse_move',
    description: 'Move the remote mouse pointer to an absolute (x, y) pixel position.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X pixel from the left edge.' },
        y: { type: 'number', description: 'Y pixel from the top edge.' },
      },
      required: ['x', 'y'],
    },
  },
};

const MOUSE_CLICK: ToolDefinition = {
  type: 'function',
  function: {
    name: 'mouse_click',
    description:
      'Click on the remote desktop. If x and y are given the pointer moves there first. ' +
      'Use button="left" by default; set double=true to double-click. ' +
      'Coordinates are in pixels of the LAST screenshot you received.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X pixel to click at (optional).' },
        y: { type: 'number', description: 'Y pixel to click at (optional).' },
        button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Mouse button (default left).' },
        double: { type: 'boolean', description: 'Double-click instead of single-click.' },
        target: { type: 'string', description: 'Short name of what you are clicking, e.g. "OK button". Required.' },
      },
      required: ['target'],
    },
  },
};

const MOUSE_DRAG: ToolDefinition = {
  type: 'function',
  function: {
    name: 'mouse_drag',
    description:
      'Press at (fromX, fromY), drag to (toX, toY), and release. ' +
      'Coordinates are in pixels of the LAST screenshot you received.',
    parameters: {
      type: 'object',
      properties: {
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
        target: { type: 'string', description: 'Short name of what you are dragging, e.g. "file icon to folder". Required.' },
      },
      required: ['fromX', 'fromY', 'toX', 'toY', 'target'],
    },
  },
};

const SCROLL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'scroll',
    description: 'Scroll the mouse wheel at (x, y). Positive amount scrolls up, negative scrolls down.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        amount: { type: 'number', description: 'Wheel clicks; sign sets direction.' },
      },
      required: ['x', 'y', 'amount'],
    },
  },
};

const WAIT: ToolDefinition = {
  type: 'function',
  function: {
    name: 'wait',
    description: 'Pause for a few seconds, e.g. while a dialog or installer loads. Then take a screenshot.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Seconds to wait (max 15).' },
      },
      required: ['seconds'],
    },
  },
};

const TYPE_TEXT: ToolDefinition = {
  type: 'function',
  function: {
    name: 'type_text',
    description:
      'Type a string of text on the remote host as keystrokes. Use this for typing into ' +
      'fields, terminals, dialogs, etc. Do not include modifier syntax here; use key_press for shortcuts.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The literal text to type.' } },
      required: ['text'],
    },
  },
};

const KEY_PRESS: ToolDefinition = {
  type: 'function',
  function: {
    name: 'key_press',
    description:
      'Press a key or a key chord. For a shortcut you may pass the whole chord as one string in "key" ' +
      '(e.g. "ctrl+a", "win+e") or pass the names together in "keys" (modifiers first). ' +
      'Names: enter, tab, backtab, escape, backspace, delete, home, end, pageup, pagedown, up, down, ' +
      'left, right, space, win, ctrl, shift, alt, f1-f12, or any single character.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'A single key name, or a chord string like "ctrl+a".' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'A chord pressed together, modifiers first.',
        },
      },
      required: [],
    },
  },
};

/**
 * String-chord twin of key_press. llama.cpp-style backends frequently drop
 * ARRAY tool arguments (no items schema / unreliable parsers), so models on
 * those backends could never send a modifier list; a plain string always
 * survives (krdc-ai lesson).
 */
const HOTKEY: ToolDefinition = {
  type: 'function',
  function: {
    name: 'hotkey',
    description:
      'Press a keyboard shortcut given as one string, modifiers first, joined with "+": ' +
      '"ctrl+a", "ctrl+shift+esc", "win+e", "alt+tab". Use this for any combination. ' +
      '"ctrl+alt+delete" wakes a locked Windows host (the lock screen ignores all other keys).',
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'The chord, e.g. "ctrl+c".' },
      },
      required: ['keys'],
    },
  },
};

const CLIPBOARD_PASTE: ToolDefinition = {
  type: 'function',
  function: {
    name: 'clipboard_paste',
    description:
      'Send text to the remote clipboard, then paste it with Ctrl+V (or Cmd+V on macOS hosts). ' +
      'Prefer this over type_text for long or complex text. Returns the text so you can paste manually if needed.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to place on the clipboard.' },
        autoPaste: { type: 'boolean', description: 'Also send the paste shortcut (default true).' },
        mac: { type: 'boolean', description: 'Use Cmd+V instead of Ctrl+V.' },
      },
      required: ['text'],
    },
  },
};

export const SESSION_TOOLS: ToolDefinition[] = [
  SESSION_INFO,
  SCREENSHOT,
  MOUSE_MOVE,
  MOUSE_CLICK,
  MOUSE_DRAG,
  SCROLL,
  TYPE_TEXT,
  KEY_PRESS,
  HOTKEY,
  CLIPBOARD_PASTE,
  WAIT,
];

function err(message: string): AgentToolResult {
  return { content: message, isError: true, summary: message };
}

function requireSession(ctx: ToolContext): NativeSession | AgentToolResult {
  const session = ctx.getActiveSession();
  if (!session) return err('No active session. Ask the user to open a connection first.');
  return session;
}

function requireInput(ctx: ToolContext): true | AgentToolResult {
  if (!ctx.inputControlEnabled())
    return err('Input control is disabled in AI settings. The user must enable "Allow AI to control mouse and keyboard".');
  return true;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

/**
 * Read and validate a point the model wants to act on.
 *
 * Two krdc-ai lessons baked in:
 * 1. Models with no screenshot answer coordinates with refusal placeholders
 *    like "[redacted]"; Number() would turn that into 0 and silently click
 *    (0,0). Coordinates must be real finite numbers.
 * 2. The model reads coordinates off a DOWNSCALED screenshot; we map them to
 *    true display pixels ourselves instead of trusting its arithmetic.
 */
function readPoint(
  ctx: ToolContext,
  args: Record<string, unknown>,
  xName: string,
  yName: string,
  screen: { width: number; height: number },
): { x: number; y: number } | AgentToolResult {
  const rawX = args[xName];
  const rawY = args[yName];
  const isNum = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
  if (!isNum(rawX) || !isNum(rawY)) {
    return err(`"${xName}" and "${yName}" must be numeric pixel coordinates from a screenshot you received. Take a screenshot first.`);
  }
  const sent = ctx.getSentImageSize();
  if (sent && sent.width > 0 && sent.height > 0) {
    if (rawX < 0 || rawY < 0 || rawX > sent.width + 8 || rawY > sent.height + 8) {
      return err(
        `(${rawX}, ${rawY}) is outside the last screenshot (${sent.width}x${sent.height}). ` +
          'Coordinates must be in the pixel space of the screenshot you last received. Take a fresh screenshot if unsure.',
      );
    }
    if (sent.width !== screen.width || sent.height !== screen.height) {
      return {
        x: Math.round((rawX * screen.width) / sent.width),
        y: Math.round((rawY * screen.height) / sent.height),
      };
    }
    return { x: Math.round(rawX), y: Math.round(rawY) };
  }
  // No screenshot sent: coordinates are in display pixels; validate against
  // the screen instead.
  if (rawX < 0 || rawY < 0 || rawX > screen.width || rawY > screen.height) {
    return err(`(${rawX}, ${rawY}) is outside the remote display (${screen.width}x${screen.height}).`);
  }
  return { x: Math.round(rawX), y: Math.round(rawY) };
}

/** Split a chord string like "ctrl+shift+esc" into key names, modifiers first. */
export function splitChord(input: string): string[] {
  return input
    .split('+')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const MODIFIER_NAMES = new Set(['ctrl', 'control', 'alt', 'shift', 'win', 'meta', 'super', 'cmd', 'command', 'option', 'opt', 'lwin', 'rwin']);

/** Build an executor bound to a live session provider. */
export function createToolExecutor(ctx: ToolContext): ToolExecutor {
  return async (name, args): Promise<AgentToolResult> => {
    // Read-only tools don't need input control enabled.
    if (name === 'session_info') {
      const s = requireSession(ctx);
      if (typeof s === 'string' || 'content' in s) return s as AgentToolResult;
      const screen = s.screenSize();
      return {
        content: JSON.stringify({
          name: s.profile.name,
          protocol: s.profile.protocol,
          hostname: s.profile.hostname,
          status: s.getStatus(),
          screen_width: screen.width,
          screen_height: screen.height,
          note: 'Pointer tools take coordinates from the last screenshot you received; the tools map them to screen pixels for you.',
        }),
        summary: `session: ${s.profile.name}`,
      };
    }

    if (name === 'screenshot') {
      const s = requireSession(ctx);
      if ('content' in s) return s as AgentToolResult;
      if (!ctx.supportsVision())
        return { content: 'The selected model does not support image input, so screenshots are disabled.', isError: true };
      const shot = s.screenshot(1600);
      if (!shot) return err('Nothing to capture yet (display not ready).');
      // Remember the image's size: it is the coordinate space the model will
      // quote back to us for clicks.
      ctx.setSentImageSize({ width: shot.width, height: shot.height });
      const screen = s.screenSize();
      return {
        content:
          `Screenshot ${shot.width}x${shot.height} of remote screen ${screen.width}x${screen.height}. ` +
          'Quote pixel coordinates from this image; the pointer tools map them to screen pixels for you.',
        imageDataUrl: shot.dataUrl,
        summary: `screenshot ${shot.width}x${shot.height}`,
      };
    }

    if (name === 'wait') {
      const seconds = Math.min(15, Math.max(0.2, num(args.seconds, 1)));
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return { content: 'ok', summary: `waited ${seconds}s` };
    }

    // Everything below mutates the remote session.
    const guard = requireInput(ctx);
    if (guard !== true) return guard;
    const s = requireSession(ctx);
    if ('content' in s) return s as AgentToolResult;

    switch (name) {
      case 'mouse_move': {
        const p = readPoint(ctx, args, 'x', 'y', s.screenSize());
        if ('content' in p) return p;
        await s.moveMouse(p.x, p.y);
        return { content: 'ok', summary: `move (${p.x}, ${p.y})` };
      }
      case 'mouse_click': {
        const button = (args.button as 'left' | 'middle' | 'right') ?? 'left';
        const double = !!args.double;
        if (args.x !== undefined && args.y !== undefined) {
          const p = readPoint(ctx, args, 'x', 'y', s.screenSize());
          if ('content' in p) return p;
          await s.click(p.x, p.y, button, double);
          return { content: 'ok', summary: `${double ? 'double-' : ''}${button}-click (${p.x}, ${p.y})` };
        }
        await s.click(0, 0, button, double).catch(() => {});
        return { content: 'Clicked at the current pointer position.', summary: `${button}-click (current)` };
      }
      case 'mouse_drag': {
        const screen = s.screenSize();
        const from = readPoint(ctx, args, 'fromX', 'fromY', screen);
        if ('content' in from) return from;
        const to = readPoint(ctx, args, 'toX', 'toY', screen);
        if ('content' in to) return to;
        const button = (args.button as 'left' | 'middle' | 'right') ?? 'left';
        await s.drag(from.x, from.y, to.x, to.y, button);
        return { content: 'ok', summary: `drag (${from.x}, ${from.y}) → (${to.x}, ${to.y})` };
      }
      case 'scroll': {
        const p = readPoint(ctx, args, 'x', 'y', s.screenSize());
        if ('content' in p) return p;
        const amount = num(args.amount, 3);
        await s.scroll(p.x, p.y, amount);
        return { content: 'ok', summary: `scroll ${amount > 0 ? 'up' : 'down'} @(${p.x}, ${p.y})` };
      }
      case 'type_text': {
        const text = String(args.text ?? '');
        if (!text) return err('Nothing to type.');
        await s.typeText(text);
        return { content: 'ok', summary: `typed ${text.length} char${text.length === 1 ? '' : 's'}` };
      }
      case 'key_press': {
        // Accept a chord string in "key" ("ctrl+a") as well as the keys array.
        let keys: string[] = Array.isArray(args.keys)
          ? (args.keys as unknown[]).map(String)
          : typeof args.key === 'string'
            ? [args.key]
            : [];
        if (keys.length === 1 && keys[0].includes('+')) keys = splitChord(keys[0]);
        if (!keys.length) return err('Provide "key" (may be "ctrl+a") or "keys".');
        const resolved = keys.map((k) => ({ k, ks: keyNameToKeysym(k) }));
        const bad = resolved.find((r) => r.ks === null);
        if (bad) return err(`Unknown key "${bad.k}".`);
        if (resolved.length === 1) {
          await s.pressKey(resolved[0].ks!);
          return { content: 'ok', summary: `key ${resolved[0].k}` };
        }
        await s.pressChord(resolved.map((r) => r.k));
        return { content: 'ok', summary: `chord ${resolved.map((r) => r.k).join('+')}` };
      }
      case 'hotkey': {
        const raw = args.keys;
        const keys = (Array.isArray(raw) ? (raw as unknown[]).map(String) : typeof raw === 'string' ? [raw] : [])
          .flatMap(splitChord);
        if (!keys.length) return err('Provide "keys" as one chord string, e.g. "ctrl+c".');
        // Modifiers first (models sometimes write "a+ctrl"); keyNameToKeysym
        // resolves the order-independent hold/release sequence in pressChord.
        keys.sort((a, b) => Number(MODIFIER_NAMES.has(b)) - Number(MODIFIER_NAMES.has(a)));
        const resolved = keys.map((k) => ({ k, ks: keyNameToKeysym(k) }));
        const bad = resolved.find((r) => r.ks === null);
        if (bad) return err(`Unknown key "${bad.k}" in chord "${String(raw)}".`);
        await s.pressChord(resolved.map((r) => r.k));
        return { content: 'ok', summary: `hotkey ${resolved.map((r) => r.k).join('+')}` };
      }
      case 'clipboard_paste': {
        const text = String(args.text ?? '');
        if (!text) return err('Nothing to paste.');
        if (!s.sendClipboardText(text)) {
          // The native engine has no clipboard channel yet; typing the text
          // as keystrokes is slower but works the same for text inputs.
          await s.typeText(text);
          return {
            content: 'Clipboard redirection is unavailable; the text was typed directly instead.',
            summary: `typed ${text.length} chars (no clipboard)`,
          };
        }
        const autoPaste = args.autoPaste !== false;
        if (autoPaste) {
          await s.pressChord(args.mac ? ['super', 'v'] : ['ctrl', 'v']);
          return { content: 'Text sent to clipboard and pasted.', summary: `paste ${text.length} chars` };
        }
        return { content: 'Text sent to the remote clipboard.', summary: `clipboard ${text.length} chars` };
      }
      default:
        return err(`Unknown tool "${name}".`);
    }
  };
}
