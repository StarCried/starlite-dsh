//! The default character is a normal, separately licensed VRM file staged by
//! the DSH plugin. Importing it uses exactly the same validation as other VRMs.
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use tauri::AppHandle;

use crate::{
    model,
    settings::{self, DesktopSettings, ModelBackend, ModelInstallRequest, ModelLicense},
    vrm,
};

const MODEL_LIMIT: u64 = 64 * 1024 * 1024;
const DEFAULT_ERROR: &str = "微光模型准备失败。请重启 DSH 重试，原模型和设置未改变。";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DefaultDescriptor {
    schema_version: u32,
    title: String,
    sha256: String,
    bytes: u64,
    file: String,
}

pub fn prepare_model(app: &AppHandle) -> Result<DesktopSettings, String> {
    let mut current = settings::load(app);
    if has_default(&current) {
        return Ok(current);
    }
    let parent = default_parent()?;
    let Some(descriptor) = read_descriptor(&parent)? else {
        return Ok(current);
    };
    if adopt_default_identity(&mut current, &descriptor) {
        settings::store(app, &current)?;
        return Ok(current);
    }
    if model_missing(&parent)? {
        return Ok(current);
    }
    let prepared = checked_model(&parent, &descriptor)?;
    let request = ModelInstallRequest {
        backend: ModelBackend::Vrm,
        source_path: settings::path_string(&parent.join("default-model.vrm"))?,
        animation_sources: vec![],
        profile_path: None,
        mappings: prepared.default_mappings.clone(),
        preferences: current.preferences,
    };
    model::install_prepared_character(
        app,
        request,
        prepared,
        None,
        Some(descriptor.title),
        Some(settings::DEFAULT_MODEL_ID.into()),
        false,
    )
}

pub fn select_model(app: &AppHandle, model_id: Option<String>) -> Result<DesktopSettings, String> {
    let mut current = settings::load(app);
    if model_id.as_deref() == Some(settings::DEFAULT_MODEL_ID) && !has_default(&current) {
        current = prepare_model(app)?;
        // A missing local cache is acquired by the plugin on the next DSH
        // startup. Persist the explicit selection without inventing model data.
        if !has_default(&current) {
            read_descriptor(&default_parent()?)?.ok_or(DEFAULT_ERROR)?;
        }
    }
    current.select(model_id)?;
    settings::store(app, &current)?;
    Ok(current)
}

pub fn model_license(app: &AppHandle, model_id: String) -> Result<Option<ModelLicense>, String> {
    let current = settings::load(app);
    if let Some(model) = current.models.iter().find(|model| model.id == model_id) {
        if model.data.license.is_some() {
            return Ok(model.data.license.clone());
        }
        if model.data.backend != ModelBackend::Vrm {
            return Ok(None);
        }
        return vrm::inspect(Path::new(&model.data.model_path), &[], None)
            .map(|model| model.license);
    }
    if model_id != settings::DEFAULT_MODEL_ID {
        return Err("没有找到该模型，请重新打开设置。".into());
    }
    let parent = default_parent()?;
    let Some(descriptor) = read_descriptor(&parent)? else {
        return Ok(None);
    };
    if model_missing(&parent)? {
        return Ok(None);
    }
    checked_model(&parent, &descriptor).map(|model| model.license)
}

fn has_default(current: &DesktopSettings) -> bool {
    current
        .models
        .iter()
        .any(|model| model.id == settings::DEFAULT_MODEL_ID)
}

fn adopt_default_identity(current: &mut DesktopSettings, descriptor: &DefaultDescriptor) -> bool {
    let Some(model) = current.models.iter_mut().find(|model| {
        model.data.backend == ModelBackend::Vrm && model.data.source_sha256 == descriptor.sha256
    }) else {
        return false;
    };
    let previous = std::mem::replace(&mut model.id, settings::DEFAULT_MODEL_ID.into());
    model.title = descriptor.title.clone();
    if current.active_model_id.as_ref() == Some(&previous) {
        current.active_model_id = Some(settings::DEFAULT_MODEL_ID.into());
    }
    true
}

fn default_parent() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|_| DEFAULT_ERROR)?;
    Ok(executable.parent().ok_or(DEFAULT_ERROR)?.to_owned())
}

fn model_missing(parent: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(parent.join("default-model.vrm")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(DEFAULT_ERROR.into()),
        Ok(_) => Ok(false),
    }
}

fn read_descriptor(parent: &Path) -> Result<Option<DefaultDescriptor>, String> {
    let path = parent.join("default-model.json");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(DEFAULT_ERROR.into()),
        Ok(_) => (),
    }
    let parent_metadata = fs::symlink_metadata(parent).map_err(|_| DEFAULT_ERROR)?;
    if !parent_metadata.is_dir() || linked(&parent_metadata) {
        return Err(DEFAULT_ERROR.into());
    }
    let bytes = read_regular(&path, 4096).map_err(|_| DEFAULT_ERROR)?;
    let descriptor: DefaultDescriptor =
        serde_json::from_slice(&bytes).map_err(|_| DEFAULT_ERROR)?;
    if descriptor.schema_version != 2
        || descriptor.title.trim().is_empty()
        || descriptor.title.chars().count() > 128
        || descriptor.title.chars().any(char::is_control)
        || descriptor.sha256.len() != 64
        || !descriptor
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !(1..=MODEL_LIMIT).contains(&descriptor.bytes)
        || descriptor.file != "default-model.vrm"
    {
        return Err(DEFAULT_ERROR.into());
    }
    Ok(Some(descriptor))
}

fn checked_model(parent: &Path, descriptor: &DefaultDescriptor) -> Result<vrm::Prepared, String> {
    let path = parent.join("default-model.vrm");
    let metadata = fs::symlink_metadata(&path).map_err(|_| DEFAULT_ERROR)?;
    if !metadata.is_file() || linked(&metadata) || metadata.len() != descriptor.bytes {
        return Err(DEFAULT_ERROR.into());
    }
    let prepared = vrm::inspect(&path, &[], None).map_err(|_| DEFAULT_ERROR)?;
    if prepared.source_sha256 != descriptor.sha256 || prepared.source_bytes != descriptor.bytes {
        return Err(DEFAULT_ERROR.into());
    }
    Ok(prepared)
}

fn read_regular(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || linked(&metadata) || metadata.len() > limit {
        return Err("invalid default model file".into());
    }
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = vec![];
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("default model file exceeds size limit".into());
    }
    Ok(bytes)
}

fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn descriptor() -> serde_json::Value {
        serde_json::json!({"schemaVersion":2,"title":"Example",
        "sha256":"a".repeat(64),"bytes":3,"file":"default-model.vrm"})
    }

    #[test]
    fn default_is_one_fixed_vrm_file_without_archive_or_external_paths() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("default-model.json");
        assert!(read_descriptor(directory.path()).unwrap().is_none());
        fs::write(&path, serde_json::to_vec(&descriptor()).unwrap()).unwrap();
        assert!(read_descriptor(directory.path()).unwrap().is_some());
        assert!(model_missing(directory.path()).unwrap());
        for bad in [
            "../model.vrm",
            "https://example.invalid/model.vrm",
            "starter-character.zip",
        ] {
            let mut value = descriptor();
            value["file"] = bad.into();
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(read_descriptor(directory.path()).is_err());
        }
    }

    #[test]
    fn corrupt_default_never_reaches_model_installation() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("default-model.vrm"), b"bad").unwrap();
        let info: DefaultDescriptor = serde_json::from_value(descriptor()).unwrap();
        assert!(checked_model(directory.path(), &info).is_err());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
