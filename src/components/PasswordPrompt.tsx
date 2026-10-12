/**
 * Connect-time password prompt. The entered password goes straight into the
 * store's in-memory map and the session's open message; it is never written
 * to connections.json (the editor has no password field for protocols that
 * prompt here).
 */
import { useEffect, useRef, useState } from 'react';
import { store, useStore } from '../store/hooks';

export function PasswordPrompt() {
  const s = useStore();
  const pending = s.pendingPassword;
  const [pw, setPw] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPw('');
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [pending?.profileId]);

  if (!pending) return null;

  const submit = () => store.resolvePassword(pw);
  const cancel = () => store.resolvePassword(null);

  return (
    <div className="modal-backdrop" onClick={cancel}>
      <div className="modal" style={{ width: 380 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Password</h3>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>{pending.prompt}</label>
            <input
              ref={inputRef}
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
                else if (e.key === 'Escape') cancel();
              }}
              placeholder="Connection password"
              autoFocus
            />
            <div className="help">
              Used for this connection only and kept in memory while trdc runs —
              never saved to disk.
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn ghost" onClick={cancel}>
            Cancel
          </button>
          <button className="btn" onClick={submit}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
