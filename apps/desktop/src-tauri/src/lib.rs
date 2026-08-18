mod model;
mod settings;
mod tray;

use tauri::{AppHandle, Emitter, Manager, WindowEvent};
#[cfg(all(debug_assertions, windows))]
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_window_state::StateFlags;

#[tauri::command]
fn get_settings(app: AppHandle) -> settings::DesktopSettings {
    settings::load(&app)
}

#[tauri::command]
fn inspect_model(path: String) -> Result<model::ModelInspection, String> {
    model::inspect(path)
}

#[tauri::command]
fn install_model(
    app: AppHandle,
    request: settings::ModelInstallRequest,
) -> Result<settings::DesktopSettings, String> {
    let next = model::install(&app, request)?;
    let _ = app.emit("settings-changed", next.clone());
    Ok(next)
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    request: settings::ModelInstallRequest,
) -> Result<settings::DesktopSettings, String> {
    let next = model::update(&app, request)?;
    let _ = app.emit("settings-changed", next.clone());
    Ok(next)
}

#[tauri::command]
fn set_connection_state(app: AppHandle, connected: bool) {
    app.state::<tray::UiState>().set_connected(connected);
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    tray::show_settings(&app);
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Deep links on Windows arrive through a second process, so this must
        // remain the first plugin and forward only to the existing instance.
        .plugin(tauri_plugin_single_instance::init(
            |_app, _arguments, _cwd| {},
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE)
                .build(),
        )
        .manage(tray::UiState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            inspect_model,
            install_model,
            update_settings,
            set_connection_state,
            open_settings,
            exit_app,
        ])
        .setup(|app| {
            #[cfg(all(debug_assertions, windows))]
            app.deep_link().register_all()?;
            model::install_bundled_if_empty(app.handle())
                .map_err(|error| format!("bundled model installation failed: {error}"))?;
            tray::setup(app)?;
            if settings::load(app.handle()).model.is_none() {
                tray::show_settings(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("DSH Inochi2D Pet failed to start");
}
