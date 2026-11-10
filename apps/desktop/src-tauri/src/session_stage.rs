//! Session-only movement. Never write the model library or user preferences.
use std::sync::Mutex;

use tauri::{Manager, PhysicalPosition, PhysicalSize};

use crate::model_viewport::ModelBodyRect;

#[derive(Default)]
pub struct SessionStageState(Mutex<Option<StageBaseline>>);

#[derive(Clone, Copy)]
struct StageBaseline {
    anchor: PhysicalPosition<f64>,
    width: f64,
    height: f64,
}

fn validate_window(window: &tauri::WebviewWindow, rect: ModelBodyRect) -> Result<f64, String> {
    if window.label() != "main" {
        return Err("session stage belongs to the pet window".into());
    }
    rect.validate()?;
    let scale = window
        .scale_factor()
        .map_err(|_| "window scale unavailable")?;
    if !scale.is_finite() || !(0.25..=8.0).contains(&scale) {
        return Err("invalid window scale".into());
    }
    let size = window.inner_size().map_err(|_| "window size unavailable")?;
    if rect.left + rect.width > f64::from(size.width) / scale + 1.0
        || rect.top + rect.height > f64::from(size.height) / scale + 1.0
    {
        return Err("model rectangle exceeds the pet window".into());
    }
    Ok(scale)
}

fn foot(rect: ModelBodyRect, position: PhysicalPosition<i32>, scale: f64) -> PhysicalPosition<f64> {
    PhysicalPosition::new(
        f64::from(position.x) + (rect.left + rect.width / 2.0) * scale,
        f64::from(position.y) + (rect.top + rect.height) * scale,
    )
}

fn bounded_position(
    rect: ModelBodyRect,
    scale: f64,
    origin: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    target: PhysicalPosition<f64>,
) -> Result<PhysicalPosition<i32>, String> {
    rect.validate()?;
    if !scale.is_finite()
        || !(0.25..=8.0).contains(&scale)
        || size.width == 0
        || size.height == 0
        || !target.x.is_finite()
        || !target.y.is_finite()
    {
        return Err("invalid stage geometry".into());
    }
    let left = f64::from(origin.x);
    let top = f64::from(origin.y);
    let x = (target.x - rect.width * scale / 2.0).clamp(
        left,
        left + (f64::from(size.width) - rect.width * scale).max(0.0),
    );
    let y = (target.y - rect.height * scale).clamp(
        top,
        top + (f64::from(size.height) - rect.height * scale).max(0.0),
    );
    Ok(PhysicalPosition::new(
        (x - rect.left * scale).round() as i32,
        (y - rect.top * scale).round() as i32,
    ))
}

#[tauri::command]
pub fn begin_session_stage(
    window: tauri::WebviewWindow,
    state: tauri::State<SessionStageState>,
    interaction: tauri::State<crate::hit_test::HitTestState>,
    model_rect: ModelBodyRect,
) -> Result<(), String> {
    let _movement = interaction
        .window_geometry
        .lock()
        .map_err(|_| "window geometry unavailable")?;
    let scale = validate_window(&window, model_rect)?;
    let mut saved = state.0.lock().map_err(|_| "session stage unavailable")?;
    if saved.is_some() {
        return Err("session stage already active".into());
    }
    *saved = Some(StageBaseline {
        anchor: foot(
            model_rect,
            window
                .outer_position()
                .map_err(|_| "window position unavailable")?,
            scale,
        ),
        width: model_rect.width,
        height: model_rect.height,
    });
    Ok(())
}

#[tauri::command]
pub fn set_session_stage_position(
    window: tauri::WebviewWindow,
    state: tauri::State<SessionStageState>,
    interaction: tauri::State<crate::hit_test::HitTestState>,
    model_rect: ModelBodyRect,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() || !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
        return Err("stage position must be in 0..1".into());
    }
    let _movement = interaction
        .window_geometry
        .lock()
        .map_err(|_| "window geometry unavailable")?;
    let scale = validate_window(&window, model_rect)?;
    let saved = state.0.lock().map_err(|_| "session stage unavailable")?;
    if saved.is_none() {
        return Err("session stage is not active".into());
    }
    let current = foot(
        model_rect,
        window
            .outer_position()
            .map_err(|_| "window position unavailable")?,
        scale,
    );
    let monitor = window
        .monitor_from_point(current.x, current.y - model_rect.height * scale / 2.0)
        .map_err(|_| "monitor unavailable")?
        .or(window
            .current_monitor()
            .map_err(|_| "monitor unavailable")?)
        .or(window
            .primary_monitor()
            .map_err(|_| "monitor unavailable")?)
        .ok_or("monitor unavailable")?;
    let area = monitor.work_area();
    let target = PhysicalPosition::new(
        f64::from(area.position.x)
            + model_rect.width * scale / 2.0
            + x * (f64::from(area.size.width) - model_rect.width * scale).max(0.0),
        f64::from(area.position.y)
            + model_rect.height * scale
            + y * (f64::from(area.size.height) - model_rect.height * scale).max(0.0),
    );
    window
        .set_position(bounded_position(
            model_rect,
            scale,
            area.position,
            area.size,
            target,
        )?)
        .map_err(|_| "window movement unavailable".to_string())
}

#[tauri::command]
pub fn end_session_stage(
    window: tauri::WebviewWindow,
    state: tauri::State<SessionStageState>,
    interaction: tauri::State<crate::hit_test::HitTestState>,
    model_rect: ModelBodyRect,
    restore: bool,
) -> Result<(), String> {
    let _movement = interaction
        .window_geometry
        .lock()
        .map_err(|_| "window geometry unavailable")?;
    let scale = validate_window(&window, model_rect)?;
    let mut saved = state.0.lock().map_err(|_| "session stage unavailable")?;
    let Some(baseline) = *saved else {
        return Ok(());
    };
    let anchor = baseline.anchor;
    if restore {
        let monitor = window
            .monitor_from_point(anchor.x, anchor.y - 1.0)
            .map_err(|_| "monitor unavailable")?
            .or(window
                .current_monitor()
                .map_err(|_| "monitor unavailable")?)
            .or(window
                .primary_monitor()
                .map_err(|_| "monitor unavailable")?)
            .ok_or("monitor unavailable")?;
        let area = monitor.work_area();
        window
            .set_position(bounded_position(
                model_rect,
                scale,
                area.position,
                area.size,
                anchor,
            )?)
            .map_err(|_| "window movement unavailable")?;
    }
    *saved = None;
    Ok(())
}

/// Run after removing the transparent gesture margins. The window-state plugin
/// must save the user's original size/position, not a session's temporary stage.
pub fn restore_before_exit(window: &tauri::WebviewWindow) {
    let state = window.state::<SessionStageState>();
    let Ok(mut saved) = state.0.lock() else {
        return;
    };
    let Some(baseline) = *saved else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let monitor = window
        .monitor_from_point(baseline.anchor.x, baseline.anchor.y - 1.0)
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let area = monitor.work_area();
    let rect = ModelBodyRect {
        left: 0.0,
        top: 0.0,
        width: baseline.width,
        height: baseline.height,
    };
    let Ok(position) = bounded_position(rect, scale, area.position, area.size, baseline.anchor)
    else {
        return;
    };
    let _ = window.set_size(PhysicalSize::new(
        (baseline.width * scale).round() as u32,
        (baseline.height * scale).round() as u32,
    ));
    let _ = window.set_position(position);
    *saved = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clamps_portrait_including_controls_not_transparent_canvas() {
        let rect = ModelBodyRect {
            left: 128.0,
            top: 532.0,
            width: 320.0,
            height: 520.0,
        };
        for dpi in [1.0, 1.25, 1.5, 2.0] {
            let origin = PhysicalPosition::new(-1920, -100);
            let size = PhysicalSize::new(1920, 1080);
            for target in [
                PhysicalPosition::new(-99999.0, -99999.0),
                PhysicalPosition::new(99999.0, 99999.0),
            ] {
                let position = bounded_position(rect, dpi, origin, size, target).unwrap();
                let actual = foot(rect, position, dpi);
                assert!(actual.x - rect.width * dpi / 2.0 >= -1920.5);
                assert!(actual.x + rect.width * dpi / 2.0 <= 0.5);
                assert!(actual.y - rect.height * dpi >= -100.5);
                assert!(actual.y <= 980.5);
            }
        }
    }

    #[test]
    fn restoring_anchor_after_zoom_preserves_original_feet() {
        let old = ModelBodyRect {
            left: 128.0,
            top: 532.0,
            width: 320.0,
            height: 480.0,
        };
        let scale = 1.5;
        let position = PhysicalPosition::new(-100, -600);
        let anchor = foot(old, position, scale);
        let resized = ModelBodyRect {
            left: 200.0,
            top: 600.0,
            width: 200.0,
            height: 300.0,
        };
        let next = bounded_position(
            resized,
            scale,
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1080),
            anchor,
        )
        .unwrap();
        let actual = foot(resized, next, scale);
        assert!((actual.x - anchor.x).abs() <= 0.5);
        assert!((actual.y - anchor.y).abs() <= 0.5);
        assert!(bounded_position(
            old,
            f64::NAN,
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1080),
            anchor
        )
        .is_err());
    }
}
