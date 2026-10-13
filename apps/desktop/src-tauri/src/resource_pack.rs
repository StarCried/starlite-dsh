//! A character pack is data, never an installer. Validate everything before
//! handing the desktop subset to the existing atomic model installation.
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tempfile::TempDir;
use zip::{CompressionMethod, ZipArchive};

use crate::{
    model,
    settings::{
        self, AnimationSource, DesktopPreferences, DesktopSettings, ModelBackend,
        ModelInstallRequest, ModelLicense,
    },
    vrm,
};

const ARCHIVE_LIMIT: usize = 64 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 128 * 1024 * 1024;
const ENTRY_LIMIT: usize = 512;
const MODEL_LIMIT: u64 = 64 * 1024 * 1024;
const ANIMATION_LIMIT: u64 = 16 * 1024 * 1024;
const JSON_LIMIT: u64 = 1024 * 1024;
const TEXT_LIMIT: u64 = 256 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePackInspection {
    pub title: String,
    pub license: String,
    pub sha256: String,
    pub animation_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StarterDescriptor {
    schema_version: u32,
    title: String,
    sha256: String,
    bytes: u64,
    model_sha256: String,
    archive: String,
}

const STARTER_ERROR: &str =
    "微光资源准备失败。请重启 DSH 重试；也可以手动导入资源包，原模型和设置未改变。";

pub fn prepare_model(app: &AppHandle) -> Result<DesktopSettings, String> {
    let mut current = settings::load(app);
    if !needs_default(&current) {
        return Ok(current);
    }
    let parent = starter_parent()?;
    let descriptor = read_starter_descriptor(&parent)?;
    if let Some(descriptor) = &descriptor {
        if adopt_default_identity(&mut current, &descriptor.model_sha256, &descriptor.title) {
            settings::store(app, &current)?;
            return Ok(current);
        }
    }
    let pending = current.active_model_id.as_deref() == Some(settings::DEFAULT_MODEL_ID);
    if !pending && (descriptor.is_none() || !parent.join("starter-character.zip").exists()) {
        return Ok(current);
    }
    install_default(app, current.preferences, false)
}

pub fn select_model(app: &AppHandle, model_id: Option<String>) -> Result<DesktopSettings, String> {
    let mut current = settings::load(app);
    if model_id.as_deref() == Some(settings::DEFAULT_MODEL_ID) && needs_default(&current) {
        current = prepare_model(app)?;
        if needs_default(&current) {
            current = install_default(app, current.preferences, true)?;
        }
    }
    current.select(model_id)?;
    settings::store(app, &current)?;
    Ok(current)
}

fn needs_default(current: &DesktopSettings) -> bool {
    !current
        .models
        .iter()
        .any(|model| model.id == settings::DEFAULT_MODEL_ID)
}

fn adopt_default_identity(current: &mut DesktopSettings, source_sha256: &str, title: &str) -> bool {
    let Some(model) = current.models.iter_mut().find(|model| {
        model.data.backend == ModelBackend::Vrm && model.data.source_sha256 == source_sha256
    }) else {
        return false;
    };
    let previous = std::mem::replace(&mut model.id, settings::DEFAULT_MODEL_ID.into());
    model.title = title.into();
    if current.active_model_id.as_ref() == Some(&previous) {
        current.active_model_id = Some(settings::DEFAULT_MODEL_ID.into());
    }
    true
}

fn install_default(
    app: &AppHandle,
    preferences: DesktopPreferences,
    activate: bool,
) -> Result<DesktopSettings, String> {
    let parent = starter_parent()?;
    let pack = prepare_default(&parent, preferences)?.ok_or(STARTER_ERROR)?;
    let title = pack.inspection.title.clone();
    let license = license_of(&pack);
    model::install_character(
        app,
        pack.request,
        Some(license),
        Some(title),
        Some(settings::DEFAULT_MODEL_ID.into()),
        activate,
    )
}

/// License viewing is read-only. Existing custom VRM models never acquire the
/// default character's license, and normal startup never reopens their archive.
pub fn model_license(app: &AppHandle, model_id: String) -> Result<Option<ModelLicense>, String> {
    let current = settings::load(app);
    let model = current.models.iter().find(|model| model.id == model_id);
    if let Some(license) = model.and_then(|model| model.data.license.clone()) {
        return Ok(Some(license));
    }
    if model.is_none() && model_id != settings::DEFAULT_MODEL_ID {
        return Err("没有找到该模型，请重新打开设置。".into());
    }
    if model.is_some_and(|model| model.data.backend != ModelBackend::Vrm) {
        return Ok(None);
    }
    let default_license = license_for_model(&starter_parent()?, model.map(|model| &model.data))?;
    if default_license.is_some() {
        return Ok(default_license);
    }
    model
        .map(|model| {
            vrm::inspect(Path::new(&model.data.model_path), &[], None)
                .map(|prepared| prepared.license)
        })
        .transpose()
        .map(Option::flatten)
}

fn license_for_model(
    parent: &Path,
    model: Option<&settings::InstalledModel>,
) -> Result<Option<ModelLicense>, String> {
    let Some(descriptor) = read_starter_descriptor(parent)? else {
        return Ok(None);
    };
    if model.is_some_and(|model| {
        model.backend != ModelBackend::Vrm || model.source_sha256 != descriptor.model_sha256
    }) {
        return Ok(None);
    }
    let pack = starter_checked(parent, descriptor, DesktopPreferences::default())
        .map_err(|_| STARTER_ERROR)?;
    Ok(Some(license_of(&pack)))
}

fn starter_parent() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|_| STARTER_ERROR)?;
    Ok(exe.parent().ok_or(STARTER_ERROR)?.to_owned())
}

/// Only the plugin-staged, executable-adjacent default can be used. No webview
/// path or archive name can redirect automatic preparation.
fn prepare_default(
    parent: &Path,
    preferences: DesktopPreferences,
) -> Result<Option<PreparedPack>, String> {
    read_starter_descriptor(parent)?
        .map(|descriptor| starter_checked(parent, descriptor, preferences))
        .transpose()
        .map_err(|_| STARTER_ERROR.into())
}

fn read_starter_descriptor(parent: &Path) -> Result<Option<StarterDescriptor>, String> {
    let descriptor_path = parent.join("starter-character.json");
    match fs::symlink_metadata(&descriptor_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(STARTER_ERROR.into()),
        Ok(_) => {}
    }
    descriptor_checked(parent, &descriptor_path)
        .map(Some)
        .map_err(|_| STARTER_ERROR.into())
}

fn descriptor_checked(parent: &Path, descriptor_path: &Path) -> Result<StarterDescriptor, String> {
    let parent_meta = fs::symlink_metadata(parent).map_err(|e| e.to_string())?;
    if !parent_meta.is_dir() || linked(&parent_meta) {
        return Err("invalid starter directory".into());
    }
    let descriptor: StarterDescriptor =
        serde_json::from_slice(&read_limited(descriptor_path, 4096)?)
            .map_err(|_| "invalid starter descriptor")?;
    if descriptor.schema_version != 1
        || descriptor.title.trim().is_empty()
        || descriptor.title.chars().count() > 128
        || descriptor.title.chars().any(char::is_control)
        || !valid_hash(&descriptor.sha256)
        || !valid_hash(&descriptor.model_sha256)
        || !(1..=ARCHIVE_LIMIT as u64).contains(&descriptor.bytes)
        || descriptor.archive != "starter-character.zip"
    {
        return Err("invalid starter descriptor".into());
    }
    Ok(descriptor)
}

fn starter_checked(
    parent: &Path,
    descriptor: StarterDescriptor,
    preferences: DesktopPreferences,
) -> Result<PreparedPack, String> {
    let path = parent.join("starter-character.zip");
    let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() != descriptor.bytes || linked(&metadata) {
        return Err("starter archive size or file type mismatch".into());
    }
    let prepared = prepare(&path, preferences)?;
    if prepared.inspection.sha256 != descriptor.sha256
        || prepared.model_sha256 != descriptor.model_sha256
    {
        return Err("starter archive digest mismatch".into());
    }
    Ok(prepared)
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

#[derive(Debug)]
struct PreparedPack {
    _directory: TempDir,
    inspection: ResourcePackInspection,
    request: ModelInstallRequest,
    model_sha256: String,
}

pub fn inspect(path: String) -> Result<ResourcePackInspection, String> {
    Ok(prepare(Path::new(&path), DesktopPreferences::default())?.inspection)
}

pub fn install(
    app: &AppHandle,
    path: String,
    expected_sha256: String,
    preferences: DesktopPreferences,
    accept_license: bool,
) -> Result<DesktopSettings, String> {
    let pack = checked_prepare(
        Path::new(&path),
        preferences,
        &expected_sha256,
        accept_license,
    )?;
    install_prepared(app, pack)
}

fn license_of(pack: &PreparedPack) -> ModelLicense {
    ModelLicense {
        title: pack.inspection.title.clone(),
        text: pack.inspection.license.clone(),
    }
}

fn install_prepared(app: &AppHandle, pack: PreparedPack) -> Result<DesktopSettings, String> {
    let license = license_of(&pack);
    let title = pack.inspection.title.clone();
    model::install_character(app, pack.request, Some(license), Some(title), None, true)
}

fn checked_prepare(
    path: &Path,
    preferences: DesktopPreferences,
    expected_sha256: &str,
    accept_license: bool,
) -> Result<PreparedPack, String> {
    require_confirmation(expected_sha256, accept_license)?;
    let pack = prepare(path, preferences)?;
    if pack.inspection.sha256 != expected_sha256 {
        return Err("resource pack changed after inspection; select it again".into());
    }
    Ok(pack)
}

fn require_confirmation(hash: &str, accepted: bool) -> Result<(), String> {
    if !accepted {
        return Err("accept the character pack license before importing".into());
    }
    if !valid_hash(hash) {
        return Err("inspect the resource pack before importing".into());
    }
    Ok(())
}

fn prepare(path: &Path, preferences: DesktopPreferences) -> Result<PreparedPack, String> {
    settings::validate_preferences(&preferences)?;
    let bytes = read_archive(path)?;
    let sha256 = digest(&bytes);
    let directory = tempfile::Builder::new()
        .prefix("starlite-character-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let files = extract(&bytes, directory.path())?;
    verify_checksums(directory.path(), &files)?;
    let manifest_bytes = read_limited(&directory.path().join("desktop/manifest.json"), JSON_LIMIT)?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes).map_err(|e| e.to_string())?;
    if manifest["schemaVersion"] != 1 || manifest["backend"] != "vrm" {
        return Err("the resource pack requires a version 1 VRM desktop manifest".into());
    }
    if manifest["publication"]["allowRedistribution"] != true {
        return Err("the resource pack has not allowed distribution".into());
    }
    let license_file = match manifest["publication"].get("licenseFile") {
        None => "LICENSE-Weiguang.md",
        Some(value) => value.as_str().ok_or("invalid license filename")?,
    };
    safe_relative(license_file)?;
    if !license_file.ends_with(".md") && !license_file.ends_with(".txt") {
        return Err("the license must be a Markdown or text file".into());
    }
    let license = String::from_utf8(read_limited(
        &directory.path().join(license_file),
        TEXT_LIMIT,
    )?)
    .map_err(|_| "the character license must be UTF-8 text")?;
    if license.trim().is_empty() || license.contains('\0') {
        return Err("the character license is empty or invalid".into());
    }

    let root = directory.path().join("desktop");
    let source = asset_path(&root, &manifest["model"], ".vrm", MODEL_LIMIT)?;
    let clips = manifest["animations"]
        .as_array()
        .ok_or("missing animation catalog")?;
    if clips.is_empty() || clips.len() > 64 {
        return Err("the resource pack must contain 1 to 64 authored animations".into());
    }
    let mut animation_sources = Vec::new();
    let mut paths = HashSet::new();
    for clip in clips {
        let name = clip["name"].as_str().ok_or("invalid animation name")?;
        let path = asset_path(&root, clip, ".vrma", ANIMATION_LIMIT)?;
        if !paths.insert(path.clone()) {
            return Err("multiple animations reference the same resource".into());
        }
        animation_sources.push(AnimationSource {
            name: name.into(),
            path: settings::path_string(&path)?,
        });
    }
    let profile = if manifest["profile"].is_null() {
        None
    } else {
        Some(asset_path(
            &root,
            &manifest["profile"],
            ".json",
            JSON_LIMIT,
        )?)
    };
    let prepared = vrm::inspect(&source, &animation_sources, profile.as_deref())?;
    let catalog = prepared.catalog();
    for (clip, actual) in clips.iter().zip(&catalog) {
        if clip["durationMs"].as_f64().is_none_or(|duration| {
            !duration.is_finite()
                || (duration - actual["durationMs"].as_f64().unwrap_or(-1.0)).abs() > 0.1
        }) {
            return Err("manifest animation duration does not match the resource".into());
        }
    }
    let mappings = serde_json::from_value(manifest["mappings"].clone())
        .map_err(|_| "the resource pack is missing valid desktop action mappings")?;
    settings::validate_mappings(&mappings, &catalog)?;
    let title: String = prepared
        .model_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "VRM character pack".into())
        .chars()
        .take(128)
        .collect();
    Ok(PreparedPack {
        model_sha256: prepared.source_sha256,
        inspection: ResourcePackInspection {
            title,
            license,
            sha256,
            animation_count: catalog.len(),
        },
        request: ModelInstallRequest {
            backend: ModelBackend::Vrm,
            source_path: settings::path_string(&source)?,
            animation_sources,
            profile_path: profile.as_deref().map(settings::path_string).transpose()?,
            mappings,
            preferences,
        },
        _directory: directory,
    })
}

fn asset_path(root: &Path, item: &Value, extension: &str, limit: u64) -> Result<PathBuf, String> {
    let name = item["file"].as_str().ok_or("missing resource filename")?;
    safe_relative(name)?;
    if !name.to_ascii_lowercase().ends_with(extension) {
        return Err("resource file does not match its declared kind".into());
    }
    let path = root.join(name);
    let bytes = read_limited(&path, limit)?;
    if item["bytes"].as_u64() != Some(bytes.len() as u64)
        || !item["sha256"]
            .as_str()
            .is_some_and(|hash| valid_hash(hash) && digest(&bytes) == hash)
    {
        return Err("manifest resource size or SHA-256 does not match".into());
    }
    Ok(path)
}

fn read_archive(path: &Path) -> Result<Vec<u8>, String> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("zip"))
    {
        return Err("select a character resource .zip package".into());
    }
    read_limited(path, ARCHIVE_LIMIT as u64)
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || linked(&metadata) || metadata.len() > limit {
        return Err("resource has an invalid file type or exceeds its byte limit".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("resource exceeds its byte limit".into());
    }
    Ok(bytes)
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn safe_relative(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 512
        || name
            .chars()
            .any(|c| c.is_control() || "\\<>:\"|?*".contains(c))
    {
        return Err("unsafe resource pack path".into());
    }
    for part in name.split('/') {
        let base = part
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end_matches(' ')
            .to_ascii_lowercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || matches!(
                base.as_str(),
                "con"
                    | "prn"
                    | "aux"
                    | "nul"
                    | "conin$"
                    | "conout$"
                    | "com¹"
                    | "com²"
                    | "com³"
                    | "lpt¹"
                    | "lpt²"
                    | "lpt³"
            )
            || ((base.starts_with("com") || base.starts_with("lpt"))
                && base.len() == 4
                && matches!(base.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("unsafe resource pack path".into());
        }
    }
    Ok(())
}

struct Entry {
    name: String,
    bytes: u64,
    directory: bool,
}
fn u16_at(bytes: &[u8], at: usize) -> Result<u16, String> {
    Ok(u16::from_le_bytes(
        bytes
            .get(at..at + 2)
            .ok_or("truncated ZIP")?
            .try_into()
            .map_err(|_| "truncated ZIP")?,
    ))
}
fn u32_at(bytes: &[u8], at: usize) -> Result<u32, String> {
    Ok(u32::from_le_bytes(
        bytes
            .get(at..at + 4)
            .ok_or("truncated ZIP")?
            .try_into()
            .map_err(|_| "truncated ZIP")?,
    ))
}

// Check allocation and path budgets before ZipArchive allocates its directory.
// The archive is intentionally the ordinary single-disk ZIP used by character
// packs; ZIP64, encryption, links and executable handling are unnecessary.
fn directory(bytes: &[u8]) -> Result<Vec<Entry>, String> {
    if bytes.len() > ARCHIVE_LIMIT || bytes.len() < 22 {
        return Err("invalid ZIP size".into());
    }
    let end = (bytes.len().saturating_sub(65557)..=bytes.len() - 22)
        .rev()
        .find(|at| {
            u32_at(bytes, *at) == Ok(0x06054b50)
                && u16_at(bytes, *at + 20).is_ok_and(|n| *at + 22 + usize::from(n) == bytes.len())
        })
        .ok_or("invalid ZIP end record")?;
    let count = usize::from(u16_at(bytes, end + 10)?);
    let size = u32_at(bytes, end + 12)? as usize;
    let mut at = u32_at(bytes, end + 16)? as usize;
    if u16_at(bytes, end + 4)? != 0
        || u16_at(bytes, end + 6)? != 0
        || usize::from(u16_at(bytes, end + 8)?) != count
        || count == 0
        || count > ENTRY_LIMIT
        || at.checked_add(size) != Some(end)
    {
        return Err("unsupported ZIP directory or entry count".into());
    }
    let mut entries = Vec::new();
    let mut seen = HashMap::new();
    let mut casing = HashMap::new();
    let mut total = 0u64;
    for _ in 0..count {
        if at + 46 > end || u32_at(bytes, at)? != 0x02014b50 {
            return Err("invalid ZIP central entry".into());
        }
        let flags = u16_at(bytes, at + 8)?;
        let method = u16_at(bytes, at + 10)?;
        let compressed = u32_at(bytes, at + 20)?;
        let length = u32_at(bytes, at + 24)?;
        let name_len = usize::from(u16_at(bytes, at + 28)?);
        let next = at
            + 46
            + name_len
            + usize::from(u16_at(bytes, at + 30)?)
            + usize::from(u16_at(bytes, at + 32)?);
        let mode = u32_at(bytes, at + 38)? >> 16;
        if next > end
            || flags & 0x2041 != 0
            || !matches!(method, 0 | 8)
            || compressed == u32::MAX
            || length == u32::MAX
            || u16_at(bytes, at + 34)? != 0
        {
            return Err("unsupported encrypted or compressed ZIP entry".into());
        }
        let raw_name = &bytes[at + 46..at + 46 + name_len];
        let name = std::str::from_utf8(raw_name).map_err(|_| "ZIP names must be UTF-8")?;
        let is_directory = name.ends_with('/');
        let relative = if is_directory {
            &name[..name.len() - 1]
        } else {
            name
        };
        safe_relative(relative)?;
        for end in relative
            .match_indices('/')
            .map(|(at, _)| at)
            .chain(std::iter::once(relative.len()))
        {
            let prefix = &relative[..end];
            if casing
                .insert(prefix.to_lowercase(), prefix.to_owned())
                .is_some_and(|previous| previous != prefix)
            {
                return Err("ZIP paths conflict on case-insensitive filesystems".into());
            }
        }
        let kind = mode & 0xf000;
        if kind != 0 && kind != if is_directory { 0x4000 } else { 0x8000 } {
            return Err("ZIP links and special files are forbidden".into());
        }
        if (is_directory && length != 0) || u64::from(length) > MODEL_LIMIT {
            return Err("ZIP entry exceeds its byte limit".into());
        }
        total += u64::from(length);
        if total > TOTAL_LIMIT {
            return Err("ZIP expanded size exceeds 128 MiB".into());
        }
        let identity = relative.to_lowercase();
        if seen.insert(identity, is_directory).is_some() {
            return Err("duplicate ZIP path".into());
        }
        let local = u32_at(bytes, at + 42)? as usize;
        if local + 30 > bytes.len()
            || u32_at(bytes, local)? != 0x04034b50
            || u16_at(bytes, local + 6)? != flags
            || u16_at(bytes, local + 8)? != method
            || usize::from(u16_at(bytes, local + 26)?) != name_len
            || bytes.get(local + 30..local + 30 + name_len) != Some(raw_name)
        {
            return Err("ZIP local entry does not match the central directory".into());
        }
        entries.push(Entry {
            name: name.into(),
            bytes: u64::from(length),
            directory: is_directory,
        });
        at = next;
    }
    if at != end {
        return Err("invalid ZIP central directory size".into());
    }
    for entry in &entries {
        let name = entry.name.trim_end_matches('/').to_lowercase();
        for (at, _) in name.match_indices('/') {
            if seen.get(&name[..at]) == Some(&false) {
                return Err("ZIP file conflicts with a directory".into());
            }
        }
    }
    Ok(entries)
}

fn extract(bytes: &[u8], root: &Path) -> Result<HashSet<String>, String> {
    let entries = directory(bytes)?;
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    if archive.len() != entries.len() {
        return Err("ZIP directory count mismatch".into());
    }
    let mut files = HashSet::new();
    let mut total = 0u64;
    for (index, expected) in entries.iter().enumerate() {
        let mut file = archive.by_index(index).map_err(|e| e.to_string())?;
        if file.name_raw() != expected.name.as_bytes()
            || file.size() != expected.bytes
            || file.encrypted()
            || file.is_symlink()
            || !matches!(
                file.compression(),
                CompressionMethod::Stored | CompressionMethod::Deflated
            )
        {
            return Err("unsupported or mismatched ZIP entry".into());
        }
        if expected.directory {
            continue;
        }
        let destination = root.join(&expected.name);
        fs::create_dir_all(destination.parent().ok_or("missing resource parent")?)
            .map_err(|e| e.to_string())?;
        let mut output = File::create(&destination).map_err(|e| e.to_string())?;
        let mut count = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            count += n as u64;
            total += n as u64;
            if count > expected.bytes || total > TOTAL_LIMIT {
                return Err("ZIP expanded size exceeds its declared budget".into());
            }
            output.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        }
        if count != expected.bytes {
            return Err("truncated ZIP resource".into());
        }
        files.insert(expected.name.clone());
    }
    Ok(files)
}

fn verify_checksums(root: &Path, files: &HashSet<String>) -> Result<(), String> {
    let text = String::from_utf8(read_limited(&root.join("SHA256SUMS"), TEXT_LIMIT)?)
        .map_err(|_| "SHA256SUMS must be UTF-8")?;
    let mut expected = HashMap::new();
    for line in text.lines() {
        let (hash, name) = line.split_once("  ").ok_or("invalid SHA256SUMS line")?;
        safe_relative(name)?;
        if !valid_hash(hash) || name == "SHA256SUMS" || expected.insert(name, hash).is_some() {
            return Err("invalid or duplicate resource checksum".into());
        }
    }
    if !files.contains("SHA256SUMS") || files.len() != expected.len() + 1 {
        return Err("SHA256SUMS must cover every resource".into());
    }
    for name in files.iter().filter(|name| name.as_str() != "SHA256SUMS") {
        let hash = expected
            .get(name.as_str())
            .ok_or("missing resource checksum")?;
        if digest(&read_limited(&root.join(name), MODEL_LIMIT)?) != *hash {
            return Err("resource SHA-256 mismatch".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn glb(value: Value, mut bin: Vec<u8>) -> Vec<u8> {
        let mut text = serde_json::to_vec(&value).unwrap();
        while text.len() % 4 != 0 {
            text.push(b' ');
        }
        while bin.len() % 4 != 0 {
            bin.push(0);
        }
        let size = 20 + text.len() + if bin.is_empty() { 0 } else { 8 + bin.len() };
        let mut bytes = Vec::new();
        for n in [0x46546c67, 2, size as u32, text.len() as u32, 0x4e4f534a] {
            bytes.extend(n.to_le_bytes());
        }
        bytes.extend(text);
        if !bin.is_empty() {
            bytes.extend((bin.len() as u32).to_le_bytes());
            bytes.extend(0x004e4942u32.to_le_bytes());
            bytes.extend(bin);
        }
        bytes
    }

    fn fixture() -> Vec<(String, Vec<u8>)> {
        let bones = [
            "hips",
            "spine",
            "head",
            "leftUpperArm",
            "leftLowerArm",
            "leftHand",
            "rightUpperArm",
            "rightLowerArm",
            "rightHand",
            "leftUpperLeg",
            "leftLowerLeg",
            "leftFoot",
            "rightUpperLeg",
            "rightLowerLeg",
            "rightFoot",
        ];
        let model = glb(
            json!({"asset":{"version":"2.0"}, "nodes":bones.iter().map(|name|json!({"name":name})).collect::<Vec<_>>(), "extensions":{"VRM":{"specVersion":"0.0", "meta":{"title":"Generated test character"}, "humanoid":{"humanBones":bones.iter().enumerate().map(|(i,name)|json!({"bone":name,"node":i})).collect::<Vec<_>>()}}}}),
            vec![],
        );
        let motion = glb(
            json!({"asset":{"version":"2.0"}, "extensions":{"VRMC_vrm_animation":{"specVersion":"1.0"}}, "nodes":[{"name":"hips"}], "buffers":[{"byteLength":40}], "bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":8},{"buffer":0,"byteOffset":8,"byteLength":32}], "accessors":[{"bufferView":0,"count":2,"type":"SCALAR","componentType":5126,"min":[0],"max":[1]},{"bufferView":1,"count":2,"type":"VEC4","componentType":5126}], "animations":[{"samplers":[{"input":0,"output":1}], "channels":[{"sampler":0,"target":{"node":0,"path":"rotation"}}]}]}),
            [0.0f32, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
                .into_iter()
                .flat_map(f32::to_le_bytes)
                .collect(),
        );
        let manifest = json!({"schemaVersion":1, "backend":"vrm", "model":{"file":"model.vrm","sha256":digest(&model),"bytes":model.len()}, "animations":[{"name":"Rest","file":"motions/base.vrma","sha256":digest(&motion),"bytes":motion.len(),"durationMs":1000}], "mappings":{"idle":"Rest","click":["Rest"],"ambient":[]}, "publication":{"allowRedistribution":true}});
        vec![
            (
                "LICENSE-Weiguang.md".into(),
                b"Synthetic test license; no artwork.".to_vec(),
            ),
            (
                "desktop/manifest.json".into(),
                serde_json::to_vec(&manifest).unwrap(),
            ),
            ("desktop/model.vrm".into(), model),
            ("desktop/motions/base.vrma".into(), motion),
        ]
    }

    fn zip_bytes(files: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, bytes) in files {
            writer.start_file(name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn pack(files: Vec<(String, Vec<u8>)>) -> (TempDir, PathBuf) {
        let mut files = files;
        let sums = files
            .iter()
            .map(|(name, bytes)| format!("{}  {}\n", digest(bytes), name))
            .collect::<String>();
        files.push(("SHA256SUMS".into(), sums.into_bytes()));
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("character.zip");
        fs::write(&path, zip_bytes(&files)).unwrap();
        (folder, path)
    }

    fn change_manifest(files: &mut [(String, Vec<u8>)], change: impl FnOnce(&mut Value)) {
        let bytes = &mut files
            .iter_mut()
            .find(|(name, _)| name == "desktop/manifest.json")
            .unwrap()
            .1;
        let mut value: Value = serde_json::from_slice(bytes).unwrap();
        change(&mut value);
        *bytes = serde_json::to_vec(&value).unwrap();
    }

    fn starter_fixture(files: Vec<(String, Vec<u8>)>) -> (TempDir, Value) {
        let model_hash = digest(
            &files
                .iter()
                .find(|(name, _)| name == "desktop/model.vrm")
                .unwrap()
                .1,
        );
        let (folder, archive) = pack(files);
        let bytes = fs::read(&archive).unwrap();
        fs::rename(archive, folder.path().join("starter-character.zip")).unwrap();
        let descriptor = json!({"schemaVersion":1,"title":"微光","sha256":digest(&bytes),"bytes":bytes.len(),"modelSha256":model_hash,"archive":"starter-character.zip"});
        fs::write(
            folder.path().join("starter-character.json"),
            serde_json::to_vec(&descriptor).unwrap(),
        )
        .unwrap();
        (folder, descriptor)
    }

    fn starter_at(parent: &Path) -> Result<Option<PreparedPack>, String> {
        prepare_default(parent, DesktopPreferences::default())
    }

    #[test]
    fn discovers_only_the_fixed_starter_and_validates_model_identity_and_license() {
        let portable = tempfile::tempdir().unwrap();
        assert!(starter_at(portable.path()).unwrap().is_none());
        let (folder, descriptor) = starter_fixture(fixture());
        let result = starter_at(folder.path()).unwrap().unwrap();
        assert_eq!(result.inspection.animation_count, 1);
        assert_eq!(
            result.inspection.license,
            "Synthetic test license; no artwork."
        );
        assert_eq!(result.model_sha256, descriptor["modelSha256"]);
        assert_eq!(result.inspection.sha256, descriptor["sha256"]);
        assert!(Path::new(&result.request.source_path).is_file());
    }

    #[test]
    fn fails_closed_for_stale_or_redirected_starter_descriptors_without_exposing_paths() {
        let (folder, original) = starter_fixture(fixture());
        for (field, value) in [
            ("schemaVersion", json!(2)),
            ("archive", json!("../character.zip")),
            ("bytes", json!(ARCHIVE_LIMIT + 1)),
            ("bytes", json!(original["bytes"].as_u64().unwrap() + 1)),
            ("sha256", json!("0".repeat(64))),
            ("modelSha256", json!("0".repeat(64))),
            ("title", json!("bad\ntitle")),
            ("unexpected", json!(true)),
        ] {
            let mut descriptor = original.clone();
            descriptor[field] = value;
            fs::write(
                folder.path().join("starter-character.json"),
                serde_json::to_vec(&descriptor).unwrap(),
            )
            .unwrap();
            assert_eq!(
                starter_at(folder.path()).unwrap_err(),
                STARTER_ERROR,
                "{field}"
            );
        }
        fs::write(
            folder.path().join("starter-character.json"),
            serde_json::to_vec(&original).unwrap(),
        )
        .unwrap();
        fs::remove_file(folder.path().join("starter-character.zip")).unwrap();
        assert_eq!(starter_at(folder.path()).unwrap_err(), STARTER_ERROR);
    }

    #[test]
    fn checks_starter_pack_contents_even_when_outer_size_and_hash_match() {
        let mut files = fixture();
        change_manifest(&mut files, |manifest| {
            manifest["mappings"]["idle"] = json!("Missing")
        });
        let (folder, _) = starter_fixture(files);
        assert_eq!(starter_at(folder.path()).unwrap_err(), STARTER_ERROR);
        fs::write(
            folder.path().join("starter-character.json"),
            vec![b' '; 4097],
        )
        .unwrap();
        assert_eq!(starter_at(folder.path()).unwrap_err(), STARTER_ERROR);
    }

    #[test]
    fn default_preparation_requires_no_first_launch_marker_or_consent_flag() {
        let (folder, _) = starter_fixture(fixture());
        let preferences = DesktopPreferences {
            fps: 60,
            scale: 0.8,
            privacy_mode: true,
            ..DesktopPreferences::default()
        };
        let prepared = prepare_default(folder.path(), preferences)
            .unwrap()
            .unwrap();
        assert_eq!(prepared.request.preferences.fps, 60);
        assert_eq!(prepared.request.preferences.scale, 0.8);
        assert!(prepared.request.preferences.privacy_mode);
        assert_eq!(
            license_of(&prepared).text,
            "Synthetic test license; no artwork."
        );
        assert!(!folder.path().join("starter-offered.sha256").exists());
    }

    #[test]
    fn default_identity_reuses_migrated_resources_and_preserves_selection() {
        let (folder, _) = starter_fixture(fixture());
        let starter = read_starter_descriptor(folder.path()).unwrap().unwrap();
        let prepared = prepare(
            &folder.path().join("starter-character.zip"),
            DesktopPreferences::default(),
        )
        .unwrap();
        let model = settings::LibraryModel {
            id: "migrated-character".into(),
            title: "Character".into(),
            data: settings::InstalledModel {
                backend: ModelBackend::Vrm,
                model_path: prepared.request.source_path.clone(),
                source_sha256: starter.model_sha256.clone(),
                animations: vec![json!({"name":"Rest","durationMs":1000})],
                mappings: prepared.request.mappings,
                inochi2d: None,
                vrm: Some(settings::VrmModelData {
                    animations: prepared.request.animation_sources,
                    profile_path: None,
                }),
                license: None,
            },
        };
        let mut current = DesktopSettings::default();
        current.add_model(model).unwrap();
        fs::remove_file(folder.path().join("starter-character.zip")).unwrap();
        assert!(needs_default(&current));
        let original_path = current.models[0].data.model_path.clone();
        assert!(adopt_default_identity(
            &mut current,
            &starter.model_sha256,
            &starter.title
        ));
        assert!(!needs_default(&current));
        assert_eq!(
            current.active_model_id.as_deref(),
            Some(settings::DEFAULT_MODEL_ID)
        );
        assert_eq!(current.models.len(), 1);
        assert_eq!(current.models[0].data.model_path, original_path);
        current.select(None).unwrap();
        assert!(!needs_default(&current));
        assert!(current.active_model_id.is_none());
        current.models[0].data.source_sha256 = "f".repeat(64);
        assert!(
            license_for_model(folder.path(), Some(&current.models[0].data))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_failed_default_does_not_change_preferences_or_replace_a_legacy_model() {
        let (folder, _) = starter_fixture(fixture());
        let old = json!({"schemaVersion":1,"preferences":{"fps":60,"maxDevicePixelRatio":1.25,"scale":0.8,"privacyMode":true},"model":{"modelPath":"local/model.inp","sourceSha256":"source","animations":[{"name":"Idle","timestepMs":100,"length":10,"lanes":[]}],"mappings":{"idle":"Idle","thinking":null,"working":null,"completed":null,"error":null,"blocked":null,"approval":null,"click":null}}});
        let current = settings::decode_settings(&serde_json::to_vec(&old).unwrap()).unwrap();
        let before = serde_json::to_value(&current).unwrap();
        assert!(needs_default(&current));
        fs::remove_file(folder.path().join("starter-character.zip")).unwrap();
        assert_eq!(
            prepare_default(folder.path(), current.preferences.clone()).unwrap_err(),
            STARTER_ERROR
        );
        assert_eq!(serde_json::to_value(current).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_starter_files_and_directories() {
        use std::os::unix::fs::symlink;
        let (folder, _) = starter_fixture(fixture());
        let link_folder = tempfile::tempdir().unwrap();
        let link = link_folder.path().join("linked");
        symlink(folder.path(), &link).unwrap();
        assert_eq!(starter_at(&link).unwrap_err(), STARTER_ERROR);
        let archive = folder.path().join("starter-character.zip");
        let real = folder.path().join("other.zip");
        fs::rename(&archive, &real).unwrap();
        symlink(real, archive).unwrap();
        assert_eq!(starter_at(folder.path()).unwrap_err(), STARTER_ERROR);
    }

    #[test]
    fn prepares_exact_manifest_mappings_and_preserves_preferences() {
        let (_folder, path) = pack(fixture());
        let preferences = DesktopPreferences {
            fps: 30,
            scale: 1.25,
            privacy_mode: true,
            ..DesktopPreferences::default()
        };
        let prepared = prepare(&path, preferences).unwrap();
        assert_eq!(prepared.inspection.title, "Generated test character");
        assert_eq!(prepared.inspection.animation_count, 1);
        assert_eq!(
            prepared.inspection.sha256,
            digest(&fs::read(&path).unwrap())
        );
        assert_eq!(prepared.request.mappings.idle, "Rest");
        assert_eq!(prepared.request.mappings.click, ["Rest"]);
        assert!(prepared.request.mappings.working.is_none());
        assert_eq!(prepared.request.preferences.fps, 30);
        assert_eq!(prepared.request.preferences.scale, 1.25);
        assert!(prepared.request.preferences.privacy_mode);
        let extracted = PathBuf::from(&prepared.request.source_path);
        assert!(extracted.is_file());
        drop(prepared);
        assert!(!extracted.exists());
    }

    #[test]
    fn requires_license_consent_and_the_inspected_archive_digest() {
        let (_folder, path) = pack(fixture());
        let hash = digest(&fs::read(&path).unwrap());
        assert!(
            checked_prepare(&path, DesktopPreferences::default(), &hash, false)
                .err()
                .unwrap()
                .contains("license")
        );
        assert!(
            checked_prepare(&path, DesktopPreferences::default(), &"0".repeat(64), true)
                .err()
                .unwrap()
                .contains("changed")
        );
        assert!(checked_prepare(&path, DesktopPreferences::default(), "invalid", true).is_err());
        assert!(checked_prepare(&path, DesktopPreferences::default(), &hash, true).is_ok());
    }

    #[test]
    fn rejects_missing_or_unavailable_idle_and_other_mappings() {
        for mapping in [
            json!({"click":[]}),
            json!({"idle":"Unavailable"}),
            json!({"idle":"Rest","working":"Unavailable"}),
            json!({"idle":"Rest","click":["Rest","Rest"]}),
        ] {
            let mut files = fixture();
            change_manifest(&mut files, |manifest| manifest["mappings"] = mapping);
            let (_folder, path) = pack(files);
            assert!(prepare(&path, DesktopPreferences::default()).is_err());
        }
    }

    #[test]
    fn rejects_missing_or_corrupt_assets_and_wrong_manifest_sizes() {
        for mode in 0..5 {
            let mut files = fixture();
            match mode {
                0 => {
                    files.retain(|(name, _)| name != "desktop/motions/base.vrma");
                }
                1 => {
                    files
                        .iter_mut()
                        .find(|(name, _)| name == "desktop/model.vrm")
                        .unwrap()
                        .1 = b"bad".to_vec();
                }
                2 => change_manifest(&mut files, |manifest| manifest["model"]["bytes"] = 1.into()),
                3 => change_manifest(&mut files, |manifest| {
                    manifest["animations"][0]["durationMs"] = 2000.into()
                }),
                _ => change_manifest(&mut files, |manifest| {
                    manifest["model"]["file"] = "../blog/model.vrm".into()
                }),
            }
            let (_folder, path) = pack(files);
            assert!(prepare(&path, DesktopPreferences::default()).is_err());
        }
    }

    #[test]
    fn rejects_unlicensed_packs_and_accepts_explicit_text_license_file() {
        let mut files = fixture();
        change_manifest(&mut files, |manifest| {
            manifest["publication"]["allowRedistribution"] = false.into()
        });
        let (_folder, path) = pack(files);
        assert!(prepare(&path, DesktopPreferences::default())
            .err()
            .unwrap()
            .contains("distribution"));
        let mut files = fixture();
        files[0].0 = "LICENSE.txt".into();
        change_manifest(&mut files, |manifest| {
            manifest["publication"]["licenseFile"] = "LICENSE.txt".into()
        });
        let (_folder, path) = pack(files);
        assert!(prepare(&path, DesktopPreferences::default()).is_ok());
    }

    #[test]
    fn requires_all_file_checksums_and_detects_changes() {
        let (_folder, path) = pack(fixture());
        let bytes = fs::read(&path).unwrap();
        let root = tempfile::tempdir().unwrap();
        let mut files = extract(&bytes, root.path()).unwrap();
        fs::write(root.path().join("desktop/model.vrm"), b"changed").unwrap();
        assert!(verify_checksums(root.path(), &files)
            .err()
            .unwrap()
            .contains("mismatch"));
        files.insert("unlisted.txt".into());
        assert!(verify_checksums(root.path(), &files)
            .err()
            .unwrap()
            .contains("every resource"));
    }

    #[test]
    fn rejects_paths_links_case_conflicts_and_zip_budgets() {
        for name in [
            "../outside",
            "/absolute",
            "C:/outside",
            "a\\b",
            "CON.txt",
            "con .txt",
            "COM¹.txt",
            "COM².txt",
            "COM³.txt",
            "LPT¹.txt",
            "LPT².txt",
            "LPT³.txt",
            "foo/../bar",
            "file. ",
            "foo//bar",
        ] {
            assert!(safe_relative(name).is_err(), "{name}");
        }
        for names in [
            ["model.vrm", "MODEL.vrm"],
            ["Dir/a", "dir/b"],
            ["dir", "dir/a"],
        ] {
            let bytes = zip_bytes(
                &names
                    .into_iter()
                    .map(|name| (name.into(), vec![0]))
                    .collect::<Vec<_>>(),
            );
            assert!(directory(&bytes).is_err());
        }
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .add_symlink("link", "../outside", SimpleFileOptions::default())
            .unwrap();
        assert!(directory(&writer.finish().unwrap().into_inner()).is_err());
        let mut bytes = zip_bytes(&[("file".into(), vec![0])]);
        let central = bytes
            .windows(4)
            .position(|b| b == [0x50, 0x4b, 0x01, 0x02])
            .unwrap();
        bytes[central + 24..central + 28]
            .copy_from_slice(&((MODEL_LIMIT + 1) as u32).to_le_bytes());
        assert!(directory(&bytes).err().unwrap().contains("limit"));
        let bytes = zip_bytes(
            &(0..ENTRY_LIMIT + 1)
                .map(|i| (format!("{i}.txt"), vec![]))
                .collect::<Vec<_>>(),
        );
        assert!(directory(&bytes).err().unwrap().contains("count"));
    }

    #[test]
    fn rejects_encryption_unknown_compression_and_local_header_mismatch() {
        for (offset, value) in [(8, 1u16), (10, 12u16)] {
            let mut bytes = zip_bytes(&[("file".into(), vec![0])]);
            let central = bytes
                .windows(4)
                .position(|b| b == [0x50, 0x4b, 0x01, 0x02])
                .unwrap();
            bytes[central + offset..central + offset + 2].copy_from_slice(&value.to_le_bytes());
            assert!(directory(&bytes).is_err());
        }
        let mut bytes = zip_bytes(&[("file".into(), vec![0])]);
        bytes[30] = b'X';
        assert!(directory(&bytes).err().unwrap().contains("local entry"));
    }

    #[test]
    #[ignore = "requires a local independently licensed character pack"]
    fn local_character_pack_passes_resource_validation() {
        let path = std::env::var("STARLITE_CHARACTER_PACK").expect("set STARLITE_CHARACTER_PACK");
        let prepared = prepare(Path::new(&path), DesktopPreferences::default()).unwrap();
        assert_eq!(prepared.inspection.animation_count, 14);
        assert_eq!(prepared.inspection.sha256.len(), 64);
        assert!(!prepared.inspection.license.is_empty());
        assert_eq!(prepared.request.animation_sources.len(), 14);
        assert_eq!(prepared.request.mappings.idle, "Idle");
        assert_eq!(
            prepared.request.mappings.working.as_deref(),
            Some("Working")
        );
        assert_eq!(
            prepared.request.mappings.completed.as_deref(),
            Some("Completed")
        );
        assert_eq!(prepared.request.mappings.error.as_deref(), Some("Error"));
        assert_eq!(
            prepared.request.mappings.blocked.as_deref(),
            Some("Blocked")
        );
        assert_eq!(
            prepared.request.mappings.approval.as_deref(),
            Some("Approval")
        );
        assert_eq!(prepared.request.mappings.click.len(), 5);
        assert_eq!(prepared.request.mappings.ambient.len(), 3);
        assert!(prepared.request.profile_path.is_some());
        assert_eq!(inspect(path).unwrap().sha256, prepared.inspection.sha256);
    }
}
