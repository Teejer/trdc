//! Local WebSocket <-> RDP session bridge.
//!
//! The webview can only speak WebSocket, so every WS connection is one
//! remote-desktop session. The first message must be a JSON "open" (protocol
//! rdp + connection parameters); from then on the webview sends JSON input
//! events and receives JSON control events plus binary pixel frames:
//!
//!   binary out: [u8 kind][i32le x][i32le y][i32le w][i32le h][payload]
//!     kind 1 = screen tile (JPEG), kind 2 = cursor shape (PNG; x/y are the
//!     hotspot). Text frames are JSON control messages.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;

use crate::rdp::{ConnectParams, RunningSession, ServerEvent};

/// Shared bridge state: the port the WS listener is bound to.
pub struct BridgeState {
    pub ws_port: std::sync::Mutex<u16>,
}

impl BridgeState {
    pub fn new() -> Self {
        Self {
            ws_port: std::sync::Mutex::new(0),
        }
    }
}

/// Bind the WS listener and return the assigned port. The accept loop runs
/// as a background tokio task.
pub async fn start_bridge(state: Arc<BridgeState>) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("failed to bind bridge listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("bridge listener address unavailable: {e}"))?
        .port();
    *state
        .ws_port
        .lock()
        .map_err(|_| "bridge state poisoned".to_string())? = port;

    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, peer)) => {
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = handle_connection(stream).await {
                            log::debug!("session connection from {peer} closed: {e}");
                        }
                    });
                }
                Err(e) => {
                    log::warn!("bridge accept failed: {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
    });

    Ok(port)
}

fn get_str(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn get_u32(v: &Value, key: &str, default: u32) -> u32 {
    // Connection-editor params arrive as strings ("1920"); the probe and
    // any hand-written open message may use JSON numbers. Accept both.
    v.get(key)
        .and_then(|x| {
            x.as_u64()
                .or_else(|| x.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
        })
        .map(|x| x as u32)
        .unwrap_or(default)
}

fn parse_open(v: &Value) -> Result<ConnectParams, String> {
    if v.get("t").and_then(|t| t.as_str()) != Some("open") {
        return Err("first message must be an open".into());
    }
    let protocol = get_str(v, "protocol");
    if protocol != "rdp" {
        return Err(format!("unsupported protocol {protocol:?}"));
    }
    let hostname = get_str(v, "hostname");
    if hostname.is_empty() {
        return Err("open message needs a hostname".into());
    }
    Ok(ConnectParams {
        hostname,
        port: get_u32(v, "port", 3389) as u16,
        username: get_str(v, "username"),
        password: get_str(v, "password"),
        domain: get_str(v, "domain"),
        width: get_u32(v, "width", 1280),
        height: get_u32(v, "height", 800),
        dpi: get_u32(v, "dpi", 96),
        layout: {
            let l = get_str(v, "layout");
            if l.is_empty() { crate::rdp::keymap::DEFAULT_LAYOUT.to_string() } else { l }
        },
    })
}

/// One session per connection: open message, then pump both ways.
async fn handle_connection(
    stream: TcpStream,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut ws = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("ws handshake failed: {e}"))?;

    // First frame: the open message.
    let open = loop {
        match ws.next().await {
            Some(Ok(Message::Text(text))) => break serde_json::from_str::<Value>(&text)
                .map_err(|e| format!("open message is not valid JSON: {e}"))?,
            Some(Ok(Message::Close(_))) | None => return Err("closed before open".into()),
            Some(Err(e)) => return Err(format!("ws error: {e}").into()),
            Some(Ok(_)) => continue, // ping/pong/etc before open
        }
    };
    let params = match parse_open(&open) {
        Ok(p) => p,
        Err(e) => {
            // Explain the rejection before hanging up; the webview shows
            // this text on the session's error overlay.
            let _ = ws
                .send(Message::Text(
                    json!({"t": "closed", "error": e}).to_string().into(),
                ))
                .await;
            let _ = ws.send(Message::Close(None)).await;
            return Err(e.into());
        }
    };
    let label = format!("{}:{}", params.hostname, params.port);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ServerEvent>();
    // freerdp_connect blocks (TLS/NLA handshakes), so start off-runtime.
    let mut session = tauri::async_runtime::spawn_blocking(move || {
        let s = RunningSession::start(params, tx);
        s.start_ticker();
        s
    })
    .await
    .map_err(|e| format!("session start panicked: {e}"))?;

    log::debug!("rdp session opened to {label}");
    let (mut ws_tx, mut ws_rx) = ws.split();

    // Server -> webview: forward events until the session reports Closed.
    let mut out = tauri::async_runtime::spawn(async move {
        let mut failed = false;
        let dbg = std::env::var("TRDC_RDP_DEBUG").is_ok();
        let mut nframe = 0u64;
        let mut nev = 0u64;
        while let Some(ev) = rx.recv().await {
            let closed = matches!(ev, ServerEvent::Closed { .. });
            let isframe = matches!(ev, ServerEvent::Frame { .. });
            nev += 1;
            if isframe {
                nframe += 1;
                if dbg && nframe <= 3 {
                    eprintln!("[trdc-dbg] out -> ws frame #{nframe}");
                }
            }
            let msg = encode_event(ev);
            let stop = ws_tx.send(msg).await.is_err();
            if stop || closed {
                if dbg && stop {
                    eprintln!("[trdc-dbg] out: ws send failed at event #{nev} (frames={nframe})");
                }
                failed = stop;
                break;
            }
        }
        if dbg {
            eprintln!("[trdc-dbg] out exiting: events={nev} frames={nframe} failed={failed}");
        }
        // Tell the webview to drop the socket if we ended server-side; if
        // the socket is already gone there is nothing to say.
        if !failed {
            let _ = ws_tx.send(Message::Close(None)).await;
        }
        ws_tx
    });

    // Webview -> server: JSON input events, straight into the session. The
    // session is *owned* by this block so that whichever way the select
    // below ends — block completion or cancellation — the RunningSession
    // (and with it the FreeRDP loop and the last event-channel sender) is
    // dropped, which is what lets the out task's rx.recv() wind down.
    let input = async move {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if text.starts_with("{\"t\":\"debug\"") {
                        eprintln!("[webview] {text}");
                    } else if !handle_input(&mut session, &text) {
                        break; // {"t":"disconnect"}
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => {}
            }
        }
    };

    // Drop-then-join: awaiting out before the session died would deadlock
    // whenever the webview hung up while the RDP host kept painting. If out
    // already completed inside the select its JoinHandle must not be polled
    // again (tokio panics on poll-after-completion) — hence the await lives
    // only in the input branch.
    tokio::select! {
        _ = input => { let _ = out.await; }
        _ = &mut out => {}
    };
    log::debug!("rdp session closed: {label}");
    Ok(())
}

/// Translate one input event; returns false when the webview asked to
/// disconnect.
fn handle_input(session: &mut RunningSession, text: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return true;
    };
    match v.get("t").and_then(|t| t.as_str()).unwrap_or("") {
        "mouse" => {
            if std::env::var("TRDC_RDP_DEBUG").is_ok() {
                eprintln!(
                    "[trdc-dbg] bridge mouse x={} y={} mask={} live={}",
                    v.get("x").and_then(|x| x.as_i64()).unwrap_or(0),
                    v.get("y").and_then(|y| y.as_i64()).unwrap_or(0),
                    v.get("mask").and_then(|m| m.as_i64()).unwrap_or(0),
                    session.live()
                );
            }
            session.mouse(
                v.get("x").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
                v.get("y").and_then(|y| y.as_i64()).unwrap_or(0) as i32,
                v.get("mask").and_then(|m| m.as_i64()).unwrap_or(0) as i32,
            )
        }
        "key" => {
            let keysym = v.get("keysym").and_then(|k| k.as_i64()).unwrap_or(0) as i32;
            let down = v.get("down").and_then(|d| d.as_i64()).unwrap_or(0) != 0;
            if std::env::var("TRDC_RDP_DEBUG").is_ok() {
                eprintln!("[trdc-dbg] bridge key keysym=0x{keysym:x} down={down} live={}", session.live());
            }
            if keysym != 0 {
                session.keysym(keysym, down);
            }
        }
        "locks" => {
            let flags = v.get("flags").and_then(|f| f.as_u64()).unwrap_or(0) as u32;
            session.sync_locks(flags);
        }
        "resize" => {
            let width = v.get("width").and_then(|w| w.as_i64()).unwrap_or(0) as i32;
            let height = v.get("height").and_then(|h| h.as_i64()).unwrap_or(0) as i32;
            let sent = session.resize(width, height);
            eprintln!("[trdc-dbg] bridge resize {width}x{height} sent={sent}");
        }
        "disconnect" => return false,
        _ => {}
    }
    true
}

/// i32 little-endian append helper for the binary frame header.
fn put_i32(buf: &mut Vec<u8>, v: i32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

fn encode_event(ev: ServerEvent) -> Message {
    match ev {
        ServerEvent::Ready { width, height } => Message::Text(
            json!({"t": "ready", "width": width, "height": height}).to_string().into(),
        ),
        ServerEvent::Resize { width, height } => Message::Text(
            json!({"t": "resize", "width": width, "height": height}).to_string().into(),
        ),
        ServerEvent::Frame { x, y, w, h, data } => {
            let mut buf = Vec::with_capacity(17 + data.len());
            buf.push(1u8);
            put_i32(&mut buf, x as i32);
            put_i32(&mut buf, y as i32);
            put_i32(&mut buf, w as i32);
            put_i32(&mut buf, h as i32);
            buf.extend_from_slice(&data);
            Message::Binary(buf.into())
        }
        ServerEvent::CursorPng { hotx, hoty, w, h, data } => {
            let mut buf = Vec::with_capacity(17 + data.len());
            buf.push(2u8);
            put_i32(&mut buf, hotx);
            put_i32(&mut buf, hoty);
            put_i32(&mut buf, w as i32);
            put_i32(&mut buf, h as i32);
            buf.extend_from_slice(&data);
            Message::Binary(buf.into())
        }
        ServerEvent::SystemCursor { name } => {
            Message::Text(json!({"t": "system-cursor", "name": name}).to_string().into())
        }
        ServerEvent::CursorHide => Message::Text(json!({"t": "cursor-hide"}).to_string().into()),
        ServerEvent::CursorPos { x, y } => {
            Message::Text(json!({"t": "cursor-pos", "x": x, "y": y}).to_string().into())
        }
        ServerEvent::Closed { error } => {
            Message::Text(json!({"t": "closed", "error": error}).to_string().into())
        }
    }
}
