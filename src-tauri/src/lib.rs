mod sidecar;

use sidecar::{Destination, SidecarState};
use tauri::Manager;

#[tauri::command]
async fn start_sidecar(app: tauri::AppHandle) -> Result<(), String> {
    sidecar::spawn_sidecar(&app).await
}

#[tauri::command]
async fn stop_sidecar(app: tauri::AppHandle) -> Result<(), String> {
    sidecar::kill_sidecar(&app).await
}

#[tauri::command]
async fn send_command(app: tauri::AppHandle, command: String) -> Result<(), String> {
    sidecar::send_to_sidecar(&app, &command).await
}

#[tauri::command]
async fn add_destination(app: tauri::AppHandle, destination: Destination) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "add_destination",
        "destination": destination,
    });
    sidecar::send_to_sidecar(&app, &cmd.to_string()).await
}

#[tauri::command]
async fn update_destination(app: tauri::AppHandle, destination: Destination) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "update_destination",
        "destination": destination,
    });
    sidecar::send_to_sidecar(&app, &cmd.to_string()).await
}

#[tauri::command]
async fn remove_destination(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "remove_destination",
        "id": id,
    });
    sidecar::send_to_sidecar(&app, &cmd.to_string()).await
}

#[tauri::command]
async fn start_server(app: tauri::AppHandle, port: u16) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "start_server",
        "port": port,
    });
    sidecar::send_to_sidecar(&app, &cmd.to_string()).await
}

#[tauri::command]
async fn stop_server(app: tauri::AppHandle) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "stop_server",
    });
    sidecar::send_to_sidecar(&app, &cmd.to_string()).await
}

#[tauri::command]
async fn get_status(app: tauri::AppHandle) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "get_status",
    });
    sidecar::send_to_sidecar(&app, &cmd.to_string()).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Debug)
                        .build(),
                )?;
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sidecar::spawn_sidecar(&handle).await {
                    log::error!("Failed to start sidecar: {e}");
                }
            });

            Ok(())
        })
        .manage(SidecarState::new())
        .invoke_handler(tauri::generate_handler![
            start_sidecar,
            stop_sidecar,
            send_command,
            add_destination,
            update_destination,
            remove_destination,
            start_server,
            stop_server,
            get_status,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = sidecar::kill_sidecar(&app).await;
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
