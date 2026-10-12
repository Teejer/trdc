#!/usr/bin/env node
/**
 * Connect through the session bridge using a SAVED profile from
 * connections.json (password read from disk only if present; never printed).
 *
 *   node scripts/probe-profile.mjs ws://127.0.0.1:<bridge>/ <profile-name>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2];
const name = process.argv[3];
if (!url || !name) { console.error('usage: probe-profile.mjs <bridge-ws> <name>'); process.exit(2); }

const file = path.join(os.homedir(), '.config/dev.teejer.trdc/connections.json');
const conns = JSON.parse(fs.readFileSync(file, 'utf8'));
const list = Array.isArray(conns) ? conns : conns.connections || [];
const p = list.find((c) => c.name === name);
if (!p) { console.error('profile not found:', name, 'have:', list.map((c) => c.name).join(', ')); process.exit(2); }
const params = p.params || {};

const ws = new WebSocket(url);
const t0 = Date.now();
const say = (...a) => console.log(`+${String(Date.now() - t0).padStart(6)}ms`, ...a);
let tiles = 0, bytes = 0;

ws.onopen = () => {
  say('open →', p.hostname, 'user=', params.username || '(none)', 'domain=', params.domain || '(none)', 'pw=', params.password ? 'yes' : 'no');
  ws.send(JSON.stringify({
    t: 'open', protocol: p.protocol, hostname: p.hostname,
    port: params.port || 3389, username: params.username || '',
    password: params.password || '', domain: params.domain || '',
    width: 1280, height: 800, dpi: 96, layout: params.layout || 'en-us-qwerty',
  }));
};
ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') { say('msg', ev.data.slice(0, 300)); return; }
  const b = Buffer.from(ev.data);
  if (b[0] === 1) { tiles++; bytes += b.length - 17; if (tiles <= 3 || tiles % 30 === 0) say(`tile #${tiles}`, `${b.readInt32LE(9)}x${b.readInt32LE(13)}`, `${b.length}B`); }
  else say('bin kind', b[0]);
};
ws.onclose = (e) => { say('close', e.code, `tiles=${tiles} bytes=${bytes}`); process.exit(0); };
ws.onerror = () => {};
// NLA can take a while (Kerberos DNS discovery); give it room.
setTimeout(() => { say('timeout 30s', `tiles=${tiles}`); process.exit(1); }, 30000).unref?.();
