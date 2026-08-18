use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationMappings {
    pub idle: String,
    pub thinking: Option<String>,
    pub working: Option<String>,
    pub completed: Option<String>,
    pub error: Option<String>,
    pub blocked: Option<String>,
    pub approval: Option<String>,
    pub click: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPreferences {
    pub fps: u16,
    pub max_device_pixel_ratio: f64,
    pub scale: f64,
    pub privacy_mode: bool,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            fps: 60,
            max_device_pixel_ratio: 1.5,
            scale: 1.0,
            privacy_mode: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub model_path: String,
    pub source_sha256: String,
    pub animations: Vec<Value>,
    pub mappings: AnimationMappings,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub schema_version: u32,
    pub preferences: DesktopPreferences,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<InstalledModel>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            preferences: DesktopPreferences::default(),
            model: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInstallRequest {
    pub source_path: String,
    pub mappings: AnimationMappings,
    pub preferences: DesktopPreferences,
}

pub fn validate_preferences(preferences: &DesktopPreferences) -> Result<(), String> {
    if preferences.fps != 30 && preferences.fps != 60 {
        return Err("frame rate must be 30 or 60".into());
    }
    if !preferences.max_device_pixel_ratio.is_finite()
        || !(1.0..=1.5).contains(&preferences.max_device_pixel_ratio)
    {
        return Err("device pixel ratio limit must be between 1 and 1.5".into());
    }
    if !preferences.scale.is_finite() || !(0.25..=3.0).contains(&preferences.scale) {
        return Err("model scale must be between 0.25 and 3".into());
    }
    Ok(())
}

pub fn validate_mappings(mappings: &AnimationMappings, animations: &[Value]) -> Result<(), String> {
    let names = animation_names(animations)?;
    if mappings.idle.is_empty() {
        return Err("Idle animation is required".into());
    }
    for (state, value) in [
        ("Idle", Some(&mappings.idle)),
        ("Thinking", mappings.thinking.as_ref()),
        ("Working", mappings.working.as_ref()),
        ("Completed", mappings.completed.as_ref()),
        ("Error", mappings.error.as_ref()),
        ("Blocked", mappings.blocked.as_ref()),
        ("Approval", mappings.approval.as_ref()),
        ("Click", mappings.click.as_ref()),
    ] {
        if let Some(name) = value {
            if name.is_empty() || !names.contains(name.as_str()) {
                return Err(format!("{state} animation does not exist in the model"));
            }
        }
    }
    Ok(())
}

pub fn load(app: &AppHandle) -> DesktopSettings {
    let Ok(path) = settings_path(app) else {
        return DesktopSettings::default();
    };
    let Ok(bytes) = fs::read(path) else {
        return DesktopSettings::default();
    };
    if bytes.len() > 4 * 1024 * 1024 {
        return DesktopSettings::default();
    }
    let Ok(settings) = serde_json::from_slice::<DesktopSettings>(&bytes) else {
        return DesktopSettings::default();
    };
    if settings.schema_version != SETTINGS_SCHEMA_VERSION
        || validate_preferences(&settings.preferences).is_err()
        || settings
            .model
            .as_ref()
            .is_some_and(|model| validate_mappings(&model.mappings, &model.animations).is_err())
    {
        return DesktopSettings::default();
    }
    settings
}

pub fn store(app: &AppHandle, settings: &DesktopSettings) -> Result<(), String> {
    validate_preferences(&settings.preferences)?;
    if let Some(model) = &settings.model {
        validate_mappings(&model.mappings, &model.animations)?;
    }
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    let mut file = AtomicWriteFile::open(path).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    file.commit().map_err(|error| error.to_string())
}

pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("models"))
        .map_err(|error| error.to_string())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("settings.json"))
        .map_err(|error| error.to_string())
}

fn animation_names(animations: &[Value]) -> Result<HashSet<&str>, String> {
    animations
        .iter()
        .map(|animation| {
            animation
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| "model animation metadata is invalid".to_owned())
        })
        .collect()
}

pub fn path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "model path cannot be represented as Unicode".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mappings(idle: &str) -> AnimationMappings {
        AnimationMappings {
            idle: idle.into(),
            thinking: None,
            working: None,
            completed: None,
            error: None,
            blocked: None,
            approval: None,
            click: None,
        }
    }

    #[test]
    fn mapping_names_are_exact_and_idle_is_required() {
        let animations = vec![serde_json::json!({ "name": "Idle" })];
        assert!(validate_mappings(&mappings("Idle"), &animations).is_ok());
        assert!(validate_mappings(&mappings("idle"), &animations).is_err());
        assert!(validate_mappings(&mappings(""), &animations).is_err());
    }

    #[test]
    fn preference_limits_are_enforced() {
        assert!(validate_preferences(&DesktopPreferences::default()).is_ok());
        let invalid = DesktopPreferences {
            fps: 120,
            ..DesktopPreferences::default()
        };
        assert!(validate_preferences(&invalid).is_err());
    }
}
