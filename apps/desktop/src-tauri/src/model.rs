use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use uuid::Uuid;

use crate::settings::{
    self, AnimationMappings, AnimationSource, DesktopPreferences, DesktopSettings, InstalledModel,
    LibraryModel, ModelBackend, ModelInstallRequest, ModelLicense,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    license: Option<ModelLicense>,
    default_mappings: AnimationMappings,
    animations: Vec<Value>,
    capabilities: Value,
    metrics: Value,
    compatibility_supported: bool,
    issues: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRemoval {
    pub settings: DesktopSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleanup_warning: Option<String>,
}

pub fn remove(app: &AppHandle, model_id: String) -> Result<ModelRemoval, String> {
    let current = settings::load(app);
    let root = settings::models_dir(app)?;
    remove_from_library(current, &model_id, &root, |next| settings::store(app, next))
}

fn remove_from_library(
    mut current: DesktopSettings,
    model_id: &str,
    root: &Path,
    commit: impl FnOnce(&DesktopSettings) -> Result<(), String>,
) -> Result<ModelRemoval, String> {
    let removed = current.remove_model(model_id)?;
    let cache = removed
        .as_ref()
        .and_then(|model| managed_cache(root, model, &current.models));
    // Never remove resources before the durable library change has succeeded.
    commit(&current)?;
    let cleanup_warning = cache
        .filter(|cache| cleanup_managed_cache(cache).is_err())
        .map(|_| "模型已移除，但本机副本清理未完成；原始 VRM 文件未改变。".into());
    Ok(ModelRemoval {
        settings: current,
        cleanup_warning,
    })
}

struct ManagedCache {
    root: PathBuf,
    directory: PathBuf,
    files: HashSet<PathBuf>,
}

fn model_resources(model: &LibraryModel) -> impl Iterator<Item = &str> {
    std::iter::once(model.data.model_path.as_str()).chain(model.data.vrm.iter().flat_map(|data| {
        data.animations
            .iter()
            .map(|animation| animation.path.as_str())
            .chain(data.profile_path.as_deref())
    }))
}

fn managed_cache(
    root: &Path,
    model: &LibraryModel,
    remaining: &[LibraryModel],
) -> Option<ManagedCache> {
    if model.data.backend != ModelBackend::Vrm {
        return None;
    }
    let data = model.data.vrm.as_ref()?;
    let model_path = Path::new(&model.data.model_path);
    let directory = model_path.parent()?;
    let suffix = directory.file_name()?.to_str()?.strip_prefix("model-")?;
    if Uuid::parse_str(suffix).ok()?.to_string() != suffix
        || model_path != directory.join("model.vrm")
    {
        return None;
    }
    let mut files = HashSet::from([directory.join("model.vrm")]);
    for (index, animation) in data.animations.iter().enumerate() {
        let expected = directory.join(format!("motion-{index}.vrma"));
        if Path::new(&animation.path) != expected {
            return None;
        }
        files.insert(expected);
    }
    if let Some(profile) = &data.profile_path {
        let expected = directory.join("profile.json");
        if Path::new(profile) != expected {
            return None;
        }
        files.insert(expected);
    }
    let cache = ManagedCache {
        root: root.to_owned(),
        directory: directory.to_owned(),
        files,
    };
    if !cache_is_owned(&cache) {
        return None;
    }
    let canonical = fs::canonicalize(directory).ok()?;
    if remaining
        .iter()
        .flat_map(model_resources)
        .any(|resource| fs::canonicalize(resource).is_ok_and(|path| path.starts_with(&canonical)))
    {
        return None;
    }
    Some(cache)
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

fn cache_boundary_is_owned(cache: &ManagedCache) -> bool {
    let ordinary_directory = |path: &Path| {
        path.is_absolute()
            && fs::symlink_metadata(path)
                .is_ok_and(|metadata| metadata.is_dir() && !linked(&metadata))
    };
    if !ordinary_directory(&cache.root) || !ordinary_directory(&cache.directory) {
        return false;
    }
    let (Ok(root), Ok(directory)) = (
        fs::canonicalize(&cache.root),
        fs::canonicalize(&cache.directory),
    ) else {
        return false;
    };
    directory.parent() == Some(root.as_path())
}

fn cache_is_owned(cache: &ManagedCache) -> bool {
    if !cache_boundary_is_owned(cache) {
        return false;
    }
    let Ok(entries) = fs::read_dir(&cache.directory) else {
        return false;
    };
    let mut count = 0;
    for entry in entries {
        let Ok(entry) = entry else { return false };
        if !cache.files.contains(&entry.path())
            || !fs::symlink_metadata(entry.path())
                .is_ok_and(|metadata| metadata.is_file() && !linked(&metadata))
        {
            return false;
        }
        count += 1;
    }
    count == cache.files.len()
}

fn cleanup_managed_cache(cache: &ManagedCache) -> Result<(), String> {
    if !cache_is_owned(cache) {
        return Err("model cache changed during removal".into());
    }
    // Installed files are flat. Do not recursively traverse user-controlled
    // directories, links, or new files that appeared after validation.
    for file in &cache.files {
        if !cache_boundary_is_owned(cache)
            || !fs::symlink_metadata(file)
                .is_ok_and(|metadata| metadata.is_file() && !linked(&metadata))
        {
            return Err("model cache file changed during removal".into());
        }
        fs::remove_file(file).map_err(|_| "model cache file could not be removed")?;
    }
    fs::remove_dir(&cache.directory)
        .map_err(|_| "model cache directory could not be removed".into())
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
        license: prepared.license,
        default_mappings: prepared.default_mappings,
        animations,
        capabilities: prepared.capabilities,
        metrics: prepared.metrics,
        compatibility_supported: true,
        issues: vec![],
    })
}

pub fn install(app: &AppHandle, request: ModelInstallRequest) -> Result<DesktopSettings, String> {
    install_character(app, request, None, None, None, true)
}

pub fn install_character(
    app: &AppHandle,
    request: ModelInstallRequest,
    license: Option<ModelLicense>,
    title: Option<String>,
    id: Option<String>,
    activate: bool,
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
    install_prepared_character(app, request, vrm, license, title, id, activate)
}

pub fn install_prepared_character(
    app: &AppHandle,
    request: ModelInstallRequest,
    vrm: vrm::Prepared,
    license: Option<ModelLicense>,
    title: Option<String>,
    id: Option<String>,
    activate: bool,
) -> Result<DesktopSettings, String> {
    require_supported_backend(request.backend)?;
    settings::validate_preferences(&request.preferences)?;
    let input = PathBuf::from(&request.source_path);
    settings::validate_mappings(&request.mappings, &vrm.catalog())?;
    let models_dir = settings::models_dir(app)?;
    fs::create_dir_all(&models_dir).map_err(|error| error.to_string())?;
    let output_dir = models_dir.join(format!("model-{}", Uuid::new_v4()));
    let prepared = (|| {
        let (model_path, data) = vrm.write(&output_dir)?;
        let title = title
            .or(vrm.model_name.clone())
            .unwrap_or_else(|| {
                input
                    .file_stem()
                    .and_then(|name| name.to_str())
                    .unwrap_or("VRM 模型")
                    .to_owned()
            })
            .chars()
            .filter(|character| !character.is_control())
            .take(128)
            .collect::<String>();
        let model = LibraryModel {
            adjustments: None,
            id: id.unwrap_or_else(|| format!("model-{}", Uuid::new_v4())),
            title: if title.trim().is_empty() {
                "VRM 模型".into()
            } else {
                title
            },
            data: InstalledModel {
                backend: ModelBackend::Vrm,
                model_path,
                source_sha256: vrm.source_sha256.clone(),
                animations: vrm.catalog(),
                mappings: request.mappings,
                inochi2d: None,
                vrm: Some(data),
                license: license.or(vrm.license.clone()),
            },
        };
        let mut next = settings::load(app);
        let previous = next.active_model_id.clone();
        next.preferences = request.preferences;
        next.add_model(model)?;
        if !activate {
            next.active_model_id = previous;
        }
        Ok(next)
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

pub fn update_preferences(
    app: &AppHandle,
    preferences: DesktopPreferences,
) -> Result<DesktopSettings, String> {
    settings::validate_preferences(&preferences)?;
    let mut next = settings::load(app);
    next.preferences = preferences;
    settings::store(app, &next)?;
    Ok(next)
}

pub fn update_mappings(
    app: &AppHandle,
    model_id: String,
    mappings: AnimationMappings,
) -> Result<DesktopSettings, String> {
    let mut next = settings::load(app);
    let model = next
        .models
        .iter_mut()
        .find(|model| model.id == model_id)
        .ok_or("没有找到该模型，请重新打开设置。")?;
    require_supported_backend(model.data.backend)?;
    settings::validate_mappings(&mappings, &model.data.animations)?;
    model.data.mappings = mappings;
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

    fn installed_model(root: &Path, id: &str) -> LibraryModel {
        let directory = root.join(format!("model-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        for name in ["model.vrm", "motion-0.vrma", "profile.json"] {
            fs::write(directory.join(name), b"generated test asset").unwrap();
        }
        serde_json::from_value(serde_json::json!({
            "id":id, "title":id, "backend":"vrm", "modelPath":directory.join("model.vrm").to_str().unwrap(),
            "sourceSha256":"generated", "animations":[{"name":"Idle","durationMs":1000}],
            "mappings":{"idle":"Idle","working":null,"completed":null,"error":null,"blocked":null,"approval":null,"click":[],"ambient":[]},
            "vrm":{"animations":[{"name":"Idle","path":directory.join("motion-0.vrma").to_str().unwrap()}],"profilePath":directory.join("profile.json").to_str().unwrap()}
        })).unwrap()
    }

    #[test]
    fn removal_commits_first_and_only_deletes_the_removed_managed_copy() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("models");
        let source = temporary.path().join("original.vrm");
        fs::write(&source, b"original artwork-free source").unwrap();
        let removed = installed_model(&root, "removed");
        let kept = installed_model(&root, "kept");
        let removed_directory = Path::new(&removed.data.model_path).parent().unwrap();
        let mut current = DesktopSettings::default();
        current.add_model(kept.clone()).unwrap();
        current.add_model(removed.clone()).unwrap();
        let result = remove_from_library(current.clone(), "removed", &root, |_| {
            Err("disk full".into())
        });
        assert!(result.is_err());
        assert!(Path::new(&removed.data.model_path).is_file());
        let saved = temporary.path().join("settings.json");
        let result = remove_from_library(current, "removed", &root, |next| {
            assert!(removed_directory.is_dir());
            fs::write(&saved, serde_json::to_vec(next).unwrap()).map_err(|error| error.to_string())
        })
        .unwrap();
        assert!(result.cleanup_warning.is_none());
        assert!(!removed_directory.exists());
        assert!(Path::new(&kept.data.model_path).is_file());
        assert_eq!(fs::read(source).unwrap(), b"original artwork-free source");
        let restored = settings::decode_settings(&fs::read(saved).unwrap()).unwrap();
        assert_eq!(restored.models.len(), 1);
        assert_eq!(restored.models[0].id, "kept");
        assert!(restored.active_model_id.is_none());
    }

    #[test]
    fn removal_preserves_external_shared_and_unrecognized_files() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("models");
        fs::create_dir(&root).unwrap();
        for variant in 0..4 {
            let parent = if variant == 0 {
                temporary.path()
            } else {
                &root
            };
            let mut removed = installed_model(parent, "removed");
            let path = removed.data.model_path.clone();
            let mut current = DesktopSettings::default();
            if variant == 1 {
                let mut shared = removed.clone();
                shared.id = "shared".into();
                current.add_model(shared).unwrap();
            } else if variant == 2 {
                fs::write(
                    Path::new(&path).parent().unwrap().join("keep.txt"),
                    b"user file",
                )
                .unwrap();
            } else if variant == 3 {
                removed.data.vrm.as_mut().unwrap().profile_path = Some(
                    temporary
                        .path()
                        .join("external-profile.json")
                        .to_str()
                        .unwrap()
                        .into(),
                );
            }
            current.add_model(removed).unwrap();
            let result = remove_from_library(current, "removed", &root, |_| Ok(())).unwrap();
            assert!(result.cleanup_warning.is_none());
            assert!(
                Path::new(&path).is_file(),
                "unsafe cleanup for variant {variant}"
            );
        }
    }

    #[test]
    fn a_changed_cache_is_not_traversed_and_reports_cleanup_separately_from_saved_removal() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("models");
        let removed = installed_model(&root, "removed");
        let directory = Path::new(&removed.data.model_path)
            .parent()
            .unwrap()
            .to_owned();
        let mut current = DesktopSettings::default();
        current.add_model(removed).unwrap();
        let result = remove_from_library(current, "removed", &root, |_| {
            fs::create_dir(directory.join("unrecognized-directory")).unwrap();
            fs::write(directory.join("unrecognized-directory/keep.txt"), b"keep").unwrap();
            Ok(())
        })
        .unwrap();
        assert!(result.settings.models.is_empty());
        assert!(result.settings.active_model_id.is_none());
        assert!(result.cleanup_warning.unwrap().contains("模型已移除"));
        assert!(directory.join("model.vrm").is_file());
        assert!(directory.join("unrecognized-directory/keep.txt").is_file());
    }

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
