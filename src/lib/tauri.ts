/** Thin typed wrappers around the trdc Tauri commands. */
import { invoke } from '@tauri-apps/api/core';

export interface GuacdStatus {
  running: boolean;
  port: number;
  binary: string | null;
  detail: string | null;
}

export async function bridgePort(): Promise<number> {
  return invoke<number>('bridge_port');
}

export async function guacdStatus(): Promise<GuacdStatus> {
  return invoke<GuacdStatus>('guacd_status');
}

export async function startGuacd(path?: string): Promise<GuacdStatus> {
  return invoke<GuacdStatus>('start_guacd', { path: path ?? null });
}

export async function stopGuacd(): Promise<void> {
  return invoke('stop_guacd');
}

export interface AiRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  onChunk?: (text: string) => void;
}

/** Route an HTTP request through the Rust shell (no CORS, key stays out of webview). */
export async function aiRequest(opts: AiRequestOptions): Promise<string> {
  const headers: [string, string][] = Object.entries(opts.headers ?? {}).map(
    ([k, v]) => [k, v],
  );
  const { Channel } = await import('@tauri-apps/api/core');
  const on_data = new Channel<string>((d) => opts.onChunk?.(typeof d === 'string' ? d : String(d)));
  return invoke<string>('ai_request', {
    req: {
      method: opts.method,
      url: opts.url,
      headers,
      body: opts.body ?? null,
      timeout_ms: opts.timeoutMs ?? null,
    },
    onData: on_data,
  });
}

export async function readConfig<T>(name: string): Promise<T | null> {
  return invoke<T | null>('read_config', { name });
}

export async function writeConfig(name: string, contents: unknown): Promise<void> {
  return invoke('write_config', { name, contents });
}
