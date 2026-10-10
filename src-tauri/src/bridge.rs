//! Local WebSocket <-> TCP bridge.
//!
//! The webview can only speak WebSocket, while guacd speaks the raw
//! Guacamole protocol over TCP. This bridge listens on a random loopback
//! port; every accepted WebSocket connection is piped byte-for-byte to a
//! fresh TCP connection to the currently-running guacd.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;

/// Shared bridge state: the port the WS listener is bound to, and the
/// (reconfigurable) port guacd is listening on.
pub struct BridgeState {
    pub ws_port: std::sync::Mutex<u16>,
    pub guacd_port: std::sync::Mutex<u16>,
}

impl BridgeState {
    pub fn new() -> Self {
        Self {
            ws_port: std::sync::Mutex::new(0),
            guacd_port: std::sync::Mutex::new(4822),
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
                    let state = Arc::clone(&state);
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = handle_connection(stream, state).await {
                            log::debug!("bridge connection from {peer} closed: {e}");
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

async fn handle_connection(
    stream: TcpStream,
    state: Arc<BridgeState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let guacd_port = {
        let p = state.guacd_port.lock().map_err(|_| "poisoned")?;
        *p
    };

    let ws = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("ws handshake failed: {e}"))?;

    let tcp = TcpStream::connect(("127.0.0.1", guacd_port))
        .await
        .map_err(|e| format!("cannot reach guacd on port {guacd_port}: {e}"))?;

    log::debug!("bridged session connection -> guacd :{guacd_port}");
    pump(ws, tcp).await
}

/// Pump bytes in both directions until either side closes.
async fn pump(
    ws: WebSocketStream<TcpStream>,
    tcp: TcpStream,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (mut tcp_r, mut tcp_w) = tcp.into_split();
    let (mut ws_tx, mut ws_rx) = ws.split();

    let ws_to_tcp = async {
        while let Some(msg) = ws_rx.next().await {
            match msg? {
                tokio_tungstenite::tungstenite::Message::Binary(data) => {
                    tcp_w.write_all(&data[..]).await?;
                    tcp_w.flush().await?;
                }
                tokio_tungstenite::tungstenite::Message::Text(data) => {
                    tcp_w.write_all(data.as_bytes()).await?;
                    tcp_w.flush().await?;
                }
                tokio_tungstenite::tungstenite::Message::Close(_) => break,
                _ => {}
            }
        }
        Ok::<(), tokio_tungstenite::tungstenite::Error>(())
    };

    let tcp_to_ws = async {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = tcp_r.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            ws_tx
                .send(tokio_tungstenite::tungstenite::Message::Binary(
                    buf[..n].to_vec().into(),
                ))
                .await
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::BrokenPipe, e))?;
        }
        Ok::<(), std::io::Error>(())
    };

    let (a, b) = tokio::join!(ws_to_tcp, tcp_to_ws);
    a?;
    b?;
    Ok(())
}

/// Set the port guacd is listening on (used when the sidecar (re)starts).
pub fn set_guacd_port(state: &BridgeState, port: u16) {
    if let Ok(mut p) = state.guacd_port.lock() {
        *p = port;
    }
}
