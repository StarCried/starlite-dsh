mod hit_test;
mod model;
mod model_viewport;
mod resource_pack;
mod settings;
mod startup;
mod tray;
mod vrm;

use tauri::{AppHandle, Emitter, Manager, WindowEvent};
#[cfg(all(debug_assertions, windows))]
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_window_state::StateFlags;

#[tauri::command]
fn get_settings(app: AppHandle) -> settings::DesktopSettings {
    settings::load(&app)
}

#[tauri::command]
fn inspect_model(
    path: String,
    animation_sources: Option<Vec<settings::AnimationSource>>,
    profile_path: Option<String>,
) -> Result<model::ModelInspection, String> {
    model::inspect(path, animation_sources.unwrap_or_default(), profile_path)
}

#[tauri::command]
async fn inspect_resource_pack(
    path: String,
) -> Result<resource_pack::ResourcePackInspection, String> {
    tauri::async_runtime::spawn_blocking(move || resource_pack::inspect(path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn install_resource_pack(
    app: AppHandle,
    path: String,
    expected_sha256: String,
    preferences: settings::DesktopPreferences,
    accept_license: bool,
) -> Result<settings::DesktopSettings, String> {
    let install_app = app.clone();
    let next = tauri::async_runtime::spawn_blocking(move || {
        resource_pack::install(
            &install_app,
            path,
            expected_sha256,
            preferences,
            accept_license,
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    let _ = app.emit("settings-changed", next.clone());
    Ok(next)
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
    model_viewport::restore_before_exit(&app);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Deep links on Windows arrive through a second process, so this must
        // remain the first plugin and forward only to the existing instance.
        .plugin(tauri_plugin_single_instance::init(
            |app, arguments, _cwd| {
                if !startup::is_connection_launch(arguments) {
                    tray::show_settings(app);
                }
            },
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE)
                .build(),
        )
        .manage(tray::UiState::default())
        .manage(hit_test::HitTestState::default())
        .manage(model_viewport::ModelViewportState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            inspect_model,
            inspect_resource_pack,
            install_resource_pack,
            install_model,
            update_settings,
            set_connection_state,
            open_settings,
            exit_app,
            hit_test::set_model_hit_mask,
            model_viewport::set_model_viewport,
            hit_test::set_bubble_interaction_region,
            hit_test::begin_model_drag,
            hit_test::move_model_drag,
            hit_test::end_model_drag,
        ])
        .setup(|app| {
            #[cfg(all(debug_assertions, windows))]
            app.deep_link().register_all()?;
            tray::setup(app)?;
            hit_test::setup(app.handle())?;
            if !startup::is_connection_launch(std::env::args_os())
                || settings::load(app.handle()).model.is_none()
            {
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
        .expect("StarLite for DSH failed to start");
}
