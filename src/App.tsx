import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useStore, store } from './store/hooks';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { SessionView } from './components/SessionView';
import { AiPanel } from './components/AiPanel';
import { SettingsModal } from './components/SettingsModal';
import { ConnectionEditor } from './components/ConnectionEditor';
import { PasswordPrompt } from './components/PasswordPrompt';

let autopenDone = false; // survive React StrictMode double-invoke

/** Fire a window-control call; ignore failures when not running under
 *  Tauri (e.g. the vite dev URL opened in a plain browser). */
function winCtrl(fn: (w: ReturnType<typeof getCurrentWindow>) => Promise<unknown>): void {
  try {
    void fn(getCurrentWindow()).catch(() => undefined);
  } catch {
    /* no Tauri internals in this environment */
  }
}

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
      {/* "deep": the whole subtree drags (a bare attribute only drags when
          the click lands on this exact element, and the flex spacer covers
          most of the bar). Tauri's drag script still refuses to drag when
          the click target is a button/link, so the controls work. */}
      <div className="titlebar" data-tauri-drag-region="deep">
        <span className="brand">
          trdc<small>tabbed remote desktop · AI assistant</small>
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
        {/* Client-side decorations: the OS titlebar is off (tauri.conf),
            this bar is the titlebar (data-tauri-drag-region above), these
            are its window buttons. tao hit-tests the window edges itself,
            so resizing still works without an OS titlebar. */}
        <span className="win-controls">
          <button className="winbtn" title="Minimize" onClick={() => winCtrl((w) => w.minimize())}>
            ─
          </button>
          <button
            className="winbtn"
            title="Maximize / restore"
            onClick={() => winCtrl((w) => w.toggleMaximize())}
          >
            ▢
          </button>
          <button className="winbtn close" title="Close" onClick={() => winCtrl((w) => w.close())}>
            ✕
          </button>
        </span>
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
                The AI assistant on the right can see the screen and drive the mouse & keyboard.
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
      <PasswordPrompt />
      {editingId && (
        <ConnectionEditor
          profileId={editingId === '__new__' ? null : editingId}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}
