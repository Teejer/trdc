/** Shared types for trdc. */

export interface ConnectionProfile {
  id: string;
  name: string;
  /** Protocol id from the protocol registry (e.g. "rdp", "vnc"). */
  protocol: string;
  hostname: string;
  /** Protocol-specific parameters keyed by guacamole argument name. */
  params: Record<string, string>;
  /** Optional sort/group hint. */
  folder?: string;
  createdAt: number;
}

export type SessionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface SessionInfo {
  id: string;
  profileId: string;
  name: string;
  protocol: string;
  status: SessionStatus;
  error?: string;
  /** Remote display size in pixels. */
  width: number;
  height: number;
  /** True while the AI has input control (visual indicator). */
  aiActive: boolean;
}

export type FieldType = 'text' | 'password' | 'number' | 'boolean' | 'select';

export interface ProtocolField {
  /** Guacamole connection parameter name. */
  name: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  help?: string;
  default?: string;
  /** For select fields (mirrors the engine's open-message choices). */
  choices?: { value: string; label: string }[];
  /** Shown in the compact form; the rest live behind "Advanced". */
  advanced?: boolean;
}

export interface ProtocolDef {
  id: string;
  label: string;
  accent: string;
  defaultPort: number;
  /** Extra static guacamole parameters sent with every connection. */
  extraArgs?: Record<string, string>;
  /**
   * The password is asked at connect time and kept in memory only (never
   * written to connections.json); the editor shows no password field for
   * such protocols.
   */
  passwordAtConnect?: boolean;
  fields: ProtocolField[];
}

export interface AiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxToolRounds: number;
  /** Attach a screenshot automatically before each tool round. */
  autoScreenshot: boolean;
  /** Master switch for AI mouse/keyboard control. */
  inputControlEnabled: boolean;
  /**
   * Run ordinary action tools (clicks, typing) without asking. Dangerous
   * calls (destructive commands, lock/logout chords) ALWAYS ask.
   */
  autoExecute: boolean;
  systemPrompt: string;
}

export interface AppSettings {
  ai: AiSettings;
  sidebarWidth: number;
  aiPanelWidth: number;
  /** New sessions start with the dark-mode (invert) screen filter on. */
  darkModeDefault: boolean;
}

export const DEFAULT_SYSTEM_PROMPT = `You are trdc's built-in assistant with live control of the user's remote desktop sessions.

Rules:
- Use session_info and screenshot before acting so you know what is on screen.
- Click coordinates are pixels of the LAST screenshot you received; the tools map them to screen pixels for you. Never invent coordinates without a recent screenshot.
- Every click/drag needs a "target": a short name of what you are hitting, e.g. "OK button". The user approves actions from a zoomed preview of that spot.
- The user may be asked to Approve each action. If an action is denied, do not retry it without being asked.
- Prefer type_text for strings; for shortcuts use hotkey with one string like "ctrl+c" (works everywhere), or key_press.
- Act in small steps; take a screenshot after acting to verify the result.
- Summarize what you did when you are done.`;

export const DEFAULT_SETTINGS: AppSettings = {
  ai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
    temperature: 0.2,
    maxToolRounds: 12,
    autoScreenshot: true,
    inputControlEnabled: true,
    autoExecute: false,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  },
  sidebarWidth: 250,
  aiPanelWidth: 360,
  darkModeDefault: false,
};

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
