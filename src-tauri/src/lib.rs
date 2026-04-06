mod sidecar;

use sidecar::{Destination, Profile, SidecarState};
use tauri::{Emitter, Manager};

async fn ensure_sidecar_and_send(app: &tauri::AppHandle, command: String) -> Result<(), String> {
    sidecar::spawn_sidecar(app).await?;
    sidecar::send_to_sidecar(app, &command).await
}

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
    ensure_sidecar_and_send(&app, command).await
}

#[tauri::command]
async fn create_profile(app: tauri::AppHandle, profile: Profile) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "create_profile",
        "profile": profile,
    });
    ensure_sidecar_and_send(&app, cmd.to_string()).await
}

#[tauri::command]
async fn update_profile(app: tauri::AppHandle, profile: Profile) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "update_profile",
        "profile": profile,
    });
    ensure_sidecar_and_send(&app, cmd.to_string()).await
}

#[tauri::command]
async fn delete_profile(app: tauri::AppHandle, profile_id: String) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "delete_profile",
        "profileId": profile_id,
    });
    ensure_sidecar_and_send(&app, cmd.to_string()).await
}

#[tauri::command]
async fn add_destination(
    app: tauri::AppHandle,
    profile_id: String,
    destination: Destination,
) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "add_destination",
        "profileId": profile_id,
        "destination": destination,
    });
    ensure_sidecar_and_send(&app, cmd.to_string()).await
}

#[tauri::command]
async fn update_destination(
    app: tauri::AppHandle,
    profile_id: String,
    destination: Destination,
) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "update_destination",
        "profileId": profile_id,
        "destination": destination,
    });
    ensure_sidecar_and_send(&app, cmd.to_string()).await
}

#[tauri::command]
async fn remove_destination(app: tauri::AppHandle, profile_id: String, id: String) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "remove_destination",
        "profileId": profile_id,
        "id": id,
    });
    ensure_sidecar_and_send(&app, cmd.to_string()).await
}

#[tauri::command]
async fn push_destinations(app: tauri::AppHandle, profile_id: String) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "push_destinations",
        "profileId": profile_id,
    });
    ensure_sidecar_and_send(&app, cmd.to_string()).await
}

#[tauri::command]
async fn stop_pushing(app: tauri::AppHandle, profile_id: String) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "stop_pushing",
        "profileId": profile_id,
    });
    ensure_sidecar_and_send(&app, cmd.to_string()).await
}

#[tauri::command]
async fn start_server(app: tauri::AppHandle, profile_id: String) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "start_server",
        "profileId": profile_id,
    });
    ensure_sidecar_and_send(&app, cmd.to_string()).await
}

#[tauri::command]
async fn stop_server(app: tauri::AppHandle, profile_id: String) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "stop_server",
        "profileId": profile_id,
    });
    ensure_sidecar_and_send(&app, cmd.to_string()).await
}

#[tauri::command]
async fn get_status(app: tauri::AppHandle) -> Result<(), String> {
    let cmd = serde_json::json!({
        "cmd": "get_status",
    });
    ensure_sidecar_and_send(&app, cmd.to_string()).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .build(),
            )?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sidecar::spawn_sidecar(&handle).await {
                    log::error!("Failed to start sidecar: {e}");
                    let _ = handle.emit(
                        "sidecar-event",
                        serde_json::json!({
                            "event": "sidecar_error",
                            "error": format!("Failed to start sidecar: {e}")
                        }),
                    );
                }
            });

            Ok(())
        })
        .manage(SidecarState::new())
        .invoke_handler(tauri::generate_handler![
            start_sidecar,
            stop_sidecar,
            send_command,
            create_profile,
            update_profile,
            delete_profile,
            add_destination,
            update_destination,
            remove_destination,
            push_destinations,
            stop_pushing,
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
