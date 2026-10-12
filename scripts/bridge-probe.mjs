#!/usr/bin/env node
/**
 * Bridge protocol smoke test (replaces the old guacd-era probe-ws.ts).
 *
 *   node scripts/bridge-probe.mjs ws://127.0.0.1:<port>/ <host> [port]
 *
 * Opens a session-bridge WebSocket, sends the JSON "open" message for an
 * RDP connection, and prints every control message + a summary of every
 * binary frame (tile/cursor kind, rect, payload bytes) until the session
 * closes. Useful for exercising the Rust engine without the UI: against a
 * dead port it must print a closed frame carrying the FreeRDP error text;
 * against a live host it should show ready + tile frames streaming.
 */
const url = process.argv[2] || 'ws://127.0.0.1:1421/';
const host = process.argv[3] || '127.0.0.1';
const port = Number(process.argv[4] || 1); // deliberately dead by default

const ws = new WebSocket(url);
const t0 = Date.now();
const say = (...a) => console.log(`+${String(Date.now() - t0).padStart(6)}ms`, ...a);
let tiles = 0, cursors = 0, bytes = 0;

ws.onopen = () => {
  say('open', url);
  ws.send(JSON.stringify({
    t: 'open', protocol: 'rdp',
    hostname: host, port,
    username: 'probe', password: 'probe', domain: '',
    width: 1024, height: 768, dpi: 96, layout: 'en-us-qwerty',
  }));
  say('sent open →', host + ':' + port);
};
ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') { say('msg  ', ev.data.slice(0, 400)); return; }
  const buf = Buffer.from(ev.data);
  const kind = buf[0];
  const x = buf.readInt32LE(1), y = buf.readInt32LE(5);
  const w = buf.readInt32LE(9), h = buf.readInt32LE(13);
  const len = buf.length - 17;
  if (kind === 1) { tiles++; bytes += len; if (tiles <= 3 || tiles % 60 === 0) say(`tile #${tiles}`, `${w}x${h}@${x},${y}`, `${len}B`); }
  else if (kind === 2) { cursors++; say(`cursor`, `${w}x${h} hot=${x},${y}`, `${len}B`); }
  else say('binary kind=' + kind, `${w}x${h}@${x},${y}`, `${len}B`);
};
ws.onerror = (e) => say('ws error', e.message || '(see close)');
ws.onclose = (e) => { say('close', 'code=' + e.code, `tiles=${tiles} bytes=${bytes} cursors=${cursors}`); process.exit(0); };
setTimeout(() => { say('timeout 15s', `tiles=${tiles} cursors=${cursors}`); process.exit(2); }, 15000).unref?.();
