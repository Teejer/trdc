# trdc — a remote desktop client with a built-in AI operator

trdc is a single-desktop-app remote access client:

- **Connection tabs** across the top, one per live session
- **Connection list sidebar** on the left (search, folders, status dots)
- **AI panel** on the right that can *look at* the remote screen and *drive*
  it — mouse moves, clicks, drags, scrolling, typing and key chords — through
  any OpenAI-compatible backend that supports vision + tool calling

Protocols are a registry, not hard-coded: RDP and VNC work today, SSH and
Telnet (terminal) are included, and adding a protocol is one `ProtocolDef`
entry in `src/protocols/index.ts` as long as guacamole-server has a plugin for
it.

Old Windows apps that only ever paint light get a **client-side dark mode**:
a per-tab 🌙 toggle (and a global default in Settings) that renders the remote
screen through an `invert + hue-rotate` filter, so Explorer, old GDI apps and
Windows 7-era software are comfortable to look at. Hues stay correct, and the
AI's screenshots read the raw layer canvas — the model always sees true
colors regardless of the filter.

No Electron, no Docker, no system daemon: one Tauri binary that spawns its own
loopback-only `guacd` sidecar.

## Architecture

```
┌───────────────────────────── trdc (Tauri 2) ─────────────────────────────┐
│                                                                          │
│  Webview (React)                    Rust core                            │
│  ┌───────────────┐   invoke   ┌───────────────┐   spawn  ┌────────────┐  │
│  │ tabs/sidebar/ │ ─────────► │ config, ai_    │ ───────► │ guacd      │  │
│  │ session views │            │ request proxy, │  127.0.0.1│ (sidecar, │  │
│  │ AI panel      │            │ WS↔TCP bridge  │  only    │ 127.0.0.1) │  │
│  │  │ WsTunnel   │ ◄──ws────► │ (bridge.rs)    │ ◄──tcp─► │ RDP/VNC/…  │  │
│  └───────────────┘            └───────────────┘          └─────┬──────┘  │
└────────────────────────────────────────────────────────────────│─────────┘
                                                                 ▼
                                                       remote hosts (RDP/VNC/…)
```

- **`guacd` sidecar** — trdc finds a guacamole-server install tree (bundled
  next to the binary, `native/prefix/` in a dev checkout, or a path you set in
  Settings), picks a free loopback port, and launches it with the right
  `LD_LIBRARY_PATH` / `GUAC_RDP_PLUGIN_DIR`. It is killed on app exit and on
  SIGTERM.
- **Bridge** (`src-tauri/src/bridge.rs`) — the webview can only speak
  WebSocket, guacd speaks raw Guacamole protocol over TCP, so the Rust core
  runs a byte-for-byte WS↔TCP pump on an ephemeral 127.0.0.1 port.
- **`WsTunnel`** (`src/guac/WsTunnel.ts`) — implements the guacd client
  handshake (`select → args → size/audio/video/image/name/timezone/connect
  → ready`) and plugs into guacamole-common-js's `Guacamole.Client`.
- **AI** — all LLM HTTP goes through the Rust `ai_request` command (reqwest +
  rustls, streaming) so the API key never enters the webview and CORS is a
  non-issue. The agent loop lives in `src/ai/openai.ts`; the remote-control
  tools in `src/ai/tools.ts` (screenshot, mouse_move/click/drag/scroll,
  type_text, key_press, hotkey, wait, clipboard_paste, session_info).
  Screenshots are rendered from the live `Guacamole.Display` and sent back to
  the model as a vision image.
- **Approval gate** (ported from the krdc-ai work, KDE MR !259) — every tool
  call is classified in `src/ai/risk.ts` as safe (reads only → never asks),
  action (asks unless Settings → *Auto-execute* is on), or dangerous (always
  asks, even with auto-execute: destructive shell/PowerShell patterns in typed
  text, Ctrl+Alt+Del, Win+L, Alt+F4, …). The approval bar shows a plain-English
  description plus a live crop of the screen with red crosshairs on the exact
  landing point — ground truth, not the model's claim. Denying tells the model
  not to retry.
- **Coordinate mapping** (also from krdc-ai) — the model quotes pixels of the
  downscaled screenshot it received; trdc maps them to true display pixels
  itself and rejects non-numeric or out-of-bounds coordinates instead of
  silently clicking (0,0). `hotkey` takes one string chord ("ctrl+alt+del")
  because llama.cpp-style backends drop array tool arguments.
- **Shared cursor** — human and AI drive the same remote cursor (last writer
  wins, like two people sharing one machine). A purple "AI control" badge
  shows while the AI is acting; AI input can be disabled globally in Settings.

## Prerequisites

- Rust (rustup), Node 20+
- System libs for Tauri/WebKitGTK (Arch: `webkit2gtk-4.1`, `gtk3`,
  `libsoup3`; see the Tauri prerequisites page for other distros)
- For building guacd: FreeRDP 3.x, libvncserver, libssh2, openssl, libpng,
  libjpeg, pthread/stubs — plus a C toolchain

## Building guacd (one time)

The pinned, verified version is **guacamole-server 1.6.0**:

```sh
cd native
git clone --depth 1 --branch 1.6.0 https://github.com/apache/guacamole-server.git src/guacamole-server

# Required for the FreeRDP channel plugin loading fix (no root needed):
cd src/guacamole-server && git apply ../../patches/plugin_dir.patch && cd ../..

./bootstrap
export CPPFLAGS="$CPPFLAGS -Wno-error -Wno-deprecated-declarations"
./configure --prefix=$PWD/prefix --with-init-dir=/tmp/guacd-init \
    --enable-webp --with-freerdp-plugin-dir=$PWD/prefix/lib/freerdp3
make -j$(nproc) && make install
```

On Arch (and anywhere with recent FreeRDP): the `-Wno-error` **must go in
CPPFLAGS, not CFLAGS**. guacamole-server's configure appends its own
`-Werror` after `$CFLAGS` but before `$CPPFLAGS` when probing FreeRDP
features; with `-Werror` last, deprecation warnings fail the
`FREERDP_HAS_CONTEXT` probe, config.h silently takes the old-struct-layout
branch, and the RDP plugin then fails to compile (or worse, miscompiles)
against FreeRDP ≥ 3.32.

`patches/plugin_dir.patch` teaches the RDP plugin to load FreeRDP channel
plugins (`libguac-common-svc-client.so`) from `GUAC_RDP_PLUGIN_DIR` instead of
the compiled-in `/usr/lib/freerdp3` — without it, clipboard/formatting
channels silently no-op unless you install as root. It builds cleanly against
Arch's FreeRDP 3.32 with `-Wno-error`.

The resulting `native/prefix/` tree is what trdc auto-launches in development;
for a packaged app, ship the tree next to the binary (see
`src-tauri/src/guacd.rs` candidate list) or point Settings → guacd path at it.

## Running

```sh
npm install
npm run dev          # vite on :1420 + trdc window (cargo tauri dev), or:
npm run build && (cd src-tauri && cargo run)
```

Headless-ish dev launch (what this repo's e2e used):

```sh
npx vite --port 1420 --strictPort &
DISPLAY=:0 GDK_BACKEND=x11 ./src-tauri/target/debug/trdc
```

If you launch from a shell that lost X authorization (e.g. after the screen
locked under GNOME/Mutter), point `XAUTHORITY` at the running Xwayland's auth
file: `XAUTHORITY=$(tr '\0' ' ' </proc/$(pgrep -f "[X]wayland")/cmdline |
grep -oP '(?<=-auth )[^ ]+')`.

Release bundle: `npx tauri build` (bundles `native/prefix` if you add it to
`bundle.resources`).

## Testing hooks

- `?autopen=<connection-id>` in the dev URL opens that saved connection on
  startup (set it in `src-tauri/tauri.conf.json` → `build.devUrl` for scripted
  runs).
- `scripts/probe-ws.ts ws://127.0.0.1:<bridge-port>/` replays a raw VNC
  handshake through the bridge — useful for debugging protocol-level issues
  without the UI.
- Test target used during development: `Xvnc :99 -SecurityTypes None
  -geometry 1024x768 -localhost no` (VNC on :5999), change the screen with
  `DISPLAY=:99 xsetroot -solid '#rrggbb'`. **Don't leave this running** — it
  is unauthenticated on all interfaces.

## guacd protocol notes (hard-won)

- Wire format: `len.value` elements joined by `,`, instruction ends `;`.
  All blob data is base64.
- `args` reply is `args,<protocol-version>,<argname>...`; the `connect`
  instruction must echo the server's version string as argv[0] and have
  exactly one value per advertised arg name.
- **guacd 1.6 sends `ready` only as an ack of our `connect`** — don't wait for
  `ready` to send values; reply to `args`.
- **`size,<w>,<h>,<dpi>` before `connect` is mandatory** — without it
  guacd's optimal width/height stay 0 and it never forwards a single frame
  (it just sits there replying `ready` forever).
- The client must **echo the server's `sync` timestamp** back; a `sync` whose
  timestamp exceeds guacd's `last_sent_timestamp` errors the user out
  ("User connection aborted").
- Idle users are disconnected after 15 s of silence (`GUACD_TIMEOUT`), so the
  tunnel pings `nop` like guacamole-common-js's HTTP tunnel does.
- Unrecognized handshake opcodes are silently ignored — a stale client doesn't
  error, it just hangs.

## Layout

```
src/
  guac/       WsTunnel (guacd handshake + keepalive), GuacSession
              (display, human+AI input injection, screenshots)
  protocols/  protocol registry (rdp, vnc, ssh, telnet)
  ai/         openai.ts (SSE streaming + tool loop), tools.ts (remote-control tools)
  store/      external store (tabs, conversations, settings) + useSyncExternalStore
  components/ App, Sidebar, TabBar, SessionView, AiPanel, ConnectionEditor, SettingsModal
src-tauri/src/
  lib.rs      commands + startup wiring
  bridge.rs   WS↔TCP pump (webview ↔ guacd)
  guacd.rs    sidecar discovery/env/spawn/kill
  ai_proxy.rs ai_request (reqwest, streaming via Channel<String>)
  config.rs   connections.json / settings.json persistence (whitelisted names)
native/prefix/  built guacamole-server 1.6.0 (guacd + protocol plugins)
patches/        plugin_dir.patch (FreeRDP plugin-dir fix)
```
