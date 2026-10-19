//! Expand the transparent VRM window without moving or scaling its logical model area.
use std::sync::{Arc, Mutex, TryLockError};

use serde::Deserialize;
use tauri::{Manager, PhysicalPosition, PhysicalSize};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelViewport {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    base_width: f64,
    base_height: f64,
}

impl ModelViewport {
    fn validate(&self) -> Result<(), String> {
        if ![
            self.left,
            self.top,
            self.width,
            self.height,
            self.base_width,
            self.base_height,
        ]
        .iter()
        .all(|value| value.is_finite())
            || !(80.0..=960.0).contains(&self.base_width)
            || !(120.0..=1440.0).contains(&self.base_height)
            || (self.base_width * 1.5 - self.base_height).abs() > 1.0
            || self.left > 0.0
            || self.top > 0.0
            || self.width > 4096.0
            || self.height > 4096.0
            || self.width + self.left < self.base_width
            || self.height + self.top < self.base_height
        {
            return Err("invalid model viewport".into());
        }
        Ok(())
    }

    fn base(self) -> Self {
        Self {
            left: 0.0,
            top: 0.0,
            width: self.base_width,
            height: self.base_height,
            ..self
        }
    }
}

#[derive(Default)]
pub struct ModelViewportState {
    viewport: Mutex<Option<ModelViewport>>,
    // Separate from viewport/window_geometry: a resize can be emitted while
    // set_model_viewport holds those locks and is still inside the native call.
    reconcile: Arc<Mutex<ReconcileQueue>>,
}

#[derive(Default)]
struct ReconcileQueue {
    scheduled: bool,
    dirty: bool,
}

impl ReconcileQueue {
    fn request(&mut self) -> bool {
        self.dirty = true;
        if self.scheduled {
            false
        } else {
            self.scheduled = true;
            true
        }
    }

    fn begin(&mut self) {
        self.dirty = false;
    }

    fn finish(&mut self, retry: bool) -> bool {
        if self.dirty || retry {
            true
        } else {
            self.scheduled = false;
            false
        }
    }
}

fn physical_size(viewport: ModelViewport, scale: f64) -> Result<PhysicalSize<u32>, String> {
    viewport.validate()?;
    if !scale.is_finite() || !(0.25..=8.0).contains(&scale) {
        return Err("invalid window scale".into());
    }
    Ok(PhysicalSize::new(
        (viewport.width * scale).round() as u32,
        (viewport.height * scale).round() as u32,
    ))
}

fn size_correction(
    viewport: Option<ModelViewport>,
    current_scale: f64,
    actual: PhysicalSize<u32>,
) -> Result<Option<PhysicalSize<u32>>, String> {
    let Some(viewport) = viewport else {
        return Ok(None);
    };
    let expected = physical_size(viewport, current_scale)?;
    Ok((expected != actual).then_some(expected))
}

/// Reassert the logical viewport after Windows has applied its DPI suggested
/// rectangle. That rectangle can otherwise leave the tall transparent surface
/// shorter than its contents even after moving it away from the screen edge.
pub fn schedule_reconcile(window: &tauri::Window) {
    if window.label() != "main" {
        return;
    }
    let queue = window.state::<ModelViewportState>().reconcile.clone();
    let start = queue.lock().is_ok_and(|mut queue| queue.request());
    if start {
        defer_reconcile(window.clone(), queue, false);
    }
}

fn defer_reconcile(
    window: tauri::Window,
    queue: Arc<Mutex<ReconcileQueue>>,
    wait_for_geometry: bool,
) {
    // run_on_main_thread executes inline when called on the UI thread. Hop to
    // the blocking pool first so Tao's WM_DPICHANGED finishes SetWindowPos
    // before the repair runs; no event callback waits on viewport/drag locks.
    tauri::async_runtime::spawn_blocking(move || {
        if wait_for_geometry {
            // A command on another thread may still own the geometry mutex.
            // Yield a frame instead of repeatedly queuing a busy UI task.
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
        let task_window = window.clone();
        let task_queue = queue.clone();
        if window
            .run_on_main_thread(move || {
                let Ok(mut pending) = task_queue.lock() else {
                    return;
                };
                pending.begin();
                drop(pending);
                let retry = reconcile_size(&task_window);
                let again = task_queue
                    .lock()
                    .is_ok_and(|mut pending| pending.finish(retry));
                if again {
                    defer_reconcile(task_window, task_queue, retry);
                }
            })
            .is_err()
        {
            if let Ok(mut pending) = queue.lock() {
                *pending = ReconcileQueue::default();
            }
        }
    });
}

/// Returns true only when an in-flight geometry operation requires another
/// deferred pass. API errors (including a destroyed window) do not spin.
fn reconcile_size(window: &tauri::Window) -> bool {
    let interaction = window.state::<crate::hit_test::HitTestState>();
    let _movement = match interaction.window_geometry.try_lock() {
        Ok(lock) => lock,
        Err(TryLockError::WouldBlock) => return true,
        Err(TryLockError::Poisoned(_)) => return false,
    };
    let state = window.state::<ModelViewportState>();
    let current = match state.viewport.try_lock() {
        Ok(lock) => lock,
        Err(TryLockError::WouldBlock) => return true,
        Err(TryLockError::Poisoned(_)) => return false,
    };
    if current.is_none() || window.is_minimized().unwrap_or(true) {
        return false;
    }
    // Read the live DPI here, never the payload of a potentially late event.
    if let (Ok(scale), Ok(actual)) = (window.scale_factor(), window.inner_size()) {
        if let Ok(Some(size)) = size_correction(*current, scale, actual) {
            let _ = window.set_size(size);
        }
    }
    // Size only: retain the current position, model, hit mask and bubble region.
    false
}

struct Geometry {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    delta: PhysicalPosition<i32>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelBodyRect {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

impl ModelBodyRect {
    fn validate(&self) -> Result<(), String> {
        if ![self.left, self.top, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            || self.left < 0.0
            || self.top < 0.0
            || self.width <= 0.0
            || self.height <= 0.0
            || self.left + self.width > 16384.0
            || self.top + self.height > 16384.0
        {
            return Err("invalid model body rectangle".into());
        }
        Ok(())
    }
}

fn default_body_position(
    model: ModelBodyRect,
    scale: f64,
    work_origin: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
) -> Result<PhysicalPosition<i32>, String> {
    model.validate()?;
    if !scale.is_finite()
        || !(0.25..=8.0).contains(&scale)
        || work_size.width == 0
        || work_size.height == 0
    {
        return Err("invalid monitor geometry".into());
    }
    // Align the portrait, not the large transparent area reserved for actions
    // and questions. Leave taskbars and negative-origin monitors intact.
    let body_x = f64::from(work_origin.x)
        + (f64::from(work_size.width) - (model.width + 24.0) * scale).max(0.0);
    let body_y = f64::from(work_origin.y)
        + (f64::from(work_size.height) - (model.height + 48.0) * scale).max(0.0);
    Ok(PhysicalPosition::new(
        (body_x - model.left * scale).round() as i32,
        (body_y - model.top * scale).round() as i32,
    ))
}

#[tauri::command]
pub fn restore_default_position(
    window: tauri::WebviewWindow,
    interaction: tauri::State<crate::hit_test::HitTestState>,
    model_rect: ModelBodyRect,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("model position belongs to the pet window".into());
    }
    model_rect.validate()?;
    let _movement = interaction
        .window_geometry
        .lock()
        .map_err(|_| "window geometry unavailable")?;
    let scale = window
        .scale_factor()
        .map_err(|_| "window scale unavailable")?;
    if !scale.is_finite() || !(0.25..=8.0).contains(&scale) {
        return Err("invalid window scale".into());
    }
    let size = window.inner_size().map_err(|_| "window size unavailable")?;
    if model_rect.left + model_rect.width > f64::from(size.width) / scale + 1.0
        || model_rect.top + model_rect.height > f64::from(size.height) / scale + 1.0
    {
        return Err("model body rectangle exceeds the pet window".into());
    }
    let origin = window
        .inner_position()
        .map_err(|_| "window position unavailable")?;
    let center_x = f64::from(origin.x) + (model_rect.left + model_rect.width / 2.0) * scale;
    let center_y = f64::from(origin.y) + (model_rect.top + model_rect.height / 2.0) * scale;
    let monitor = window
        .monitor_from_point(center_x, center_y)
        .map_err(|_| "monitor unavailable")?
        .or(window
            .current_monitor()
            .map_err(|_| "monitor unavailable")?)
        .or(window
            .primary_monitor()
            .map_err(|_| "monitor unavailable")?)
        .ok_or("monitor unavailable")?;
    let area = monitor.work_area();
    let position =
        default_body_position(model_rect, monitor.scale_factor(), area.position, area.size)?;
    window
        .set_position(position)
        .map_err(|_| "window movement unavailable".to_string())
}

fn geometry(
    previous: Option<ModelViewport>,
    next: ModelViewport,
    position: PhysicalPosition<i32>,
    scale: f64,
) -> Result<Geometry, String> {
    let size = physical_size(next, scale)?;
    // Round each padding separately: repeated fractional-DPI expansion/collapse
    // must not gradually move the character on screen.
    let previous = previous.unwrap_or_else(|| next.base());
    let delta = PhysicalPosition::new(
        (next.left * scale).round() as i32 - (previous.left * scale).round() as i32,
        (next.top * scale).round() as i32 - (previous.top * scale).round() as i32,
    );
    Ok(Geometry {
        position: PhysicalPosition::new(
            position.x.saturating_add(delta.x),
            position.y.saturating_add(delta.y),
        ),
        size,
        delta,
    })
}

#[tauri::command]
pub fn set_model_viewport(
    window: tauri::WebviewWindow,
    state: tauri::State<ModelViewportState>,
    interaction: tauri::State<crate::hit_test::HitTestState>,
    viewport: Option<ModelViewport>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("model viewport belongs to the pet window".into());
    }
    let _movement = interaction
        .window_geometry
        .lock()
        .map_err(|_| "window geometry unavailable")?;
    let mut current = state
        .viewport
        .lock()
        .map_err(|_| "window geometry unavailable")?;
    let Some(next) = viewport.or_else(|| current.map(ModelViewport::base)) else {
        return Ok(());
    };
    let position = window
        .outer_position()
        .map_err(|_| "window position unavailable")?;
    let scale = window
        .scale_factor()
        .map_err(|_| "window scale unavailable")?;
    let next_geometry = geometry(*current, next, position, scale)?;
    interaction.rebase_viewport(next_geometry.delta)?;
    window
        .set_size(next_geometry.size)
        .map_err(|_| "window resize unavailable")?;
    window
        .set_position(next_geometry.position)
        .map_err(|_| "window movement unavailable")?;
    *current = viewport.map(|_| next);
    Ok(())
}

/// Let the existing window-state plugin persist the logical anchor, not a
/// temporary transparent margin that would be subtracted again next launch.
pub fn restore_before_exit(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = set_model_viewport(window, app.state(), app.state(), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn viewport() -> ModelViewport {
        ModelViewport {
            left: -80.0,
            top: -120.0,
            width: 520.0,
            height: 720.0,
            base_width: 320.0,
            base_height: 480.0,
        }
    }

    #[test]
    fn expanded_window_preserves_character_anchor_at_fractional_dpi() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let origin = PhysicalPosition::new(-600, 300);
            let v = viewport();
            let expanded = geometry(None, v, origin, scale).unwrap();
            assert_eq!(
                expanded.position.x - (v.left * scale).round() as i32,
                origin.x
            );
            assert_eq!(
                expanded.position.y - (v.top * scale).round() as i32,
                origin.y
            );
            assert_eq!(
                expanded.size,
                PhysicalSize::new(
                    (v.width * scale).round() as u32,
                    (v.height * scale).round() as u32
                )
            );
            let restored = geometry(Some(v), v.base(), expanded.position, scale).unwrap();
            assert_eq!(restored.position, origin);
            assert_eq!(
                restored.size,
                PhysicalSize::new(
                    (320.0 * scale).round() as u32,
                    (480.0 * scale).round() as u32
                )
            );
        }
    }

    #[test]
    fn padding_changes_preserve_user_drag_and_do_not_accumulate_rounding() {
        let mut current = viewport();
        let mut position = PhysicalPosition::new(100, 200);
        let start = position;
        for _ in 0..20 {
            let next = ModelViewport {
                left: -81.25,
                top: -121.25,
                ..current
            };
            position = geometry(Some(current), next, position, 1.25)
                .unwrap()
                .position;
            position = geometry(Some(next), current, position, 1.25)
                .unwrap()
                .position;
        }
        assert_eq!(position, start);
        position.x += 40;
        position.y -= 25;
        current = viewport();
        let restored = geometry(Some(current), current.base(), position, 1.25).unwrap();
        assert_eq!(
            restored.position,
            PhysicalPosition::new(start.x + 40 + 100, start.y - 25 + 150)
        );
    }

    #[test]
    fn rejects_nonfinite_unbounded_and_clipped_logical_viewports() {
        for v in [
            ModelViewport {
                left: f64::NAN,
                ..viewport()
            },
            ModelViewport {
                width: f64::INFINITY,
                ..viewport()
            },
            ModelViewport {
                width: 4097.0,
                ..viewport()
            },
            ModelViewport {
                left: 1.0,
                ..viewport()
            },
            ModelViewport {
                width: 350.0,
                ..viewport()
            },
            ModelViewport {
                base_width: 640.0,
                ..viewport()
            },
        ] {
            assert!(v.validate().is_err());
        }
        assert!(geometry(None, viewport(), PhysicalPosition::new(0, 0), f64::NAN).is_err());
    }

    #[test]
    fn restored_window_state_can_reopen_and_expand_without_position_drift() {
        let scale = 1.5;
        let viewport = viewport();
        let origin = PhysicalPosition::new(200, 300);
        let mut expanded = geometry(None, viewport, origin, scale).unwrap();
        // Simulate a user's physical drag before a normal application exit.
        expanded.position.x += 35;
        expanded.position.y -= 20;
        let saved = geometry(Some(viewport), viewport.base(), expanded.position, scale).unwrap();
        let reopened = geometry(None, viewport, saved.position, scale).unwrap();
        assert_eq!(reopened.position, expanded.position);
        assert_eq!(reopened.size, expanded.size);
        assert_eq!(saved.position, PhysicalPosition::new(235, 280));
    }

    fn fixed_vrm_viewport() -> ModelViewport {
        ModelViewport {
            left: -128.0,
            top: -532.0,
            width: 576.0,
            height: 1204.0,
            base_width: 320.0,
            base_height: 480.0,
        }
    }

    #[test]
    fn true_model_scaling_preserves_body_anchor_and_validates_aspect() {
        let previous = fixed_vrm_viewport();
        let origin = PhysicalPosition::new(200, -100);
        for model_scale in [0.25_f64, 0.5, 0.73, 1.0, 1.5, 3.0] {
            let width = (320.0 * model_scale).round();
            let height = (480.0 * model_scale).round();
            let next = ModelViewport {
                base_width: width,
                base_height: height,
                width: width + 256.0,
                height: height + 724.0,
                ..previous
            };
            for dpi in [1.0, 1.25, 1.5, 2.0] {
                let resized = geometry(Some(previous), next, origin, dpi).unwrap();
                assert_eq!(resized.position, origin);
                assert_eq!(resized.size.width, (next.width * dpi).round() as u32);
            }
            assert!(ModelViewport {
                base_height: height + 3.0,
                ..next
            }
            .validate()
            .is_err());
        }
    }

    #[test]
    fn default_position_aligns_body_not_transparent_reserved_window() {
        let model = ModelBodyRect {
            left: 128.0,
            top: 532.0,
            width: 320.0,
            height: 480.0,
        };
        for dpi in [1.0, 1.25, 1.5, 2.0] {
            let origin = PhysicalPosition::new(-2560, 80);
            let area = PhysicalSize::new(2560, 1440);
            let position = default_body_position(model, dpi, origin, area).unwrap();
            let right = f64::from(position.x) + (model.left + model.width) * dpi;
            let bottom = f64::from(position.y) + (model.top + model.height) * dpi;
            assert_eq!(right, -24.0 * dpi);
            assert_eq!(bottom, 1520.0 - 48.0 * dpi);
            assert!(f64::from(position.y) + model.top * dpi >= f64::from(origin.y));
        }
    }

    #[test]
    fn default_position_handles_oversized_models_and_rejects_invalid_geometry() {
        let model = ModelBodyRect {
            left: 128.0,
            top: 532.0,
            width: 960.0,
            height: 1440.0,
        };
        let origin = PhysicalPosition::new(20, 30);
        let small = PhysicalSize::new(640, 480);
        assert_eq!(
            default_body_position(model, 1.0, origin, small).unwrap(),
            PhysicalPosition::new(-108, -502)
        );
        assert!(default_body_position(model, f64::NAN, origin, small).is_err());
        assert!(default_body_position(model, 1.0, origin, PhysicalSize::new(0, 480)).is_err());
        assert!(ModelBodyRect {
            left: -1.0,
            ..model
        }
        .validate()
        .is_err());
        assert!(ModelBodyRect {
            width: 0.0,
            ..model
        }
        .validate()
        .is_err());
        assert!(ModelBodyRect {
            height: f64::INFINITY,
            ..model
        }
        .validate()
        .is_err());
    }

    #[test]
    fn os_shrunk_window_recovers_full_surface_at_current_dpi() {
        let viewport = fixed_vrm_viewport();
        for (scale, shrunk, expected) in [
            (
                1.0,
                PhysicalSize::new(576, 720),
                PhysicalSize::new(576, 1204),
            ),
            (
                1.5,
                PhysicalSize::new(864, 1080),
                PhysicalSize::new(864, 1806),
            ),
        ] {
            assert_eq!(
                size_correction(Some(viewport), scale, shrunk).unwrap(),
                Some(expected)
            );
            // The resize notification caused by the repair must be a no-op.
            assert_eq!(
                size_correction(Some(viewport), scale, expected).unwrap(),
                None
            );
        }
    }

    #[test]
    fn dpi_round_trip_never_reapplies_logical_padding() {
        let viewport = fixed_vrm_viewport();
        let mut size = PhysicalSize::new(576, 720);
        for (scale, expected) in [
            (1.0, PhysicalSize::new(576, 1204)),
            (1.5, PhysicalSize::new(864, 1806)),
            (1.0, PhysicalSize::new(576, 1204)),
            (1.5, PhysicalSize::new(864, 1806)),
            (1.0, PhysicalSize::new(576, 1204)),
        ] {
            size = size_correction(Some(viewport), scale, size)
                .unwrap()
                .unwrap_or(size);
            assert_eq!(size, expected);
        }
        assert_eq!(viewport, fixed_vrm_viewport());
    }

    #[test]
    fn matching_or_deactivated_viewport_does_not_resize() {
        let size = PhysicalSize::new(576, 1204);
        assert_eq!(
            size_correction(Some(fixed_vrm_viewport()), 1.0, size).unwrap(),
            None
        );
        // A deferred event from before model disposal must not re-expand it.
        assert_eq!(
            size_correction(None, 1.5, PhysicalSize::new(480, 720)).unwrap(),
            None
        );
    }

    #[test]
    fn late_dpi_event_uses_live_scale_not_old_notification() {
        let mut pending = ReconcileQueue::default();
        assert!(pending.request()); // 100% -> 150%, deferred native repair.
        assert!(!pending.request()); // Back to 100% before the task runs.
        pending.begin();
        // No DPI payload is stored in the queue; only the current window scale
        // is used when the deferred task runs, even if an old event arrives late.
        assert_eq!(
            size_correction(
                Some(fixed_vrm_viewport()),
                1.0,
                PhysicalSize::new(864, 1080)
            )
            .unwrap(),
            Some(PhysicalSize::new(576, 1204))
        );
        assert!(!pending.finish(false));
    }

    #[test]
    fn event_burst_and_repair_feedback_coalesce_without_resize_loop() {
        let mut pending = ReconcileQueue::default();
        assert!(pending.request());
        for _ in 0..100 {
            assert!(!pending.request());
        }
        pending.begin();
        // set_size itself emits a resize event; keep exactly one follow-up.
        assert!(!pending.request());
        assert!(pending.finish(false));
        pending.begin();
        assert_eq!(
            size_correction(
                Some(fixed_vrm_viewport()),
                1.5,
                PhysicalSize::new(864, 1806)
            )
            .unwrap(),
            None
        );
        assert!(!pending.finish(false));
        assert!(!pending.scheduled);
    }

    #[test]
    fn busy_repair_and_newest_event_cannot_lose_a_follow_up() {
        let mut pending = ReconcileQueue::default();
        assert!(pending.request());
        pending.begin();
        assert!(pending.finish(true)); // IPC owns geometry: retry, without waiting on UI.
        assert!(!pending.request()); // A newer DPI event joins the scheduled retry.
        pending.begin();
        assert!(!pending.request()); // Another event occurs during the repair.
        assert!(pending.finish(false));
        pending.begin();
        assert!(!pending.finish(false));
        // An event after the final pass takes ownership of a new deferred task.
        assert!(pending.request());
    }
}
