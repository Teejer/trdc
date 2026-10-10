import { useMemo, useState } from 'react';
import { useStore, store } from '../store/hooks';
import { getProtocol, getProtocols } from '../protocols';

interface Props {
  onEdit: (id: string) => void;
  onNew: () => void;
}

export function Sidebar({ onEdit, onNew }: Props) {
  const s = useStore();
  const [query, setQuery] = useState('');

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = s.connections.filter((c) => {
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.hostname.toLowerCase().includes(q) ||
        c.protocol.toLowerCase().includes(q)
      );
    });
    const map = new Map<string, typeof filtered>();
    for (const c of filtered) {
      const key = c.folder || '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return [...map.entries()].sort((a, b) => (a[0] || 'zzz').localeCompare(b[0] || 'zzz'));
  }, [s.connections, query]);

  const tabFor = (profileId: string) => s.tabs.find((t) => t.profileId === profileId);

  return (
    <div className="sidebar" style={{ width: s.settings.sidebarWidth }}>
      <div className="sidebar-header">
        <h2>Connections</h2>
        <button className="btn small" onClick={onNew} title="New connection">
          + New
        </button>
      </div>
      <div className="sidebar-search">
        <input
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="conn-list">
        {grouped.length === 0 && (
          <div className="chat-empty" style={{ marginTop: 24 }}>
            {s.connections.length === 0
              ? 'No connections yet. Click “+ New” to add your first host.'
              : 'No matches.'}
          </div>
        )}
        {grouped.map(([folder, items]) => (
          <div key={folder || '__root__'}>
            {folder && <div className="conn-folder">{folder}</div>}
            {items.map((c) => {
              const proto = getProtocol(c.protocol);
              const tab = tabFor(c.id);
              const active = tab && tab.id === s.activeTabId;
              return (
                <div
                  key={c.id}
                  className={'conn-item' + (active ? ' active' : '')}
                  onClick={() => tab && store.setActiveTab(tab.id)}
                  onDoubleClick={() => void store.openSession(c.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onEdit(c.id);
                  }}
                  title={`${proto?.label ?? c.protocol} · ${c.hostname}\nDouble-click to connect · right-click to edit`}
                >
                  <span className="swatch" style={{ background: proto?.accent ?? '#555' }} />
                  <span className="meta">
                    <div className="name">{c.name}</div>
                    <div className="host">
                      {c.hostname}
                      {c.params.port ? `:${c.params.port}` : `:${proto?.defaultPort ?? ''}`}
                    </div>
                  </span>
                  {tab && <span className={'live ' + tab.status} />}
                </div>
              );
            })}
          </div>
        ))}
        {s.connections.length > 0 && (
          <div style={{ padding: '10px 8px 4px' }}>
            <button className="btn ghost small" onClick={onNew} style={{ width: '100%', justifyContent: 'center' }}>
              + Add connection
            </button>
          </div>
        )}
      </div>
      <div style={{ padding: '6px 10px', borderTop: '1px solid var(--border)' }} className="muted">
        {getProtocols().length} protocols · {s.connections.length} saved
      </div>
    </div>
  );
}
