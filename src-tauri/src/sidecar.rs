use serde::{Deserialize, Serialize};
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
    let ffmpeg_ext = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let ffmpeg_name = format!("binaries/ffmpeg-{target_triple}{ffmpeg_ext}");
    let ffmpeg_path = resource_dir.join(&ffmpeg_name);
    let ffmpeg_path_str = ffmpeg_path.to_string_lossy().to_string();

    let sidecar_cmd = app
        .shell()
        .sidecar("binaries/broadcaster-sidecar")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .args(["--ffmpeg-path", &ffmpeg_path_str, "--data-dir", &data_dir_str]);

    let (mut rx, child) = sidecar_cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

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
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    log::debug!("[sidecar stderr] {}", line_str.trim());
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
