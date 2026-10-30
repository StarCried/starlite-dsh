//! The default character is a normal, separately licensed VRM file staged by
//! the DSH plugin. Importing it uses exactly the same validation as other VRMs.
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::{
    model,
    settings::{self, DesktopSettings, ModelBackend, ModelInstallRequest, ModelLicense},
    vrm,
};

const MODEL_LIMIT: u64 = 64 * 1024 * 1024;
const DEFAULT_ERROR: &str = "示例模型准备失败。请重启 DSH 重试，原模型和设置未改变。";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DefaultDescriptor {
    id: String,
    title: String,
    sha256: String,
    bytes: u64,
    file: String,
    license: ModelLicense,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyDescriptor {
    schema_version: u32,
    title: String,
    sha256: String,
    bytes: u64,
    file: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogDescriptor {
    schema_version: u32,
    models: Vec<DefaultDescriptor>,
}

#[derive(Serialize)]
pub struct DefaultModelSummary {
    id: String,
    title: String,
}

pub fn available_models() -> Result<Vec<DefaultModelSummary>, String> {
    Ok(read_descriptors(&default_parent()?)?
        .into_iter()
        .map(|model| DefaultModelSummary {
            id: model.id,
            title: model.title,
        })
        .collect())
}

pub fn prepare_model(app: &AppHandle) -> Result<DesktopSettings, String> {
    let current = settings::load(app);
    if !needs_default(&current) {
        return Ok(current);
    }
    let id = current
        .active_model_id
        .clone()
        .ok_or(crate::locale::message(DEFAULT_ERROR))?;
    prepare_default(app, current, &id)
}

fn needs_default(current: &DesktopSettings) -> bool {
    current
        .active_model_id
        .as_deref()
        .is_some_and(|id| settings::is_default_model_id(id) && !has_model(current, id))
}

fn prepare_default(
    app: &AppHandle,
    mut current: DesktopSettings,
    model_id: &str,
) -> Result<DesktopSettings, String> {
    let parent = default_parent()?;
    let Some(descriptor) = read_descriptors(&parent)?
        .into_iter()
        .find(|model| model.id == model_id)
    else {
        return Ok(current);
    };
    if adopt_default_identity(&mut current, &descriptor) {
        settings::store(app, &current)?;
        return Ok(current);
    }
    if model_missing(&parent, &descriptor)? {
        return Ok(current);
    }
    let prepared = checked_model(&parent, &descriptor)?;
    let request = ModelInstallRequest {
        backend: ModelBackend::Vrm,
        source_path: settings::path_string(&parent.join(&descriptor.file))?,
        animation_sources: vec![],
        profile_path: None,
        mappings: prepared.default_mappings.clone(),
        preferences: current.preferences,
    };
    model::install_prepared_character(
        app,
        request,
        prepared,
        Some(descriptor.license),
        Some(descriptor.title),
        Some(descriptor.id),
        false,
    )
}

pub fn select_model(app: &AppHandle, model_id: Option<String>) -> Result<DesktopSettings, String> {
    let mut current = settings::load(app);
    if let Some(id) = model_id
        .as_deref()
        .filter(|id| settings::is_default_model_id(id) && !has_model(&current, id))
    {
        if !read_descriptors(&default_parent()?)?
            .iter()
            .any(|model| model.id == id)
        {
            return Err(crate::locale::message(
                "此示例尚未配置下载来源，请使用当前模型或导入 VRM。",
            )
            .into());
        }
        current = prepare_default(app, current, id)?;
        // A missing local cache is acquired by the plugin on the next DSH
        // startup. Persist the explicit selection without inventing model data.
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
    if !settings::is_default_model_id(&model_id) {
        return Err(crate::locale::message("没有找到该模型，请重新打开设置。").into());
    }
    let parent = default_parent()?;
    let Some(descriptor) = read_descriptors(&parent)?
        .into_iter()
        .find(|model| model.id == model_id)
    else {
        return Ok(None);
    };
    Ok(Some(descriptor.license))
}

fn has_model(current: &DesktopSettings, id: &str) -> bool {
    current.models.iter().any(|model| model.id == id)
}

fn adopt_default_identity(current: &mut DesktopSettings, descriptor: &DefaultDescriptor) -> bool {
    let Some(model) = current.models.iter_mut().find(|model| {
        // Only adopt an ordinary import. A misconfigured catalog with identical
        // bytes must never rename another default or replace its license.
        !settings::is_default_model_id(&model.id)
            && model.data.backend == ModelBackend::Vrm
            && model.data.source_sha256 == descriptor.sha256
    }) else {
        return false;
    };
    let previous = std::mem::replace(&mut model.id, descriptor.id.clone());
    model.title = descriptor.title.clone();
    model.data.license = Some(descriptor.license.clone());
    if current.active_model_id.as_ref() == Some(&previous) {
        current.active_model_id = Some(descriptor.id.clone());
    }
    true
}

fn default_parent() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|_| crate::locale::message(DEFAULT_ERROR))?;
    Ok(executable
        .parent()
        .ok_or(crate::locale::message(DEFAULT_ERROR))?
        .to_owned())
}

fn model_missing(parent: &Path, descriptor: &DefaultDescriptor) -> Result<bool, String> {
    match fs::symlink_metadata(parent.join(&descriptor.file)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(crate::locale::message(DEFAULT_ERROR).into()),
        Ok(_) => Ok(false),
    }
}

fn read_descriptors(parent: &Path) -> Result<Vec<DefaultDescriptor>, String> {
    let path = parent.join("default-model.json");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err(crate::locale::message(DEFAULT_ERROR).into()),
        Ok(_) => (),
    }
    let parent_metadata =
        fs::symlink_metadata(parent).map_err(|_| crate::locale::message(DEFAULT_ERROR))?;
    if !parent_metadata.is_dir() || linked(&parent_metadata) {
        return Err(crate::locale::message(DEFAULT_ERROR).into());
    }
    let bytes =
        read_regular(&path, 256 * 1024).map_err(|_| crate::locale::message(DEFAULT_ERROR))?;
    decode_descriptors(&bytes)
}

fn decode_descriptors(bytes: &[u8]) -> Result<Vec<DefaultDescriptor>, String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| crate::locale::message(DEFAULT_ERROR))?;
    let legacy = value["schemaVersion"] == 2;
    let models = if legacy {
        let old: LegacyDescriptor =
            serde_json::from_value(value).map_err(|_| crate::locale::message(DEFAULT_ERROR))?;
        if old.schema_version != 2 || old.file != "default-model.vrm" {
            return Err(crate::locale::message(DEFAULT_ERROR).into());
        }
        vec![DefaultDescriptor {
            id: settings::DEFAULT_MODEL_ID.into(),
            title: old.title,
            sha256: old.sha256,
            bytes: old.bytes,
            file: old.file,
            license: ModelLicense {
                title: "微光 v3.0".into(),
                text: include_str!("../../../../docs/weiguang-license.md").into(),
            },
        }]
    } else {
        let catalog: CatalogDescriptor =
            serde_json::from_value(value).map_err(|_| crate::locale::message(DEFAULT_ERROR))?;
        if catalog.schema_version != 3 {
            return Err(crate::locale::message(DEFAULT_ERROR).into());
        }
        catalog.models
    };
    if models.is_empty()
        || models.len() > 2
        || !models
            .iter()
            .any(|model| model.id == settings::DEFAULT_MODEL_ID)
    {
        return Err(crate::locale::message(DEFAULT_ERROR).into());
    }
    let mut ids = std::collections::HashSet::new();
    for descriptor in &models {
        if !settings::is_default_model_id(&descriptor.id)
            || !ids.insert(&descriptor.id)
            || descriptor.title.trim().is_empty()
            || descriptor.title.chars().count() > 128
            || descriptor.title.chars().any(char::is_control)
            || descriptor.sha256.len() != 64
            || !descriptor
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || !(1..=MODEL_LIMIT).contains(&descriptor.bytes)
            || (!legacy && descriptor.file != format!("{}.vrm", descriptor.id))
            || descriptor.license.title.trim().is_empty()
            || descriptor.license.title.chars().count() > 128
            || descriptor.license.title.chars().any(char::is_control)
            || descriptor.license.text.trim().is_empty()
            || descriptor.license.text.len() > 100 * 1024
            || descriptor.license.text.contains('\0')
        {
            return Err(crate::locale::message(DEFAULT_ERROR).into());
        }
    }
    Ok(models)
}

fn checked_model(parent: &Path, descriptor: &DefaultDescriptor) -> Result<vrm::Prepared, String> {
    let path = parent.join(&descriptor.file);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| crate::locale::message(DEFAULT_ERROR))?;
    if !metadata.is_file() || linked(&metadata) || metadata.len() != descriptor.bytes {
        return Err(crate::locale::message(DEFAULT_ERROR).into());
    }
    let prepared =
        vrm::inspect(&path, &[], None).map_err(|_| crate::locale::message(DEFAULT_ERROR))?;
    if prepared.source_sha256 != descriptor.sha256 || prepared.source_bytes != descriptor.bytes {
        return Err(crate::locale::message(DEFAULT_ERROR).into());
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
        assert!(read_descriptors(directory.path()).unwrap().is_empty());
        fs::write(&path, serde_json::to_vec(&descriptor()).unwrap()).unwrap();
        let models = read_descriptors(directory.path()).unwrap();
        assert_eq!(models[0].id, settings::DEFAULT_MODEL_ID);
        assert!(models[0].license.text.contains("微光示例模型使用许可"));
        assert!(model_missing(directory.path(), &models[0]).unwrap());
        for bad in [
            "../model.vrm",
            "https://example.invalid/model.vrm",
            "starter-character.zip",
        ] {
            let mut value = descriptor();
            value["file"] = bad.into();
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(read_descriptors(directory.path()).is_err());
        }
    }

    #[test]
    fn corrupt_default_never_reaches_model_installation() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("default-model.vrm"), b"bad").unwrap();
        let info = decode_descriptors(&serde_json::to_vec(&descriptor()).unwrap())
            .unwrap()
            .remove(0);
        assert!(checked_model(directory.path(), &info).is_err());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn only_the_selected_missing_starter_is_automatically_prepared() {
        let mut current = DesktopSettings::default();
        assert!(needs_default(&current));
        current.remove_model(settings::DEFAULT_MODEL_ID).unwrap();
        assert!(!needs_default(&current));
        current.active_model_id = Some("custom-model".into());
        assert!(!needs_default(&current));
        current.select(Some("bluefish-default".into())).unwrap();
        assert!(needs_default(&current));
        current.remove_model("bluefish-default").unwrap();
        assert!(!needs_default(&current));
    }

    fn catalog() -> serde_json::Value {
        let models: Vec<_> = [settings::DEFAULT_MODEL_ID, "bluefish-default"].into_iter().map(|id| {
            serde_json::json!({"id":id,"title":id,"sha256":"a".repeat(64),"bytes":3,
                "file":format!("{id}.vrm"),"license":{"title":id,"text":"Synthetic terms; no artwork"}})
        }).collect();
        serde_json::json!({"schemaVersion":3,"models":models})
    }

    #[test]
    fn catalog_terms_are_available_without_any_model_file() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("default-model.json"),
            serde_json::to_vec(&catalog()).unwrap(),
        )
        .unwrap();
        let models = read_descriptors(directory.path()).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[1].id, "bluefish-default");
        assert_eq!(models[1].license.text, "Synthetic terms; no artwork");
        assert!(model_missing(directory.path(), &models[1]).unwrap());
        assert!(model_missing(directory.path(), &models[0]).unwrap());
    }

    #[test]
    fn catalog_rejects_unknown_ids_duplicate_ids_paths_and_missing_terms() {
        for (key, bad) in [
            ("id", serde_json::json!("unknown")),
            ("id", serde_json::json!(settings::DEFAULT_MODEL_ID)),
            ("file", serde_json::json!("../outside.vrm")),
            ("file", serde_json::json!("weiguang-default.vrm")),
            ("license", serde_json::json!({"title":"Terms","text":""})),
        ] {
            let mut value = catalog();
            value["models"][1][key] = bad;
            assert!(decode_descriptors(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }

    #[test]
    fn adopting_an_import_never_renames_another_default_with_the_same_digest() {
        let mut current = DesktopSettings::default();
        let original: settings::LibraryModel = serde_json::from_value(serde_json::json!({
            "id":settings::DEFAULT_MODEL_ID,"title":"Weiguang", "backend":"vrm", "modelPath":"model.vrm",
            "sourceSha256":"a".repeat(64), "animations":[], "vrm":{"animations":[]},
            "mappings":{"idle":"Idle","working":null,"completed":null,"error":null,"blocked":null,"approval":null,"click":[],"ambient":[]},
            "license":{"title":"Weiguang","text":"Original terms"}
        })).unwrap();
        current.models.push(original);
        let fish = decode_descriptors(&serde_json::to_vec(&catalog()).unwrap())
            .unwrap()
            .remove(1);
        assert!(!adopt_default_identity(&mut current, &fish));
        assert_eq!(current.models[0].id, settings::DEFAULT_MODEL_ID);
        assert_eq!(
            current.models[0].data.license.as_ref().unwrap().text,
            "Original terms"
        );
        current.models[0].id = "ordinary-import".into();
        current.active_model_id = Some("ordinary-import".into());
        assert!(adopt_default_identity(&mut current, &fish));
        assert_eq!(current.models[0].id, "bluefish-default");
        assert_eq!(current.active_model_id.as_deref(), Some("bluefish-default"));
    }
}
