//! Optional, local-only sampling of small visible patches outside the pet window.
//! Pixels never leave this module: only an averaged RGB color reaches the webview.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Manager;

const SAMPLE_INTERVAL: Duration = Duration::from_millis(250);
const PATCH_SIZE: i32 = 12;
const PATCH_GAP: i32 = 8;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EnvironmentColor {
    color: String,
}

#[derive(Default)]
struct SampleCache {
    sampled_at: Option<Instant>,
    color: Option<EnvironmentColor>,
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
            if let Ok(mut cache) = self.cache.try_lock() {
                *cache = SampleCache::default();
            }
        }
    }
}

#[tauri::command]
pub async fn sample_environment_color(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<EnvironmentColor>, String> {
    if window.label() != "main" {
        return Err("environment sampling belongs to the pet window".into());
    }
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
            *cache = SampleCache::default();
            return None;
        }
        let now = Instant::now();
        if cache.fresh(now) {
            return cache.color.clone();
        }
        cache.sampled_at = Some(now);
        cache.color = sample_window(&window);
        // A disable during a native read must not publish its late result.
        if !state.enabled.load(Ordering::SeqCst)
            || state.generation.load(Ordering::SeqCst) != generation
        {
            cache.color = None;
        }
        cache.color.clone()
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

/// Clip against real monitor rectangles, not the virtual bounding box (which
/// can contain gaps). No requested patch overlaps the pet, its bubble or menu.
fn surrounding_patches(window: Rect, monitors: &[Rect]) -> Vec<Rect> {
    let width = i64::from(window.right) - i64::from(window.left);
    let height = i64::from(window.bottom) - i64::from(window.top);
    if !window.valid_size() {
        return Vec::new();
    }
    if !monitors
        .iter()
        .any(|monitor| window.intersection(*monitor).is_some())
    {
        return Vec::new();
    }
    let half = PATCH_SIZE / 2;
    let mut candidates = Vec::with_capacity(8);
    for numerator in [1, 3] {
        let x = window.left.saturating_add((width * numerator / 4) as i32);
        let y = window.top.saturating_add((height * numerator / 4) as i32);
        candidates.extend([
            (
                x.saturating_sub(half),
                window.top.saturating_sub(PATCH_GAP + PATCH_SIZE),
            ),
            (
                x.saturating_sub(half),
                window.bottom.saturating_add(PATCH_GAP),
            ),
            (
                window.left.saturating_sub(PATCH_GAP + PATCH_SIZE),
                y.saturating_sub(half),
            ),
            (
                window.right.saturating_add(PATCH_GAP),
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
            };
            if patch.intersection(window).is_some() {
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

fn representative_color(patches: &[[f64; 3]]) -> Option<EnvironmentColor> {
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
    Some(EnvironmentColor {
        color: format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2]),
    })
}

#[cfg(not(windows))]
fn sample_window(_window: &tauri::WebviewWindow) -> Option<EnvironmentColor> {
    None
}

#[cfg(windows)]
fn sample_window(window: &tauri::WebviewWindow) -> Option<EnvironmentColor> {
    windows::sample(window)
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
        Foundation::{LPARAM, RECT},
        Graphics::Gdi::{
            BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject,
            EnumDisplayMonitors, GdiFlush, GetDC, ReleaseDC, SelectObject, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, HMONITOR,
            SRCCOPY,
        },
        System::StationsAndDesktops::{
            CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS,
            UOI_NAME,
        },
        UI::WindowsAndMessaging::GetWindowRect,
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

    pub(super) fn sample(window: &tauri::WebviewWindow) -> Option<EnvironmentColor> {
        if !input_desktop_is_available() {
            return None;
        }
        let hwnd = window.hwnd().ok()?.0;
        unsafe {
            let mut before: RECT = zeroed();
            if GetWindowRect(hwnd, &mut before) == 0 {
                return None;
            }
            let window_rect = Rect {
                left: before.left,
                top: before.top,
                right: before.right,
                bottom: before.bottom,
            };
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
            let patches = surrounding_patches(window_rect, &monitors);
            if patches.is_empty() {
                return None;
            }
            let capture = Capture::new()?;
            let mut samples = capture.colors(&patches);
            let mut after: RECT = zeroed();
            if GetWindowRect(hwnd, &mut after) == 0 || !input_desktop_is_available() {
                return None;
            }
            retain_uncovered_patches(
                &mut samples,
                window_rect,
                Rect {
                    left: after.left,
                    top: after.top,
                    right: after.right,
                    bottom: after.bottom,
                },
            );
            representative_color(
                &samples
                    .into_iter()
                    .map(|(_, color)| color)
                    .collect::<Vec<_>>(),
            )
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

    #[test]
    fn patches_stay_outside_pet_and_within_real_monitors() {
        let window = rect(-200, 100, 100, 500);
        let monitors = [rect(-1920, 0, 0, 1080), rect(0, 200, 1920, 1280)];
        let patches = surrounding_patches(window, &monitors);
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
        assert!(surrounding_patches(rect(2100, 100, 2400, 500), &monitor).is_empty());
        assert!(surrounding_patches(rect(10, 10, 0, 500), &monitor).is_empty());
        assert!(surrounding_patches(rect(i32::MIN, 0, i32::MAX, 1), &monitor).is_empty());
        let patches = surrounding_patches(rect(-50, -50, 100, 200), &monitor);
        assert!(!patches.is_empty());
        assert!(patches
            .iter()
            .all(|patch| patch.left >= 0 && patch.top >= 0));
        assert!(surrounding_patches(rect(0, 0, 1920, 1080), &monitor).is_empty());
    }

    #[test]
    fn stationary_and_small_movements_preserve_every_sample() {
        let before = rect(300, 300, 500, 600);
        let samples: Vec<_> = surrounding_patches(before, &[rect(0, 0, 1600, 1200)])
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
        let samples: Vec<_> = surrounding_patches(before, &[rect(0, 0, 1800, 1600)])
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
        let patches = surrounding_patches(before, &[rect(0, 0, 1600, 1200)]);
        // Simulate failed reads at other indices. Only the successful left-side
        // patch remains safe when the window moves down and right.
        let expected = (patches[2], [44, 116, 204].map(linear));
        let mut samples = vec![(patches[1], [1.0; 3]), expected, (patches[7], [0.0; 3])];
        retain_uncovered_patches(&mut samples, before, rect(650, 720, 850, 1020));
        assert_eq!(samples, vec![expected]);
        assert_eq!(
            representative_color(&[samples[0].1]).unwrap().color,
            "#2c74cc"
        );
    }

    #[test]
    fn invalid_or_fully_covering_after_rectangles_leave_no_color() {
        let before = rect(300, 300, 500, 600);
        let samples: Vec<_> = surrounding_patches(before, &[rect(0, 0, 1600, 1200)])
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
        assert_eq!(representative_color(&samples).unwrap().color, "#2c74cc");
        assert_eq!(
            representative_color(&[[0.0; 3], [1.0; 3]]).unwrap().color,
            "#bcbcbc"
        );
        assert!(representative_color(&[]).is_none());
        assert!(representative_color(&[[f64::NAN; 3]]).is_none());
    }

    #[test]
    fn cache_rate_limit_and_disable_reset_do_not_keep_a_previous_color() {
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
            color: Some(EnvironmentColor {
                color: "#112233".into(),
            }),
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
        assert!(state.cache.lock().unwrap().color.is_none());
    }
}
