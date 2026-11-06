//! Local-only sampling near the visible model, excluding this window's own UI.
//! Pixels never leave this module: only reduced RGB and patch geometry do.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use crate::hit_test::EnvironmentBounds;
use serde::{Deserialize, Serialize};
use tauri::Manager;

const SAMPLE_INTERVAL: Duration = Duration::from_millis(250);
const PATCH_SIZE: i32 = 12;
const PATCH_GAP: i32 = 12;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentColor {
    color: String,
    patches: Vec<EnvironmentRect>,
    viewport_width: f64,
    viewport_height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentRect {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentOverlays {
    viewport_width: f64,
    viewport_height: f64,
    regions: Vec<EnvironmentRect>,
}

impl EnvironmentOverlays {
    fn validate(&self) -> Result<(), String> {
        let valid = [self.viewport_width, self.viewport_height]
            .iter()
            .all(|v| v.is_finite() && *v > 0.0 && *v <= 16384.0)
            && self.regions.len() <= 40
            && self.regions.iter().all(|r| {
                [r.left, r.top, r.width, r.height]
                    .iter()
                    .all(|v| v.is_finite())
                    && r.left >= 0.0
                    && r.top >= 0.0
                    && r.width > 0.0
                    && r.height > 0.0
                    && r.left + r.width <= self.viewport_width
                    && r.top + r.height <= self.viewport_height
            });
        if valid {
            Ok(())
        } else {
            Err("invalid environment overlay geometry".into())
        }
    }
}

#[derive(Default)]
struct SampleCache {
    sampled_at: Option<Instant>,
}

impl SampleCache {
    fn fresh(&self, now: Instant) -> bool {
        self.sampled_at
            .is_some_and(|last| now.saturating_duration_since(last) < SAMPLE_INTERVAL)
    }
}

#[derive(Default)]
pub struct EnvironmentSamplingState {
    enabled: AtomicBool,
    generation: AtomicU64,
    cache: Arc<Mutex<SampleCache>>,
}

impl EnvironmentSamplingState {
    pub fn configure(&self, preferences: &crate::settings::DesktopPreferences) {
        let enabled = preferences.environment_lighting_enabled
            && preferences.environment_lighting_strength > 0.0;
        if self.enabled.swap(enabled, Ordering::SeqCst) != enabled {
            self.generation.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
pub async fn sample_environment_color(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    overlays: EnvironmentOverlays,
) -> Result<Option<EnvironmentColor>, String> {
    if window.label() != "main" {
        return Err("environment sampling belongs to the pet window".into());
    }
    overlays.validate()?;
    // The enabled state comes from native preferences, not an
    // untrusted webview parameter. There is no arbitrary screen rectangle API.
    let state = app.state::<EnvironmentSamplingState>();
    if !state.enabled.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let generation = state.generation.load(Ordering::SeqCst);
    let cache = state.cache.clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<EnvironmentSamplingState>();
        let mut cache = cache.try_lock().ok()?;
        if !state.enabled.load(Ordering::SeqCst)
            || state.generation.load(Ordering::SeqCst) != generation
            || app.state::<crate::tray::UiState>().paused()
            || !window.is_visible().unwrap_or(false)
            || window.is_minimized().unwrap_or(true)
        {
            return None;
        }
        let now = Instant::now();
        if cache.fresh(now) {
            // The frontend retains its last light. Replaying old patch positions
            // after movement would misrepresent where a new screen read occurred.
            return None;
        }
        cache.sampled_at = Some(now);
        let color = sample_window(&window, &overlays);
        // A disable during a native read must not publish its late result.
        if !state.enabled.load(Ordering::SeqCst)
            || state.generation.load(Ordering::SeqCst) != generation
            || app.state::<crate::tray::UiState>().paused()
            || !window.is_visible().unwrap_or(false)
            || window.is_minimized().unwrap_or(true)
        {
            return None;
        }
        color
    })
    .await
    .ok()
    .flatten())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl Rect {
    fn valid_size(self) -> bool {
        (1..=32768).contains(&(i64::from(self.right) - i64::from(self.left)))
            && (1..=32768).contains(&(i64::from(self.bottom) - i64::from(self.top)))
    }

    fn intersection(self, other: Self) -> Option<Self> {
        let result = Self {
            left: self.left.max(other.left),
            top: self.top.max(other.top),
            right: self.right.min(other.right),
            bottom: self.bottom.min(other.bottom),
        };
        (result.left < result.right && result.top < result.bottom).then_some(result)
    }
}

fn screen_rect(region: EnvironmentRect, overlays: &EnvironmentOverlays, client: Rect) -> Rect {
    let x = f64::from(client.right - client.left) / overlays.viewport_width;
    let y = f64::from(client.bottom - client.top) / overlays.viewport_height;
    Rect {
        left: client.left.saturating_add((region.left * x).floor() as i32),
        top: client.top.saturating_add((region.top * y).floor() as i32),
        right: client
            .left
            .saturating_add(((region.left + region.width) * x).ceil() as i32),
        bottom: client
            .top
            .saturating_add(((region.top + region.height) * y).ceil() as i32),
    }
}

struct SceneGeometry {
    client: Rect,
    model: Rect,
    excluded: Vec<Rect>,
}

fn scene_geometry(
    bounds: EnvironmentBounds,
    overlays: &EnvironmentOverlays,
    client: Rect,
) -> Option<SceneGeometry> {
    if !client.valid_size()
        || bounds.viewport_width != overlays.viewport_width
        || bounds.viewport_height != overlays.viewport_height
    {
        return None;
    }
    let model = screen_rect(
        EnvironmentRect {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
        },
        overlays,
        client,
    )
    .intersection(client)?;
    let excluded = overlays
        .regions
        .iter()
        .map(|r| screen_rect(*r, overlays, client))
        .collect();
    Some(SceneGeometry {
        client,
        model,
        excluded,
    })
}

/// Model-relative candidates can lie inside the transparent native window.
/// Clip to its client and real monitors, then remove visible UI coverage.
fn surrounding_patches(
    model: Rect,
    client: Rect,
    monitors: &[Rect],
    excluded: &[Rect],
) -> Vec<Rect> {
    let width = i64::from(model.right) - i64::from(model.left);
    let height = i64::from(model.bottom) - i64::from(model.top);
    if !model.valid_size() || !client.valid_size() {
        return Vec::new();
    }
    if !monitors
        .iter()
        .any(|monitor| model.intersection(*monitor).is_some())
    {
        return Vec::new();
    }
    let half = PATCH_SIZE / 2;
    let mut candidates = Vec::with_capacity(8);
    for numerator in [1, 3] {
        let x = model.left.saturating_add((width * numerator / 4) as i32);
        let y = model.top.saturating_add((height * numerator / 4) as i32);
        candidates.extend([
            (
                x.saturating_sub(half),
                model.top.saturating_sub(PATCH_GAP + PATCH_SIZE),
            ),
            (
                x.saturating_sub(half),
                model.bottom.saturating_add(PATCH_GAP),
            ),
            (
                model.left.saturating_sub(PATCH_GAP + PATCH_SIZE),
                y.saturating_sub(half),
            ),
            (
                model.right.saturating_add(PATCH_GAP),
                y.saturating_sub(half),
            ),
        ]);
    }
    candidates
        .into_iter()
        .filter_map(|(left, top)| {
            let patch = Rect {
                left,
                top,
                right: left.saturating_add(PATCH_SIZE),
                bottom: top.saturating_add(PATCH_SIZE),
            }
            .intersection(client)?;
            if patch.intersection(model).is_some()
                || excluded.iter().any(|r| patch.intersection(*r).is_some())
            {
                return None;
            }
            // Each patch is capped at 12x12 even when straddling two monitors.
            // Choosing the largest intersection avoids capturing virtual gaps.
            monitors
                .iter()
                .filter_map(|monitor| patch.intersection(*monitor))
                .max_by_key(|rect| (rect.right - rect.left) * (rect.bottom - rect.top))
        })
        .collect()
}

/// Keep samples outside the conservative bounds between the two observed
/// window positions. Movement can invalidate a leading-side patch without
/// invalidating the safe trailing-side samples from the same screen read.
fn retain_uncovered_patches(samples: &mut Vec<(Rect, [f64; 3])>, before: Rect, after: Rect) {
    if !before.valid_size() || !after.valid_size() {
        samples.clear();
        return;
    }
    let swept = Rect {
        left: before.left.min(after.left),
        top: before.top.min(after.top),
        right: before.right.max(after.right),
        bottom: before.bottom.max(after.bottom),
    };
    samples.retain(|(patch, _)| patch.intersection(swept).is_none());
}

fn finish_sample(
    mut samples: Vec<(Rect, [f64; 3])>,
    before: &SceneGeometry,
    after: &SceneGeometry,
    overlays: &EnvironmentOverlays,
) -> Option<EnvironmentColor> {
    if before.client.right - before.client.left != after.client.right - after.client.left
        || before.client.bottom - before.client.top != after.client.bottom - after.client.top
        || before.excluded.len() != after.excluded.len()
    {
        return None;
    }
    retain_uncovered_patches(&mut samples, before.model, after.model);
    for (old, new) in before.excluded.iter().zip(&after.excluded) {
        retain_uncovered_patches(&mut samples, *old, *new);
    }
    // Patches are reported in the current client, never as arbitrary desktop coordinates.
    samples.retain(|(patch, _)| patch.intersection(after.client) == Some(*patch));
    let color = representative_color(&samples.iter().map(|(_, color)| *color).collect::<Vec<_>>())?;
    let x = overlays.viewport_width / f64::from(after.client.right - after.client.left);
    let y = overlays.viewport_height / f64::from(after.client.bottom - after.client.top);
    Some(EnvironmentColor {
        color,
        patches: samples
            .into_iter()
            .map(|(r, _)| EnvironmentRect {
                left: f64::from(r.left - after.client.left) * x,
                top: f64::from(r.top - after.client.top) * y,
                width: f64::from(r.right - r.left) * x,
                height: f64::from(r.bottom - r.top) * y,
            })
            .collect(),
        viewport_width: overlays.viewport_width,
        viewport_height: overlays.viewport_height,
    })
}

fn linear(value: u8) -> f64 {
    let value = f64::from(value) / 255.0;
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

fn srgb(value: f64) -> u8 {
    let value = if value <= 0.0031308 {
        value * 12.92
    } else {
        1.055 * value.powf(1.0 / 2.4) - 0.055
    };
    (value * 255.0).round().clamp(0.0, 255.0) as u8
}

fn representative_color(patches: &[[f64; 3]]) -> Option<String> {
    if patches.is_empty()
        || patches
            .iter()
            .flatten()
            .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        return None;
    }
    let mut rgb = [0; 3];
    for channel in 0..3 {
        let mut values: Vec<_> = patches.iter().map(|pixel| pixel[channel]).collect();
        values.sort_by(f64::total_cmp);
        // Ignore one extreme patch at either end, so a tiny bright button or
        // dark text fragment does not make the entire character flash.
        let trim = usize::from(values.len() >= 5);
        let values = &values[trim..values.len() - trim];
        rgb[channel] = srgb(values.iter().sum::<f64>() / values.len() as f64);
    }
    Some(format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2]))
}

#[cfg(not(windows))]
fn sample_window(
    _window: &tauri::WebviewWindow,
    _overlays: &EnvironmentOverlays,
) -> Option<EnvironmentColor> {
    None
}

#[cfg(windows)]
fn sample_window(
    window: &tauri::WebviewWindow,
    overlays: &EnvironmentOverlays,
) -> Option<EnvironmentColor> {
    windows::sample(window, overlays)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        ffi::c_void,
        mem::{size_of, zeroed},
        ptr::null_mut,
    };
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, POINT, RECT},
        Graphics::Gdi::{
            BitBlt, ClientToScreen, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject,
            EnumDisplayMonitors, GdiFlush, GetDC, ReleaseDC, SelectObject, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, HMONITOR,
            SRCCOPY,
        },
        System::StationsAndDesktops::{
            CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS,
            UOI_NAME,
        },
        UI::WindowsAndMessaging::GetClientRect,
    };

    fn input_desktop_is_available() -> bool {
        unsafe {
            let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
            if desktop.is_null() {
                return false;
            }
            let mut name = [0u16; 64];
            let mut needed = 0;
            let success = GetUserObjectInformationW(
                desktop,
                UOI_NAME,
                name.as_mut_ptr().cast(),
                size_of::<[u16; 64]>() as u32,
                &mut needed,
            ) != 0;
            CloseDesktop(desktop);
            let end = name
                .iter()
                .position(|item| *item == 0)
                .unwrap_or(name.len());
            success && String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("default")
        }
    }

    unsafe extern "system" fn collect_monitor(
        _monitor: HMONITOR,
        _dc: HDC,
        rect: *mut RECT,
        data: LPARAM,
    ) -> i32 {
        if rect.is_null() {
            return 1;
        }
        let monitors = &mut *(data as *mut Vec<Rect>);
        if monitors.len() >= 64 {
            return 0;
        }
        monitors.push(Rect {
            left: (*rect).left,
            top: (*rect).top,
            right: (*rect).right,
            bottom: (*rect).bottom,
        });
        1
    }

    struct Capture {
        screen: HDC,
        memory: HDC,
        bitmap: HBITMAP,
        previous: HGDIOBJ,
        bits: *mut c_void,
    }

    impl Drop for Capture {
        fn drop(&mut self) {
            unsafe {
                if !self.previous.is_null() {
                    SelectObject(self.memory, self.previous);
                }
                if !self.bitmap.is_null() {
                    DeleteObject(self.bitmap);
                }
                if !self.memory.is_null() {
                    DeleteDC(self.memory);
                }
                if !self.screen.is_null() {
                    ReleaseDC(null_mut(), self.screen);
                }
            }
        }
    }

    impl Capture {
        fn new() -> Option<Self> {
            unsafe {
                let mut result = Self {
                    screen: GetDC(null_mut()),
                    memory: null_mut(),
                    bitmap: null_mut(),
                    previous: null_mut(),
                    bits: null_mut(),
                };
                if result.screen.is_null() {
                    return None;
                }
                result.memory = CreateCompatibleDC(result.screen);
                if result.memory.is_null() {
                    return None;
                }
                let mut info: BITMAPINFO = zeroed();
                info.bmiHeader = BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: PATCH_SIZE,
                    biHeight: -(PATCH_SIZE * 8),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    ..zeroed()
                };
                result.bitmap = CreateDIBSection(
                    result.screen,
                    &info,
                    DIB_RGB_COLORS,
                    &mut result.bits,
                    null_mut(),
                    0,
                );
                if result.bitmap.is_null() || result.bits.is_null() {
                    return None;
                }
                result.previous = SelectObject(result.memory, result.bitmap);
                if result.previous.is_null() || result.previous as isize == -1 {
                    result.previous = null_mut();
                    return None;
                }
                Some(result)
            }
        }

        fn colors(&self, patches: &[Rect]) -> Vec<(Rect, [f64; 3])> {
            let mut copied = Vec::new();
            for (index, rect) in patches.iter().take(8).enumerate() {
                let width = rect.right - rect.left;
                let height = rect.bottom - rect.top;
                // This is the only screen read: at most eight 12x12 patches.
                let success = unsafe {
                    BitBlt(
                        self.memory,
                        0,
                        index as i32 * PATCH_SIZE,
                        width,
                        height,
                        self.screen,
                        rect.left,
                        rect.top,
                        SRCCOPY | CAPTUREBLT,
                    ) != 0
                };
                if success {
                    copied.push((index, *rect));
                }
            }
            if unsafe { GdiFlush() } == 0 {
                return Vec::new();
            }
            let pixels = unsafe {
                std::slice::from_raw_parts(
                    self.bits.cast::<u8>(),
                    (PATCH_SIZE * PATCH_SIZE * 8 * 4) as usize,
                )
            };
            copied
                .into_iter()
                .map(|(index, rect)| {
                    let width = (rect.right - rect.left) as usize;
                    let height = (rect.bottom - rect.top) as usize;
                    let mut sum = [0.0; 3];
                    for y in 0..height {
                        for x in 0..width {
                            let offset =
                                ((index * PATCH_SIZE as usize + y) * PATCH_SIZE as usize + x) * 4;
                            for channel in 0..3 {
                                sum[channel] += linear(pixels[offset + 2 - channel]);
                            }
                        }
                    }
                    (rect, sum.map(|channel| channel / (width * height) as f64))
                })
                .collect()
        }
    }

    fn client_rect(hwnd: HWND) -> Option<Rect> {
        unsafe {
            let mut size: RECT = zeroed();
            let mut origin: POINT = zeroed();
            if GetClientRect(hwnd, &mut size) == 0 || ClientToScreen(hwnd, &mut origin) == 0 {
                return None;
            }
            let rect = Rect {
                left: origin.x,
                top: origin.y,
                right: origin.x.checked_add(size.right)?,
                bottom: origin.y.checked_add(size.bottom)?,
            };
            rect.valid_size().then_some(rect)
        }
    }

    pub(super) fn sample(
        window: &tauri::WebviewWindow,
        overlays: &EnvironmentOverlays,
    ) -> Option<EnvironmentColor> {
        if !input_desktop_is_available() {
            return None;
        }
        let hwnd = window.hwnd().ok()?.0;
        let state = window.state::<crate::hit_test::HitTestState>();
        let before = scene_geometry(state.environment_bounds()?, overlays, client_rect(hwnd)?)?;
        unsafe {
            let mut monitors: Vec<Rect> = Vec::new();
            if EnumDisplayMonitors(
                null_mut(),
                std::ptr::null(),
                Some(collect_monitor),
                &mut monitors as *mut Vec<Rect> as LPARAM,
            ) == 0
            {
                return None;
            }
            let patches =
                surrounding_patches(before.model, before.client, &monitors, &before.excluded);
            if patches.is_empty() {
                return None;
            }
            let capture = Capture::new()?;
            let samples = capture.colors(&patches);
            let after = scene_geometry(state.environment_bounds()?, overlays, client_rect(hwnd)?)?;
            if !input_desktop_is_available() {
                return None;
            }
            finish_sample(samples, &before, &after, overlays)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect {
            left,
            top,
            right,
            bottom,
        }
    }

    fn patches_around(model: Rect, monitors: &[Rect]) -> Vec<Rect> {
        surrounding_patches(model, rect(-10000, -10000, 10000, 10000), monitors, &[])
    }

    fn overlays(regions: Vec<EnvironmentRect>) -> EnvironmentOverlays {
        EnvironmentOverlays {
            viewport_width: 800.0,
            viewport_height: 1200.0,
            regions,
        }
    }

    fn bounds() -> EnvironmentBounds {
        EnvironmentBounds {
            left: 300.0,
            top: 400.0,
            width: 200.0,
            height: 400.0,
            viewport_width: 800.0,
            viewport_height: 1200.0,
        }
    }

    #[test]
    fn overlay_input_only_accepts_bounded_local_exclusions() {
        let good = EnvironmentRect {
            left: 10.0,
            top: 20.0,
            width: 30.0,
            height: 40.0,
        };
        assert!(overlays(vec![good; 40]).validate().is_ok());
        assert!(overlays(vec![good; 41]).validate().is_err());
        for bad in [
            EnvironmentRect { left: -1.0, ..good },
            EnvironmentRect {
                top: f64::NAN,
                ..good
            },
            EnvironmentRect { width: 0.0, ..good },
            EnvironmentRect {
                height: f64::INFINITY,
                ..good
            },
            EnvironmentRect {
                left: 799.0,
                ..good
            },
            EnvironmentRect {
                top: 1199.0,
                ..good
            },
        ] {
            assert!(overlays(vec![bad]).validate().is_err());
        }
        let mut invalid = overlays(vec![]);
        invalid.viewport_width = 0.0;
        assert!(invalid.validate().is_err());
        for json in [
            r#"{"viewportWidth":800,"viewportHeight":1200,"regions":[],"screenX":10}"#,
            r#"{"viewportWidth":800,"viewportHeight":1200,"regions":[{"left":0,"top":0,"width":1,"height":1,"color":"red"}]}"#,
        ] {
            assert!(serde_json::from_str::<EnvironmentOverlays>(json).is_err());
        }
    }

    #[test]
    fn nearby_patches_are_inside_client_and_avoid_visible_noninteractive_ui() {
        let client = rect(0, 0, 800, 1200);
        let model = rect(300, 400, 500, 800);
        let all = surrounding_patches(model, client, &[client], &[]);
        assert_eq!(all.len(), 8);
        assert!(all.iter().all(|r| r.intersection(client) == Some(*r)));
        // A plain text bubble and debug panel exclude samples despite not being clickable.
        let excluded = [rect(300, 350, 500, 395), rect(505, 450, 550, 750)];
        let safe = surrounding_patches(model, client, &[client], &excluded);
        assert_eq!(safe.len(), 4);
        assert!(safe
            .iter()
            .all(|r| excluded.iter().all(|e| r.intersection(*e).is_none())));
        assert!(safe
            .iter()
            .all(|r| (r.right - r.left) * (r.bottom - r.top) <= 144));
    }

    #[test]
    fn previous_debug_frame_edges_cannot_contaminate_new_patch_centers() {
        let client = rect(0, 0, 800, 1200);
        let model = rect(300, 400, 500, 800);
        let patch = surrounding_patches(model, client, &[client], &[])[0];
        // Prior hollow frame around this sample with a six-pixel empty gap.
        let edges = [
            rect(
                patch.left - 8,
                patch.top - 8,
                patch.right + 8,
                patch.top - 6,
            ),
            rect(
                patch.left - 8,
                patch.bottom + 6,
                patch.right + 8,
                patch.bottom + 8,
            ),
            rect(
                patch.left - 8,
                patch.top - 6,
                patch.left - 6,
                patch.bottom + 6,
            ),
            rect(
                patch.right + 6,
                patch.top - 6,
                patch.right + 8,
                patch.bottom + 6,
            ),
        ];
        assert!(surrounding_patches(model, client, &[client], &edges).contains(&patch));
        let moved = rect(307, 400, 507, 800);
        let shifted = surrounding_patches(moved, client, &[client], &[])[0];
        assert!(edges.iter().any(|e| shifted.intersection(*e).is_some()));
        assert!(!surrounding_patches(moved, client, &[client], &edges).contains(&shifted));
    }

    #[test]
    fn physical_sampling_and_returned_css_geometry_follow_client_dpi() {
        let overlays = overlays(vec![]);
        for dpi in [1.0, 1.25, 1.5, 1.75, 2.0] {
            let client = rect(
                -400,
                100,
                -400 + (800.0 * dpi) as i32,
                100 + (1200.0 * dpi) as i32,
            );
            let scene = scene_geometry(bounds(), &overlays, client).unwrap();
            assert_eq!(scene.model.left, -400 + (300.0 * dpi) as i32);
            let patches = surrounding_patches(scene.model, client, &[client], &[]);
            let result = finish_sample(
                patches.iter().map(|r| (*r, [0.5; 3])).collect(),
                &scene,
                &scene,
                &overlays,
            )
            .unwrap();
            assert_eq!(result.patches.len(), 8);
            assert_eq!(result.viewport_width, 800.0);
            for (physical, css) in patches.iter().zip(result.patches) {
                assert!(
                    (css.left * dpi + f64::from(client.left) - f64::from(physical.left)).abs()
                        < 1e-8
                );
                assert!((css.width * dpi - 12.0).abs() < 1e-8);
            }
        }
        let mut stale = bounds();
        stale.viewport_width = 799.0;
        assert!(scene_geometry(stale, &overlays, rect(0, 0, 800, 1200)).is_none());
    }

    #[test]
    fn moving_ui_and_model_use_swept_bounds_and_resize_drops_result() {
        let overlays = overlays(vec![]);
        let before = scene_geometry(bounds(), &overlays, rect(0, 0, 800, 1200)).unwrap();
        let samples: Vec<_> =
            surrounding_patches(before.model, before.client, &[before.client], &[])
                .into_iter()
                .map(|r| (r, [0.5; 3]))
                .collect();
        let after = scene_geometry(bounds(), &overlays, rect(40, 20, 840, 1220)).unwrap();
        let result = finish_sample(samples.clone(), &before, &after, &overlays).unwrap();
        assert_eq!(result.patches.len(), 4);
        let resized = scene_geometry(bounds(), &overlays, rect(0, 0, 900, 1200)).unwrap();
        assert!(finish_sample(samples.clone(), &before, &resized, &overlays).is_none());
        let target = samples[0].0;
        let old_ui = rect(
            target.left - 50,
            target.top,
            target.left - 30,
            target.bottom,
        );
        let new_ui = rect(
            target.right + 30,
            target.top,
            target.right + 50,
            target.bottom,
        );
        let mut before_ui = scene_geometry(bounds(), &overlays, before.client).unwrap();
        let mut after_ui = scene_geometry(bounds(), &overlays, before.client).unwrap();
        before_ui.excluded.push(old_ui);
        after_ui.excluded.push(new_ui);
        let result = finish_sample(samples, &before_ui, &after_ui, &overlays).unwrap();
        assert!(!result
            .patches
            .iter()
            .any(|r| r.left == f64::from(target.left) && r.top == f64::from(target.top)));
    }

    #[test]
    fn patches_stay_outside_pet_and_within_real_monitors() {
        let window = rect(-200, 100, 100, 500);
        let monitors = [rect(-1920, 0, 0, 1080), rect(0, 200, 1920, 1280)];
        let patches = patches_around(window, &monitors);
        assert!(patches.len() >= 6);
        for patch in patches {
            assert!(patch.intersection(window).is_none());
            assert!(monitors
                .iter()
                .any(|monitor| patch.intersection(*monitor) == Some(patch)));
            assert!((1..=PATCH_SIZE).contains(&(patch.right - patch.left)));
            assert!((1..=PATCH_SIZE).contains(&(patch.bottom - patch.top)));
        }
    }

    #[test]
    fn edge_offscreen_and_invalid_geometry_do_not_capture_virtual_gaps() {
        let monitor = [rect(0, 0, 1920, 1080)];
        assert!(patches_around(rect(2100, 100, 2400, 500), &monitor).is_empty());
        assert!(patches_around(rect(10, 10, 0, 500), &monitor).is_empty());
        assert!(patches_around(rect(i32::MIN, 0, i32::MAX, 1), &monitor).is_empty());
        let patches = patches_around(rect(-50, -50, 100, 200), &monitor);
        assert!(!patches.is_empty());
        assert!(patches
            .iter()
            .all(|patch| patch.left >= 0 && patch.top >= 0));
        assert!(patches_around(rect(0, 0, 1920, 1080), &monitor).is_empty());
    }

    #[test]
    fn stationary_and_small_movements_preserve_every_sample() {
        let before = rect(300, 300, 500, 600);
        let samples: Vec<_> = patches_around(before, &[rect(0, 0, 1600, 1200)])
            .into_iter()
            .enumerate()
            .map(|(index, patch)| (patch, [index as f64 / 16.0; 3]))
            .collect();
        assert_eq!(samples.len(), 8);
        for (dx, dy) in [(0, 0), (1, 0), (-1, -1), (7, 7), (8, -8)] {
            let after = rect(300 + dx, 300 + dy, 500 + dx, 600 + dy);
            let mut retained = samples.clone();
            retain_uncovered_patches(&mut retained, before, after);
            assert_eq!(retained, samples, "movement ({dx}, {dy})");
        }
    }

    #[test]
    fn directional_and_diagonal_movements_keep_only_uncovered_samples() {
        let before = rect(500, 500, 700, 800);
        let samples: Vec<_> = patches_around(before, &[rect(0, 0, 1800, 1600)])
            .into_iter()
            .enumerate()
            .map(|(index, patch)| (patch, [index as f64 / 16.0; 3]))
            .collect();
        for (dx, dy, count) in [
            (350, 0, 6),
            (-350, 0, 6),
            (0, 420, 6),
            (0, -420, 6),
            (350, 420, 4),
            (-350, 420, 4),
            (350, -420, 4),
            (-350, -420, 4),
        ] {
            let after = rect(500 + dx, 500 + dy, 700 + dx, 800 + dy);
            let mut retained = samples.clone();
            retain_uncovered_patches(&mut retained, before, after);
            assert_eq!(retained.len(), count, "movement ({dx}, {dy})");
            for sample in &retained {
                assert!(samples.contains(sample), "keep each patch's own color");
                for step in 0..=20 {
                    let x = dx * step / 20;
                    let y = dy * step / 20;
                    assert!(sample
                        .0
                        .intersection(rect(500 + x, 500 + y, 700 + x, 800 + y))
                        .is_none());
                }
            }
            // A large jump can cross a patch without either endpoint covering
            // it. Checking only the two endpoint rectangles would keep it.
            assert!(samples.iter().any(|sample| {
                sample.0.intersection(after).is_none() && !retained.contains(sample)
            }));
        }
    }

    #[test]
    fn skipped_capture_patches_do_not_shift_color_associations() {
        let before = rect(300, 300, 500, 600);
        let patches = patches_around(before, &[rect(0, 0, 1600, 1200)]);
        // Simulate failed reads at other indices. Only the successful left-side
        // patch remains safe when the window moves down and right.
        let expected = (patches[2], [44, 116, 204].map(linear));
        let mut samples = vec![(patches[1], [1.0; 3]), expected, (patches[7], [0.0; 3])];
        retain_uncovered_patches(&mut samples, before, rect(650, 720, 850, 1020));
        assert_eq!(samples, vec![expected]);
        assert_eq!(representative_color(&[samples[0].1]).unwrap(), "#2c74cc");
    }

    #[test]
    fn invalid_or_fully_covering_after_rectangles_leave_no_color() {
        let before = rect(300, 300, 500, 600);
        let samples: Vec<_> = patches_around(before, &[rect(0, 0, 1600, 1200)])
            .into_iter()
            .map(|patch| (patch, [0.5; 3]))
            .collect();
        for after in [
            rect(0, 0, 0, 0),
            rect(1, 1, 0, 0),
            rect(i32::MIN, 0, i32::MAX, 1),
            rect(200, 200, 700, 800),
        ] {
            let mut retained = samples.clone();
            retain_uncovered_patches(&mut retained, before, after);
            assert!(retained.is_empty());
            let colors: Vec<_> = retained.into_iter().map(|(_, color)| color).collect();
            assert!(representative_color(&colors).is_none());
        }
    }

    #[test]
    fn uniform_color_survives_linear_reduction_and_outliers_are_trimmed() {
        let rgb = [44, 116, 204].map(linear);
        let mut samples = vec![rgb; 6];
        samples.extend([[0.0; 3], [1.0; 3]]);
        assert_eq!(representative_color(&samples).unwrap(), "#2c74cc");
        assert_eq!(
            representative_color(&[[0.0; 3], [1.0; 3]]).unwrap(),
            "#bcbcbc"
        );
        assert!(representative_color(&[]).is_none());
        assert!(representative_color(&[[f64::NAN; 3]]).is_none());
    }

    #[test]
    fn rate_limit_survives_geometry_changes_and_disable_reenable() {
        let state = EnvironmentSamplingState::default();
        assert!(!state.enabled.load(Ordering::SeqCst));
        let mut preferences = crate::settings::DesktopPreferences {
            environment_lighting_enabled: true,
            ..Default::default()
        };
        state.configure(&preferences);
        assert!(state.enabled.load(Ordering::SeqCst));
        let now = Instant::now();
        *state.cache.lock().unwrap() = SampleCache {
            sampled_at: Some(now),
        };
        assert!(state
            .cache
            .lock()
            .unwrap()
            .fresh(now + Duration::from_millis(249)));
        assert!(!state
            .cache
            .lock()
            .unwrap()
            .fresh(now + Duration::from_millis(250)));
        let generation = state.generation.load(Ordering::SeqCst);
        preferences.environment_lighting_strength = 0.0;
        state.configure(&preferences);
        assert!(!state.enabled.load(Ordering::SeqCst));
        assert!(state.generation.load(Ordering::SeqCst) > generation);
        assert!(state
            .cache
            .lock()
            .unwrap()
            .fresh(now + Duration::from_millis(249)));
        preferences.environment_lighting_strength = 1.0;
        state.configure(&preferences);
        assert!(state
            .cache
            .lock()
            .unwrap()
            .fresh(now + Duration::from_millis(249)));
    }
}
