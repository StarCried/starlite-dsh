use std::fs;
use std::path::PathBuf;

use inochi2d_pipeline::{build, inspect_file, BuildRequest};
use serde::{Deserialize, Serialize};
use serde_json::{to_value, Value};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::settings::{
    self, path_string, AnimationSource, DesktopSettings, InochiModelData, InstalledModel,
    ModelBackend, ModelInstallRequest,
};
use crate::vrm;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInspection {
    backend: ModelBackend,
    source_sha256: String,
    source_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_name: Option<String>,
    animations: Vec<Value>,
    compatibility_supported: bool,
    issues: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct BundledModelDefaults {
    mappings: settings::AnimationMappings,
}

pub fn inspect(
    path: String,
    sources: Vec<AnimationSource>,
    profile: Option<String>,
) -> Result<ModelInspection, String> {
    let input = PathBuf::from(path);
    let backend = backend_for_path(&input)?;
    if backend == ModelBackend::Vrm {
        let prepared = vrm::inspect(
            &input,
            &sources,
            profile.as_deref().map(std::path::Path::new),
        )?;
        let animations = prepared.catalog();
        return Ok(ModelInspection {
            backend,
            source_sha256: prepared.source_sha256,
            source_bytes: prepared.source_bytes,
            model_name: prepared.model_name,
            animations,
            compatibility_supported: true,
            issues: vec![],
        });
    }
    if !sources.is_empty() || profile.is_some() {
        return Err("VRMA and character profiles require the VRM backend".into());
    }
    let report = inspect_file(&input).map_err(|error| error.to_string())?;
    Ok(ModelInspection {
        backend,
        source_sha256: report.source.sha256,
        source_bytes: report.source.bytes,
        model_name: report.metadata.name,
        animations: settings::inochi_catalog(&values(report.animations)?)?,
        compatibility_supported: report.compatibility.supported,
        issues: values(report.compatibility.issues)?,
    })
}

pub fn install(app: &AppHandle, request: ModelInstallRequest) -> Result<DesktopSettings, String> {
    settings::validate_preferences(&request.preferences)?;
    let input = PathBuf::from(&request.source_path);
    if backend_for_path(&input)? != request.backend {
        return Err("source file does not match selected backend".into());
    }
    // Read and validate every VRM component before creating any installed files.
    let vrm = if request.backend == ModelBackend::Vrm {
        Some(vrm::inspect(
            &input,
            &request.animation_sources,
            request.profile_path.as_deref().map(std::path::Path::new),
        )?)
    } else {
        if !request.animation_sources.is_empty() || request.profile_path.is_some() {
            return Err("VRMA resources require the VRM backend".into());
        }
        let inspection = inspect_file(&input).map_err(|error| error.to_string())?;
        if !inspection.compatibility.supported {
            return Err("the model contains unsupported or unsafe resources".into());
        }
        settings::validate_mappings(
            &request.mappings,
            &settings::inochi_catalog(&values(inspection.animations)?)?,
        )?;
        None
    };
    if let Some(prepared) = &vrm {
        settings::validate_mappings(&request.mappings, &prepared.catalog())?;
    }
    let models_dir = settings::models_dir(app)?;
    fs::create_dir_all(&models_dir).map_err(|error| error.to_string())?;
    let output_dir = models_dir.join(format!("model-{}", Uuid::new_v4()));
    let prepared = (|| {
        let model = if let Some(prepared) = vrm {
            let (model_path, data) = prepared.write(&output_dir)?;
            InstalledModel {
                backend: ModelBackend::Vrm,
                model_path,
                source_sha256: prepared.source_sha256.clone(),
                animations: prepared.catalog(),
                mappings: request.mappings,
                inochi2d: None,
                vrm: Some(data),
            }
        } else {
            let manifest = build(&BuildRequest {
                input,
                output_dir: output_dir.clone(),
                fallback: None,
            })
            .map_err(|error| error.to_string())?;
            let clips = values(manifest.animations)?;
            let animations = settings::inochi_catalog(&clips)?;
            settings::validate_mappings(&request.mappings, &animations)?;
            let model_path = output_dir.join(&manifest.model.file);
            if !model_path.is_file() {
                return Err("prepared model artifact is missing".into());
            }
            InstalledModel {
                backend: ModelBackend::Inochi2d,
                model_path: path_string(&model_path)?,
                source_sha256: manifest.model.source_sha256,
                animations,
                mappings: request.mappings,
                inochi2d: Some(InochiModelData { animations: clips }),
                vrm: None,
            }
        };
        Ok(DesktopSettings {
            schema_version: settings::SETTINGS_SCHEMA_VERSION,
            preferences: request.preferences,
            model: Some(model),
        })
    })();
    match prepared {
        Ok(next) => {
            if let Err(error) = settings::store(app, &next) {
                let _ = fs::remove_dir_all(&output_dir);
                return Err(error);
            }
            Ok(next)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&output_dir);
            Err(error)
        }
    }
}

/// Installs the release demo on first launch through the same transactional
/// pipeline as a user-selected model. Development builds intentionally omit
/// the optional resource and continue with an empty model configuration.
pub fn install_bundled_if_empty(app: &AppHandle) -> Result<(), String> {
    if settings::load(app).model.is_some() {
        return Ok(());
    }
    let directory = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("resources")
        .join("microlight");
    let model = directory.join("model.inp");
    if !model.is_file() {
        return Ok(());
    }
    let defaults_path = directory.join("defaults.json");
    let bytes = fs::read(&defaults_path).map_err(|error| {
        format!(
            "bundled animation defaults are unavailable ({}): {error}",
            defaults_path.display()
        )
    })?;
    if bytes.len() > 64 * 1024 {
        return Err("bundled animation defaults exceed 64 KiB".into());
    }
    let defaults: BundledModelDefaults =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    install(
        app,
        ModelInstallRequest {
            backend: ModelBackend::Inochi2d,
            animation_sources: vec![],
            profile_path: None,
            source_path: path_string(&model)?,
            mappings: defaults.mappings,
            preferences: settings::DesktopPreferences::default(),
        },
    )?;
    Ok(())
}

pub fn update(app: &AppHandle, request: ModelInstallRequest) -> Result<DesktopSettings, String> {
    if !request.source_path.is_empty() {
        return Err("updating settings cannot import a new source model".into());
    }
    settings::validate_preferences(&request.preferences)?;
    let current = settings::load(app);
    let Some(mut model) = current.model else {
        return Err("no installed model is available to update".into());
    };
    if model.backend != request.backend
        || !request.animation_sources.is_empty()
        || request.profile_path.is_some()
    {
        return Err("updating preferences cannot replace model components".into());
    }
    settings::validate_mappings(&request.mappings, &model.animations)?;
    model.mappings = request.mappings;
    let next = DesktopSettings {
        schema_version: settings::SETTINGS_SCHEMA_VERSION,
        preferences: request.preferences,
        model: Some(model),
    };
    settings::store(app, &next)?;
    Ok(next)
}

fn values<T: Serialize>(items: Vec<T>) -> Result<Vec<Value>, String> {
    items
        .into_iter()
        .map(|item| to_value(item).map_err(|error| error.to_string()))
        .collect()
}

fn backend_for_path(path: &std::path::Path) -> Result<ModelBackend, String> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("inp") => Ok(ModelBackend::Inochi2d),
        Some("vrm") => Ok(ModelBackend::Vrm),
        _ => Err("select an Inochi2D .inp or VRM .vrm model file".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Release CI opts into this test with the approved asset path. Ordinary
    /// development remains artwork-free and therefore skips it.
    #[test]
    fn approved_demo_model_survives_inspect_build_and_mapping_validation() {
        let Ok(source) = std::env::var("DSH_PET_DEMO_MODEL") else {
            return;
        };
        let source = PathBuf::from(source);
        let defaults_path = source
            .parent()
            .expect("demo model must have a parent directory")
            .join("defaults.json");
        let defaults: BundledModelDefaults = serde_json::from_slice(
            &fs::read(defaults_path).expect("demo animation defaults must be readable"),
        )
        .expect("demo animation defaults must be valid JSON");
        let inspection = inspect_file(&source).expect("demo model must be inspectable");
        assert!(
            inspection.compatibility.supported,
            "demo model must be compatible with the Web runtime"
        );
        let inspected = values(inspection.animations).expect("animation metadata must serialize");
        settings::validate_mappings(&defaults.mappings, &inspected)
            .expect("demo mappings must exactly match source animations");

        let temporary = tempfile::tempdir().expect("temporary output directory must be available");
        let output = temporary.path().join("prepared");
        let manifest = build(&BuildRequest {
            input: source,
            output_dir: output.clone(),
            fallback: None,
        })
        .expect("demo model must pass the release pipeline");
        let prepared = values(manifest.animations).expect("prepared animations must serialize");
        settings::validate_mappings(&defaults.mappings, &prepared)
            .expect("demo mappings must survive preparation");
        assert!(output.join(manifest.model.file).is_file());
    }
}
