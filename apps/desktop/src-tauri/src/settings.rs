use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub const SETTINGS_SCHEMA_VERSION: u32 = 4;
pub const DEFAULT_MODEL_ID: &str = "weiguang-default";
const SETTINGS_LIMIT: usize = 4 * 1024 * 1024;

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
    #[serde(default)]
    pub embedded_animations: Vec<String>,
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
    pub fps: u16,
    pub max_device_pixel_ratio: f64,
    pub scale: f64,
    pub privacy_mode: bool,
    #[serde(default)]
    pub bubble_mode: BubbleMode,
    #[serde(default)]
    pub performance_overlay: bool,
    #[serde(default = "enabled_by_default")]
    pub bubbles_visible: bool,
    #[serde(default = "enabled_by_default")]
    pub pointer_enabled: bool,
}

fn enabled_by_default() -> bool {
    true
}

/// A quick-menu write only changes its named fields, never a stale UI snapshot.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferencesPatch {
    pub fps: Option<u16>,
    pub max_device_pixel_ratio: Option<f64>,
    pub scale: Option<f64>,
    pub privacy_mode: Option<bool>,
    pub bubble_mode: Option<BubbleMode>,
    pub performance_overlay: Option<bool>,
    pub bubbles_visible: Option<bool>,
    pub pointer_enabled: Option<bool>,
}

impl PreferencesPatch {
    pub fn apply(self, current: &DesktopPreferences) -> Result<DesktopPreferences, String> {
        let next = DesktopPreferences {
            fps: self.fps.unwrap_or(current.fps),
            max_device_pixel_ratio: self
                .max_device_pixel_ratio
                .unwrap_or(current.max_device_pixel_ratio),
            scale: self.scale.unwrap_or(current.scale),
            privacy_mode: self.privacy_mode.unwrap_or(current.privacy_mode),
            bubble_mode: self.bubble_mode.unwrap_or(current.bubble_mode),
            performance_overlay: self
                .performance_overlay
                .unwrap_or(current.performance_overlay),
            bubbles_visible: self.bubbles_visible.unwrap_or(current.bubbles_visible),
            pointer_enabled: self.pointer_enabled.unwrap_or(current.pointer_enabled),
        };
        validate_preferences(&next)?;
        Ok(next)
    }
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
            fps: 30,
            max_device_pixel_ratio: 1.5,
            scale: 1.0,
            privacy_mode: false,
            bubble_mode: BubbleMode::Compact,
            performance_overlay: false,
            bubbles_visible: true,
            pointer_enabled: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLicense {
    pub title: String,
    pub text: String,
}

/// Per-character calibration; omitted fields preserve the authored baseline.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelAdjustments {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle: Option<IdleAdjustments>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gaze: Option<GazeAdjustments>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdleAdjustments {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arm_lift_degrees: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub palm_twist_degrees: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hand_curl: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elbow_bend_degrees: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GazeAdjustments {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_strength: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eye_strength: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smoothing_ms: Option<f64>,
}

impl ModelAdjustments {
    fn is_empty(&self) -> bool {
        self.idle.as_ref().is_none_or(|idle| {
            idle.arm_lift_degrees.is_none()
                && idle.palm_twist_degrees.is_none()
                && idle.hand_curl.is_none()
                && idle.elbow_bend_degrees.is_none()
        }) && self.gaze.as_ref().is_none_or(|gaze| {
            gaze.head_strength.is_none()
                && gaze.eye_strength.is_none()
                && gaze.smoothing_ms.is_none()
        })
    }

    pub fn validate(&self) -> Result<(), String> {
        let idle = self.idle.clone().unwrap_or_default();
        let gaze = self.gaze.clone().unwrap_or_default();
        for (name, value, min, max) in [
            ("armLiftDegrees", idle.arm_lift_degrees, -30.0, 45.0),
            ("palmTwistDegrees", idle.palm_twist_degrees, -45.0, 45.0),
            ("handCurl", idle.hand_curl, 0.0, 1.0),
            ("elbowBendDegrees", idle.elbow_bend_degrees, -20.0, 45.0),
            ("headStrength", gaze.head_strength, 0.0, 2.0),
            ("eyeStrength", gaze.eye_strength, 0.0, 2.0),
            ("smoothingMs", gaze.smoothing_ms, 20.0, 1000.0),
        ] {
            if value.is_some_and(|value| !value.is_finite() || !(min..=max).contains(&value)) {
                return Err(format!("invalid model adjustment: {name}"));
            }
        }
        Ok(())
    }
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
pub struct LibraryModel {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adjustments: Option<ModelAdjustments>,
    #[serde(flatten)]
    pub data: InstalledModel,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub schema_version: u32,
    pub preferences: DesktopPreferences,
    pub models: Vec<LibraryModel>,
    pub active_model_id: Option<String>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            preferences: DesktopPreferences::default(),
            models: Vec::new(),
            active_model_id: Some(DEFAULT_MODEL_ID.into()),
        }
    }
}

impl DesktopSettings {
    pub fn active_model(&self) -> Option<&LibraryModel> {
        self.active_model_id
            .as_ref()
            .and_then(|id| self.models.iter().find(|model| &model.id == id))
    }

    pub fn select(&mut self, id: Option<String>) -> Result<(), String> {
        if let Some(id) = &id {
            let selected = self.models.iter().find(|model| &model.id == id);
            match selected {
                Some(model) if model.data.backend == ModelBackend::Vrm => {}
                None if id == DEFAULT_MODEL_ID => {}
                _ => return Err("请选择已导入的 VRM 模型。".into()),
            }
        }
        self.active_model_id = id;
        Ok(())
    }

    pub fn add_model(&mut self, model: LibraryModel) -> Result<(), String> {
        if self.models.iter().any(|item| item.id == model.id) {
            return Err("model identifier already exists".into());
        }
        let previous = self.active_model_id.replace(model.id.clone());
        self.models.push(model);
        if let Err(error) = validate_settings(self) {
            self.models.pop();
            self.active_model_id = previous;
            return Err(error);
        }
        Ok(())
    }

    pub fn set_model_adjustments(
        &mut self,
        id: &str,
        adjustments: ModelAdjustments,
    ) -> Result<(), String> {
        adjustments.validate()?;
        let model = self
            .models
            .iter_mut()
            .find(|model| model.id == id)
            .ok_or("没有找到该模型，请重新打开设置。")?;
        if model.data.backend != ModelBackend::Vrm {
            return Err("本版本仅支持调整 VRM 模型。".into());
        }
        model.adjustments = (!adjustments.is_empty()).then_some(adjustments);
        Ok(())
    }

    pub fn remove_model(&mut self, id: &str) -> Result<Option<LibraryModel>, String> {
        let removed = if let Some(index) = self.models.iter().position(|model| model.id == id) {
            Some(self.models.remove(index))
        } else if id == DEFAULT_MODEL_ID && self.active_model_id.as_deref() == Some(id) {
            // A starter download may not yet have created an installed entry.
            None
        } else {
            return Err("没有找到该模型，请重新打开设置。".into());
        };
        if self.active_model_id.as_deref() == Some(id) {
            self.active_model_id = None;
        }
        Ok(removed)
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
    if bytes.len() > SETTINGS_LIMIT {
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
                .chain(data.embedded_animations.iter().map(String::as_str))
                .collect();
            if data.animations.len() + data.embedded_animations.len() != names.len()
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
    if bytes.len() > SETTINGS_LIMIT {
        return Err("model settings exceed 4 MiB".into());
    }
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
    }
    if matches!(version, Some(1..=3)) {
        let enabled = value["preferences"]["modelEnabled"]
            .as_bool()
            .unwrap_or(true);
        if let Some(preferences) = value["preferences"].as_object_mut() {
            preferences.remove("modelEnabled");
        }
        let legacy = value
            .as_object_mut()
            .and_then(|object| object.remove("model"));
        let mut active = enabled.then(|| DEFAULT_MODEL_ID.to_owned());
        let models = if let Some(mut model) = legacy.filter(|model| !model.is_null()) {
            use sha2::{Digest, Sha256};
            let identity = format!("{}:{}", model["modelPath"], model["sourceSha256"]);
            let id = format!("model-{:x}", Sha256::digest(identity.as_bytes()));
            let title = model["license"]["title"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    if model["backend"] == "inochi2d" {
                        "Inochi2D 模型".into()
                    } else {
                        "VRM 模型".into()
                    }
                });
            if enabled && model["backend"] == "vrm" {
                active = Some(id.clone());
            }
            model["id"] = id.into();
            model["title"] = title.into();
            vec![model]
        } else {
            Vec::new()
        };
        value["models"] = Value::Array(models);
        value["activeModelId"] = active.map(Value::String).unwrap_or(Value::Null);
        value["schemaVersion"] = SETTINGS_SCHEMA_VERSION.into();
    }
    let settings: DesktopSettings =
        serde_json::from_value(value).map_err(|error| error.to_string())?;
    validate_settings(&settings)?;
    Ok(settings)
}

fn validate_settings(settings: &DesktopSettings) -> Result<(), String> {
    validate_preferences(&settings.preferences)?;
    if settings.schema_version != SETTINGS_SCHEMA_VERSION {
        return Err("unsupported settings version".into());
    }
    let mut identities = HashSet::new();
    if settings.models.len() > 64 {
        return Err("at most 64 imported models are supported".into());
    }
    for model in &settings.models {
        if model.id.is_empty()
            || model.id.len() > 128
            || !model
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            || !identities.insert(&model.id)
            || model.title.trim().is_empty()
            || model.title.chars().count() > 128
            || model.title.chars().any(char::is_control)
        {
            return Err("invalid model library metadata".into());
        }
        validate_model(&model.data)?;
        if let Some(adjustments) = &model.adjustments {
            adjustments.validate()?;
        }
    }
    if let Some(id) = &settings.active_model_id {
        match settings.models.iter().find(|model| &model.id == id) {
            Some(model) if model.data.backend == ModelBackend::Vrm => {}
            None if id == DEFAULT_MODEL_ID => {}
            _ => return Err("invalid active model selection".into()),
        }
    }
    Ok(())
}

pub fn store(app: &AppHandle, settings: &DesktopSettings) -> Result<(), String> {
    let bytes = settings_bytes(settings)?;
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = AtomicWriteFile::open(path).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    file.commit().map_err(|error| error.to_string())
}

fn settings_bytes(settings: &DesktopSettings) -> Result<Vec<u8>, String> {
    validate_settings(settings)?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    if bytes.len() > SETTINGS_LIMIT {
        return Err("模型库设置已达到容量上限，请使用更精简的许可信息。".into());
    }
    Ok(bytes)
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
        assert_eq!(migrated.schema_version, 4);
        assert_eq!(migrated.preferences.fps, 60);
        assert!(migrated.preferences.privacy_mode);
        assert_eq!(migrated.preferences.bubble_mode, BubbleMode::Compact);
        let model = &migrated.models[0].data;
        assert_eq!(model.backend, ModelBackend::Inochi2d);
        assert_eq!(model.model_path, "local/model.inp");
        assert_eq!(model.mappings.idle, "Idle");
        assert_eq!(model.animations[0]["durationMs"].as_f64(), Some(1000.0));
        assert_eq!(
            model.inochi2d.as_ref().unwrap().animations,
            old["model"]["animations"].as_array().unwrap().clone()
        );
    }

    #[test]
    fn version_two_merges_thinking_and_preserves_click() {
        let mut value = serde_json::to_value(DesktopSettings::default()).unwrap();
        value["schemaVersion"] = 2.into();
        value["model"] = serde_json::json!({"backend":"vrm","modelPath":"pet.vrm","sourceSha256":"source","animations":[{"name":"Idle","durationMs":1000},{"name":"Think","durationMs":1000}],"vrm":{"animations":[{"name":"Idle","path":"idle.vrma"},{"name":"Think","path":"think.vrma"}]},"mappings":{"idle":"Idle","thinking":"Think","working":null,"completed":null,"error":null,"blocked":null,"approval":null,"click":"Idle"}});
        let migrated = decode_settings(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(migrated.schema_version, 4);
        let mappings = &migrated.models[0].data.mappings;
        assert_eq!(mappings.working.as_deref(), Some("Think"));
        assert_eq!(mappings.click, vec!["Idle"]);
        assert!(mappings.ambient.is_empty());
        value["model"]["mappings"]["working"] = "Idle".into();
        assert_eq!(
            decode_settings(&serde_json::to_vec(&value).unwrap())
                .unwrap()
                .models[0]
                .data
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
    fn performance_overlay_defaults_off_and_round_trips_without_resetting_preferences() {
        let mut value = serde_json::to_value(DesktopSettings::default()).unwrap();
        value["preferences"]
            .as_object_mut()
            .unwrap()
            .remove("performanceOverlay");
        value["preferences"]["fps"] = 60.into();
        value["preferences"]["scale"] = 0.8.into();
        let decoded = decode_settings(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(!decoded.preferences.performance_overlay);
        assert_eq!(decoded.preferences.fps, 60);
        assert_eq!(decoded.preferences.scale, 0.8);
        assert_eq!(decoded.schema_version, SETTINGS_SCHEMA_VERSION);
        value["preferences"]["performanceOverlay"] = true.into();
        let enabled = decode_settings(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(enabled.preferences.performance_overlay);
        let round_trip = decode_settings(&serde_json::to_vec(&enabled).unwrap()).unwrap();
        assert!(round_trip.preferences.performance_overlay);
        assert_eq!(round_trip.preferences.fps, 60);
        assert_eq!(round_trip.preferences.scale, 0.8);
        value["preferences"]["performanceOverlay"] = "true".into();
        assert!(decode_settings(&serde_json::to_vec(&value).unwrap()).is_err());
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
    fn model_selection_survives_reload_and_legacy_opt_out_is_preserved() {
        let mut current = DesktopSettings::default();
        current.select(None).unwrap();
        let decoded = decode_settings(&serde_json::to_vec(&current).unwrap()).unwrap();
        assert!(decoded.active_model_id.is_none());
        assert!(decoded.models.is_empty());
        let legacy = serde_json::json!({"schemaVersion":3,"preferences":{"modelEnabled":false,"fps":60,"maxDevicePixelRatio":1.25,"scale":0.8,"privacyMode":false}});
        let migrated = decode_settings(&serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(migrated.active_model_id.is_none());
        assert_eq!(migrated.preferences.fps, 60);
        assert!(serde_json::to_value(migrated).unwrap()["preferences"]
            .get("modelEnabled")
            .is_none());
    }

    fn test_model(id: &str) -> LibraryModel {
        LibraryModel {
            id: id.into(),
            title: format!("Character {id}"),
            adjustments: None,
            data: InstalledModel {
                backend: ModelBackend::Vrm,
                model_path: format!("{id}/model.vrm"),
                source_sha256: id.into(),
                animations: vec![serde_json::json!({"name":"Idle","durationMs":1000})],
                mappings: mappings("Idle"),
                inochi2d: None,
                vrm: Some(VrmModelData {
                    animations: vec![AnimationSource {
                        name: "Idle".into(),
                        path: format!("{id}/idle.vrma"),
                    }],
                    embedded_animations: vec![],
                    profile_path: None,
                }),
                license: None,
            },
        }
    }

    #[test]
    fn imports_retain_each_model_and_switch_without_replacing_resources() {
        let mut current = DesktopSettings::default();
        current.add_model(test_model("first")).unwrap();
        current.add_model(test_model("second")).unwrap();
        assert_eq!(current.models.len(), 2);
        assert_eq!(current.active_model().unwrap().id, "second");
        current.select(Some("first".into())).unwrap();
        assert_eq!(
            current.active_model().unwrap().data.model_path,
            "first/model.vrm"
        );
        assert!(current.select(Some("missing".into())).is_err());
        assert_eq!(current.active_model().unwrap().id, "first");
        current.select(None).unwrap();
        let restored = decode_settings(&serde_json::to_vec(&current).unwrap()).unwrap();
        assert_eq!(restored.models.len(), 2);
        assert!(restored.active_model_id.is_none());
        assert!(current.add_model(test_model("first")).is_err());
    }

    #[test]
    fn removal_preserves_other_models_and_frees_library_capacity() {
        let mut current = DesktopSettings::default();
        for index in 0..64 {
            current
                .add_model(test_model(&format!("model-{index}")))
                .unwrap();
        }
        current.remove_model("model-0").unwrap();
        assert_eq!(current.active_model_id.as_deref(), Some("model-63"));
        current.add_model(test_model("replacement")).unwrap();
        assert_eq!(current.models.len(), 64);
        current.remove_model("replacement").unwrap();
        assert!(current.active_model_id.is_none());
        assert_eq!(current.models.len(), 63);
        assert!(current.remove_model("missing").is_err());
        let restored = decode_settings(&settings_bytes(&current).unwrap()).unwrap();
        assert!(restored.active_model_id.is_none());
        assert_eq!(restored.models.len(), 63);
    }

    #[test]
    fn installed_or_pending_starter_removal_persists_an_empty_disabled_library() {
        for installed in [false, true] {
            let mut current = DesktopSettings::default();
            if installed {
                current.add_model(test_model(DEFAULT_MODEL_ID)).unwrap();
            }
            current.remove_model(DEFAULT_MODEL_ID).unwrap();
            let restored = decode_settings(&settings_bytes(&current).unwrap()).unwrap();
            assert!(restored.models.is_empty());
            assert!(restored.active_model_id.is_none());
        }
    }

    #[test]
    fn embedded_and_external_animation_catalogs_round_trip_without_a_pack() {
        let mut current = DesktopSettings::default();
        let mut model = test_model("single-vrm");
        model
            .data
            .animations
            .push(serde_json::json!({"name":"Wave","durationMs":1500}));
        model
            .data
            .vrm
            .as_mut()
            .unwrap()
            .embedded_animations
            .push("Wave".into());
        model.data.mappings.click = vec!["Wave".into()];
        current.add_model(model).unwrap();
        let decoded = decode_settings(&settings_bytes(&current).unwrap()).unwrap();
        assert_eq!(
            decoded
                .active_model()
                .unwrap()
                .data
                .vrm
                .as_ref()
                .unwrap()
                .embedded_animations,
            ["Wave"]
        );
        assert_eq!(
            decoded.active_model().unwrap().data.mappings.click,
            ["Wave"]
        );
        current.models[0]
            .data
            .vrm
            .as_mut()
            .unwrap()
            .embedded_animations
            .push("Idle".into());
        assert!(settings_bytes(&current).is_err());
    }

    #[test]
    fn rejects_duplicate_ids_and_unknown_or_unsupported_selection() {
        let mut current = DesktopSettings::default();
        current.add_model(test_model("first")).unwrap();
        let mut value = serde_json::to_value(current).unwrap();
        value["activeModelId"] = "missing".into();
        assert!(decode_settings(&serde_json::to_vec(&value).unwrap()).is_err());
        value["activeModelId"] = "first".into();
        let repeated = value["models"][0].clone();
        value["models"].as_array_mut().unwrap().push(repeated);
        assert!(decode_settings(&serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn version_three_retains_model_license_mappings_and_preferences() {
        let mut model = test_model("original");
        model.data.license = Some(ModelLicense {
            title: "Original character".into(),
            text: "Original license".into(),
        });
        model.data.mappings.click = vec!["Idle".into()];
        let mut old = serde_json::json!({"schemaVersion":3,"preferences":{"modelEnabled":true,"fps":60,"maxDevicePixelRatio":1.25,"scale":0.8,"privacyMode":true,"bubbleMode":"detailed"},"model":model.data});
        let bytes = serde_json::to_vec(&old).unwrap();
        let migrated = decode_settings(&bytes).unwrap();
        assert_eq!(migrated.models.len(), 1);
        let selected = migrated.active_model().unwrap();
        assert_eq!(selected.title, "Original character");
        assert_eq!(selected.data.model_path, "original/model.vrm");
        assert_eq!(selected.data.mappings.click, ["Idle"]);
        assert_eq!(
            selected.data.license.as_ref().unwrap().text,
            "Original license"
        );
        assert_eq!(migrated.preferences.fps, 60);
        assert_eq!(migrated.preferences.scale, 0.8);
        assert_eq!(migrated.preferences.bubble_mode, BubbleMode::Detailed);
        assert!(migrated.preferences.privacy_mode);
        assert_eq!(
            decode_settings(&bytes).unwrap().active_model_id,
            migrated.active_model_id
        );
        old["preferences"]["modelEnabled"] = false.into();
        let disabled = decode_settings(&serde_json::to_vec(&old).unwrap()).unwrap();
        assert!(disabled.active_model_id.is_none());
        assert_eq!(disabled.models.len(), 1);
    }

    #[test]
    fn refuses_an_aggregate_library_larger_than_the_reload_limit() {
        let mut current = DesktopSettings::default();
        for index in 0..64 {
            let mut model = test_model(&format!("model-{index}"));
            model.data.license = Some(ModelLicense {
                title: "License".into(),
                text: "x".repeat(70_000),
            });
            current.add_model(model).unwrap();
        }
        assert!(settings_bytes(&current).is_err());
        assert!(current.add_model(test_model("overflow")).is_err());
        assert_eq!(current.models.len(), 64);
        assert!(decode_settings(&vec![b' '; SETTINGS_LIMIT + 1]).is_err());
    }

    #[test]
    fn quick_menu_preferences_default_enabled_for_existing_settings_and_round_trip() {
        let mut value = serde_json::to_value(DesktopSettings::default()).unwrap();
        value["preferences"]
            .as_object_mut()
            .unwrap()
            .remove("bubblesVisible");
        value["preferences"]
            .as_object_mut()
            .unwrap()
            .remove("pointerEnabled");
        value["preferences"]["scale"] = 0.8.into();
        let migrated = decode_settings(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(migrated.preferences.bubbles_visible);
        assert!(migrated.preferences.pointer_enabled);
        assert_eq!(migrated.preferences.scale, 0.8);
        value["preferences"]["bubblesVisible"] = false.into();
        value["preferences"]["pointerEnabled"] = false.into();
        let disabled = decode_settings(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(!disabled.preferences.bubbles_visible);
        assert!(!disabled.preferences.pointer_enabled);
        let restored = decode_settings(&settings_bytes(&disabled).unwrap()).unwrap();
        assert!(!restored.preferences.bubbles_visible);
        assert!(!restored.preferences.pointer_enabled);
        value["preferences"]["bubblesVisible"] = "false".into();
        assert!(decode_settings(&serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn preference_patches_merge_latest_fields_without_overwriting_other_ui_changes() {
        let current = DesktopPreferences {
            scale: 0.8,
            privacy_mode: true,
            ..Default::default()
        };
        let menu: PreferencesPatch = serde_json::from_value(
            serde_json::json!({"bubblesVisible":false,"pointerEnabled":false}),
        )
        .unwrap();
        let next = menu.apply(&current).unwrap();
        let settings: PreferencesPatch = serde_json::from_value(
            serde_json::json!({"bubbleMode":"detailed","performanceOverlay":true}),
        )
        .unwrap();
        let next = settings.apply(&next).unwrap();
        assert!(!next.bubbles_visible);
        assert!(!next.pointer_enabled);
        assert_eq!(next.scale, 0.8);
        assert!(next.privacy_mode);
        assert_eq!(next.bubble_mode, BubbleMode::Detailed);
        assert!(next.performance_overlay);
        assert_eq!(next.fps, 30);
        let unchanged = PreferencesPatch::default().apply(&next).unwrap();
        assert_eq!(
            serde_json::to_value(next).unwrap(),
            serde_json::to_value(unchanged).unwrap()
        );
    }

    #[test]
    fn preference_patches_reject_unknown_fields_invalid_types_and_out_of_range_values() {
        assert!(
            serde_json::from_value::<PreferencesPatch>(serde_json::json!({"unknown":true}))
                .is_err()
        );
        assert!(serde_json::from_value::<PreferencesPatch>(
            serde_json::json!({"pointerEnabled":"false"})
        )
        .is_err());
        for value in [
            serde_json::json!({"scale":0.0}),
            serde_json::json!({"fps":120}),
            serde_json::json!({"maxDevicePixelRatio":2.0}),
        ] {
            let patch: PreferencesPatch = serde_json::from_value(value).unwrap();
            assert!(patch.apply(&DesktopPreferences::default()).is_err());
        }
    }

    #[test]
    fn model_adjustments_are_optional_model_local_and_resettable() {
        let mut current = DesktopSettings::default();
        current.add_model(test_model("first")).unwrap();
        current.add_model(test_model("second")).unwrap();
        let original = serde_json::to_value(&current).unwrap();
        let adjustments: ModelAdjustments = serde_json::from_value(serde_json::json!({
            "idle":{"armLiftDegrees":12,"handCurl":0.25},
            "gaze":{"headStrength":0.8,"eyeStrength":1.2,"smoothingMs":150}
        }))
        .unwrap();
        current.set_model_adjustments("first", adjustments).unwrap();
        let restored = decode_settings(&settings_bytes(&current).unwrap()).unwrap();
        assert_eq!(
            restored.models[0]
                .adjustments
                .as_ref()
                .unwrap()
                .idle
                .as_ref()
                .unwrap()
                .hand_curl,
            Some(0.25)
        );
        assert!(restored.models[1].adjustments.is_none());
        assert_eq!(restored.active_model_id.as_deref(), Some("second"));
        assert_eq!(
            serde_json::to_value(&restored.models[0].data).unwrap(),
            serde_json::to_value(&current.models[0].data).unwrap()
        );
        current
            .set_model_adjustments("first", ModelAdjustments::default())
            .unwrap();
        assert_eq!(serde_json::to_value(&current).unwrap(), original);
        assert!(current
            .set_model_adjustments("missing", ModelAdjustments::default())
            .is_err());
        assert!(decode_settings(&serde_json::to_vec(&original).unwrap())
            .unwrap()
            .models[0]
            .adjustments
            .is_none());
    }

    #[test]
    fn rejects_invalid_adjustments_without_changing_a_model() {
        let mut current = DesktopSettings::default();
        current.add_model(test_model("first")).unwrap();
        let original = serde_json::to_value(&current).unwrap();
        for value in [
            serde_json::json!({"idle":{"armLiftDegrees":46}}),
            serde_json::json!({"idle":{"palmTwistDegrees":-46}}),
            serde_json::json!({"idle":{"elbowBendDegrees":-21}}),
            serde_json::json!({"idle":{"handCurl":1.01}}),
            serde_json::json!({"gaze":{"headStrength":2.1}}),
            serde_json::json!({"gaze":{"eyeStrength":-0.1}}),
            serde_json::json!({"gaze":{"smoothingMs":0}}),
        ] {
            let adjustments: ModelAdjustments = serde_json::from_value(value.clone()).unwrap();
            assert!(current.set_model_adjustments("first", adjustments).is_err());
            assert_eq!(serde_json::to_value(&current).unwrap(), original);
            let mut invalid = original.clone();
            invalid["models"][0]["adjustments"] = value;
            assert!(decode_settings(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
        for value in [
            serde_json::json!({"other":1}),
            serde_json::json!({"idle":{"handCurl":"open"}}),
            serde_json::json!({"gaze":{"other":1}}),
        ] {
            assert!(serde_json::from_value::<ModelAdjustments>(value).is_err());
        }
    }
}
