use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use uuid::Uuid;

use crate::settings::{
    self, AnimationSource, DesktopSettings, InstalledModel, ModelBackend, ModelInstallRequest,
    ModelLicense,
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
    let prepared = vrm::inspect(
        &input,
        &sources,
        profile.as_deref().map(std::path::Path::new),
    )?;
    let animations = prepared.catalog();
    Ok(ModelInspection {
        backend,
        source_sha256: prepared.source_sha256,
        source_bytes: prepared.source_bytes,
        model_name: prepared.model_name,
        animations,
        compatibility_supported: true,
        issues: vec![],
    })
}

pub fn install(app: &AppHandle, request: ModelInstallRequest) -> Result<DesktopSettings, String> {
    install_with_license(app, request, None)
}

pub fn install_with_license(
    app: &AppHandle,
    request: ModelInstallRequest,
    license: Option<ModelLicense>,
) -> Result<DesktopSettings, String> {
    require_supported_backend(request.backend)?;
    settings::validate_preferences(&request.preferences)?;
    let input = PathBuf::from(&request.source_path);
    if backend_for_path(&input)? != request.backend {
        return Err("source file does not match selected backend".into());
    }
    // Read and validate every VRM component before creating any installed files.
    let vrm = vrm::inspect(
        &input,
        &request.animation_sources,
        request.profile_path.as_deref().map(std::path::Path::new),
    )?;
    settings::validate_mappings(&request.mappings, &vrm.catalog())?;
    let models_dir = settings::models_dir(app)?;
    fs::create_dir_all(&models_dir).map_err(|error| error.to_string())?;
    let output_dir = models_dir.join(format!("model-{}", Uuid::new_v4()));
    let prepared = (|| {
        let (model_path, data) = vrm.write(&output_dir)?;
        let model = InstalledModel {
            backend: ModelBackend::Vrm,
            model_path,
            source_sha256: vrm.source_sha256.clone(),
            animations: vrm.catalog(),
            mappings: request.mappings,
            inochi2d: None,
            vrm: Some(data),
            license,
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
    require_supported_backend(request.backend)?;
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

fn require_supported_backend(backend: ModelBackend) -> Result<(), String> {
    if backend != ModelBackend::Vrm {
        return Err("当前版本暂不支持 Inochi2D，请使用 VRM 模型。".into());
    }
    Ok(())
}

fn backend_for_path(path: &std::path::Path) -> Result<ModelBackend, String> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("inp") => Err("当前版本暂不支持 Inochi2D，请使用 VRM 模型。".into()),
        Some("vrm") => Ok(ModelBackend::Vrm),
        _ => Err("请选择 VRM .vrm 模型文件。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inochi_import_is_disabled_before_reading_the_source_file() {
        let error = inspect("missing.inp".into(), vec![], None).unwrap_err();
        assert!(error.contains("当前版本暂不支持 Inochi2D"));
        assert!(require_supported_backend(ModelBackend::Inochi2d).is_err());
        assert!(require_supported_backend(ModelBackend::Vrm).is_ok());
        assert_eq!(
            backend_for_path(std::path::Path::new("model.VRM")).unwrap(),
            ModelBackend::Vrm
        );
    }
}
