use std::fs;
use std::path::PathBuf;

use inochi2d_pipeline::{build, inspect_file, BuildRequest};
use serde::{Deserialize, Serialize};
use serde_json::{to_value, Value};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::settings::{self, path_string, DesktopSettings, InstalledModel, ModelInstallRequest};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInspection {
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

pub fn inspect(path: String) -> Result<ModelInspection, String> {
    let input = PathBuf::from(path);
    ensure_inp(&input)?;
    let report = inspect_file(&input).map_err(|error| error.to_string())?;
    Ok(ModelInspection {
        source_sha256: report.source.sha256,
        source_bytes: report.source.bytes,
        model_name: report.metadata.name,
        animations: values(report.animations)?,
        compatibility_supported: report.compatibility.supported,
        issues: values(report.compatibility.issues)?,
    })
}

pub fn install(app: &AppHandle, request: ModelInstallRequest) -> Result<DesktopSettings, String> {
    settings::validate_preferences(&request.preferences)?;
    if request.source_path.is_empty() {
        return Err("a source .inp file is required for import".into());
    }
    let input = PathBuf::from(&request.source_path);
    ensure_inp(&input)?;
    let inspection = inspect_file(&input).map_err(|error| error.to_string())?;
    if !inspection.compatibility.supported {
        return Err("the model contains unsupported or unsafe resources".into());
    }
    let inspected_animations = values(inspection.animations)?;
    settings::validate_mappings(&request.mappings, &inspected_animations)?;

    let models_dir = settings::models_dir(app)?;
    fs::create_dir_all(&models_dir).map_err(|error| error.to_string())?;
    let output_dir = models_dir.join(format!("model-{}", Uuid::new_v4()));
    let prepared = (|| {
        let manifest = build(&BuildRequest {
            input,
            output_dir: output_dir.clone(),
            fallback: None,
        })
        .map_err(|error| error.to_string())?;
        let animations = values(manifest.animations)?;
        // Revalidate the generated manifest so a pipeline regression cannot
        // install mappings that differ from the inspected source.
        settings::validate_mappings(&request.mappings, &animations)?;
        let model_path = output_dir.join(&manifest.model.file);
        if !model_path.is_file() {
            return Err("prepared model artifact is missing".into());
        }
        Ok(DesktopSettings {
            schema_version: settings::SETTINGS_SCHEMA_VERSION,
            preferences: request.preferences,
            model: Some(InstalledModel {
                model_path: path_string(&model_path)?,
                source_sha256: manifest.model.source_sha256,
                animations,
                mappings: request.mappings,
            }),
        })
    })();

    match prepared {
        Ok(next) => {
            // The old settings remain visible until the prepared model and
            // exact animation mapping have both passed validation.
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

fn ensure_inp(path: &std::path::Path) -> Result<(), String> {
    let is_inp = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("inp"));
    if !is_inp {
        return Err("only Inochi2D .inp model files can be imported".into());
    }
    Ok(())
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
