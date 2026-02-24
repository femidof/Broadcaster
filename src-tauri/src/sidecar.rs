use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Destination {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub url: String,
    #[serde(rename = "streamKey")]
    pub stream_key: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayStatus {
    #[serde(rename = "destinationId")]
    pub destination_id: String,
    pub name: String,
    pub status: String,
    pub error: Option<String>,
    #[serde(rename = "restartCount")]
    pub restart_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event")]
pub enum SidecarEvent {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "server_started")]
    ServerStarted { port: u16 },
    #[serde(rename = "server_stopped")]
    ServerStopped,
    #[serde(rename = "server_error")]
    ServerError { error: String },
    #[serde(rename = "stream_connected")]
    StreamConnected {
        #[serde(rename = "streamKey")]
        stream_key: String,
    },
    #[serde(rename = "stream_disconnected")]
    StreamDisconnected {
        #[serde(rename = "streamKey")]
        stream_key: String,
    },
    #[serde(rename = "relay_started")]
    RelayStarted {
        #[serde(rename = "destinationId")]
        destination_id: String,
    },
    #[serde(rename = "relay_stopped")]
    RelayStopped {
        #[serde(rename = "destinationId")]
        destination_id: String,
        reason: String,
    },
    #[serde(rename = "relay_error")]
    RelayError {
        #[serde(rename = "destinationId")]
        destination_id: String,
        error: String,
    },
    #[serde(rename = "status")]
    Status {
        #[serde(rename = "serverRunning")]
        server_running: bool,
        port: u16,
        #[serde(rename = "streamActive")]
        stream_active: bool,
        relays: Vec<RelayStatus>,
        destinations: Vec<Destination>,
    },
    #[serde(rename = "destinations_updated")]
    DestinationsUpdated {
        destinations: Vec<Destination>,
    },
    #[serde(rename = "error")]
    Error { error: String },
}

fn get_target_triple() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        }
    } else if cfg!(target_os = "windows") {
        "x86_64-pc-windows-msvc"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-gnu"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}

pub struct SidecarState {
    child: Arc<Mutex<Option<CommandChild>>>,
    running: Arc<Mutex<bool>>,
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            running: Arc::new(Mutex::new(false)),
        }
    }
}

fn emit_debug_log(app: &AppHandle, source: &str, message: impl Into<String>) {
    let _ = app.emit(
        "sidecar-event",
        serde_json::json!({
            "event": "debug_log",
            "source": source,
            "message": message.into(),
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
        }),
    );
}

fn verify_binary(path: &std::path::Path, label: &str) -> Result<(), String> {
    let metadata =
        fs::metadata(path).map_err(|e| format!("{label} binary missing at {}: {e}", path.display()))?;
    if metadata.len() == 0 {
        return Err(format!("{label} binary is empty at {}", path.display()));
    }
    Ok(())
}

struct RuntimePaths {
    mode: &'static str,
    ffmpeg_path: PathBuf,
    sidecar_binary_path: PathBuf,
    sidecar_identifier: String,
    attempts: Vec<String>,
}

fn is_binary_ready(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.len() > 0)
}

fn resolve_runtime_paths(resource_dir: &Path, target_triple: &str, ext: &str) -> RuntimePaths {
    let mut attempts = Vec::new();

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            let bundled_ffmpeg = exe_dir.join(format!("ffmpeg{ext}"));
            let bundled_sidecar = exe_dir.join(format!("broadcaster-sidecar{ext}"));
            let ffmpeg_ok = is_binary_ready(&bundled_ffmpeg);
            let sidecar_ok = is_binary_ready(&bundled_sidecar);

            attempts.push(format!(
                "bundled: ffmpeg={} ({ffmpeg_ok}), sidecar={} ({sidecar_ok})",
                bundled_ffmpeg.display(),
                bundled_sidecar.display()
            ));

            if ffmpeg_ok && sidecar_ok {
                return RuntimePaths {
                    mode: "bundled",
                    ffmpeg_path: bundled_ffmpeg,
                    sidecar_binary_path: bundled_sidecar,
                    // Bundled apps often resolve by the plain executable stem.
                    sidecar_identifier: "broadcaster-sidecar".to_string(),
                    attempts,
                };
            }
        }
    }

    let dev_ffmpeg = resource_dir.join(format!("binaries/ffmpeg-{target_triple}{ext}"));
    let dev_sidecar = resource_dir.join(format!("binaries/broadcaster-sidecar-{target_triple}{ext}"));
    let ffmpeg_ok = is_binary_ready(&dev_ffmpeg);
    let sidecar_ok = is_binary_ready(&dev_sidecar);
    attempts.push(format!(
        "dev: ffmpeg={} ({ffmpeg_ok}), sidecar={} ({sidecar_ok})",
        dev_ffmpeg.display(),
        dev_sidecar.display()
    ));

    RuntimePaths {
        mode: "dev",
        ffmpeg_path: dev_ffmpeg,
        sidecar_binary_path: dev_sidecar,
        sidecar_identifier: "binaries/broadcaster-sidecar".to_string(),
        attempts,
    }
}

pub async fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<SidecarState>();

    {
        let running = state.running.lock().await;
        if *running {
            return Ok(());
        }
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;

    let data_dir_str = data_dir.to_string_lossy().to_string();

    // Resolve the ffmpeg binary path from the sidecar binaries directory
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;

    let target_triple = get_target_triple();
    let bin_ext = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let resolved = resolve_runtime_paths(&resource_dir, target_triple, bin_ext);
    let ffmpeg_path_str = resolved.ffmpeg_path.to_string_lossy().to_string();

    emit_debug_log(
        app,
        "sidecar",
        format!(
            "Startup preflight: mode={}, resource_dir={}, target={}, ffmpeg_path={}, sidecar_path={}, attempts={}",
            resolved.mode,
            resource_dir.display(),
            target_triple,
            resolved.ffmpeg_path.display(),
            resolved.sidecar_binary_path.display(),
            resolved.attempts.join(" | ")
        ),
    );

    verify_binary(&resolved.ffmpeg_path, "ffmpeg")?;
    verify_binary(&resolved.sidecar_binary_path, "sidecar")?;

    let mut sidecar_ids = vec![resolved.sidecar_identifier.clone()];
    let fallback_id = if resolved.sidecar_identifier.contains('/') {
        resolved
            .sidecar_identifier
            .rsplit('/')
            .next()
            .unwrap_or("broadcaster-sidecar")
            .to_string()
    } else {
        format!("binaries/{}", resolved.sidecar_identifier)
    };
    if !sidecar_ids.contains(&fallback_id) {
        sidecar_ids.push(fallback_id);
    }

    emit_debug_log(
        app,
        "sidecar",
        format!(
            "Startup preflight passed, launching sidecar process (mode={}, sidecar_ids={:?})",
            resolved.mode, sidecar_ids
        ),
    );

    let mut used_sidecar_id: Option<String> = None;
    let mut sidecar_rx = None;
    let mut sidecar_child: Option<CommandChild> = None;
    let mut last_error: Option<String> = None;

    for sidecar_id in sidecar_ids.iter() {
        match app.shell().sidecar(sidecar_id) {
            Ok(sidecar_cmd) => match sidecar_cmd
                .args(["--ffmpeg-path", &ffmpeg_path_str, "--data-dir", &data_dir_str])
                .spawn()
            {
                Ok((rx, child)) => {
                    used_sidecar_id = Some(sidecar_id.clone());
                    sidecar_rx = Some(rx);
                    sidecar_child = Some(child);
                    break;
                }
                Err(e) => {
                    let msg = format!("Failed to spawn sidecar with id '{sidecar_id}': {e}");
                    emit_debug_log(app, "sidecar", msg.clone());
                    last_error = Some(msg);
                }
            },
            Err(e) => {
                let msg = format!("Failed to create sidecar command with id '{sidecar_id}': {e}");
                emit_debug_log(app, "sidecar", msg.clone());
                last_error = Some(msg);
            }
        }
    }

    let used_sidecar_id = used_sidecar_id.ok_or_else(|| {
        let msg = format!(
            "Failed to spawn sidecar with any identifier {:?} (mode={}, resource_dir={}, target={}, ffmpeg_path={}, sidecar_path={}, last_error={})",
            sidecar_ids,
            resolved.mode,
            resource_dir.display(),
            target_triple,
            resolved.ffmpeg_path.display(),
            resolved.sidecar_binary_path.display(),
            last_error.unwrap_or_else(|| "unknown".to_string())
        );
        emit_debug_log(app, "sidecar", msg.clone());
        msg
    })?;
    let mut rx = sidecar_rx.ok_or_else(|| "Sidecar spawned without receiver".to_string())?;
    let child = sidecar_child.ok_or_else(|| "Sidecar spawned without child process".to_string())?;

    emit_debug_log(
        app,
        "sidecar",
        format!("Sidecar launched successfully with id '{used_sidecar_id}'"),
    );

    {
        let mut child_lock = state.child.lock().await;
        *child_lock = Some(child);
    }
    {
        let mut running_lock = state.running.lock().await;
        *running_lock = true;
    }

    let app_handle = app.clone();
    let running_flag = state.running.clone();
    let child_ref = state.child.clone();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    let trimmed = line_str.trim();
                    if trimmed.is_empty() {
                        continue;
                    }

                    match serde_json::from_str::<serde_json::Value>(trimmed) {
                        Ok(value) => {
                            let _ = app_handle.emit("sidecar-event", value);
                        }
                        Err(e) => {
                            log::warn!("Failed to parse sidecar output: {trimmed} - {e}");
                            let _ = app_handle.emit(
                                "sidecar-event",
                                serde_json::json!({
                                    "event": "debug_log",
                                    "source": "sidecar-stdout",
                                    "message": format!("Unparseable output: {trimmed}"),
                                    "timestamp": std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_millis() as u64
                                }),
                            );
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    let msg = line_str.trim();
                    if !msg.is_empty() {
                        log::debug!("[sidecar stderr] {msg}");
                        let _ = app_handle.emit(
                            "sidecar-event",
                            serde_json::json!({
                                "event": "debug_log",
                                "source": "sidecar",
                                "message": msg,
                                "timestamp": std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis() as u64
                            }),
                        );
                    }
                }
                CommandEvent::Terminated(payload) => {
                    log::info!(
                        "Sidecar terminated with code: {:?}, signal: {:?}",
                        payload.code,
                        payload.signal
                    );
                    let mut running = running_flag.lock().await;
                    *running = false;
                    let mut child_lock = child_ref.lock().await;
                    *child_lock = None;

                    let is_error = payload.code.map_or(true, |c| c != 0);
                    if is_error {
                        let error_msg = format!(
                            "Sidecar terminated unexpectedly (code: {:?}, signal: {:?})",
                            payload.code, payload.signal
                        );
                        let _ = app_handle.emit(
                            "sidecar-event",
                            serde_json::json!({
                                "event": "sidecar_error",
                                "error": error_msg
                            }),
                        );
                    }

                    let _ = app_handle.emit(
                        "sidecar-event",
                        serde_json::json!({"event": "server_stopped"}),
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

pub async fn send_to_sidecar(app: &AppHandle, message: &str) -> Result<(), String> {
    let state = app.state::<SidecarState>();
    let mut child_lock = state.child.lock().await;

    if let Some(ref mut child) = *child_lock {
        let msg = if message.ends_with('\n') {
            message.to_string()
        } else {
            format!("{message}\n")
        };

        child
            .write(msg.as_bytes())
            .map_err(|e| format!("Failed to write to sidecar: {e}"))?;
        Ok(())
    } else {
        Err("Sidecar is not running".to_string())
    }
}

pub async fn kill_sidecar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<SidecarState>();

    // Try graceful shutdown first
    let _ = send_to_sidecar(app, r#"{"cmd":"shutdown"}"#).await;

    // Give it a moment, then force kill
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let mut child_lock = state.child.lock().await;
    if let Some(child) = child_lock.take() {
        let _ = child.kill();
    }

    let mut running = state.running.lock().await;
    *running = false;

    Ok(())
}
