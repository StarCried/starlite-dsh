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
pub struct HitTestState {
    mask: Mutex<Option<HitMask>>,
    bubble: Mutex<Option<BubbleRegion>>,
    drag: Mutex<Option<DragOrigin>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BubbleRegion {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
    viewport_height: f64,
}
impl BubbleRegion {
    fn validate(&self) -> Result<(), String> {
        if ![
            self.left,
            self.top,
            self.width,
            self.height,
            self.viewport_width,
            self.viewport_height,
        ]
        .iter()
        .all(|v| v.is_finite())
            || self.left < 0.0
            || self.top < 0.0
            || self.width <= 0.0
            || self.height <= 0.0
            || self.viewport_width <= 0.0
            || self.viewport_height <= 0.0
            || self.viewport_width > 16384.0
            || self.viewport_height > 16384.0
            || self.left + self.width > self.viewport_width
            || self.top + self.height > self.viewport_height
        {
            return Err("invalid bubble interaction region".into());
        }
        Ok(())
    }
    fn contains(&self, x: f64, y: f64, width: u32, height: u32) -> bool {
        if width == 0 || height == 0 {
            return false;
        }
        let x = x * self.viewport_width / f64::from(width);
        let y = y * self.viewport_height / f64::from(height);
        x >= self.left && x < self.left + self.width && y >= self.top && y < self.top + self.height
    }
}

#[tauri::command]
pub fn set_bubble_interaction_region(
    window: tauri::WebviewWindow,
    state: tauri::State<HitTestState>,
    region: Option<BubbleRegion>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("bubble interaction belongs to the pet window".into());
    }
    let mut current = state
        .bubble
        .lock()
        .map_err(|_| "interaction state unavailable")?;
    *current = None;
    if let Some(region) = region {
        region.validate()?;
        *current = Some(region);
    }
    Ok(())
}

struct DragOrigin {
    x: f64,
    y: f64,
    position: tauri::PhysicalPosition<i32>,
    threshold: f64,
}
impl DragOrigin {
    fn destination(&self, x: f64, y: f64) -> Option<tauri::PhysicalPosition<i32>> {
        let dx = x - self.x;
        let dy = y - self.y;
        if !dx.is_finite() || !dy.is_finite() || dx.hypot(dy) < self.threshold {
            return None;
        }
        Some(tauri::PhysicalPosition::new(
            self.position.x.saturating_add(dx.round() as i32),
            self.position.y.saturating_add(dy.round() as i32),
        ))
    }
}

#[tauri::command]
pub fn begin_model_drag(
    window: tauri::WebviewWindow,
    state: tauri::State<HitTestState>,
    app: AppHandle,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if window.label() != "main" || app.state::<crate::tray::UiState>().click_through() {
        return Err("model interaction unavailable".into());
    }
    let origin = window
        .inner_position()
        .map_err(|_| "window position unavailable")?;
    let position = window
        .outer_position()
        .map_err(|_| "window position unavailable")?;
    let size = window.inner_size().map_err(|_| "window size unavailable")?;
    let mask = state
        .mask
        .lock()
        .map_err(|_| "interaction state unavailable")?;
    let mask = mask.as_ref().ok_or("model interaction unavailable")?;
    let px = x * f64::from(size.width) / mask.viewport_width;
    let py = y * f64::from(size.height) / mask.viewport_height;
    if !mask.contains(px, py, size.width, size.height) {
        return Err("pointer is outside the model".into());
    }
    *state.drag.lock().map_err(|_| "drag state unavailable")? = Some(DragOrigin {
        x: f64::from(origin.x) + px,
        y: f64::from(origin.y) + py,
        position,
        threshold: 5.0 * f64::from(size.width) / mask.viewport_width,
    });
    Ok(())
}

#[tauri::command]
pub fn move_model_drag(
    window: tauri::WebviewWindow,
    state: tauri::State<HitTestState>,
    app: AppHandle,
) -> Result<(), String> {
    if window.label() != "main" || app.state::<crate::tray::UiState>().click_through() {
        return Err("model interaction unavailable".into());
    }
    let cursor = window
        .cursor_position()
        .map_err(|_| "cursor position unavailable")?;
    let position = state
        .drag
        .lock()
        .map_err(|_| "drag state unavailable")?
        .as_ref()
        .and_then(|drag| drag.destination(cursor.x, cursor.y));
    if let Some(position) = position {
        window
            .set_position(position)
            .map_err(|_| "window movement unavailable")?;
    }
    Ok(())
}

#[tauri::command]
pub fn end_model_drag(
    window: tauri::WebviewWindow,
    state: tauri::State<HitTestState>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("model interaction unavailable".into());
    }
    *state.drag.lock().map_err(|_| "drag state unavailable")? = None;
    Ok(())
}

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
        .mask
        .lock()
        .map_err(|_| "interaction state unavailable")?;
    // Invalid updates remove stale coverage rather than keeping an old model active.
    *current = None;
    if mask.is_none() {
        *state.drag.lock().map_err(|_| "drag state unavailable")? = None;
    }
    if let Some(mask) = mask {
        if let Err(error) = mask.validate() {
            *state.drag.lock().map_err(|_| "drag state unavailable")? = None;
            return Err(error);
        }
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
                    let coverage = state.mask.lock().ok().map(|mask| {
                        let hit = mask
                            .as_ref()
                            .is_some_and(|m| m.contains(x, y, size.width, size.height));
                        let gaze = mask
                            .as_ref()
                            .filter(|_| size.width > 0 && size.height > 0)
                            .map(|mask| CursorPoint {
                                x: x * mask.viewport_width / f64::from(size.width),
                                y: y * mask.viewport_height / f64::from(size.height),
                            });
                        (hit, gaze)
                    });
                    // Never dispatch window/IPC work while holding the mask mutex.
                    if let Some((hit, gaze)) = coverage {
                        let hit = hit
                            || state.bubble.lock().is_ok_and(|region| {
                                region
                                    .as_ref()
                                    .is_some_and(|r| r.contains(x, y, size.width, size.height))
                            });
                        let force = app.state::<crate::tray::UiState>().click_through();
                        let down = primary_button_down();
                        let active_drag = state.drag.lock().is_ok_and(|drag| drag.is_some());
                        let ignore =
                            latch.ignore(hit, down, force) && !(active_drag && down && !force);
                        if ignore != ignored && window.set_ignore_cursor_events(ignore).is_ok() {
                            ignored = ignore;
                        }
                        if last_gaze.elapsed().as_millis() >= 32 {
                            if let Some(point) = gaze {
                                let _ = window.emit("pet-cursor", point);
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
    #[test]
    fn interactive_bubble_is_bounded_and_respects_dpi() {
        let mut r = BubbleRegion {
            left: 16.0,
            top: 10.0,
            width: 288.0,
            height: 200.0,
            viewport_width: 320.0,
            viewport_height: 480.0,
        };
        r.validate().unwrap();
        assert!(r.contains(100.0, 100.0, 640, 960));
        assert!(!r.contains(30.0, 100.0, 640, 960));
        assert!(!r.contains(100.0, 430.0, 640, 960));
        assert!(!r.contains(f64::NAN, 100.0, 640, 960));
        assert!(!r.contains(100.0, 100.0, 0, 960));
        r.width = 500.0;
        assert!(r.validate().is_err());
        r.width = f64::INFINITY;
        assert!(r.validate().is_err());
    }
    #[test]
    fn drag_uses_the_original_physical_cursor_and_window_position() {
        let d = DragOrigin {
            x: 500.0,
            y: 300.0,
            position: tauri::PhysicalPosition::new(-200, 100),
            threshold: 7.5,
        };
        assert!(d.destination(503.0, 301.0).is_none());
        assert_eq!(
            d.destination(650.0, 400.0).unwrap(),
            tauri::PhysicalPosition::new(-50, 200)
        );
        assert_eq!(
            d.destination(650.0, 400.0).unwrap(),
            tauri::PhysicalPosition::new(-50, 200)
        );
        assert!(d.destination(f64::NAN, 400.0).is_none());
    }
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
