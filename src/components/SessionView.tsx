import { useEffect, useRef } from 'react';
import { useStore, store } from '../store/hooks';

export function SessionView({ tabId }: { tabId: string }) {
  const s = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const tab = s.tabs.find((t) => t.id === tabId);
  const session = store.getSession(tabId);

  // Attach the session's display element whenever this view mounts for the
  // active tab (only one tab is rendered at a time, so only one session is
  // ever attached to the DOM).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !session) return;
    session.attach(el);
    session.setFocused(true);
    const ro = new ResizeObserver(() => session.setFitEnabled(!!tab?.fit));
    ro.observe(el);
    return () => {
      ro.disconnect();
      session.detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, session]);

  if (!tab) return null;

  const showOverlay = tab.status === 'error' || tab.status === 'disconnected';

  return (
    <div className="session-view">
      <div className="session-container" ref={containerRef} />

      {tab.aiActive && <div className="ai-takeover">AI is controlling the remote host</div>}

      {tab.status === 'connected' && !tab.fit && (
        <div style={{ position: 'absolute', bottom: 10, right: 12 }} className="muted">
          {tab.width}×{tab.height} · 1:1
        </div>
      )}

      {showOverlay && (
        <div className="session-error">
          <div style={{ fontSize: 34 }}>⚠️</div>
          <div style={{ fontWeight: 600 }}>
            {tab.status === 'error' ? 'Connection failed' : 'Disconnected'}
          </div>
          {tab.error && <div className="code">{tab.error}</div>}
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={() => store.reconnect(tab.id)}>
              ↻ Reconnect
            </button>
            <button className="btn secondary" onClick={() => store.closeSession(tab.id)}>
              Close tab
            </button>
          </div>
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          bottom: 10,
          left: 12,
          display: 'flex',
          gap: 6,
          opacity: tab.status === 'connected' ? 1 : 0.0,
          transition: 'opacity .15s',
        }}
      >
        <button
          className="btn secondary small"
          onClick={() => store.setFit(tab.id, !tab.fit)}
          title="Toggle fit-to-window / 1:1"
        >
          {tab.fit ? '⤢ Fit' : '⤡ 1:1'}
        </button>
        <button
          className="btn secondary small"
          onClick={() => store.setDark(tab.id, !tab.dark)}
          title={
            tab.dark
              ? 'Dark-mode filter is ON (host paints light; trdc inverts it)'
              : 'Dark-mode filter is OFF — invert light hosts/apps for comfortable viewing'
          }
          style={tab.dark ? { borderColor: 'var(--purple)', color: 'var(--purple)' } : undefined}
        >
          {tab.dark ? '🌙 Dark' : '☀️ Dark'}
        </button>
      </div>
    </div>
  );
}
