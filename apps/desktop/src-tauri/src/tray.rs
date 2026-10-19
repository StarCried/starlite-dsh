use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager};

use crate::settings;

#[derive(Default)]
pub struct UiState {
    connected: Mutex<bool>,
    paused: Mutex<bool>,
    click_through: Mutex<bool>,
    user_hidden: Mutex<bool>,
}

impl UiState {
    pub fn set_connected(&self, value: bool) {
        if let Ok(mut connected) = self.connected.lock() {
            *connected = value;
        }
    }

    fn connected(&self) -> bool {
        self.connected.lock().is_ok_and(|value| *value)
    }

    fn paused(&self) -> bool {
        self.paused.lock().map_or(true, |value| *value)
    }

    fn set_paused(&self, paused: bool) -> Result<(), String> {
        *self
            .paused
            .lock()
            .map_err(|_| "animation state unavailable")? = paused;
        Ok(())
    }

    fn toggle_click_through(&self) -> bool {
        self.click_through.lock().is_ok_and(|mut value| {
            *value = !*value;
            *value
        })
    }
    pub fn click_through(&self) -> bool {
        self.click_through.lock().map_or(true, |value| *value)
    }

    fn visible(&self) -> bool {
        self.user_hidden.lock().is_ok_and(|value| !*value)
    }

    fn set_visible(&self, visible: bool) -> Result<(), String> {
        *self
            .user_hidden
            .lock()
            .map_err(|_| "visibility state unavailable")? = !visible;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetUiState {
    paused: bool,
    visible: bool,
    actual_visible: bool,
    click_through: bool,
}

#[tauri::command]
pub fn get_pet_ui_state(app: AppHandle) -> PetUiState {
    let state = app.state::<UiState>();
    PetUiState {
        paused: state.paused(),
        // User visibility is independent of temporary Host disconnect hides.
        visible: state.visible(),
        actual_visible: app
            .get_webview_window("main")
            .is_some_and(|window| window.is_visible().unwrap_or(false)),
        click_through: state.click_through(),
    }
}

fn emit_ui_state(app: &AppHandle) -> PetUiState {
    let state = get_pet_ui_state(app.clone());
    let _ = app.emit("pet-ui-state", state.clone());
    state
}

#[tauri::command]
pub fn set_pet_paused(app: AppHandle, paused: bool) -> Result<PetUiState, String> {
    app.state::<UiState>().set_paused(paused)?;
    let _ = app.emit("tray-action", if paused { "pause" } else { "resume" });
    Ok(emit_ui_state(&app))
}

#[tauri::command]
pub fn set_pet_visible(app: AppHandle, visible: bool) -> Result<PetUiState, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("pet window unavailable")?;
    if visible {
        if !app.state::<UiState>().connected()
            || !settings::load(&app)
                .active_model()
                .is_some_and(|model| model.data.backend == settings::ModelBackend::Vrm)
        {
            return Err("pet is not connected or has no active model".into());
        }
        window
            .show()
            .map_err(|_| "pet window visibility unavailable")?;
    } else {
        window
            .hide()
            .map_err(|_| "pet window visibility unavailable")?;
    }
    app.state::<UiState>().set_visible(visible)?;
    Ok(emit_ui_state(&app))
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let visibility = MenuItem::with_id(app, "visibility", "显示/隐藏", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "暂停/继续动画", true, None::<&str>)?;
    let click_through =
        MenuItem::with_id(app, "click-through", "鼠标穿透开关", true, None::<&str>)?;
    let privacy = MenuItem::with_id(app, "privacy", "隐藏会话内容", true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset", "复位模型", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &settings,
            &visibility,
            &pause,
            &click_through,
            &privacy,
            &reset,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("StarLite for DSH")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu(app, event.id.as_ref()));
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "settings" => show_settings(app),
        "visibility" => toggle_visibility(app),
        "pause" => {
            let paused = !app.state::<UiState>().paused();
            let _ = set_pet_paused(app.clone(), paused);
        }
        "click-through" => {
            app.state::<UiState>().toggle_click_through();
            emit_ui_state(app);
        }
        "privacy" => toggle_privacy(app),
        "reset" => {
            let _ = app.emit("tray-action", "reset");
        }
        "quit" => {
            crate::model_viewport::restore_before_exit(app);
            app.exit(0);
        }
        _ => {}
    }
}

pub fn show_settings(app: &AppHandle) {
    show_and_focus(app, "settings");
}

fn show_and_focus(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_visibility(app: &AppHandle) {
    let visible = !app.state::<UiState>().visible();
    let _ = set_pet_visible(app.clone(), visible);
}

fn toggle_privacy(app: &AppHandle) {
    let _ = settings::with_write(app, || {
        let mut current = settings::load(app);
        current.preferences.privacy_mode = !current.preferences.privacy_mode;
        settings::store(app, &current)?;
        let _ = app.emit("settings-changed", current);
        Ok(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_visibility_and_pause_share_state_without_changing_connection() {
        let state = UiState::default();
        assert!(state.visible());
        assert!(!state.paused());
        assert!(!state.connected());
        state.set_connected(true);
        state.set_visible(false).unwrap();
        state.set_paused(true).unwrap();
        assert!(!state.visible());
        assert!(state.paused());
        state.set_connected(false);
        state.set_connected(true);
        assert!(!state.visible());
        assert!(state.paused());
        state.set_visible(true).unwrap();
        state.set_paused(false).unwrap();
        assert!(state.visible());
        assert!(!state.paused());
        assert!(state.connected());
    }
}
