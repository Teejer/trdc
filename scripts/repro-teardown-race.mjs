#!/usr/bin/env node
/**
 * Repro for the teardown race: connect to a TCP listener that accepts but
 * can never complete the RDP handshake (an HTTP server), while spamming
 * mouse input. Before the shim fix this SIGSEGVs the app the moment the
 * connect fails and input hits the freed FreeRDP instance.
 *
 *   node scripts/repro-teardown-race.mjs ws://127.0.0.1:<bridge-port>/
 */
import net from 'node:net';

const url = process.argv[2];
if (!url) { console.error('usage: repro-teardown-race.mjs <bridge-ws-url>'); process.exit(2); }

// A local "host" that accepts TCP and speaks nonsense.
const fakeHost = net.createServer((sock) => {
  sock.on('data', () => sock.write('HTTP/1.1 404 Not Found\r\n\r\n'));
  sock.on('error', () => {});
});
await new Promise((r) => fakeHost.listen({ port: 0, host: '127.0.0.1' }, r));
const hostPort = fakeHost.address().port;
console.log('fake RDP host on 127.0.0.1:' + hostPort);

const ws = new WebSocket(url);
const t0 = Date.now();
const say = (...a) => console.log(`+${String(Date.now() - t0).padStart(6)}ms`, ...a);
let spam = 0, alive = true;

ws.onopen = () => {
  say('sent open');
  ws.send(JSON.stringify({
    t: 'open', protocol: 'rdp', hostname: '127.0.0.1', port: hostPort,
    username: 'u', password: 'p', width: 800, height: 600,
  }));
  // Like a human whose mouse sits on the canvas while the handshake dies.
  const timer = setInterval(() => {
    if (!alive || ws.readyState !== WebSocket.OPEN) return clearInterval(timer);
    ws.send(JSON.stringify({ t: 'mouse', x: spam % 800, y: 300, mask: 0 }));
    spam++;
  }, 5);
  // Force the teardown path: ask to disconnect mid-spam, then keep sending
  // input for a bit longer so events race the shim's instance teardown.
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) { say('sent disconnect'); ws.send('{"t":"disconnect"}'); }
  }, 8000).unref?.();
};
ws.onmessage = (ev) => say('msg', typeof ev.data === 'string' ? ev.data.slice(0, 160) : `[binary ${ev.data.byteLength}]`);
ws.onclose = (e) => { say('close', e.code, `(sent ${spam} mouse events)`); alive = false; fakeHost.close(); process.exit(0); };
ws.onerror = () => {};
setTimeout(() => { say('timeout 30s — no close'); process.exit(1); }, 30000);
