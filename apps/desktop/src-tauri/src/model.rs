use std::fs;
use std::path::PathBuf;

use inochi2d_pipeline::{build, inspect_file, BuildRequest};
use serde::Serialize;
use serde_json::{to_value, Value};
use tauri::AppHandle;
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
