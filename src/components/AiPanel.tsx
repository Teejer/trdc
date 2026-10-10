import { useEffect, useRef, useState } from 'react';
import { useStore, store } from '../store/hooks';

export function AiPanel() {
  const s = useStore();
  const tabId = s.activeTabId;
  const conv = tabId ? s.conversations[tabId] : undefined;
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const ai = s.settings.ai;
  const configured = !!ai.baseUrl;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv?.messages.length, conv?.streaming, conv?.activity.length]);

  const busy = conv?.status === 'thinking' || conv?.status === 'running-tool';

  const send = () => {
    const text = draft.trim();
    if (!text || !tabId || busy) return;
    setDraft('');
    void store.sendChat(tabId, text);
  };

  return (
    <div className="aipanel" style={{ width: s.settings.aiPanelWidth }}>
      <div className="aipanel-header">
        <h2>🤖 AI copilot</h2>
        <span
          className="model-chip"
          title={ai.model || 'No model selected — open settings'}
          onClick={() => {
            const evt = new CustomEvent('trdc:open-settings');
            window.dispatchEvent(evt);
          }}
        >
          {ai.model || 'no model'}
        </span>
      </div>

      {!tabId && (
        <div className="chat-empty">
          Open a connection tab and the copilot can look at the screen and drive the mouse &
          keyboard for you.
        </div>
      )}

      {tabId && !configured && (
        <div className="chat-empty">
          <p>Point the copilot at an OpenAI-compatible backend to get started.</p>
          <button
            className="btn"
            onClick={() => window.dispatchEvent(new CustomEvent('trdc:open-settings'))}
          >
            Configure AI backend
          </button>
        </div>
      )}

      {tabId && configured && (
        <>
          <div className="chat-scroll" ref={scrollRef}>
            {(!conv || (conv.messages.length === 0 && conv.activity.length === 0 && !conv.streaming)) && (
              <div className="chat-empty">
                Ask the copilot to open an app, fill a form, or explain what's on screen.
                <br />
                <span className="muted">
                  It acts on the active tab. A purple badge appears while it has the mouse.
                </span>
              </div>
            )}

            {conv?.messages.map((m, i) => {
              if (m.role === 'tool' || m.role === 'system') return null;
              const text =
                typeof m.content === 'string'
                  ? m.content
                  : (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '🖼')).join(' ');
              return (
                <div key={i} className={'msg ' + m.role}>
                  {text}
                </div>
              );
            })}

            {conv && conv.activity.length > 0 && (
              <div className="activity">
                {conv.activity.slice(-40).map((a, i) => (
                  <div key={i} className={'activity-row' + (a.kind === 'error' ? ' error' : '')}>
                    <span>{a.label}</span>
                    {a.detail && <span className="detail">{a.detail}</span>}
                  </div>
                ))}
              </div>
            )}

            {conv?.streaming && (
              <div className="msg assistant streaming">
                {conv.streaming}
                <span className="cursor" />
              </div>
            )}
          </div>

          {conv?.pendingApproval && (
            <div className={'approval' + (conv.pendingApproval.risk === 'dangerous' ? ' dangerous' : '')}>
              <div className="approval-head">
                <span className="approval-icon">{conv.pendingApproval.risk === 'dangerous' ? '⛔' : '🔑'}</span>
                <span className="approval-summary">{conv.pendingApproval.summary}</span>
              </div>
              {conv.pendingApproval.reason && <div className="approval-reason">{conv.pendingApproval.reason}</div>}
              {conv.pendingApproval.preview && (
                <img className="approval-preview" src={conv.pendingApproval.preview} alt="where it lands" />
              )}
              <div className="approval-actions">
                <button className="btn approve" onClick={() => store.approvePending(tabId)}>
                  ✓ Approve
                </button>
                <button className="btn danger" onClick={() => store.denyPending(tabId)}>
                  ✗ Deny
                </button>
              </div>
            </div>
          )}

          {busy && (
            <div className="ai-status">
              <span className="spin" />
              {conv?.status === 'running-tool' ? 'running a tool…' : 'thinking…'}
              <button className="btn ghost small" style={{ marginLeft: 'auto' }} onClick={() => tabId && store.abortChat(tabId)}>
                Stop
              </button>
            </div>
          )}

          <div className="chat-input">
            <textarea
              rows={1}
              placeholder={ai.model ? 'Ask the copilot… (Enter to send)' : 'Pick a model in settings first'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {busy ? (
              <button className="btn danger" onClick={() => tabId && store.abortChat(tabId)}>
                ■
              </button>
            ) : (
              <button className="btn" onClick={send} disabled={!draft.trim() || !ai.model}>
                Send
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
