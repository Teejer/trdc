import { useEffect, useState } from 'react';
import { useStore, store } from './store/hooks';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { SessionView } from './components/SessionView';
import { AiPanel } from './components/AiPanel';
import { SettingsModal } from './components/SettingsModal';
import { ConnectionEditor } from './components/ConnectionEditor';

let autopenDone = false; // survive React StrictMode double-invoke

export default function App() {
  const s = useStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    void store.init().then(() => {
      // Debug helper: trdc dev URL may carry ?autopen=<connection-id> to
      // auto-open a connection on load (used for headless e2e testing).
      const autopen = new URLSearchParams(window.location.search).get('autopen');
      if (autopen && !autopenDone) {
        autopenDone = true;
        void store.openSession(autopen);
      }
    });
  }, []);

  // Allow child components to open settings via a DOM event.
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener('trdc:open-settings', handler);
    return () => window.removeEventListener('trdc:open-settings', handler);
  }, []);

  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <span className="brand">
          trdc<small>tabbed remote desktop · AI copilot</small>
        </span>
        <span className="spacer" />
        <button
          className={'guacd-pill' + (s.bridgeWsPort ? ' ok' : '')}
          title={
            s.bridgeWsPort
              ? `built-in RDP engine, session bridge on 127.0.0.1:${s.bridgeWsPort}`
              : 'session bridge not up yet'
          }
          onClick={() => setSettingsOpen(true)}
        >
          <span className="dot" />
          {s.bridgeWsPort ? `engine :${s.bridgeWsPort}` : 'engine offline'}
        </button>
        <button className="btn ghost small" onClick={() => setSettingsOpen(true)}>
          ⚙ Settings
        </button>
      </div>

      <TabBar />

      <div className="body">
        <Sidebar onEdit={(id) => setEditingId(id)} onNew={() => setEditingId('__new__')} />
        <div className="stage">
          {s.activeTabId ? (
            <SessionView key={s.activeTabId} tabId={s.activeTabId} />
          ) : (
            <div className="stage-empty">
              <h1>trdc</h1>
              <p>
                Pick a connection on the left to open a tab, or create a new one.
                <br />
                The AI copilot on the right can see the screen and drive the mouse & keyboard.
              </p>
              <button className="btn" onClick={() => setEditingId('__new__')}>
                + New connection
              </button>
            </div>
          )}
        </div>
        <AiPanel />
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {editingId && (
        <ConnectionEditor
          profileId={editingId === '__new__' ? null : editingId}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}
