/**
 * AppStore - the single external store for trdc.
 *
 * Holds the persisted pieces (connection profiles, settings) plus the live,
 * non-serializable session objects and per-tab AI conversations. React reads
 * it through the hooks at the bottom (useSyncExternalStore); imperative code
 * (the AI tool executor, event handlers) calls its methods directly.
 */
import { NativeSession } from '../native/NativeSession';
import { DEFAULT_SETTINGS, newId } from '../types';
import type {
  AppSettings,
  AiSettings,
  ConnectionProfile,
  SessionStatus,
} from '../types';
import { getProtocol } from '../protocols';
import {
  bridgePort,
  readConfig,
  writeConfig,
} from '../lib/tauri';
import { runAgent, listModels } from '../ai/openai';
import type { ChatMessage, ModelInfo } from '../ai/openai';
import { createToolExecutor, SESSION_TOOLS } from '../ai/tools';

export interface TabState {
  id: string;
  profileId: string;
  name: string;
  protocol: string;
  status: SessionStatus;
  error?: string;
  width: number;
  height: number;
  aiActive: boolean;
  fit: boolean;
  /** Client-side dark-mode filter (invert) applied to the remote screen. */
  dark: boolean;
}

export type AiStatus = 'idle' | 'thinking' | 'running-tool' | 'awaiting-approval' | 'error';

export interface AiActivity {
  kind: 'tool' | 'text' | 'error' | 'info';
  label: string;
  detail?: string;
  time: number;
}

export interface PendingApproval {
  name: string;
  args: Record<string, unknown>;
  risk: 'safe' | 'action' | 'dangerous';
  /** One-line description of what would happen. */
  summary: string;
  /** Why it asks even with auto-execute on (dangerous calls only). */
  reason: string;
  /** Crop of the live screen with crosshairs on the click points, if any. */
  preview: string | null;
}

export interface Conversation {
  messages: ChatMessage[];
  activity: AiActivity[];
  streaming: string;
  status: AiStatus;
  models: ModelInfo[];
  modelsError?: string;
  testResult?: { ok: boolean; message: string };
  /** Tool call waiting for the user's Approve/Deny, if any. */
  pendingApproval?: PendingApproval;
  /**
   * Size of the last screenshot image sent to the model; the coordinate
   * space it quotes click positions in. Persisted per conversation like in
   * krdc-ai so a click two turns after a screenshot still maps correctly.
   */
  sentImageSize: { width: number; height: number } | null;
}

const CONNECTIONS_FILE = 'connections.json';
const SETTINGS_FILE = 'settings.json';

function emptyConversation(): Conversation {
  return { messages: [], activity: [], streaming: '', status: 'idle', models: [], sentImageSize: null };
}

export class AppStore {
  settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  private initPromise: Promise<void> | null = null;
  connections: ConnectionProfile[] = [];
  tabs: TabState[] = [];
  activeTabId: string | null = null;
  conversations: Record<string, Conversation> = {};
  bridgeWsPort = 0;
  /** Global "AI takes over input" master toggle, mirrors settings but live. */
  aiInputEnabled = true;

  /**
   * Non-null while a connect-time password prompt is on screen. There is
   * deliberately no password cache: every connect and reconnect prompts
   * (the typed password lives only long enough to send the one RDP open
   * frame, then NativeSession clears it). saveConnections() also scrubs
   * any legacy password out of the on-disk profiles. AI API keys are
   * different and do persist.
   */
  pendingPassword: { profileId: string; prompt: string } | null = null;
  private passwordResolvers = new Map<string, (pw: string | null) => void>();

  private sessions = new Map<string, NativeSession>();
  private abortControllers = new Map<string, AbortController>();
  /** Resolve functions for tool calls waiting on Approve/Deny. */
  private approvalResolvers = new Map<string, (ok: boolean) => void>();
  private listeners = new Set<() => void>();
  private snapshotCache: AppStore | null = null;
  private snapshotVersion = 0;
  private initialized = false;

  // ---- reactivity ------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): AppStore => {
    return this.snapshotCache ?? this;
  };

  private emit() {
    this.snapshotVersion++;
    this.snapshotCache = Object.create(AppStore.prototype) as AppStore;
    Object.assign(this.snapshotCache, this);
    this.snapshotCache.snapshotVersion = this.snapshotVersion;
    for (const fn of this.listeners) fn();
  }

  // ---- init ------------------------------------------------------------

  async init(): Promise<void> {
    if (this.initialized) return this.initPromise ?? Promise.resolve();
    this.initialized = true;
    this.initPromise = (async () => {

    const [settings, connections] = await Promise.all([
      readConfig<Partial<AppSettings>>(SETTINGS_FILE),
      readConfig<ConnectionProfile[]>(CONNECTIONS_FILE),
    ]);
    if (settings) {
      this.settings = {
        ...structuredClone(DEFAULT_SETTINGS),
        ...settings,
        ai: { ...DEFAULT_SETTINGS.ai, ...(settings.ai ?? {}) },
      };
    }
    if (Array.isArray(connections)) {
      // Older versions could save the RDP password into the profile file.
      // Move any such password into the in-memory map (so existing
      // connections keep working this run) and re-persist the scrubbed
      // list, getting the secret back off disk.
      let scrubbed = false;
      this.connections = connections.map((c) => {
        if (!c.params || !('password' in c.params)) return c;
        scrubbed = true;
        // Just delete it: a password scrubbed off disk is NOT promoted
        // into a live credential — the next connect prompts for it.
        const { password: _gone, ...rest } = c.params;
        return { ...c, params: rest };
      });
      if (scrubbed) void this.saveConnections();
    }
    this.aiInputEnabled = this.settings.ai.inputControlEnabled;

    try {
      this.bridgeWsPort = await bridgePort();
    } catch {
      this.bridgeWsPort = 0;
    }
    this.emit();
    })();
    return this.initPromise;
  }

  // ---- settings --------------------------------------------------------

  updateSettings(patch: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...patch };
    if (patch.ai) {
      this.settings.ai = { ...this.settings.ai, ...patch.ai };
      this.aiInputEnabled = this.settings.ai.inputControlEnabled;
    }
    void writeConfig(SETTINGS_FILE, this.settings);
    this.emit();
  }

  updateAiSettings(patch: Partial<AiSettings>): void {
    this.updateSettings({ ai: { ...this.settings.ai, ...patch } });
  }

  // ---- connections -----------------------------------------------------

  addConnection(partial: Partial<ConnectionProfile>): ConnectionProfile {
    const profile: ConnectionProfile = {
      id: newId(),
      name: partial.name?.trim() || 'New connection',
      protocol: partial.protocol || 'rdp',
      hostname: partial.hostname || '',
      params: partial.params || {},
      folder: partial.folder,
      createdAt: Date.now(),
    };
    this.connections = [...this.connections, profile];
    void this.saveConnections();
    this.emit();
    return profile;
  }

  updateConnection(id: string, patch: Partial<ConnectionProfile>): void {
    this.connections = this.connections.map((c) => (c.id === id ? { ...c, ...patch } : c));
    void this.saveConnections();
    // Reflect renames into any open tab.
    const tab = this.tabs.find((t) => t.profileId === id);
    if (tab && patch.name) {
      tab.name = patch.name;
      this.sessions.get(tab.id)?.callbacks && (this.sessions.get(tab.id)!.profile.name = patch.name);
    }
    this.emit();
  }

  deleteConnection(id: string): void {
    const tab = this.tabs.find((t) => t.profileId === id);
    if (tab) this.closeSession(tab.id);
    this.connections = this.connections.filter((c) => c.id !== id);
    void this.saveConnections();
    this.emit();
  }

  private async saveConnections(): Promise<void> {
    try {
      // Belt and braces: passwords must never reach the profile file, so
      // strip the key from every profile before writing.
      const clean = this.connections.map((c) => {
        if (!c.params || !('password' in c.params)) return c;
        const { password: _gone, ...rest } = c.params;
        return { ...c, params: rest };
      });
      await writeConfig(CONNECTIONS_FILE, clean);
    } catch (e) {
      console.error('failed to save connections', e);
    }
  }

  // ---- connect-time passwords -------------------------------------------

  /**
   * The password to authenticate `profile` with. Protocols that prompt at
   * connect time ALWAYS ask — nothing is ever cached, not even in memory,
   * so a second connect or a reconnect prompts again. Resolves null when
   * the user cancels the prompt (the caller must then not connect); for
   * protocols without prompts it resolves undefined.
   */
  private async askPassword(profile: ConnectionProfile): Promise<string | null | undefined> {
    const proto = getProtocol(profile.protocol);
    if (!proto?.passwordAtConnect) return undefined;
    return new Promise<string | null | undefined>((resolve) => {
      this.passwordResolvers.set(profile.id, (pw) => {
        this.pendingPassword = null;
        this.emit();
        resolve(pw);
      });
      const params = profile.params ?? {};
      const who = params.username ? `${params.username}@` : '';
      this.pendingPassword = {
        profileId: profile.id,
        prompt: `Password for ${who}${profile.hostname}`,
      };
      this.emit();
    });
  }

  /** Answer the on-screen password prompt (null = cancel). */
  resolvePassword(pw: string | null): void {
    const pending = this.pendingPassword;
    if (!pending) return;
    const resolve = this.passwordResolvers.get(pending.profileId);
    this.passwordResolvers.delete(pending.profileId);
    resolve?.(pw);
  }

  // ---- sessions / tabs -------------------------------------------------

  private bridgeUrl(): string {
    return `ws://127.0.0.1:${this.bridgeWsPort}/`;
  }

  async openSession(profileId: string): Promise<string | null> {
    const profile = this.connections.find((c) => c.id === profileId);
    if (!profile) return null;

    // Reuse an existing tab for this profile.
    const existing = this.tabs.find((t) => t.profileId === profileId);
    if (existing) {
      this.setActiveTab(existing.id);
      return existing.id;
    }

    // Connect-time password (memory only). Cancel = no tab.
    const pw = await this.askPassword(profile);
    if (pw === null) return null;

    const id = newId();
    const session = new NativeSession(profile, id);
    session.password = pw ?? '';
    const tab: TabState = {
      id,
      profileId,
      name: profile.name,
      protocol: profile.protocol,
      status: 'connecting',
      width: 0,
      height: 0,
      aiActive: false,
      fit: true,
      dark: this.settings.darkModeDefault,
    };
    session.callbacks = {
      onStatus: (status, error) => {
        const t = this.tabs.find((x) => x.id === id);
        if (t) {
          t.status = status;
          t.error = error;
          this.emit();
        }
      },
      onSize: (width, height) => {
        const t = this.tabs.find((x) => x.id === id);
        if (t) {
          t.width = width;
          t.height = height;
          this.emit();
        }
      },
      onAiActivity: (active) => {
        const t = this.tabs.find((x) => x.id === id);
        if (t) {
          t.aiActive = active;
          this.emit();
        }
      },
    };

    this.sessions.set(id, session);
    session.setDarkMode(tab.dark);
    this.tabs = [...this.tabs, tab];
    this.conversations[id] = emptyConversation();
    this.activeTabId = id;
    this.emit();

    try {
      await session.connect(this.bridgeUrl());
    } catch (e) {
      const t = this.tabs.find((x) => x.id === id);
      if (t) {
        t.status = 'error';
        t.error = String(e);
        this.emit();
      }
    }
    return id;
  }

  getSession(tabId: string | null): NativeSession | null {
    if (!tabId) return null;
    return this.sessions.get(tabId) ?? null;
  }

  getActiveSession(): NativeSession | null {
    return this.getSession(this.activeTabId);
  }

  getActiveTab(): TabState | null {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
  }

  setActiveTab(id: string): void {
    if (this.activeTabId === id) return;
    this.getSession(this.activeTabId)?.setFocused(false);
    this.activeTabId = id;
    this.getSession(id)?.setFocused(true);
    this.emit();
  }

  closeSession(id: string): void {
    const session = this.sessions.get(id);
    session?.disconnect();
    this.sessions.delete(id);
    this.abortControllers.get(id)?.abort();
    this.abortControllers.delete(id);
    this.tabs = this.tabs.filter((t) => t.id !== id);
    delete this.conversations[id];
    if (this.activeTabId === id) {
      this.activeTabId = this.tabs.length ? this.tabs[this.tabs.length - 1].id : null;
    }
    this.emit();
  }

  setFit(tabId: string, fit: boolean): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (tab) tab.fit = fit;
    this.getSession(tabId)?.setFitEnabled(fit);
    this.emit();
  }

  setDark(tabId: string, dark: boolean): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (tab) tab.dark = dark;
    this.getSession(tabId)?.setDarkMode(dark);
    this.emit();
  }

  reconnect(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const session = this.sessions.get(tabId);
    session?.disconnect();
    this.sessions.delete(tabId);
    const fresh = new NativeSession(session!.profile, tabId);
    fresh.setFitEnabled(tab.fit);
    fresh.setDarkMode(tab.dark);
    fresh.callbacks = {
      onStatus: (status, error) => {
        tab.status = status;
        tab.error = error;
        this.emit();
      },
      onSize: (width, height) => {
        tab.width = width;
        tab.height = height;
        this.emit();
      },
      onAiActivity: (active) => {
        tab.aiActive = active;
        this.emit();
      },
    };
    this.sessions.set(tabId, fresh);
    tab.status = 'connecting';
    this.emit();
    void this.askPassword(fresh.profile).then((pw) => {
      if (pw === null) {
        tab.status = 'error';
        tab.error = 'password required';
        this.emit();
        return;
      }
      fresh.password = pw ?? '';
      void fresh.connect(this.bridgeUrl());
    });
  }

  // ---- AI --------------------------------------------------------------

  private conversation(tabId: string): Conversation {
    if (!this.conversations[tabId]) this.conversations[tabId] = emptyConversation();
    return this.conversations[tabId];
  }

  private logActivity(tabId: string, activity: AiActivity): void {
    const conv = this.conversation(tabId);
    conv.activity = [...conv.activity, activity].slice(-200);
    this.emit();
  }

  supportsVision(): boolean {
    const override = this.settings.ai.vision;
    if (override === 'yes') return true;
    if (override === 'no') return false;
    // Heuristic: common vision-capable model families.
    const m = (this.settings.ai.model || '').toLowerCase();
    if (!m) return true; // unknown -> optimistic
    return /(vision|gpt-4o|gpt-4\.1|4o|4-0|claude|gemini|llava|qwen[-.]?(vl|3)|internvl|minicpm|pixtral|kimi|grok-4|o\d)/.test(m);
  }

  async testConnection(): Promise<void> {
    const { baseUrl, apiKey } = this.settings.ai;
    const conv = this.conversation(this.activeTabId ?? '_global');
    try {
      const models = await listModels(baseUrl, apiKey);
      conv.models = models;
      conv.modelsError = undefined;
      conv.testResult = {
        ok: true,
        message: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`,
      };
    } catch (e) {
      conv.testResult = { ok: false, message: String(e) };
      conv.modelsError = String(e);
    }
    this.emit();
  }

  async fetchModels(): Promise<void> {
    const { baseUrl, apiKey } = this.settings.ai;
    const conv = this.conversation(this.activeTabId ?? '_global');
    try {
      conv.models = await listModels(baseUrl, apiKey);
      conv.modelsError = undefined;
    } catch (e) {
      conv.modelsError = String(e);
    }
    this.emit();
  }

  abortChat(tabId: string): void {
    this.abortControllers.get(tabId)?.abort();
    const conv = this.conversation(tabId);
    if (conv.streaming) {
      conv.messages = [
        ...conv.messages,
        { role: 'assistant', content: conv.streaming + ' *(stopped)*' },
      ];
      conv.streaming = '';
    }
    conv.status = 'idle';
    this.emit();
  }

  clearConversation(tabId: string): void {
    const existing = this.conversation(tabId);
    this.conversations[tabId] = { ...emptyConversation(), models: existing.models };
    this.emit();
  }

  // ---- approval gate ----------------------------------------------------

  /** User clicked Approve on the pending tool call. */
  approvePending(tabId: string): void {
    const resolve = this.approvalResolvers.get(tabId);
    this.approvalResolvers.delete(tabId);
    const conv = this.conversation(tabId);
    if (conv.pendingApproval) {
      this.logActivity(tabId, { kind: 'info', label: `✓ approved: ${conv.pendingApproval.summary}`, time: Date.now() });
      conv.pendingApproval = undefined;
    }
    resolve?.(true);
    this.emit();
  }

  /** User clicked Deny on the pending tool call. */
  denyPending(tabId: string): void {
    const resolve = this.approvalResolvers.get(tabId);
    this.approvalResolvers.delete(tabId);
    const conv = this.conversation(tabId);
    if (conv.pendingApproval) {
      this.logActivity(tabId, { kind: 'error', label: `✗ denied: ${conv.pendingApproval.summary}`, time: Date.now() });
      conv.pendingApproval = undefined;
    }
    resolve?.(false);
    this.emit();
  }

  /**
   * Pause the agent loop until the user approves or denies a tool call.
   * Builds the crosshair preview from the live screen first, so the user
   * sees ground truth about where a click would land, not the model's claim.
   */
  private requestApproval(
    tabId: string,
    info: { name: string; args: Record<string, unknown>; risk: 'safe' | 'action' | 'dangerous'; summary: string; reason: string },
  ): Promise<boolean> {
    const conv = this.conversation(tabId);
    let preview: string | null = null;
    try {
      const session = this.getSession(tabId);
      const screen = session?.screenSize();
      const sent = conv.sentImageSize;
      if (session && screen && screen.width && screen.height) {
        const map = (x: unknown, y: unknown): { x: number; y: number } | null => {
          if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return null;
          if (sent && sent.width && sent.height) return { x: (x * screen.width) / sent.width, y: (y * screen.height) / sent.height };
          return { x, y };
        };
        const a = info.args;
        const points: { x: number; y: number }[] = [];
        if (info.name === 'mouse_click' || info.name === 'mouse_move' || info.name === 'scroll') {
          const p = map(a.x, a.y);
          if (p) points.push(p);
        } else if (info.name === 'mouse_drag') {
          const p1 = map(a.fromX, a.fromY);
          const p2 = map(a.toX, a.toY);
          if (p1 && p2) points.push(p1, p2);
        }
        if (points.length) preview = session.approvalPreview(points);
      }
    } catch {
      /* preview is best-effort */
    }

    conv.pendingApproval = { ...info, preview };
    conv.status = 'awaiting-approval';
    this.emit();

    return new Promise<boolean>((resolve) => {
      this.approvalResolvers.set(tabId, (ok) => {
        conv.pendingApproval = undefined;
        if (conv.status === 'awaiting-approval') conv.status = 'running-tool';
        resolve(ok);
      });
      // If the whole turn is aborted while waiting, treat it as a denial so
      // the promise never dangles.
      this.abortControllers.get(tabId)?.signal.addEventListener('abort', () => this.denyPending(tabId), { once: true });
    });
  }

  async sendChat(tabId: string, text: string): Promise<void> {
    const conv = this.conversation(tabId);
    const ai = this.settings.ai;
    if (!ai.baseUrl) {
      this.logActivity(tabId, { kind: 'error', label: 'No API base URL set', time: Date.now() });
      return;
    }

    conv.messages = [...conv.messages, { role: 'user', content: text }];
    conv.streaming = '';
    conv.status = 'thinking';
    this.emit();

    const controller = new AbortController();
    this.abortControllers.set(tabId, controller);

    // Build the system prompt with live session context.
    const tab = this.tabs.find((t) => t.id === tabId);
    const session = this.getSession(tabId);
    const ctxLine = session
      ? `The user is currently connected to "${session.profile.name}" (${session.profile.protocol}, ${session.profile.hostname}), display ${
          session.screenSize().width || tab?.width || '?'
        }x${session.screenSize().height || tab?.height || '?'}.`
      : 'There is no active remote session right now.';
    const system: ChatMessage = {
      role: 'system',
      content: `${ai.systemPrompt}\n\n${ctxLine}`,
    };

    // Trim old image payloads from history to keep requests small: keep the
    // most recent image-bearing message, replace older ones with a note.
    const history = trimImagesKeepLast(conv.messages);

    const executor = createToolExecutor({
      getActiveSession: () => this.getSession(tabId),
      inputControlEnabled: () => this.aiInputEnabled,
      supportsVision: () => this.supportsVision(),
      getSentImageSize: () => conv.sentImageSize,
      setSentImageSize: (size) => {
        conv.sentImageSize = size;
      },
    });

    try {
      const finalText = await runAgent(
        {
          baseUrl: ai.baseUrl,
          apiKey: ai.apiKey,
          model: ai.model,
          temperature: ai.temperature,
          maxToolRounds: ai.maxToolRounds,
        },
        [system, ...history],
        SESSION_TOOLS,
        executor,
        {
          signal: controller.signal,
          isAutoExecute: () => this.settings.ai.autoExecute,
          requestApproval: (info) => this.requestApproval(tabId, info),
          onText: (delta) => {
            conv.streaming += delta;
            this.emit();
          },
          onToolCall: (name) => {
            conv.status = 'running-tool';
            if (conv.streaming) {
              conv.messages = [...conv.messages, { role: 'assistant', content: conv.streaming }];
              conv.streaming = '';
            }
            this.logActivity(tabId, { kind: 'tool', label: `→ ${name}`, time: Date.now() });
          },
          onToolResult: (name, result) => {
            this.logActivity(tabId, {
              kind: result.isError ? 'error' : 'tool',
              label: `← ${name}`,
              detail: result.summary,
              time: Date.now(),
            });
          },
        },
      );

      const finalMessage = finalText || conv.streaming;
      conv.messages = [
        ...conv.messages,
        { role: 'assistant', content: finalMessage || '(no response)' },
      ];
      conv.streaming = '';
      conv.status = 'idle';
    } catch (e) {
      const msg = String(e);
      conv.streaming = '';
      conv.status = 'error';
      this.logActivity(tabId, { kind: 'error', label: msg, time: Date.now() });
      conv.messages = [
        ...conv.messages,
        { role: 'assistant', content: `⚠️ ${msg}` },
      ];
      conv.status = 'idle';
    } finally {
      this.abortControllers.delete(tabId);
      this.emit();
    }
  }
}

/**
 * Replace image_url parts in all but the most recent image-bearing message
 * with a short note, so the transcript stays light while the model still has
 * its latest screenshot.
 */
function trimImagesKeepLast(messages: ChatMessage[]): ChatMessage[] {
  let lastImageIndex = -1;
  messages.forEach((m, i) => {
    if (Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')) {
      lastImageIndex = i;
    }
  });
  return messages.map((m, i) => {
    if (i === lastImageIndex || !Array.isArray(m.content)) return m;
    if (!m.content.some((p) => p.type === 'image_url')) return m;
    return {
      ...m,
      content: m.content.map((p) =>
        p.type === 'image_url' ? { type: 'text', text: '[earlier screenshot omitted]' } : p,
      ),
    };
  });
}

export const store = new AppStore();
