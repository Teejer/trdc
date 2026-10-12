//! guacd sidecar management.
//!
//! trdc ships (or points at) a guacamole-server build and launches `guacd`
//! automatically as a child process listening on 127.0.0.1 only. The
//! required `LD_LIBRARY_PATH` / `GUAC_RDP_PLUGIN_DIR` environment variables
//! are derived from the binary's own location, so a self-contained
//! guacamole-server install tree works without root or Docker.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use serde::Serialize;
use tauri::Emitter;

use crate::bridge::BridgeState;

/// Info about a running (or failed) guacd sidecar.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuacdStatus {
    pub running: bool,
    pub port: u16,
    pub binary: Option<String>,
    pub detail: Option<String>,
}

/// State holding the child process handle.
pub struct GuacdProcess {
    pub child: std::sync::Mutex<Option<Child>>,
    pub status: std::sync::Mutex<GuacdStatus>,
}

impl GuacdProcess {
    pub fn new() -> Self {
        Self {
            child: std::sync::Mutex::new(None),
            status: std::sync::Mutex::new(GuacdStatus {
                running: false,
                port: 0,
                binary: None,
                detail: Some("not started".into()),
            }),
        }
    }
}

/// Candidate locations for the guacd binary, in priority order.
fn candidate_binaries(explicit: Option<&str>) -> Vec<PathBuf> {
    let mut out = Vec::new();

    if let Some(p) = explicit.filter(|s| !s.trim().is_empty()) {
        out.push(PathBuf::from(p));
    }
    if let Ok(p) = std::env::var("TRDC_GUACD") {
        if !p.trim().is_empty() {
            out.push(PathBuf::from(p));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let dir = exe.parent().unwrap_or(Path::new(".")).to_path_buf();
        // Bundled next to the executable...
        out.push(dir.join("guacd"));
        // ...or a sibling native install tree (development layout).
        out.push(dir.join("native/prefix/sbin/guacd"));
        out.push(dir.join("../lib/trdc/guacd"));
        out.push(dir.join("../Resources/guacd"));
        // Development layout: walk up from target/debug looking for a
        // `native/prefix` tree at any ancestor of the executable.
        let mut ancestor = dir.clone();
        for _ in 0..5 {
            if let Some(parent) = ancestor.parent() {
                ancestor = parent.to_path_buf();
                out.push(ancestor.join("native/prefix/sbin/guacd"));
            }
        }
    }
    // Development fallback relative to the repo (cargo run from src-tauri).
    out.push(PathBuf::from("../native/prefix/sbin/guacd"));
    out.push(PathBuf::from("/usr/local/sbin/guacd"));
    out.push(PathBuf::from("/usr/sbin/guacd"));
    out.push(PathBuf::from("guacd"));
    out
}

/// Find the first existing candidate guacd binary.
fn find_binary(explicit: Option<&str>) -> Option<PathBuf> {
    candidate_binaries(explicit).into_iter().find(|p| {
        // Bare names (no separator) are resolved via PATH by `which`-style
        // lookup at spawn time; accept them only if present on PATH.
        if p.components().count() == 1 && p.file_name() == Some(std::ffi::OsStr::new("guacd")) {
            return std::env::var("PATH")
                .unwrap_or_default()
                .split(':')
                .any(|dir| Path::new(dir).join("guacd").is_file());
        }
        p.is_file()
    })
}

/// Derive LD_LIBRARY_PATH and GUAC_RDP_PLUGIN_DIR from the guacd binary
/// location. A guacamole-server install tree looks like:
///   <prefix>/sbin/guacd
///   <prefix>/lib/libguac-client-*.so
///   <prefix>/lib/freerdp3/libguac-*-client.so
fn sidecar_env(binary: &Path) -> Vec<(String, String)> {
    let mut env = Vec::new();
    // Two layouts: <prefix>/sbin/guacd + <prefix>/lib (dev tree / bundled
    // tree) and the packaged flat layout /usr/lib/trdc/guacd +
    // /usr/lib/trdc/lib. Try both.
    let parent = binary.parent();
    let lib = parent
        .and_then(|p| p.parent().map(|prefix| prefix.join("lib")))
        .filter(|l| l.is_dir())
        .or_else(|| parent.map(|p| p.join("lib")))
        .filter(|l| l.is_dir());

    if let Some(lib) = lib.filter(|l| l.is_dir()) {
        let mut ld = lib.display().to_string();
        if let Ok(existing) = std::env::var("LD_LIBRARY_PATH") {
            if !existing.is_empty() {
                ld.push(':');
                ld.push_str(&existing);
            }
        }
        env.push(("LD_LIBRARY_PATH".into(), ld));

        let freerdp_dir = lib.join("freerdp3");
        if freerdp_dir.is_dir() {
            env.push((
                "GUAC_RDP_PLUGIN_DIR".into(),
                freerdp_dir.display().to_string(),
            ));
        }
    }
    env
}

/// Ask the OS for a free loopback TCP port.
fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr().map(|a| a.port()))
        .map_err(|e| format!("could not allocate a local port: {e}"))
}

/// Start guacd (if not already running). `explicit_path` optionally
/// overrides the binary location (from user settings).
pub fn start(
    app: &tauri::AppHandle,
    process: &GuacdProcess,
    bridge: &BridgeState,
    explicit_path: Option<&str>,
) -> Result<GuacdStatus, String> {
    // Already running?
    if let Ok(mut guard) = process.child.lock() {
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => {
                    let status = process.status.lock().map_err(|_| "poisoned")?.clone();
                    return Ok(status);
                }
                _ => *guard = None,
            }
        }
    }

    let binary = find_binary(explicit_path)
        .ok_or_else(|| "guacd binary not found; set its path in Settings".to_string())?;
    let binary = binary
        .canonicalize()
        .unwrap_or_else(|_| binary.to_path_buf());

    let port = free_port()?;
    let envs = sidecar_env(&binary);

    let mut command = Command::new(&binary);
    // Foreground child process bound to loopback only.
    command
        .arg("-f")
        .arg("-b")
        .arg("127.0.0.1")
        .arg("-l")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null());

    // If trdc dies abruptly (panic, SIGKILL, OOM), the kernel kills guacd
    // too — without this the sidecar outlives a crashed parent forever.
    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::unix::process::CommandExt;
        // (pre_exec itself is an unsafe API: the child runs this between
        // fork and exec.)
        command.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    // Pipe stderr and forward interesting lines to the UI as events.
    command.stderr(Stdio::piped());
    for (k, v) in &envs {
        command.env(k, v);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to launch {}: {e}", binary.display()))?;

    let stderr = child.stderr.take();
    let app_handle = app.clone();
    if let Some(stderr) = stderr {
        tauri::async_runtime::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let file = tokio::process::ChildStderr::from_std(stderr);
            let Ok(file) = file else { return };
            let mut lines = BufReader::new(file).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_handle.emit("guacd-log", &line);
            }
        });
    }

    crate::bridge::set_guacd_port(bridge, port);
    let status = GuacdStatus {
        running: true,
        port,
        binary: Some(binary.display().to_string()),
        detail: Some("running".into()),
    };
    if let Ok(mut guard) = process.status.lock() {
        *guard = status.clone();
    }
    if let Ok(mut guard) = process.child.lock() {
        *guard = Some(child);
    }
    log::info!("guacd sidecar started on 127.0.0.1:{port} ({})", binary.display());
    Ok(status)
}

/// Stop the sidecar if running.
pub fn stop(process: &GuacdProcess) {
    if let Ok(mut guard) = process.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    if let Ok(mut guard) = process.status.lock() {
        guard.running = false;
        guard.detail = Some("stopped".into());
    }
}

pub fn status(process: &GuacdProcess) -> GuacdStatus {
    // Reap if the child died since we last looked.
    if let Ok(mut guard) = process.child.lock() {
        if let Some(child) = guard.as_mut() {
            if let Ok(Some(_)) = child.try_wait() {
                *guard = None;
                if let Ok(mut s) = process.status.lock() {
                    s.running = false;
                    s.detail = Some("guacd exited unexpectedly".into());
                }
            }
        }
    }
    process
        .status
        .lock()
        .map(|s| s.clone())
        .unwrap_or(GuacdStatus {
            running: false,
            port: 0,
            binary: None,
            detail: None,
        })
}
