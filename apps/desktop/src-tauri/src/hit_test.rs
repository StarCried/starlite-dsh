use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HitMask {
    width: usize,
    height: usize,
    left: f64,
    top: f64,
    display_width: f64,
    display_height: f64,
    viewport_width: f64,
    viewport_height: f64,
    bits: Vec<u8>,
}

impl HitMask {
    fn validate(&self) -> Result<(), String> {
        if !(1..=512).contains(&self.width)
            || !(1..=512).contains(&self.height)
            || self.bits.len() != (self.width * self.height).div_ceil(8)
            || ![
                self.left,
                self.top,
                self.display_width,
                self.display_height,
                self.viewport_width,
                self.viewport_height,
            ]
            .iter()
            .all(|v| v.is_finite())
            || [
                self.display_width,
                self.display_height,
                self.viewport_width,
                self.viewport_height,
            ]
            .iter()
            .any(|v| *v <= 0.0 || *v > 16384.0)
            || self.left.abs() > 16384.0
            || self.top.abs() > 16384.0
        {
            return Err("invalid model interaction mask".into());
        }
        Ok(())
    }

    fn contains(&self, x: f64, y: f64, physical_width: u32, physical_height: u32) -> bool {
        if physical_width == 0 || physical_height == 0 || !x.is_finite() || !y.is_finite() {
            return false;
        }
        let x =
            (x * self.viewport_width / f64::from(physical_width) - self.left) / self.display_width;
        let y = (y * self.viewport_height / f64::from(physical_height) - self.top)
            / self.display_height;
        if !(0.0..1.0).contains(&x) || !(0.0..1.0).contains(&y) {
            return false;
        }
        let pixel =
            (y * self.height as f64) as usize * self.width + (x * self.width as f64) as usize;
        self.bits[pixel >> 3] & (1 << (pixel & 7)) != 0
    }
}

#[derive(Default)]
pub struct HitTestState(Mutex<Option<HitMask>>);

#[tauri::command]
pub fn set_model_hit_mask(
    window: tauri::WebviewWindow,
    state: tauri::State<HitTestState>,
    mask: Option<HitMask>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("interaction masks belong to the pet window".into());
    }
    let mut current = state
        .0
        .lock()
        .map_err(|_| "interaction state unavailable")?;
    // Invalid updates remove stale coverage rather than keeping an old model active.
    *current = None;
    if let Some(mask) = mask {
        mask.validate()?;
        *current = Some(mask);
    }
    Ok(())
}

#[derive(Default)]
struct PointerLatch {
    down: bool,
    on_model: bool,
}
impl PointerLatch {
    fn ignore(&mut self, hit: bool, down: bool, force: bool) -> bool {
        if down && !self.down {
            self.on_model = hit && !force;
        }
        if !down || force {
            self.on_model = false;
        }
        self.down = down;
        force || if down { !self.on_model } else { !hit }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorPoint {
    x: f64,
    y: f64,
}

#[cfg(windows)]
fn primary_button_down() -> bool {
    use windows_sys::Win32::UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON},
        WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON},
    };
    // Read only the current high bit, not the unreliable "pressed since last call" bit.
    // Respect the user's logical primary-button mapping.
    unsafe {
        GetAsyncKeyState(if GetSystemMetrics(SM_SWAPBUTTON) == 0 {
            VK_LBUTTON
        } else {
            VK_RBUTTON
        } as i32)
            < 0
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_ignore_cursor_events(true)?;
    }
    #[cfg(windows)]
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let mut ignored = true;
            let mut latch = PointerLatch::default();
            let mut last_gaze = std::time::Instant::now();
            loop {
                let Some(window) = app.get_webview_window("main") else {
                    break;
                };
                if !window.is_visible().unwrap_or(false) {
                    latch.down = primary_button_down();
                    latch.on_model = false;
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    continue;
                }
                if let (Ok(cursor), Ok(origin), Ok(size)) = (
                    window.cursor_position(),
                    window.inner_position(),
                    window.inner_size(),
                ) {
                    let x = cursor.x - f64::from(origin.x);
                    let y = cursor.y - f64::from(origin.y);
                    let state = app.state::<HitTestState>();
                    if let Ok(mask) = state.0.lock() {
                        let hit = mask
                            .as_ref()
                            .is_some_and(|m| m.contains(x, y, size.width, size.height));
                        let ignore = latch.ignore(
                            hit,
                            primary_button_down(),
                            app.state::<crate::tray::UiState>().click_through(),
                        );
                        if ignore != ignored && window.set_ignore_cursor_events(ignore).is_ok() {
                            ignored = ignore;
                        }
                        if last_gaze.elapsed().as_millis() >= 32 {
                            if let Some(mask) = mask.as_ref() {
                                if size.width > 0 && size.height > 0 {
                                    let _ = window.emit(
                                        "pet-cursor",
                                        CursorPoint {
                                            x: x * mask.viewport_width / f64::from(size.width),
                                            y: y * mask.viewport_height / f64::from(size.height),
                                        },
                                    );
                                }
                            }
                            last_gaze = std::time::Instant::now();
                        }
                    };
                }
                std::thread::sleep(std::time::Duration::from_millis(16));
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn mask() -> HitMask {
        HitMask {
            width: 4,
            height: 2,
            left: 10.0,
            top: 20.0,
            display_width: 80.0,
            display_height: 40.0,
            viewport_width: 100.0,
            viewport_height: 100.0,
            bits: vec![0b00100110],
        }
    }
    #[test]
    fn coverage_respects_alpha_holes_offsets_dpi_and_outside_points() {
        let m = mask();
        m.validate().unwrap();
        assert!(m.contains(70.0, 50.0, 200, 200));
        assert!(!m.contains(30.0, 50.0, 200, 200));
        assert!(m.contains(70.0, 110.0, 200, 200));
        assert!(!m.contains(110.0, 110.0, 200, 200));
        assert!(!m.contains(180.0, 50.0, 200, 200));
        assert!(!m.contains(f64::NAN, 0.0, 200, 200));
        assert!(!m.contains(0.0, 0.0, 0, 200));
    }
    #[test]
    fn rejects_malformed_or_unbounded_masks() {
        let mut m = mask();
        m.bits.clear();
        assert!(m.validate().is_err());
        let mut m = mask();
        m.width = 513;
        assert!(m.validate().is_err());
        let mut m = mask();
        m.display_width = f64::INFINITY;
        assert!(m.validate().is_err());
        let mut m = mask();
        m.viewport_width = 0.0;
        assert!(m.validate().is_err());
    }
    #[test]
    fn model_press_keeps_capture_until_release_even_if_pose_moves() {
        let mut p = PointerLatch::default();
        assert!(!p.ignore(true, false, false));
        assert!(!p.ignore(true, true, false));
        assert!(!p.ignore(false, true, false));
        assert!(p.ignore(false, false, false));
    }
    #[test]
    fn background_press_never_steals_an_underlying_drag_and_manual_passthrough_wins() {
        let mut p = PointerLatch::default();
        assert!(p.ignore(false, true, false));
        assert!(p.ignore(true, true, false));
        assert!(!p.ignore(true, false, false));
        assert!(!p.ignore(true, true, false));
        assert!(p.ignore(true, true, true));
        assert!(p.ignore(true, true, false));
        assert!(!p.ignore(true, false, false));
    }
}
