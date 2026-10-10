/** WS variant of the probe: goes through trdc's Rust bridge, exactly as the webview does. */
const url = process.argv[2];
function encode(...els: string[]): string {
  return els.map((e) => `${e.length}.${e}`).join(",") + ";";
}
function parse(buf: string): { instrs: string[]; rest: string } {
  const out: string[] = [];
  let pos = 0;
  outer: while (true) {
    const elems: string[] = [];
    while (true) {
      const dot = buf.indexOf(".", pos);
      if (dot === -1) break outer;
      const len = parseInt(buf.slice(pos, dot), 10);
      if (isNaN(len)) break outer;
      pos = dot + 1;
      if (buf.length < pos + len + 1) break outer;
      elems.push(buf.slice(pos, pos + len));
      pos += len;
      if (buf[pos] === ";") { pos++; out.push(elems.join(",")); continue outer; }
      if (buf[pos] !== ",") break outer;
      pos++;
    }
    break;
  }
  return { instrs: out, rest: buf.slice(pos) };
}
let buf = "", argNames: string[] = [], argsSeen = false, lastServerSync = 0, firstCopy = 0;
const counts: Record<string, number> = {};
const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";
ws.onopen = () => { console.log("WS open"); ws.send(encode("select", "vnc")); };
ws.onmessage = (ev) => {
  const d = ev.data as unknown;
  if (typeof d === "string") buf += d;
  else if (ArrayBuffer.isView(d)) buf += new TextDecoder().decode(d as unknown as Uint8Array);
  else if (d instanceof ArrayBuffer) buf += new TextDecoder().decode(d);
  else buf += String(d);
  if (!(ws as any).__dbg) { (ws as any).__dbg = 1; console.log("frame type:", (d as any)?.constructor?.name ?? typeof d, "len:", (d as any)?.length ?? String(d).length); }
  const { instrs, rest } = parse(buf); buf = rest;
  for (const i of instrs) {
    const op = i.split(",")[0];
    counts[op] = (counts[op] || 0) + 1;
    if (op === "args" && !argsSeen) {
      argsSeen = true;
      const elems = i.split(",");
      argNames = elems.slice(2);
      const values = argNames.map((n) => (n === "hostname" ? "127.0.0.1" : n === "port" ? "5999" : ""));
      ws.send(encode("size", "1280", "1024", "96"));
      ws.send(encode("audio", "audio/L16;rate=44100", "audio/L24;rate=44100", "audio/ogg", "audio/vnd.wave"));
      ws.send(encode("video", "video/ogg", "video/webm"));
      ws.send(encode("image", "image/jpeg", "image/png", "image/webp"));
      ws.send(encode("name", "probe"));
      ws.send(encode("timezone", "Europe/Berlin"));
      ws.send(encode("connect", elems[1], ...values));
      console.log(`args ok (${argNames.length} names); connect sent`);
    }
    if (op === "ready") console.log(`*** ready: ${i.slice(0, 60)}`);
    if (op === "sync") lastServerSync = parseInt(i.split(",")[1] || "0", 10) || lastServerSync;
    if ((op === "copy" || op === "img") && !firstCopy) { firstCopy = Date.now(); console.log(`drawing data flowing: ${i.slice(0, 50)}`); }
    if (op === "error" || op === "disconnect") console.log(`*** ${i.slice(0, 150)}`);
  }
};
ws.onclose = (e) => console.log(`WS close code=${e.code} reason=${e.reason}`);
ws.onerror = () => console.log("WS error");
const iv = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send(encode("sync", String(lastServerSync || Date.now()), "0", "0", "0"));
  console.log(JSON.stringify(counts));
  if (Date.now() - (firstCopy || Date.now()) > 8000) { clearInterval(iv); ws.close(); setTimeout(() => process.exit(0), 500); }
}, 1000);
