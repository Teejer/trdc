//! HTTP proxy for the AI panel.
//!
//! The webview cannot call arbitrary OpenAI-compatible backends directly
//! (CORS), so all AI traffic goes through this command. Responses are both
//! streamed to the caller chunk-by-chunk (for SSE chat completions) and
//! returned in full at the end.

use std::time::Duration;

use serde::Deserialize;
use tauri::ipc::Channel;

#[derive(Deserialize)]
pub struct AiRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// Overall timeout in milliseconds (default 120s).
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[tauri::command]
pub async fn ai_request(req: AiRequest, on_data: Channel<String>) -> Result<String, String> {
    if req.url.starts_with("file://") || !req.url.starts_with("http") {
        return Err("only http(s) URLs are allowed".into());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(req.timeout_ms.unwrap_or(120_000)))
        .build()
        .map_err(|e| e.to_string())?;

    let method =
        reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;

    let mut request = client.request(method, &req.url);
    for (name, value) in &req.headers {
        request = request.header(name.as_str(), value.as_str());
    }
    if let Some(body) = req.body {
        request = request.body(body);
    }

    let mut response = request
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = response.status();
    let mut full = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("read failed: {e}"))? {
        full.extend_from_slice(&chunk);
        if let Ok(text) = std::str::from_utf8(&chunk) {
            let _ = on_data.send(text.to_string());
        }
    }

    let text = String::from_utf8_lossy(&full).to_string();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), truncate(&text)));
    }
    Ok(text)
}

fn truncate(s: &str) -> String {
    const MAX: usize = 2000;
    if s.len() <= MAX {
        s.to_string()
    } else {
        let mut end = MAX;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}
