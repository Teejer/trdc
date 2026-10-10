/**
 * Minimal OpenAI-compatible chat client.
 *
 * Talks to any backend exposing /v1/models and /v1/chat/completions
 * (OpenAI, LM Studio, Ollama's OpenAI shim, vLLM, llama.cpp server,
 * OpenRouter, ...). All HTTP is routed through the Rust shell so the API
 * key never touches the webview network stack and CORS is a non-issue.
 *
 * Implements a streaming tool-calling agent loop: text deltas and
 * tool-call fragments are accumulated from the SSE stream; when the model
 * asks for tools they are executed via the supplied ToolExecutor and their
 * results fed back, repeating until the model produces a final answer or
 * the round budget is exhausted.
 */
import { aiRequest } from '../lib/tauri';
import { describeCall, dangerReason, riskOf, type Risk } from './risk';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ModelInfo {
  id: string;
  owned_by?: string;
  created?: number;
}

export interface AgentToolResult {
  /** Text returned to the model. */
  content: string;
  /** Optional screenshot attached back to the conversation. */
  imageDataUrl?: string;
  /** Short human-readable line for the activity log. */
  summary?: string;
  /** Marks an error so the model can course-correct. */
  isError?: boolean;
}

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<AgentToolResult>;

export interface AgentEvents {
  onText?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: AgentToolResult) => void;
  onRound?: (round: number) => void;
  /**
   * Approval gate (ported from krdc-ai). Called before every non-safe tool
   * call. Return true to run it, false to deny. `autoExecute` is the user's
   * convenience toggle; the gate below already skips asking for safe calls
   * and force-asks for dangerous ones, so the callback itself just asks.
   */
  requestApproval?: (info: {
    name: string;
    args: Record<string, unknown>;
    risk: Risk;
    summary: string;
    reason: string;
  }) => Promise<boolean>;
  /** Whether the user turned on auto-execute (read per call). */
  isAutoExecute?: () => boolean;
  signal?: AbortSignal;
}

export interface AgentConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxToolRounds: number;
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  return `${b}/${p}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
  return h;
}

/** GET /models - used for both "test connection" and "fetch models". */
export async function listModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  const url = joinUrl(baseUrl, 'models');
  const raw = await aiRequest({ method: 'GET', url, headers: authHeaders(apiKey) });
  const parsed = JSON.parse(raw);
  const data: ModelInfo[] = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : [];
  return data.sort((a, b) => a.id.localeCompare(b.id));
}

interface StreamAccumulator {
  content: string;
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  finishReason: string | null;
}

/** Feed one SSE chunk's data payload into the accumulator. */
function consumeSseLine(line: string, acc: StreamAccumulator, onText?: (d: string) => void) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data:')) return;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return;
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return;
  }
  const choice = (obj as { choices?: unknown[] })?.choices?.[0] as
    | { delta?: Record<string, unknown>; finish_reason?: string | null; message?: Record<string, unknown> }
    | undefined;
  if (!choice) return;
  const delta = choice.delta ?? {};
  if (choice.finish_reason) acc.finishReason = choice.finish_reason;

  const contentPiece = delta['content'];
  if (typeof contentPiece === 'string' && contentPiece.length) {
    acc.content += contentPiece;
    onText?.(contentPiece);
  }

  const toolCalls = delta['tool_calls'];
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls as Record<string, unknown>[]) {
      const index = typeof tc['index'] === 'number' ? (tc['index'] as number) : 0;
      let entry = acc.toolCalls.get(index);
      if (!entry) {
        entry = { id: '', name: '', arguments: '' };
        acc.toolCalls.set(index, entry);
      }
      if (typeof tc['id'] === 'string') entry.id = tc['id'] as string;
      const fn = tc['function'] as Record<string, unknown> | undefined;
      if (fn) {
        if (typeof fn['name'] === 'string' && fn['name']) entry.name = fn['name'] as string;
        if (typeof fn['arguments'] === 'string') entry.arguments += fn['arguments'];
      }
    }
  }

  // Some backends return a plain (non-streamed) message on the final chunk.
  const message = choice.message;
  if (message && typeof message['content'] === 'string' && !acc.content) {
    acc.content = message['content'] as string;
  }
}

/**
 * Run a chat completion, transparently streaming and executing tool calls
 * until the model stops asking for tools. Returns the final text.
 */
export async function runAgent(
  config: AgentConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  execute: ToolExecutor,
  events: AgentEvents = {},
): Promise<string> {
  const url = joinUrl(config.baseUrl, 'chat/completions');
  const headers = authHeaders(config.apiKey);
  const history: ChatMessage[] = [...messages];
  let finalText = '';

  for (let round = 0; round <= config.maxToolRounds; round++) {
    if (events.signal?.aborted) break;
    events.onRound?.(round);

    const body: Record<string, unknown> = {
      model: config.model,
      messages: history,
      temperature: config.temperature,
      stream: true,
    };
    if (tools.length) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
    }

    const acc: StreamAccumulator = { content: '', toolCalls: new Map(), finishReason: null };
    let buffer = '';

    await aiRequest({
      method: 'POST',
      url,
      headers,
      body: JSON.stringify(body),
      timeoutMs: 180_000,
      onChunk: (text) => {
        buffer += text;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          consumeSseLine(line, acc, events.onText);
        }
      },
    });
    // Flush any trailing line that wasn't newline-terminated.
    if (buffer) consumeSseLine(buffer, acc, events.onText);

    const calls = [...acc.toolCalls.values()].filter((c) => c.name);

    if (!calls.length) {
      finalText = acc.content;
      break;
    }

    // Record the assistant turn that requested tools.
    history.push({
      role: 'assistant',
      content: acc.content || null,
      tool_calls: calls.map((c) => ({
        id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments || '{}' },
      })),
    });

    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const callId = history[history.length - 1].tool_calls![i].id;
      let args: Record<string, unknown> = {};
      try {
        args = c.arguments ? JSON.parse(c.arguments) : {};
      } catch {
        args = {};
      }
      events.onToolCall?.(c.name, args);

      // --- Approval gate (krdc-ai safety model) --------------------------
      // Safe calls always run. Action calls run without asking only when the
      // user enabled auto-execute. Dangerous calls ALWAYS ask.
      const risk = riskOf(c.name, args);
      const autoRun = risk === 'safe' || (events.isAutoExecute?.() === true && risk === 'action');
      if (!autoRun && events.requestApproval) {
        const approved = await events.requestApproval({
          name: c.name,
          args,
          risk,
          summary: describeCall(c.name, args),
          reason: risk === 'dangerous' ? dangerReason(c.name, args) : '',
        });
        if (events.signal?.aborted) return finalText;
        if (!approved) {
          const rejected: AgentToolResult = {
            content: 'The user rejected this action. Do not retry it without being asked to.',
            isError: true,
            summary: 'rejected by user',
          };
          events.onToolResult?.(c.name, rejected);
          history.push({ role: 'tool', tool_call_id: callId, name: c.name, content: rejected.content });
          continue;
        }
      }

      let result: AgentToolResult;
      try {
        result = await execute(c.name, args);
      } catch (err) {
        result = { content: `Tool failed: ${String(err)}`, isError: true };
      }
      events.onToolResult?.(c.name, result);

      const toolMessage: ChatMessage = {
        role: 'tool',
        tool_call_id: callId,
        name: c.name,
        content: result.content,
      };
      history.push(toolMessage);

      // If a tool produced a screenshot and the model supports vision, give
      // it back as a follow-up user image message (OpenAI tool messages
      // cannot carry images portably across backends).
      if (result.imageDataUrl) {
        history.push({
          role: 'user',
          content: [
            { type: 'text', text: `[screenshot after "${c.name}"]` },
            { type: 'image_url', image_url: { url: result.imageDataUrl } },
          ],
        });
      }
    }
  }

  return finalText;
}
