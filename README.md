# trdc — a remote desktop client with a built-in AI operator

trdc is a single-desktop-app remote access client:

- **Connection tabs** across the top, one per live session
- **Connection list sidebar** on the left (search, folders, status dots)
- **AI panel** on the right that can *look at* the remote screen and *drive*
  it — mouse moves, clicks, drags, scrolling, typing and key chords — through
  any OpenAI-compatible backend that supports vision + tool calling

RDP is a **native client**: trdc links FreeRDP 3 directly into the process —
no Electron, no Docker, no sidecar daemon, nothing to start. One Tauri binary.
(VNC/SSH are planned as further native engines; the protocol layer is a
registry, not hard-coded.)

Old Windows apps that only ever paint light get a **client-side dark mode**:
a per-tab 🌙 toggle (and a global default in Settings) that renders the remote
screen through an `invert + hue-rotate` filter, so Explorer, old GDI apps and
Windows 7-era software are comfortable to look at. Hues stay correct, and the
AI's screenshots read the raw canvas — the model always sees true colors
regardless of the filter.

## Architecture

```
┌────────────────────────────── trdc (Tauri 2) ──────────────────────────────┐
│                                                                            │
│  Webview (React)                     Rust core                             │
│  ┌───────────────┐   invoke   ┌────────────────┐    ┌───────────────────┐  │
│  │ tabs/sidebar/ │ ─────────► │ config, ai_     │    │ rdp/ (FreeRDP 3)  │  │
│  │ session views │            │ request proxy   │───►│ per-connection    │──┼──► RDP hosts
│  │ AI panel      │ ◄──ws────► │ bridge.rs       │    │ event loop +      │  │    (3389)
│  │ NativeSession │  binary    │ session bridge  │    │ frame ticker      │  │
│  └───────────────┘  tiles     └────────────────┘    └───────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

- **RDP engine** (`src-tauri/src/rdp/`) — `shim.c` (compiled by build.rs via
  `cc` + pkg-config against system freerdp3/winpr3) owns the FreeRDP event
  loop, GDI paint hooks and pointer (AND/XOR → RGBA) decoding; `session.rs`
  wraps it safely: one FreeRDP thread per connection painting into a shared
  BGRA surface, plus a ~60 Hz ticker that JPEG-encodes the dirty region and
  pushes tiles over the bridge. `keyboard.rs` + generated `keymap.rs` are the
  X11-keysym → RDP-scancode engine ported from guacamole-server's
  `keyboard.c` (the same tables xrdp uses), including modifier/lock cost
  resolution and the KP_Enter fix guacamole itself is missing.
- **Session bridge** (`src-tauri/src/bridge.rs`) — the webview can only speak
  WebSocket, so each WS connection *is* one session: the webview sends a JSON
  `open` (host/auth/desktop size), then JSON input events; it receives JSON
  control messages plus binary pixel frames
  (`[u8 kind][i32 x][i32 y][i32 w][i32 h][JPEG|PNG]`).
- **`NativeSession`** (`src/native/NativeSession.ts`) — draws tiles onto a
  canvas in send order, sprites the server-side cursor, maps human pointer
  and keyboard (guacamole-common-js's keysym normalization) into bridge
  messages, and exposes the screenshot / approval-crop / input-injection API
  the AI tools use.
- **AI** — all LLM HTTP goes through the Rust `ai_request` command (reqwest +
  rustls, streaming) so the API key never enters the webview and CORS is a
  non-issue. The agent loop lives in `src/ai/openai.ts`; the remote-control
  tools in `src/ai/tools.ts` (screenshot, mouse_move/click/drag/scroll,
  type_text, key_press, hotkey, wait, clipboard_paste→typed fallback,
  session_info). Screenshots are rendered from the live canvas and sent back
  to the model as a vision image.
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
- Tauri/WebKitGTK system libs (Arch: `webkit2gtk-4.1`, `gtk3`, `libsoup3`)
- **FreeRDP 3.x** development files (Arch: `freerdp`; headers + pkg-config
  files `freerdp3`/`winpr3`). No libclang needed — the FFI is a hand-written
  C shim, not bindgen.

## Running

```sh
npm install
npm run dev          # vite on :1420 + trdc window (cargo tauri dev), or:
npm run build && (cd src-tauri && cargo run)
```

Headless-ish dev launch (what this repo's e2e used):

```sh
npx vite --port 1420 --strictPort &
DISPLAY=:0 ./src-tauri/target/debug/trdc
```

If you launch from a shell that lost X authorization (e.g. after the screen
locked under GNOME/Mutter), point `XAUTHORITY` at the running Xwayland's auth
file: `XAUTHORITY=$(tr '\0' ' ' </proc/$(pgrep -f "[X]wayland")/cmdline |
grep -oP '(?<=-auth )[^ ]+')`.

Release bundle: `npx tauri build`. For a plain cargo release build you must
pass the embedding feature explicitly or the binary loads the dev URL:

```sh
(cd src-tauri && cargo build --release --features custom-protocol)
```

## Installing on Arch

AUR: `yay -S trdc` (or build `pkg/PKGBUILD` yourself — it is the exact
package source). The PKGBUILD builds the frontend, then the Rust binary with
`--features custom-protocol`, and installs `/usr/bin/trdc` + icon + desktop
entry. Runtime deps are just `freerdp` and the webkit stack.

## Keyboard notes (hard-won)

- Keysyms travel the wire; scancodes are resolved on the Rust side against
  guacamole's generated per-layout tables (`scripts/gen-keymap.py` regenerates
  `keymap.rs` from the vendored table under `scripts/keymaps/`). This avoids
  winpr's VK converter, which krdc proved unreliable for extended keys.
- `XK_KP_Enter` is absent from guacamole's tables (guacd drops it); trdc maps
  it to the correct extended Enter (E0 1C).
- Shift+Tab must go out as `ISO_Left_Tab` (keysym 0xFE20), not Tab+Shift —
  models and humans both hit this.
- Typing outside the layout falls back to RDP Unicode keyboard events
  (surrogate pairs split into two events); dead-key decomposition is skipped
  since Unicode covers it on any Vista-or-newer server.

## Testing hooks

- `?autopen=<connection-id>` in the dev URL opens that saved connection on
  startup (set it in `src-tauri/tauri.conf.json` → `build.devUrl` for scripted
  runs).
- `cargo test --lib` in `src-tauri` covers the keyboard engine (scancodes,
  shift auto-press/release semantics, Unicode fallback, KP_Enter).

## Layout

```
src/
  native/     NativeSession (canvas tiles, cursor sprite, human+AI input,
              screenshots, dark-mode filter)
  protocols/  protocol registry (rdp; vnc/ssh planned as native engines)
  ai/         openai.ts (SSE streaming + tool loop), tools.ts (remote-control
              tools), risk.ts (approval gate)
  store/      external store (tabs, conversations, settings) + useSyncExternalStore
  components/ App, Sidebar, TabBar, SessionView, AiPanel, ConnectionEditor, SettingsModal
src-tauri/src/
  rdp/        shim.c + shim.h (FreeRDP event loop/paint/pointer), ffi.rs,
              session.rs (surface + frame ticker), keyboard.rs + keymap.rs
  lib.rs      commands + startup wiring
  bridge.rs   WS session bridge (open/input JSON in, control + binary tiles out)
  ai_proxy.rs ai_request (reqwest, streaming via Channel<String>)
  config.rs   connections.json / settings.json persistence (whitelisted names)
scripts/
  gen-keymap.py + keymaps/  keymap.rs generator and its vendored source table
pkg/          AUR PKGBUILD + .SRCINFO
```
