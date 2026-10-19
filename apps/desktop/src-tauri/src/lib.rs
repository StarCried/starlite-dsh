mod default_model;
mod hit_test;
mod model;
mod model_viewport;
mod settings;
mod startup;
mod tray;
mod vrm;

use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_window_state::StateFlags;

#[tauri::command]
fn get_settings(app: AppHandle) -> settings::DesktopSettings {
    settings::load(&app)
}

#[tauri::command]
async fn inspect_model(
    path: String,
    animation_sources: Option<Vec<settings::AnimationSource>>,
    profile_path: Option<String>,
) -> Result<model::ModelInspection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        model::inspect(path, animation_sources.unwrap_or_default(), profile_path)
    })
    .await
    .map_err(|_| "模型检查失败，请重试。".to_string())?
}

#[tauri::command]
async fn prepare_model(app: AppHandle) -> Result<settings::DesktopSettings, String> {
    mutate_model_settings(app, default_model::prepare_model).await
}

#[tauri::command]
async fn select_model(
    app: AppHandle,
    model_id: Option<String>,
) -> Result<settings::DesktopSettings, String> {
    mutate_model_settings(app, move |app| default_model::select_model(app, model_id)).await
}

#[tauri::command]
async fn remove_model(app: AppHandle, model_id: String) -> Result<model::ModelRemoval, String> {
    tauri::async_runtime::spawn_blocking(move || {
        settings::with_write(&app, || {
            let result = model::remove(&app, model_id)?;
            let _ = app.emit("settings-changed", result.settings.clone());
            Ok(result)
        })
    })
    .await
    .map_err(|_| "模型移除失败，请重试。".to_string())?
}

#[tauri::command]
async fn update_preferences(
    app: AppHandle,
    preferences: settings::DesktopPreferences,
) -> Result<settings::DesktopSettings, String> {
    mutate_model_settings(app, move |app| model::update_preferences(app, preferences)).await
}

#[tauri::command]
async fn patch_preferences(
    app: AppHandle,
    patch: settings::PreferencesPatch,
) -> Result<settings::DesktopSettings, String> {
    mutate_model_settings(app, move |app| {
        let mut next = settings::load(app);
        next.preferences = patch.apply(&next.preferences)?;
        settings::store(app, &next)?;
        Ok(next)
    })
    .await
}

#[tauri::command]
async fn get_model_license(
    app: AppHandle,
    model_id: String,
) -> Result<Option<settings::ModelLicense>, String> {
    tauri::async_runtime::spawn_blocking(move || default_model::model_license(&app, model_id))
        .await
        .map_err(|_| "无法读取模型许可，请重试。".to_string())?
}

async fn mutate_model_settings(
    app: AppHandle,
    operation: impl FnOnce(&AppHandle) -> Result<settings::DesktopSettings, String> + Send + 'static,
) -> Result<settings::DesktopSettings, String> {
    let work_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        settings::with_write(&work_app, || {
            let before = serde_json::to_value(settings::load(&work_app))
                .map_err(|error| error.to_string())?;
            let next = operation(&work_app)?;
            let changed =
                before != serde_json::to_value(&next).map_err(|error| error.to_string())?;
            // Enqueue events while holding the same mutation lock. A later
            // disable must never be followed by a stale prepared-model event.
            if changed {
                let _ = work_app.emit("settings-changed", next.clone());
            }
            Ok(next)
        })
    })
    .await
    .map_err(|_| "模型设置操作失败，请重试。".to_string())?
}

#[tauri::command]
async fn install_model(
    app: AppHandle,
    request: settings::ModelInstallRequest,
) -> Result<settings::DesktopSettings, String> {
    mutate_model_settings(app, move |app| model::install(app, request)).await
}

#[tauri::command]
async fn update_model_mappings(
    app: AppHandle,
    model_id: String,
    mappings: settings::AnimationMappings,
) -> Result<settings::DesktopSettings, String> {
    mutate_model_settings(app, move |app| {
        model::update_mappings(app, model_id, mappings)
    })
    .await
}

#[tauri::command]
fn set_connection_state(app: AppHandle, connected: bool) {
    app.state::<tray::UiState>().set_connected(connected);
}

#[tauri::command]
fn get_initial_connection(app: AppHandle) -> Option<String> {
    app.state::<startup::InitialConnection>().first_url()
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
        .manage(startup::InitialConnection::from_arguments(
            std::env::args_os(),
        ))
        // Deep links on Windows arrive through a second process, so this must
        // remain the first plugin and forward only to the existing instance.
        .plugin(tauri_plugin_single_instance::init(
            |app, arguments, _cwd| {
                app.state::<startup::InitialConnection>()
                    .remember_first_valid(&arguments);
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
        .manage(settings::SettingsWriteState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            inspect_model,
            prepare_model,
            select_model,
            remove_model,
            update_preferences,
            patch_preferences,
            get_model_license,
            install_model,
            update_model_mappings,
            set_connection_state,
            get_initial_connection,
            open_settings,
            exit_app,
            hit_test::set_model_hit_mask,
            model_viewport::set_model_viewport,
            hit_test::set_bubble_interaction_region,
            hit_test::set_menu_interaction_region,
            model_viewport::restore_default_position,
            tray::get_pet_ui_state,
            tray::set_pet_paused,
            tray::set_pet_visible,
            hit_test::begin_model_drag,
            hit_test::move_model_drag,
            hit_test::end_model_drag,
        ])
        .setup(|app| {
            tray::setup(app)?;
            hit_test::setup(app.handle())?;
            if !startup::is_connection_launch(std::env::args_os()) {
                tray::show_settings(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                model_viewport::schedule_reconcile(window);
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("StarLite for DSH failed to start");
}
