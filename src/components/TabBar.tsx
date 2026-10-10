import { useStore, store } from '../store/hooks';
import { getProtocol } from '../protocols';

export function TabBar() {
  const s = useStore();
  if (s.tabs.length === 0) return <div className="tabbar" />;

  return (
    <div className="tabbar">
      {s.tabs.map((t) => {
        const proto = getProtocol(t.protocol);
        return (
          <div
            key={t.id}
            className={'tab' + (t.id === s.activeTabId ? ' active' : '')}
            onClick={() => store.setActiveTab(t.id)}
            title={t.error || `${t.name} (${t.width}×${t.height})`}
          >
            <span className="tab-proto" style={{ background: proto?.accent ?? '#555' }}>
              {t.protocol}
            </span>
            <span className="tab-name">{t.name}</span>
            {t.aiActive && <span className="ai-badge" title="AI is controlling input">AI</span>}
            <span className={'tab-status ' + t.status} />
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                store.closeSession(t.id);
              }}
              title="Close tab"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
