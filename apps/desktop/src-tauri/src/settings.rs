use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub const SETTINGS_SCHEMA_VERSION: u32 = 3;

#[derive(Default)]
pub struct SettingsWriteState(Mutex<()>);

pub fn with_write<T>(
    app: &AppHandle,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<SettingsWriteState>();
    let _guard = state.0.lock().map_err(|_| "模型设置忙，请重试。")?;
    operation()
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelBackend {
    Inochi2d,
    #[default]
    Vrm,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationSource {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InochiModelData {
    pub animations: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VrmModelData {
    pub animations: Vec<AnimationSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationMappings {
    pub idle: String,
    pub working: Option<String>,
    pub completed: Option<String>,
    pub error: Option<String>,
    pub blocked: Option<String>,
    pub approval: Option<String>,
    #[serde(default, deserialize_with = "deserialize_animation_pool")]
    pub click: Vec<String>,
    #[serde(default)]
    pub ambient: Vec<String>,
}

fn deserialize_animation_pool<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<String>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::Null => Ok(Vec::new()),
        Value::String(name) => Ok(vec![name]),
        value => serde_json::from_value(value).map_err(serde::de::Error::custom),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPreferences {
    #[serde(default = "enabled_by_default")]
    pub model_enabled: bool,
    pub fps: u16,
    pub max_device_pixel_ratio: f64,
    pub scale: f64,
    pub privacy_mode: bool,
    #[serde(default)]
    pub bubble_mode: BubbleMode,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BubbleMode {
    #[default]
    Compact,
    Detailed,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            model_enabled: true,
            fps: 30,
            max_device_pixel_ratio: 1.5,
            scale: 1.0,
            privacy_mode: false,
            bubble_mode: BubbleMode::Compact,
        }
    }
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLicense {
    pub title: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub backend: ModelBackend,
    pub model_path: String,
    pub source_sha256: String,
    pub animations: Vec<Value>,
    pub mappings: AnimationMappings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inochi2d: Option<InochiModelData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vrm: Option<VrmModelData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<ModelLicense>,
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
    #[serde(default)]
    pub backend: ModelBackend,
    pub source_path: String,
    #[serde(default)]
    pub animation_sources: Vec<AnimationSource>,
    pub profile_path: Option<String>,
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
        ("Working", mappings.working.as_ref()),
        ("Completed", mappings.completed.as_ref()),
        ("Error", mappings.error.as_ref()),
        ("Blocked", mappings.blocked.as_ref()),
        ("Approval", mappings.approval.as_ref()),
    ] {
        if let Some(name) = value {
            if name.is_empty() || !names.contains(name.as_str()) {
                return Err(format!("{state} animation does not exist in the model"));
            }
        }
    }
    for (state, pool) in [("Click", &mappings.click), ("Ambient", &mappings.ambient)] {
        let unique: HashSet<_> = pool.iter().collect();
        if pool.len() > 20
            || unique.len() != pool.len()
            || pool
                .iter()
                .any(|name| name.is_empty() || !names.contains(name.as_str()))
        {
            return Err(format!(
                "{state} pool must contain distinct available animations (at most 20)"
            ));
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
    let Ok(settings) = decode_settings(&bytes) else {
        return DesktopSettings::default();
    };
    settings
}

pub fn inochi_catalog(animations: &[Value]) -> Result<Vec<Value>, String> {
    animations
        .iter()
        .map(|clip| {
            let name = clip
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .ok_or("invalid animation name")?;
            let duration = clip
                .get("timestepMs")
                .and_then(Value::as_f64)
                .ok_or("invalid animation timestep")?
                * clip
                    .get("length")
                    .and_then(Value::as_f64)
                    .ok_or("invalid animation length")?;
            if !duration.is_finite() || duration < 0.0 {
                return Err("invalid animation duration".into());
            }
            Ok(serde_json::json!({"name":name,"durationMs":duration}))
        })
        .collect()
}

fn validate_model(model: &InstalledModel) -> Result<(), String> {
    if let Some(license) = &model.license {
        if license.title.trim().is_empty()
            || license.title.chars().count() > 128
            || license.title.chars().any(char::is_control)
            || license.text.trim().is_empty()
            || license.text.len() > 256 * 1024
            || license.text.contains('\0')
        {
            return Err("invalid model license".into());
        }
    }
    validate_mappings(&model.mappings, &model.animations)?;
    let names = animation_names(&model.animations)?;
    if names.len() != model.animations.len()
        || model.animations.iter().any(|item| {
            item["durationMs"]
                .as_f64()
                .is_none_or(|n| !n.is_finite() || n < 0.0)
        })
    {
        return Err("invalid animation catalog".into());
    }
    match (model.backend, &model.inochi2d, &model.vrm) {
        (ModelBackend::Inochi2d, Some(data), None) => {
            if inochi_catalog(&data.animations)? != model.animations {
                return Err("Inochi2D catalog mismatch".into());
            }
        }
        (ModelBackend::Vrm, None, Some(data)) => {
            let resource_names: HashSet<_> = data
                .animations
                .iter()
                .map(|item| item.name.as_str())
                .collect();
            if data.animations.len() != names.len()
                || resource_names != names
                || data
                    .animations
                    .iter()
                    .any(|item| item.path.is_empty() || !names.contains(item.name.as_str()))
            {
                return Err("VRM catalog mismatch".into());
            }
        }
        _ => return Err("model backend data mismatch".into()),
    }
    Ok(())
}

pub fn decode_settings(bytes: &[u8]) -> Result<DesktopSettings, String> {
    let mut value: Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let version = value.get("schemaVersion").and_then(Value::as_u64);
    if value.get("schemaVersion").and_then(Value::as_u64) == Some(1) {
        if let Some(model) = value.get_mut("model").filter(|model| !model.is_null()) {
            let clips = model
                .get("animations")
                .and_then(Value::as_array)
                .ok_or("missing legacy animations")?
                .clone();
            model["animations"] = Value::Array(inochi_catalog(&clips)?);
            model["backend"] = Value::String("inochi2d".into());
            model["inochi2d"] = serde_json::json!({"animations":clips});
        }
    }
    if matches!(version, Some(1 | 2)) {
        if let Some(mappings) = value
            .get_mut("model")
            .and_then(|model| model.get_mut("mappings"))
        {
            if mappings.get("working").is_none_or(Value::is_null) {
                mappings["working"] = mappings.get("thinking").cloned().unwrap_or(Value::Null);
            }
            if let Some(object) = mappings.as_object_mut() {
                object.remove("thinking");
            }
        }
        value["schemaVersion"] = SETTINGS_SCHEMA_VERSION.into();
    }
    let settings: DesktopSettings =
        serde_json::from_value(value).map_err(|error| error.to_string())?;
    if settings.schema_version != SETTINGS_SCHEMA_VERSION {
        return Err("unsupported settings version".into());
    }
    validate_preferences(&settings.preferences)?;
    if let Some(model) = &settings.model {
        validate_model(model)?;
    }
    Ok(settings)
}

pub fn store(app: &AppHandle, settings: &DesktopSettings) -> Result<(), String> {
    validate_preferences(&settings.preferences)?;
    if settings.schema_version != SETTINGS_SCHEMA_VERSION {
        return Err("unsupported settings version".into());
    }
    if let Some(model) = &settings.model {
        validate_model(model)?;
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
            working: None,
            completed: None,
            error: None,
            blocked: None,
            approval: None,
            click: vec![],
            ambient: vec![],
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
    fn version_one_migrates_model_mapping_and_preferences() {
        let old = serde_json::json!({"schemaVersion":1,"preferences":{"fps":60,"maxDevicePixelRatio":1.25,"scale":0.8,"privacyMode":true},"model":{"modelPath":"local/model.inp","sourceSha256":"source","animations":[{"name":"Idle","timestepMs":100,"length":10,"lanes":[]}],"mappings":{"idle":"Idle","thinking":null,"working":null,"completed":null,"error":null,"blocked":null,"approval":null,"click":null}}});
        let migrated = decode_settings(&serde_json::to_vec(&old).unwrap()).unwrap();
        assert_eq!(migrated.schema_version, 3);
        assert_eq!(migrated.preferences.fps, 60);
        assert!(migrated.preferences.privacy_mode);
        assert!(migrated.preferences.model_enabled);
        assert_eq!(migrated.preferences.bubble_mode, BubbleMode::Compact);
        let model = migrated.model.unwrap();
        assert_eq!(model.backend, ModelBackend::Inochi2d);
        assert_eq!(model.model_path, "local/model.inp");
        assert_eq!(model.mappings.idle, "Idle");
        assert_eq!(model.animations[0]["durationMs"].as_f64(), Some(1000.0));
        assert_eq!(
            model.inochi2d.unwrap().animations,
            old["model"]["animations"].as_array().unwrap().clone()
        );
    }

    #[test]
    fn version_two_merges_thinking_and_preserves_click() {
        let mut value = serde_json::to_value(DesktopSettings::default()).unwrap();
        value["schemaVersion"] = 2.into();
        value["model"] = serde_json::json!({"backend":"vrm","modelPath":"pet.vrm","sourceSha256":"source","animations":[{"name":"Idle","durationMs":1000},{"name":"Think","durationMs":1000}],"vrm":{"animations":[{"name":"Idle","path":"idle.vrma"},{"name":"Think","path":"think.vrma"}]},"mappings":{"idle":"Idle","thinking":"Think","working":null,"completed":null,"error":null,"blocked":null,"approval":null,"click":"Idle"}});
        let migrated = decode_settings(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(migrated.schema_version, 3);
        let mappings = migrated.model.unwrap().mappings;
        assert_eq!(mappings.working.as_deref(), Some("Think"));
        assert_eq!(mappings.click, vec!["Idle"]);
        assert!(mappings.ambient.is_empty());
        value["model"]["mappings"]["working"] = "Idle".into();
        assert_eq!(
            decode_settings(&serde_json::to_vec(&value).unwrap())
                .unwrap()
                .model
                .unwrap()
                .mappings
                .working
                .as_deref(),
            Some("Idle")
        );
    }

    #[test]
    fn pools_validate_every_name_and_reject_duplicates() {
        let animations = vec![
            serde_json::json!({"name":"Idle"}),
            serde_json::json!({"name":"Wave"}),
        ];
        let mut mapping = mappings("Idle");
        mapping.click = vec!["Idle".into(), "Wave".into()];
        assert!(validate_mappings(&mapping, &animations).is_ok());
        mapping.ambient = vec!["Missing".into()];
        assert!(validate_mappings(&mapping, &animations).is_err());
        mapping.ambient = vec!["Wave".into(), "Wave".into()];
        assert!(validate_mappings(&mapping, &animations).is_err());
    }

    #[test]
    fn rejects_unknown_settings_versions() {
        let mut value = serde_json::to_value(DesktopSettings::default()).unwrap();
        value["schemaVersion"] = 99.into();
        assert!(decode_settings(&serde_json::to_vec(&value).unwrap()).is_err());
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

    #[test]
    fn existing_preferences_default_to_compact_and_modes_are_closed() {
        let mut value = serde_json::to_value(DesktopSettings::default()).unwrap();
        value["preferences"]
            .as_object_mut()
            .unwrap()
            .remove("bubbleMode");
        assert_eq!(
            decode_settings(&serde_json::to_vec(&value).unwrap())
                .unwrap()
                .preferences
                .bubble_mode,
            BubbleMode::Compact
        );
        value["preferences"]["bubbleMode"] = "detailed".into();
        assert_eq!(
            decode_settings(&serde_json::to_vec(&value).unwrap())
                .unwrap()
                .preferences
                .bubble_mode,
            BubbleMode::Detailed
        );
        value["preferences"]["bubbleMode"] = "unknown".into();
        assert!(decode_settings(&serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn disabling_a_model_survives_reload_without_requiring_an_installed_model() {
        let mut current = DesktopSettings::default();
        current.preferences.model_enabled = false;
        let decoded = decode_settings(&serde_json::to_vec(&current).unwrap()).unwrap();
        assert!(!decoded.preferences.model_enabled);
        assert!(decoded.model.is_none());
        let mut legacy = serde_json::to_value(current).unwrap();
        legacy["preferences"]
            .as_object_mut()
            .unwrap()
            .remove("modelEnabled");
        legacy["preferences"]["fps"] = 60.into();
        let migrated = decode_settings(&serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(migrated.preferences.model_enabled);
        assert_eq!(migrated.preferences.fps, 60);
    }
}
