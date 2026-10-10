import { useState } from 'react';
import { store, useStore } from '../store/hooks';
import type { AiSettings } from '../types';

const PRESETS: { label: string; baseUrl: string }[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  { label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  { label: 'llama.cpp', baseUrl: 'http://localhost:8080/v1' },
  { label: 'vLLM', baseUrl: 'http://localhost:8000/v1' },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [tab, setTab] = useState<'ai' | 'engine'>('ai');
  const [showKey, setShowKey] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);

  const ai = s.settings.ai;
  const set = (patch: Partial<AiSettings>) => store.updateAiSettings(patch);

  const conv = s.conversations[s.activeTabId ?? '_global'];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Settings</h3>
          <button className="btn ghost icon" onClick={onClose}>
            ×
          </button>
        </div>

        <div style={{ display: 'flex', gap: 4, padding: '0 16px', borderBottom: '1px solid var(--border)' }}>
          <TabButton active={tab === 'ai'} onClick={() => setTab('ai')}>
            AI backend
          </TabButton>
          <TabButton active={tab === 'engine'} onClick={() => setTab('engine')}>
            Connection engine
          </TabButton>
        </div>

        <div className="modal-body">
          {tab === 'ai' && (
            <>
              <div className="field">
                <label>Preset backends</label>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      className={'btn small ' + (ai.baseUrl === p.baseUrl ? '' : 'secondary')}
                      onClick={() => set({ baseUrl: p.baseUrl })}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>API base URL</label>
                <input type="text" value={ai.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
                <div className="help">Any OpenAI-compatible server. Include the /v1 path.</div>
              </div>

              <div className="field">
                <label>API key</label>
                <div className="row">
                  <input
                    className="grow"
                    style={{ flex: 1 }}
                    type={showKey ? 'text' : 'password'}
                    value={ai.apiKey}
                    onChange={(e) => set({ apiKey: e.target.value })}
                    placeholder="sk-…"
                    autoComplete="off"
                  />
                  <button className="btn secondary small" onClick={() => setShowKey((v) => !v)}>
                    {showKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              <div className="row" style={{ margin: '4px 0 10px' }}>
                <button className="btn" onClick={() => void store.testConnection()} disabled={!ai.baseUrl}>
                  ⚡ Test connection
                </button>
                <button className="btn secondary" onClick={() => { void store.fetchModels(); setModelsOpen(true); }} disabled={!ai.baseUrl}>
                  ⟳ Fetch models
                </button>
                {conv?.testResult && (
                  <div className={'test-result ' + (conv.testResult.ok ? 'ok' : 'fail')} style={{ marginTop: 0, flex: 1 }}>
                    {conv.testResult.message}
                  </div>
                )}
              </div>

              <div className="field">
                <label>Model</label>
                <div className="row">
                  <input
                    className="grow"
                    style={{ flex: 1 }}
                    type="text"
                    value={ai.model}
                    onChange={(e) => set({ model: e.target.value })}
                    placeholder="gpt-4o"
                    list="model-suggestions"
                  />
                  <datalist id="model-suggestions">
                    {(conv?.models ?? []).map((m) => (
                      <option key={m.id} value={m.id} />
                    ))}
                  </datalist>
                  <button className="btn secondary small" onClick={() => setModelsOpen((v) => !v)}>
                    Browse ({conv?.models.length ?? 0})
                  </button>
                </div>
                {modelsOpen && (
                  <div className="model-select">
                    {(conv?.models ?? []).length === 0 && (
                      <div className="model-option muted">No models loaded — click “Fetch models”.</div>
                    )}
                    {(conv?.models ?? []).map((m) => (
                      <div
                        key={m.id}
                        className={'model-option' + (ai.model === m.id ? ' selected' : '')}
                        onClick={() => {
                          set({ model: m.id });
                          setModelsOpen(false);
                        }}
                      >
                        <span>{m.id}</span>
                        {m.owned_by && <span className="owned">{m.owned_by}</span>}
                      </div>
                    ))}
                    {conv?.modelsError && <div className="model-option" style={{ color: 'var(--red)' }}>{conv.modelsError}</div>}
                  </div>
                )}
              </div>

              <div className="field-row">
                <div className="field">
                  <label>Temperature · {ai.temperature.toFixed(1)}</label>
                  <input type="range" min={0} max={2} step={0.1} value={ai.temperature} onChange={(e) => set({ temperature: parseFloat(e.target.value) })} style={{ width: '100%' }} />
                </div>
                <div className="field">
                  <label>Max tool rounds</label>
                  <input type="number" min={1} max={40} value={ai.maxToolRounds} onChange={(e) => set({ maxToolRounds: parseInt(e.target.value) || 1 })} />
                </div>
              </div>

              <div className="field-inline">
                <label>Allow AI to control mouse &amp; keyboard</label>
                <input type="checkbox" checked={ai.inputControlEnabled} onChange={(e) => set({ inputControlEnabled: e.target.checked })} />
              </div>
              <div className="field-inline">
                <label>Attach screenshots automatically</label>
                <input type="checkbox" checked={ai.autoScreenshot} onChange={(e) => set({ autoScreenshot: e.target.checked })} />
              </div>
              <div className="field-inline">
                <label>Auto-execute actions (skip approvals)</label>
                <input type="checkbox" checked={ai.autoExecute} onChange={(e) => set({ autoExecute: e.target.checked })} />
              </div>
              <div className="help">
                With auto-execute off, every click, keystroke or typed string needs your Approve.
                Destructive commands and lock/logout chords <b>always</b> ask, even with it on.
              </div>

              <div className="field">
                <label>System prompt</label>
                <textarea value={ai.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} />
              </div>
            </>
          )}

          {tab === 'engine' && (
            <>
              <div className="field">
                <label>Dark mode by default</label>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    checked={s.settings.darkModeDefault}
                    onChange={(e) => store.updateSettings({ darkModeDefault: e.target.checked })}
                  />
                  Start new sessions with the screen-inverting dark filter on
                </label>
                <div className="help">
                  Many older Windows apps (and Windows itself before theme support) only ever paint
                  light. trdc can invert the picture where it renders it — hues stay correct and the
                  AI still sees the true colors. Each session tab also has its own 🌙 toggle.
                </div>
              </div>

              <div className="field">
                <label>guacd binary path</label>
                <input type="text" value={s.settings.guacdPath} onChange={(e) => store.updateSettings({ guacdPath: e.target.value })} placeholder="Auto-detect (leave blank)" />
                <div className="help">
                  trdc auto-launches a guacamole-server <code>guacd</code> on 127.0.0.1. Leave blank to search
                  common locations, or point it at your own build.
                </div>
              </div>

              <div className="field">
                <label>Engine status</label>
                <div className={'test-result ' + (s.guacd.running ? 'ok' : 'fail')}>
                  {s.guacd.running ? (
                    <>
                      Running on 127.0.0.1:{s.guacd.port}
                      <div style={{ marginTop: 4, fontFamily: 'var(--mono)', fontSize: 10.5, opacity: 0.8 }}>{s.guacd.binary}</div>
                    </>
                  ) : (
                    <>Offline — {s.guacd.detail}</>
                  )}
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn" onClick={() => void store.ensureGuacd()} disabled={s.guacd.running}>
                    Start engine
                  </button>
                  <button className="btn danger" onClick={() => void import('../lib/tauri').then((m) => m.stopGuacd().then(() => store.init()))} disabled={!s.guacd.running}>
                    Stop engine
                  </button>
                </div>
              </div>

              <div className="field">
                <label>WebSocket bridge</label>
                <div className="help" style={{ fontSize: 12 }}>
                  The app talks to the engine through a local WebSocket bridge on port{' '}
                  <span className="kbd">{s.bridgeWsPort || '—'}</span>. Sessions are proxied to guacd over
                  TCP; nothing leaves this machine except the AI requests you configure.
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <span className="muted grow" style={{ marginRight: 'auto' }}>
            Saved automatically
          </span>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: 'none',
        background: 'transparent',
        color: active ? 'var(--text)' : 'var(--text-faint)',
        padding: '10px 12px',
        cursor: 'pointer',
        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
        fontSize: 13,
        marginBottom: -1,
      }}
    >
      {children}
    </button>
  );
}
