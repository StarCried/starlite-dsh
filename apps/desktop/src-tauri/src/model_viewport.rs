//! Expand the transparent VRM window without moving or scaling its logical model area.
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{PhysicalPosition, PhysicalSize};

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
            || self.base_width != 320.0
            || self.base_height != 480.0
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
pub struct ModelViewportState(Mutex<Option<ModelViewport>>);

struct Geometry {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    delta: PhysicalPosition<i32>,
}

fn geometry(
    previous: Option<ModelViewport>,
    next: ModelViewport,
    position: PhysicalPosition<i32>,
    scale: f64,
) -> Result<Geometry, String> {
    next.validate()?;
    if !scale.is_finite() || !(0.25..=8.0).contains(&scale) {
        return Err("invalid window scale".into());
    }
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
        size: PhysicalSize::new(
            (next.width * scale).round() as u32,
            (next.height * scale).round() as u32,
        ),
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
    let mut current = state.0.lock().map_err(|_| "window geometry unavailable")?;
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
}
