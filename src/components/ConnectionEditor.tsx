import { useMemo, useState } from 'react';
import { store, useStore } from '../store/hooks';
import { getProtocol, getProtocols } from '../protocols';
import type { ProtocolField } from '../types';

interface Props {
  profileId: string | null;
  onClose: () => void;
}

export function ConnectionEditor({ profileId, onClose }: Props) {
  const s = useStore();
  const existing = profileId ? s.connections.find((c) => c.id === profileId) ?? null : null;

  const [name, setName] = useState(existing?.name ?? '');
  const [protocol, setProtocol] = useState(existing?.protocol ?? 'rdp');
  const [hostname, setHostname] = useState(existing?.hostname ?? '');
  const [folder, setFolder] = useState(existing?.folder ?? '');
  const [params, setParams] = useState<Record<string, string>>(existing?.params ?? {});
  const [showAdvanced, setShowAdvanced] = useState(false);

  const proto = getProtocol(protocol);

  const setParam = (k: string, v: string) => setParams((p) => ({ ...p, [k]: v }));

  const pickProtocol = (id: string) => {
    setProtocol(id);
    const p = getProtocol(id);
    if (p) {
      // Seed the port field with the new protocol's default if unset.
      setParams((prev) => {
        const next = { ...prev };
        if (!next.port) next.port = String(p.defaultPort);
        return next;
      });
    }
  };

  const canSave = name.trim().length > 0 && hostname.trim().length > 0;

  const save = (andConnect: boolean) => {
    if (!canSave) return;
    let id = existing?.id;
    if (existing) {
      store.updateConnection(existing.id, { name, protocol, hostname, folder, params });
    } else {
      const created = store.addConnection({ name, protocol, hostname, folder, params });
      id = created.id;
    }
    onClose();
    if (andConnect && id) void store.openSession(id);
  };

  const basicFields = useMemo(() => proto?.fields.filter((f) => !f.advanced) ?? [], [proto]);
  const advancedFields = useMemo(() => proto?.fields.filter((f) => f.advanced) ?? [], [proto]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{existing ? 'Edit connection' : 'New connection'}</h3>
          <button className="btn ghost icon" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Protocol</label>
            <div className="proto-picker">
              {getProtocols().map((p) => (
                <div
                  key={p.id}
                  className={'proto-tile' + (protocol === p.id ? ' selected' : '')}
                  onClick={() => pickProtocol(p.id)}
                >
                  <div className="glyph" style={{ color: p.accent }}>
                    ◈
                  </div>
                  <div className="lbl">{p.label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label>Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="My work PC" autoFocus />
            </div>
            <div className="field">
              <label>Folder (optional)</label>
              <input type="text" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Lab" />
            </div>
          </div>

          <div className="field">
            <label>Hostname / IP</label>
            <input type="text" value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="192.168.1.50 or host.example.com" />
          </div>

          {basicFields.map((f) => (
            <FieldInput key={f.name} field={f} value={params[f.name] ?? ''} onChange={(v) => setParam(f.name, v)} />
          ))}

          {advancedFields.length > 0 && (
            <>
              <div className="adv-toggle" onClick={() => setShowAdvanced((v) => !v)}>
                {showAdvanced ? '▾ Hide advanced options' : '▸ Show advanced options'}
              </div>
              {showAdvanced &&
                advancedFields.map((f) => (
                  <FieldInput key={f.name} field={f} value={params[f.name] ?? ''} onChange={(v) => setParam(f.name, v)} />
                ))}
            </>
          )}
        </div>
        <div className="modal-footer">
          {existing && (
            <button
              className="btn danger"
              style={{ marginRight: 'auto' }}
              onClick={() => {
                store.deleteConnection(existing.id);
                onClose();
              }}
            >
              Delete
            </button>
          )}
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn secondary" onClick={() => save(false)} disabled={!canSave}>
            Save
          </button>
          <button className="btn" onClick={() => save(true)} disabled={!canSave}>
            {existing ? 'Save & connect' : 'Save & connect'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ProtocolField;
  value: string;
  onChange: (v: string) => void;
}) {
  if (field.type === 'boolean') {
    const on = value === 'true';
    return (
      <div className="field-inline">
        <label>{field.label}</label>
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} />
        {field.help && <div className="help">{field.help}</div>}
      </div>
    );
  }
  if (field.type === 'select') {
    return (
      <div className="field">
        <label>{field.label}</label>
        <select value={value || field.default || ''} onChange={(e) => onChange(e.target.value)}>
          {(field.choices ?? []).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        {field.help && <div className="help">{field.help}</div>}
      </div>
    );
  }
  const type = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';
  return (
    <div className="field">
      <label>{field.label}</label>
      <input
        type={type}
        value={value}
        placeholder={field.placeholder ?? field.default}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      {field.help && <div className="help">{field.help}</div>}
    </div>
  );
}
