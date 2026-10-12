#!/usr/bin/env node
/**
 * Crash-race probe: open a session through the bridge with a SAVED profile
 * while spamming mouse events, so input keeps arriving during the whole
 * (failing) NLA handshake and its teardown. Pre-fix this SIGSEGVs trdc.
 *
 *   node scripts/probe-mouse-spam.mjs ws://127.0.0.1:<bridge>/ <profile-name> [secs]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2];
const name = process.argv[3];
const secs = Number(process.argv[4] || 25);
if (!url || !name) { console.error('usage: probe-mouse-spam.mjs <bridge-ws> <name> [secs]'); process.exit(2); }

const file = path.join(os.homedir(), '.config/dev.teejer.trdc/connections.json');
const conns = JSON.parse(fs.readFileSync(file, 'utf8'));
const list = Array.isArray(conns) ? conns : conns.connections || [];
const p = list.find((c) => c.name === name);
if (!p) { console.error('profile not found:', name); process.exit(2); }
const params = p.params || {};

const ws = new WebSocket(url);
const t0 = Date.now();
const say = (...a) => console.log(`+${String(Date.now() - t0).padStart(6)}ms`, ...a);
let sends = 0, tiles = 0;

ws.onopen = () => {
  say('open →', p.hostname, 'pw=', params.password ? 'yes' : 'no');
  ws.send(JSON.stringify({
    t: 'open', protocol: p.protocol, hostname: p.hostname,
    port: params.port || 3389, username: params.username || '',
    password: params.password || '', domain: params.domain || '',
    width: 1280, height: 800, dpi: 96, layout: params.layout || 'en-us-qwerty',
  }));
  // Spam mouse moves+clicks through the entire handshake/teardown.
  const spam = setInterval(() => {
    if (ws.readyState !== 1) return;
    const x = 100 + (sends % 600), y = 100 + (sends % 400);
    ws.send(JSON.stringify({ t: 'mouse', x, y, mask: sends % 8 }));
    sends++;
  }, 1);
  setTimeout(() => clearInterval(spam), secs * 1000).unref?.();
};
ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') { say('msg', ev.data.slice(0, 200)); return; }
  const b = Buffer.from(ev.data);
  if (b[0] === 1) { tiles++; if (tiles <= 2) say(`tile #${tiles}`); }
};
ws.onclose = (e) => { say('close', e.code, `spams=${sends} tiles=${tiles}`); process.exit(0); };
ws.onerror = () => {};
setTimeout(() => { say('done', `spams=${sends} tiles=${tiles}`); process.exit(0); }, (secs + 5) * 1000).unref?.();
