use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager};

use crate::settings;

#[derive(Default)]
pub struct UiState {
    connected: Mutex<bool>,
    paused: Mutex<bool>,
    click_through: Mutex<bool>,
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

    fn toggle_paused(&self) -> bool {
        self.paused.lock().is_ok_and(|mut value| {
            *value = !*value;
            *value
        })
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
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let visibility = MenuItem::with_id(app, "visibility", "显示/隐藏", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "暂停/继续动画", true, None::<&str>)?;
    let click_through =
        MenuItem::with_id(app, "click-through", "鼠标穿透开关", true, None::<&str>)?;
    let privacy = MenuItem::with_id(app, "privacy", "固定文案隐私模式", true, None::<&str>)?;
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
            let paused = app.state::<UiState>().toggle_paused();
            let _ = app.emit("tray-action", if paused { "pause" } else { "resume" });
        }
        "click-through" => {
            app.state::<UiState>().toggle_click_through();
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
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else if app.state::<UiState>().connected() {
        let _ = window.show();
    }
}

fn toggle_privacy(app: &AppHandle) {
    let mut current = settings::load(app);
    current.preferences.privacy_mode = !current.preferences.privacy_mode;
    if settings::store(app, &current).is_ok() {
        let _ = app.emit("settings-changed", current);
    }
}
