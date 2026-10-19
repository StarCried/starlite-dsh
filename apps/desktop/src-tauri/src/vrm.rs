//! Self-contained VRM/VRMA import. No model-supplied URI is ever resolved.
use crate::settings::{
    self, path_string, AnimationMappings, AnimationSource, ModelLicense, VrmModelData,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::Read,
    path::Path,
};

const MODEL_LIMIT: usize = 64 * 1024 * 1024;
const ANIMATION_LIMIT: usize = 16 * 1024 * 1024;
const PROFILE_LIMIT: usize = 1024 * 1024;
pub const DEFAULT_IDLE_NAME: &str = "StarLiteIdle";
const DEFAULT_IDLE: &[u8] = include_bytes!("../assets/default-idle.vrma");

pub struct Prepared {
    pub source_sha256: String,
    pub source_bytes: u64,
    pub model_name: Option<String>,
    pub license: Option<ModelLicense>,
    pub default_mappings: AnimationMappings,
    pub capabilities: Value,
    pub metrics: Value,
    model: Vec<u8>,
    animations: Vec<(String, f64, Vec<u8>)>,
    embedded_animations: Vec<(String, f64)>,
    profile: Option<Vec<u8>>,
}

impl Prepared {
    pub fn catalog(&self) -> Vec<Value> {
        self.animations
            .iter()
            .map(|(name, duration, _)| json!({"name":name,"durationMs":duration}))
            .chain(
                self.embedded_animations
                    .iter()
                    .map(|(name, duration)| json!({"name":name,"durationMs":duration})),
            )
            .collect()
    }
    pub fn write(&self, directory: &Path) -> Result<(String, VrmModelData), String> {
        fs::create_dir(directory).map_err(|e| e.to_string())?;
        let model = directory.join("model.vrm");
        fs::write(&model, &self.model).map_err(|e| e.to_string())?;
        let mut animations = Vec::new();
        for (i, (name, _, bytes)) in self.animations.iter().enumerate() {
            let path = directory.join(format!("motion-{i}.vrma"));
            fs::write(&path, bytes).map_err(|e| e.to_string())?;
            animations.push(AnimationSource {
                name: name.clone(),
                path: path_string(&path)?,
            });
        }
        let profile_path = if let Some(bytes) = &self.profile {
            let path = directory.join("profile.json");
            fs::write(&path, bytes).map_err(|e| e.to_string())?;
            Some(path_string(&path)?)
        } else {
            None
        };
        Ok((
            path_string(&model)?,
            VrmModelData {
                animations,
                embedded_animations: self
                    .embedded_animations
                    .iter()
                    .map(|(name, _)| name.clone())
                    .collect(),
                profile_path,
            },
        ))
    }
}

pub fn inspect(
    path: &Path,
    sources: &[AnimationSource],
    profile: Option<&Path>,
) -> Result<Prepared, String> {
    if sources.len() > 64 {
        return Err("at most 64 VRMA animations are supported".into());
    }
    let model = read_limited(path, MODEL_LIMIT)?;
    let parsed = parse_glb(&model, false)?;
    let extension_name = if parsed.json["extensions"]["VRM"].is_object() {
        "VRM"
    } else {
        "VRMC_vrm"
    };
    if parsed.json.get("extensionsUsed").is_some()
        && !array(&parsed.json, "extensionsUsed")?
            .iter()
            .any(|name| name == extension_name)
    {
        return Err("missing VRM extension declaration：请使用 VRM 导出器重新导出模型。".into());
    }
    let bones = validate_humanoid(&parsed.json)?;
    let capabilities = inspect_capabilities(&parsed.json, &bones)?;
    let metrics = inspect_metrics(&parsed.json, model.len())?;
    let meta = if parsed.json["extensions"]["VRM"].is_object() {
        &parsed.json["extensions"]["VRM"]["meta"]
    } else {
        &parsed.json["extensions"]["VRMC_vrm"]["meta"]
    };
    let model_name = meta["title"]
        .as_str()
        .or_else(|| meta["name"].as_str())
        .map(|name| name.chars().filter(|c| !c.is_control()).take(128).collect());
    let extras = &parsed.json["extras"]["starlite"];
    let license = if extras["license"].is_null() {
        metadata_license(meta)?
    } else {
        let license: ModelLicense = serde_json::from_value(extras["license"].clone())
            .map_err(|_| "invalid embedded model license")?;
        if license.title.trim().is_empty()
            || license.title.chars().count() > 128
            || license.title.chars().any(char::is_control)
            || license.text.trim().is_empty()
            || license.text.len() > 256 * 1024
            || license.text.contains('\0')
        {
            return Err("invalid embedded model license".into());
        }
        Some(license)
    };
    let embedded_animations = embedded_animations(&parsed)?;
    let mut names: HashSet<_> = embedded_animations
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    let mut animations = Vec::new();
    let mut total = 0;
    for source in sources {
        if source.name.trim().is_empty()
            || source.name.len() > 128
            || source.name.chars().any(char::is_control)
            || source.name == DEFAULT_IDLE_NAME
            || !names.insert(source.name.as_str())
        {
            return Err("invalid or duplicate animation name".into());
        }
        let bytes = read_limited(Path::new(&source.path), ANIMATION_LIMIT)?;
        total += bytes.len();
        if total > MODEL_LIMIT {
            return Err("animation collection exceeds 64 MiB".into());
        }
        let animation = parse_glb(&bytes, true)?;
        let duration = animation_duration(&animation)?;
        animations.push((source.name.clone(), duration, bytes));
    }
    let default_idle = parse_glb(DEFAULT_IDLE, true)?;
    animations.push((
        DEFAULT_IDLE_NAME.into(),
        animation_duration(&default_idle)?,
        DEFAULT_IDLE.into(),
    ));
    names.insert(DEFAULT_IDLE_NAME);
    let (profile, neutral_animation) = if let Some(path) = profile {
        let bytes = read_limited(path, PROFILE_LIMIT)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        validate_profile(&value, &parsed.json, &names)?;
        (
            Some(bytes),
            value["neutralAnimation"].as_str().map(str::to_owned),
        )
    } else if !extras["profile"].is_null() {
        let bytes = serde_json::to_vec(&extras["profile"]).map_err(|e| e.to_string())?;
        if bytes.len() > PROFILE_LIMIT {
            return Err("embedded character profile exceeds size limit".into());
        }
        validate_profile(&extras["profile"], &parsed.json, &names)?;
        (
            Some(bytes),
            extras["profile"]["neutralAnimation"]
                .as_str()
                .map(str::to_owned),
        )
    } else {
        (None, None)
    };
    let mut default_mappings = AnimationMappings {
        idle: neutral_animation.unwrap_or_else(|| {
            if names.contains("Idle") {
                "Idle".into()
            } else {
                DEFAULT_IDLE_NAME.into()
            }
        }),
        working: None,
        completed: None,
        error: None,
        blocked: None,
        approval: None,
        click: vec![],
        ambient: vec![],
    };
    if !extras["mappings"].is_null() {
        default_mappings = serde_json::from_value(extras["mappings"].clone())
            .map_err(|_| "invalid embedded animation mappings")?;
    }
    let catalog: Vec<_> = animations
        .iter()
        .map(|(name, duration, _)| json!({"name":name,"durationMs":duration}))
        .chain(
            embedded_animations
                .iter()
                .map(|(name, duration)| json!({"name":name,"durationMs":duration})),
        )
        .collect();
    settings::validate_mappings(&default_mappings, &catalog)?;
    let source_sha256 = format!("{:x}", Sha256::digest(&model));
    Ok(Prepared {
        source_sha256,
        source_bytes: model.len() as u64,
        model_name,
        license,
        default_mappings,
        capabilities,
        metrics,
        model,
        animations,
        embedded_animations,
        profile,
    })
}

// The VRM metadata records author-supplied permissions, not a grant made by this
// application. Never resolve license URLs or infer permission from missing fields.
fn metadata_license(meta: &Value) -> Result<Option<ModelLicense>, String> {
    if !meta.is_object() {
        return Ok(None);
    }
    let mut entries = Vec::new();
    for (field, label) in [
        ("title", "模型"),
        ("name", "模型"),
        ("version", "版本"),
        ("author", "作者"),
        ("copyrightInformation", "版权信息"),
        ("contactInformation", "作者联系方式"),
        ("reference", "来源"),
        ("licenseName", "许可标识"),
        ("licenseUrl", "许可文件"),
        ("otherLicenseUrl", "补充许可文件"),
        ("otherPermissionUrl", "补充使用条件"),
    ] {
        if let Some(text) = metadata_text(&meta[field])? {
            entries.push(format!("- {label}：{}", markdown_literal(text)));
        }
    }
    for (field, label) in [("authors", "作者"), ("references", "来源")] {
        if let Some(values) = meta[field].as_array() {
            if values.len() > 64 {
                return Err("too many VRM metadata entries".into());
            }
            let text = values
                .iter()
                .map(metadata_text)
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .map(markdown_literal)
                .collect::<Vec<_>>()
                .join("、");
            if !text.is_empty() {
                entries.push(format!("- {label}：{text}"));
            }
        }
    }
    for (field, label) in [
        ("allowedUserName", "角色扮演使用者"),
        ("avatarPermission", "角色扮演使用者"),
        ("violentUssageName", "暴力内容"),
        ("sexualUssageName", "成人内容"),
        ("commercialUssageName", "商业使用"),
        ("commercialUsage", "商业使用"),
        ("creditNotation", "署名"),
        ("modification", "修改模型"),
    ] {
        if let Some(text) = metadata_text(&meta[field])? {
            let description = match text {
                "OnlyAuthor" | "onlyAuthor" => "仅作者",
                "ExplicitlyLicensedPerson" | "onlySeparatelyLicensedPerson" => "另获授权者",
                "Everyone" | "everyone" => "所有人",
                "Disallow" | "prohibited" => "禁止",
                "Allow" => "允许",
                "personalNonProfit" => "个人非商业使用",
                "personalProfit" => "个人营利使用",
                "corporation" => "企业商业使用",
                "required" => "必须署名",
                "unnecessary" => "无需署名",
                "allowModification" => "允许修改",
                "allowModificationRedistribution" => "允许修改并再分发",
                other => other,
            };
            entries.push(format!("- {label}：{}", markdown_literal(description)));
        }
    }
    for (field, label) in [
        ("allowExcessivelyViolentUsage", "过激暴力内容"),
        ("allowExcessivelySexualUsage", "过激成人内容"),
        ("allowPoliticalOrReligiousUsage", "政治或宗教内容"),
        ("allowAntisocialOrHateUsage", "反社会或仇恨内容"),
        ("allowRedistribution", "再分发"),
    ] {
        if let Some(allowed) = meta[field].as_bool() {
            entries.push(format!(
                "- {label}：{}",
                if allowed { "允许" } else { "禁止" }
            ));
        }
    }
    if let Some(text) = metadata_text(&meta["thirdPartyLicenses"])? {
        entries.push(format!("\n## 第三方许可\n\n{text}"));
    }
    if entries.is_empty() {
        return Ok(None);
    }
    let text = format!(
        "# 模型许可信息\n\n以下为模型文件内记录的信息。完整许可以作者提供的条款为准；未列出的权限不代表授权。\n\n{}",
        entries.join("\n")
    );
    if text.len() > 256 * 1024 {
        return Err("VRM license metadata exceeds size limit".into());
    }
    let title = meta["title"]
        .as_str()
        .or_else(|| meta["name"].as_str())
        .unwrap_or("VRM 模型")
        .chars()
        .filter(|c| !c.is_control())
        .take(128)
        .collect::<String>();
    Ok(Some(ModelLicense {
        title: if title.trim().is_empty() {
            "VRM 模型".into()
        } else {
            title
        },
        text,
    }))
}

fn metadata_text(value: &Value) -> Result<Option<&str>, String> {
    let Some(text) = value.as_str().filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    if text.len() > 64 * 1024
        || text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("invalid VRM license metadata".into());
    }
    Ok(Some(text))
}

fn markdown_literal(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '(' | ')' | '#') {
            escaped.push('\\');
        }
        escaped.push(if matches!(c, '\n' | '\r' | '\t') {
            ' '
        } else {
            c
        });
    }
    escaped
}

fn read_limited(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err("invalid asset size or file type".into());
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("asset exceeds byte limit".into());
    }
    Ok(bytes)
}

struct Glb<'a> {
    json: Value,
    bin: &'a [u8],
}
fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, String> {
    Ok(u32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or("truncated GLB")?
            .try_into()
            .map_err(|_| "truncated GLB")?,
    ))
}
fn array<'a>(value: &'a Value, key: &str) -> Result<&'a [Value], String> {
    match value.get(key) {
        None => Ok(&[]),
        Some(Value::Array(a)) => Ok(a),
        _ => Err(format!("invalid {key} array")),
    }
}
fn index(value: &Value, size: usize) -> Result<usize, String> {
    let i = value
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or("invalid resource index")?;
    if i >= size {
        Err("resource index out of bounds".into())
    } else {
        Ok(i)
    }
}
fn offset(value: &Value) -> Result<usize, String> {
    if value.is_null() {
        Ok(0)
    } else {
        value
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| "invalid byte offset".into())
    }
}
fn parse_glb(bytes: &[u8], animation: bool) -> Result<Glb<'_>, String> {
    if bytes.len() < 20
        || bytes.len()
            > if animation {
                ANIMATION_LIMIT
            } else {
                MODEL_LIMIT
            }
        || u32_at(bytes, 0)? != 0x46546c67
        || u32_at(bytes, 4)? != 2
        || u32_at(bytes, 8)? as usize != bytes.len()
    {
        return Err("invalid GLB header or size：请使用完整的二进制 VRM / VRMA 文件（模型不超过 64 MiB，单个动作不超过 16 MiB）；FBX 或普通 JSON glTF 不能直接导入。".into());
    }
    let mut at = 12;
    let mut count = 0;
    let mut value = None;
    let mut bin = &[][..];
    while at < bytes.len() {
        let size = u32_at(bytes, at)? as usize;
        let kind = u32_at(bytes, at + 4)?;
        at += 8;
        if size % 4 != 0 || size > bytes.len() - at {
            return Err("invalid GLB chunk size：文件不完整或已损坏，请重新下载或导出。".into());
        }
        match (count, kind) {
            (0, 0x4e4f534a) => {
                if size > 8 * 1024 * 1024 {
                    return Err("GLB JSON exceeds 8 MiB".into());
                }
                value = Some(
                    serde_json::from_slice::<Value>(&bytes[at..at + size])
                        .map_err(|_| "invalid GLB JSON：请使用 VRM 导出器重新导出文件。")?,
                )
            }
            (1, 0x004e4942) => bin = &bytes[at..at + size],
            _ => return Err("unexpected GLB chunk：请重新导出单文件 VRM / VRMA。".into()),
        }
        at += size;
        count += 1;
    }
    let json = value.ok_or("GLB JSON is missing")?;
    if json["asset"]["version"] != "2.0" {
        return Err("glTF 2.0 is required：请使用 VRM 0.0 / 1.0 导出器。".into());
    }
    let ext = &json["extensions"];
    if animation {
        if ext["VRMC_vrm_animation"]["specVersion"] != "1.0" {
            return Err("VRMA 1.0 is required".into());
        }
    } else if ext["VRM"].is_object() {
        if ext["VRM"]["specVersion"] != "0.0" || ext["VRMC_vrm"].is_object() {
            return Err("unsupported VRM version：请导出 VRM 0.0 或 1.0。".into());
        }
    } else if ext["VRMC_vrm"]["specVersion"] != "1.0" {
        return Err("VRM 0 or VRM 1 is required：普通 GLB、FBX 需要先通过 VRM 导出器转换。".into());
    }
    let allowed = [
        "VRM",
        "VRMC_vrm",
        "VRMC_vrm_animation",
        "VRMC_materials_mtoon",
        "VRMC_springBone",
        "VRMC_node_constraint",
        "VRMC_materials_hdr_emissiveMultiplier",
        "KHR_materials_unlit",
        "KHR_texture_transform",
        "KHR_materials_emissive_strength",
    ];
    if array(&json, "extensionsRequired")?
        .iter()
        .any(|v| !v.as_str().is_some_and(|s| allowed.contains(&s)))
    {
        return Err(
            "unsupported required glTF extension：请关闭额外的几何或贴图压缩扩展后重新导出。"
                .into(),
        );
    }
    reject_uris(&json, 0)?;
    let buffers = array(&json, "buffers")?;
    if buffers.len() > 1
        || buffers.first().is_some_and(|v| {
            v["byteLength"]
                .as_u64()
                .is_none_or(|n| n > bin.len() as u64)
        })
    {
        return Err("invalid GLB buffer".into());
    }
    let views = array(&json, "bufferViews")?;
    for view in views {
        let start = offset(&view["byteOffset"])?;
        let length = offset(&view["byteLength"])?;
        if view["buffer"] != 0
            || start.checked_add(length).is_none_or(|n| {
                n > buffers
                    .first()
                    .and_then(|b| b["byteLength"].as_u64())
                    .unwrap_or(0) as usize
            })
        {
            return Err("invalid buffer view".into());
        }
    }
    let nodes = array(&json, "nodes")?;
    let accessors = array(&json, "accessors")?;
    if nodes.len() > 4096 || accessors.len() > 32768 {
        return Err("glTF resource limit exceeded".into());
    }
    let mut active = HashSet::new();
    let mut visited = HashSet::new();
    let mut parents = HashSet::new();
    for i in 0..nodes.len() {
        walk_nodes(nodes, i, &mut active, &mut visited, &mut parents, 0)?
    }
    let mut decoded = 0usize;
    for a in accessors {
        let components = match a["type"].as_str() {
            Some("SCALAR") => 1,
            Some("VEC2") => 2,
            Some("VEC3") => 3,
            Some("VEC4" | "MAT2") => 4,
            Some("MAT3") => 9,
            Some("MAT4") => 16,
            _ => return Err("invalid accessor type".into()),
        };
        let width = component_size(&a["componentType"])?;
        let count = offset(&a["count"])?;
        if count == 0 || count > 2_000_000 {
            return Err("invalid accessor allocation".into());
        }
        let element = match a["type"].as_str() {
            Some("MAT2") => ((2 * width).div_ceil(4)) * 4 * 2,
            Some("MAT3") => ((3 * width).div_ceil(4)) * 4 * 3,
            _ => components * width,
        };
        decoded += count * element;
        if decoded > 256 * 1024 * 1024 {
            return Err("decoded geometry exceeds 256 MiB".into());
        }
        if !a["bufferView"].is_null() {
            let start = span(
                views,
                &a["bufferView"],
                &a["byteOffset"],
                count,
                element,
                width,
                true,
            )?;
            if a["componentType"] == 5126 {
                let view = &views[index(&a["bufferView"], views.len())?];
                let stride = view["byteStride"].as_u64().unwrap_or(element as u64) as usize;
                finite_floats(bin, start, count, components, stride)?;
            }
        }
        if a["sparse"].is_object() {
            let s = &a["sparse"];
            let n = offset(&s["count"])?;
            if n == 0
                || n > count
                || !matches!(
                    s["indices"]["componentType"].as_u64(),
                    Some(5121 | 5123 | 5125)
                )
            {
                return Err("invalid sparse accessor".into());
            }
            let iw = component_size(&s["indices"]["componentType"])?;
            let start = span(
                views,
                &s["indices"]["bufferView"],
                &s["indices"]["byteOffset"],
                n,
                iw,
                iw,
                false,
            )?;
            let values_start = span(
                views,
                &s["values"]["bufferView"],
                &s["values"]["byteOffset"],
                n,
                element,
                width,
                false,
            )?;
            if a["componentType"] == 5126 {
                finite_floats(bin, values_start, n, components, element)?;
            }
            let mut last = None;
            for k in 0..n {
                let pos = start + k * iw;
                let next = match iw {
                    1 => bin[pos] as usize,
                    2 => u16::from_le_bytes(
                        bin[pos..pos + 2]
                            .try_into()
                            .map_err(|_| "invalid sparse index")?,
                    ) as usize,
                    _ => u32_at(bin, pos)? as usize,
                };
                if next >= count || last.is_some_and(|previous| next <= previous) {
                    return Err("invalid sparse index".into());
                }
                last = Some(next)
            }
        }
    }
    for mesh in array(&json, "meshes")? {
        for primitive in array(mesh, "primitives")? {
            let attributes = primitive["attributes"]
                .as_object()
                .ok_or("missing mesh attributes")?;
            for a in attributes.values() {
                index(a, accessors.len())?;
            }
            let positions =
                &accessors[index(&primitive["attributes"]["POSITION"], accessors.len())?];
            if positions["type"] != "VEC3" || positions["componentType"] != 5126 {
                return Err("invalid mesh positions".into());
            }
            for target in array(primitive, "targets")? {
                for a in target.as_object().ok_or("invalid morph target")?.values() {
                    let morph = &accessors[index(a, accessors.len())?];
                    if morph["count"] != positions["count"]
                        || morph["type"] != "VEC3"
                        || morph["componentType"] != 5126
                    {
                        return Err("invalid morph accessor".into());
                    }
                }
            }
            if !primitive["indices"].is_null() {
                index(&primitive["indices"], accessors.len())?;
            }
        }
    }
    for skin in array(&json, "skins")? {
        let joints = array(skin, "joints")?;
        if joints.is_empty() || joints.len() > 256 {
            return Err("invalid skin joints".into());
        }
        for joint in joints {
            index(joint, nodes.len())?;
        }
    }
    Ok(Glb { json, bin })
}
fn finite_floats(
    bin: &[u8],
    start: usize,
    count: usize,
    components: usize,
    stride: usize,
) -> Result<(), String> {
    for i in 0..count {
        for c in 0..components {
            if !f32::from_bits(u32_at(bin, start + i * stride + c * 4)?).is_finite() {
                return Err("non-finite accessor value".into());
            }
        }
    }
    Ok(())
}

fn component_size(value: &Value) -> Result<usize, String> {
    match value.as_u64() {
        Some(5120 | 5121) => Ok(1),
        Some(5122 | 5123) => Ok(2),
        Some(5125 | 5126) => Ok(4),
        _ => Err("invalid accessor component".into()),
    }
}
fn span(
    views: &[Value],
    view: &Value,
    start: &Value,
    count: usize,
    element: usize,
    alignment: usize,
    strided: bool,
) -> Result<usize, String> {
    let view = &views[index(view, views.len())?];
    let at = offset(start)?;
    let size = offset(&view["byteLength"])?;
    let stride = if strided && !view["byteStride"].is_null() {
        offset(&view["byteStride"])?
    } else {
        element
    };
    if stride < element
        || stride > 256
        || stride % alignment != 0
        || at % alignment != 0
        || at
            .checked_add((count - 1) * stride + element)
            .is_none_or(|n| n > size)
    {
        return Err("accessor exceeds buffer view".into());
    }
    Ok(offset(&view["byteOffset"])? + at)
}
fn reject_uris(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 64 {
        return Err("glTF nesting limit exceeded".into());
    }
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if key == "uri" {
                    return Err("external glTF resources are not supported：请将全部贴图和缓冲区内嵌到同一个 VRM / VRMA 文件后重新导出。".into());
                }
                reject_uris(value, depth + 1)?
            }
        }
        Value::Array(values) => {
            for value in values {
                reject_uris(value, depth + 1)?
            }
        }
        _ => (),
    }
    Ok(())
}
fn walk_nodes(
    nodes: &[Value],
    i: usize,
    active: &mut HashSet<usize>,
    visited: &mut HashSet<usize>,
    parents: &mut HashSet<usize>,
    depth: usize,
) -> Result<(), String> {
    if active.contains(&i) || depth > 128 {
        return Err("invalid node hierarchy".into());
    }
    if !visited.insert(i) {
        return Ok(());
    }
    active.insert(i);
    for child in array(&nodes[i], "children")? {
        let child = index(child, nodes.len())?;
        if !parents.insert(child) {
            return Err("node has multiple parents".into());
        }
        walk_nodes(nodes, child, active, visited, parents, depth + 1)?;
    }
    active.remove(&i);
    Ok(())
}
const REQUIRED_HUMAN_BONES: [&str; 15] = [
    "hips",
    "spine",
    "head",
    "leftUpperLeg",
    "leftLowerLeg",
    "leftFoot",
    "leftUpperArm",
    "leftLowerArm",
    "leftHand",
    "rightUpperLeg",
    "rightLowerLeg",
    "rightFoot",
    "rightUpperArm",
    "rightLowerArm",
    "rightHand",
];
fn optional_human_bones() -> Vec<String> {
    let mut names: Vec<String> = ["chest", "upperChest", "neck", "jaw"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    for side in ["left", "right"] {
        for part in [
            "Eye",
            "Shoulder",
            "Toes",
            "ThumbMetacarpal",
            "ThumbProximal",
            "ThumbIntermediate",
            "ThumbDistal",
        ] {
            names.push(format!("{side}{part}"));
        }
        for finger in ["Index", "Middle", "Ring", "Little"] {
            for part in ["Proximal", "Intermediate", "Distal"] {
                names.push(format!("{side}{finger}{part}"));
            }
        }
    }
    names
}
fn validate_humanoid(json: &Value) -> Result<BTreeMap<String, usize>, String> {
    let optional = optional_human_bones();
    let known: HashSet<&str> = REQUIRED_HUMAN_BONES
        .into_iter()
        .chain(optional.iter().map(String::as_str))
        .collect();
    let node_count = array(json, "nodes")?.len();
    let vrm0 = json["extensions"]["VRM"].is_object();
    let human = if vrm0 {
        &json["extensions"]["VRM"]["humanoid"]["humanBones"]
    } else {
        &json["extensions"]["VRMC_vrm"]["humanoid"]["humanBones"]
    };
    let entries: Vec<(&str, &Value)> = if vrm0 {
        let mut entries = Vec::new();
        for bone in human.as_array().into_iter().flatten() {
            let name = bone["bone"]
                .as_str()
                .ok_or("invalid humanoid bone：人形骨骼条目缺少标准名称，请重新导出 VRM。")?;
            entries.push((name, bone));
        }
        entries
    } else {
        human
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, bone)| (name.as_str(), bone))
            .collect()
    };
    let mut bones = BTreeMap::new();
    let mut used = BTreeMap::new();
    let mut invalid = Vec::new();
    let mut duplicate = Vec::new();
    let mut all_names = HashSet::new();
    for (name, bone) in entries {
        // Restrict diagnostic names to the public humanoid vocabulary; model
        // authored names and URI-like strings are never copied into errors.
        if !known.contains(name) {
            if !all_names.insert(name) {
                return Err(
                    "duplicate humanoid bone：额外的人形骨骼条目重复，请在导出器中移除重复映射。"
                        .into(),
                );
            }
            index(&bone["node"], node_count).map_err(|_| {
                "invalid humanoid bone：额外的人形骨骼条目引用了无效节点，请重新导出 VRM。"
            })?;
            continue;
        }
        all_names.insert(name);
        if bones.contains_key(name) {
            duplicate.push(name);
        }
        match index(&bone["node"], node_count) {
            Ok(node) => {
                if let Some(previous) = used.insert(node, name) {
                    if previous != name {
                        duplicate.extend([previous, name]);
                    }
                }
                bones.insert(name.to_owned(), node);
            }
            Err(_) => invalid.push(name),
        }
    }
    let missing: Vec<&str> = REQUIRED_HUMAN_BONES
        .into_iter()
        .filter(|name| !bones.contains_key(*name) && !invalid.contains(name))
        .collect();
    if !missing.is_empty() || !invalid.is_empty() || !duplicate.is_empty() {
        invalid.sort_unstable();
        invalid.dedup();
        duplicate.sort_unstable();
        duplicate.dedup();
        let mut issues = Vec::new();
        if !missing.is_empty() {
            issues.push(format!("缺少：{}", missing.join(", ")));
        }
        if !invalid.is_empty() {
            issues.push(format!("节点无效：{}", invalid.join(", ")));
        }
        if !duplicate.is_empty() {
            issues.push(format!("重复绑定：{}", duplicate.join(", ")));
        }
        return Err(format!("invalid required humanoid bone：{}。请在 VRM 导出器中为这些人形骨骼指定有效、互不重复的骨骼节点后重新导出。", issues.join("；")));
    }
    Ok(bones)
}
fn vrm_extension(model: &Value) -> (&Value, bool) {
    let vrm0 = model["extensions"]["VRM"].is_object();
    (
        &model["extensions"][if vrm0 { "VRM" } else { "VRMC_vrm" }],
        vrm0,
    )
}
fn canonical_vrm0_preset(name: &str) -> Option<&'static str> {
    Some(match name {
        "a" => "aa",
        "e" => "ee",
        "i" => "ih",
        "o" => "oh",
        "u" => "ou",
        "joy" => "happy",
        "angry" => "angry",
        "sorrow" => "sad",
        "fun" => "relaxed",
        "neutral" => "neutral",
        "blink" => "blink",
        "blink_l" => "blinkLeft",
        "blink_r" => "blinkRight",
        "lookup" => "lookUp",
        "lookdown" => "lookDown",
        "lookleft" => "lookLeft",
        "lookright" => "lookRight",
        _ => return None,
    })
}
fn registered_vrm0_name(expression: &Value) -> Option<&str> {
    expression["presetName"]
        .as_str()
        .and_then(canonical_vrm0_preset)
        .or_else(|| expression["name"].as_str())
}
fn expression_for<'a>(model: &'a Value, canonical_name: &str) -> Result<Option<&'a Value>, String> {
    let (extension, vrm0) = vrm_extension(model);
    if vrm0 {
        Ok(array(&extension["blendShapeMaster"], "blendShapeGroups")?
            .iter()
            .find(|expression| registered_vrm0_name(expression) == Some(canonical_name)))
    } else {
        Ok(extension["expressions"]["preset"].get(canonical_name))
    }
}
fn morph_expression_usable(
    model: &Value,
    expression: &Value,
    name: &str,
    blink: bool,
) -> Result<bool, String> {
    let (_, vrm0) = vrm_extension(model);
    let label = if blink { "眨眼" } else { "视线" };
    let problem = |detail: &str| {
        format!("{label}表达（{name}）{detail}。请在 VRM 导出器中检查网格、形态键索引和权重后重新导出。")
    };
    if !expression.is_object() {
        return Err(problem("格式无效"));
    }
    let binds = array(expression, if vrm0 { "binds" } else { "morphTargetBinds" })
        .map_err(|_| problem("绑定列表无效"))?;
    if binds.len() > 256 {
        return Err(problem("绑定数量超过 256 个"));
    }
    let meshes = array(model, "meshes")?;
    let nodes = array(model, "nodes")?;
    let accessors = array(model, "accessors")?;
    let mut usable = false;
    for bind in binds {
        let mesh = if vrm0 {
            index(&bind["mesh"], meshes.len())
        } else {
            index(&bind["node"], nodes.len())
                .and_then(|node| index(&nodes[node]["mesh"], meshes.len()))
        }
        .map_err(|_| problem("引用了无效的模型网格"))?;
        let target = bind["index"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| problem("的形态键索引无效"))?;
        let primitives = array(&meshes[mesh], "primitives")?;
        if primitives.is_empty()
            || primitives.iter().any(|primitive| {
                !array(primitive, "targets").is_ok_and(|targets| target < targets.len())
            })
        {
            return Err(problem("引用了不存在的形态键"));
        }
        let weight = bind["weight"]
            .as_f64()
            .filter(|weight| {
                weight.is_finite() && (0.0..=if vrm0 { 100.0 } else { 1.0 }).contains(weight)
            })
            .ok_or_else(|| problem("的形态键权重无效"))?;
        let instantiated = !vrm0
            || nodes
                .iter()
                .any(|node| node["mesh"].as_u64() == Some(mesh as u64));
        let has_morphs = primitives.iter().all(|primitive| {
            array(primitive, "targets").is_ok_and(|targets| {
                targets.iter().any(|target| {
                    ["POSITION", "NORMAL", "COLOR_0"]
                        .iter()
                        .any(|semantic| index(&target[*semantic], accessors.len()).is_ok())
                })
            })
        });
        usable |= weight > 0.0 && instantiated && has_morphs;
    }
    Ok(usable)
}
fn validate_blink_bindings(model: &Value) -> Result<(), String> {
    let (extension, vrm0) = vrm_extension(model);
    if vrm0 {
        let Some(master) = extension.get("blendShapeMaster") else {
            return Ok(());
        };
        if !master.is_object() {
            return Err("眨眼表达格式无效：invalid VRM blendShapeMaster。请重新导出 VRM。".into());
        }
        for expression in array(master, "blendShapeGroups")? {
            if let Some(name @ ("blink" | "blinkLeft" | "blinkRight")) =
                registered_vrm0_name(expression)
            {
                morph_expression_usable(model, expression, name, true)?;
            }
        }
    } else if let Some(expressions) = extension.get("expressions") {
        if !expressions.is_object() {
            return Err("眨眼表达格式无效：invalid VRM expressions。请重新导出 VRM。".into());
        }
        if let Some(presets) = expressions.get("preset") {
            if !presets.is_object() {
                return Err(
                    "眨眼表达格式无效：invalid VRM expression presets。请重新导出 VRM。".into(),
                );
            }
            for name in ["blink", "blinkLeft", "blinkRight"] {
                if let Some(expression) = presets.get(name) {
                    morph_expression_usable(model, expression, name, true)?;
                }
            }
        }
    }
    Ok(())
}
fn inspect_capabilities(model: &Value, bones: &BTreeMap<String, usize>) -> Result<Value, String> {
    validate_blink_bindings(model)?;
    let usable = |name, blink| {
        expression_for(model, name)?
            .map(|expression| morph_expression_usable(model, expression, name, blink))
            .transpose()
            .map(|value| value.unwrap_or(false))
    };
    let combined = usable("blink", true)?;
    let left = usable("blinkLeft", true)?;
    let right = usable("blinkRight", true)?;
    let optional: Vec<_> = optional_human_bones()
        .into_iter()
        .filter(|name| bones.contains_key(name))
        .collect();
    Ok(
        json!({"humanoid":{"requiredBones":REQUIRED_HUMAN_BONES,"optionalBones":optional},
        "blink":{"automatic":combined || (left && right),"combined":combined,"left":left,"right":right},
        "lookAt":inspect_look_at(model, bones)?}),
    )
}
fn inspect_look_at(model: &Value, bones: &BTreeMap<String, usize>) -> Result<Value, String> {
    let (extension, vrm0) = vrm_extension(model);
    let empty = json!({"mode":"none","head":true,"eyes":false,"horizontal":false,"vertical":false});
    let Some(look_at) = extension.get(if vrm0 { "firstPerson" } else { "lookAt" }) else {
        return Ok(empty);
    };
    if !look_at.is_object() {
        return Err("视线配置格式无效，请重新导出 VRM。".into());
    }
    // three-vrm requires an expression manager even for bone-driven lookAt.
    if extension
        .get(if vrm0 {
            "blendShapeMaster"
        } else {
            "expressions"
        })
        .is_none_or(Value::is_null)
    {
        return Ok(empty);
    }
    let kind = &look_at[if vrm0 { "lookAtTypeName" } else { "type" }];
    if !kind.is_null()
        && !kind.as_str().is_some_and(|name| {
            if vrm0 {
                ["Bone", "BlendShape"].contains(&name)
            } else {
                ["bone", "expression"].contains(&name)
            }
        })
    {
        return Err("视线类型无效，请在 VRM 导出器中选择骨骼或表达视线模式。".into());
    }
    let expression_mode = kind == if vrm0 { "BlendShape" } else { "expression" };
    let scale = |key| -> Result<f64, String> {
        let range = &look_at[key];
        if !range.is_null() && !range.is_object() {
            return Err("视线角度范围格式无效，请重新导出 VRM。".into());
        }
        for field in [
            if vrm0 { "xRange" } else { "inputMaxValue" },
            if vrm0 { "yRange" } else { "outputScale" },
        ] {
            if !range[field].is_null()
                && !range[field]
                    .as_f64()
                    .is_some_and(|value| value.is_finite() && value >= 0.0)
            {
                return Err("视线角度范围无效，请设置有限、非负的输入和输出角度。".into());
            }
        }
        Ok(range[if vrm0 { "yRange" } else { "outputScale" }]
            .as_f64()
            .unwrap_or(if expression_mode { 1.0 } else { 10.0 }))
    };
    let horizontal = scale(if vrm0 {
        "lookAtHorizontalOuter"
    } else {
        "rangeMapHorizontalOuter"
    })?;
    let inner = scale(if vrm0 {
        "lookAtHorizontalInner"
    } else {
        "rangeMapHorizontalInner"
    })?;
    let up = scale(if vrm0 {
        "lookAtVerticalUp"
    } else {
        "rangeMapVerticalUp"
    })?;
    let down = scale(if vrm0 {
        "lookAtVerticalDown"
    } else {
        "rangeMapVerticalDown"
    })?;
    let (horizontal, vertical) = if expression_mode {
        let usable = |name| {
            expression_for(model, name)?
                .map(|expression| morph_expression_usable(model, expression, name, false))
                .transpose()
                .map(|value| value.unwrap_or(false))
        };
        // Validate each declared direction even when the other half is absent.
        let left_usable = usable("lookLeft")?;
        let right_usable = usable("lookRight")?;
        let up_usable = usable("lookUp")?;
        let down_usable = usable("lookDown")?;
        (
            horizontal > 0.0 && left_usable && right_usable,
            up > 0.0 && down > 0.0 && up_usable && down_usable,
        )
    } else {
        let eyes = bones.contains_key("leftEye") || bones.contains_key("rightEye");
        (
            eyes && (horizontal > 0.0 || inner > 0.0),
            eyes && (up > 0.0 || down > 0.0),
        )
    };
    Ok(
        json!({"mode":if expression_mode {"expression"} else {"bone"},"head":true,"eyes":horizontal || vertical,"horizontal":horizontal,"vertical":vertical}),
    )
}
fn inspect_metrics(model: &Value, file_bytes: usize) -> Result<Value, String> {
    let meshes = array(model, "meshes")?;
    let accessors = array(model, "accessors")?;
    let mut primitive_count = 0_u64;
    let mut vertex_count = 0_u64;
    let mut triangle_count = 0_u64;
    let mut morph_target_count = 0_u64;
    for mesh in meshes {
        for primitive in array(mesh, "primitives")? {
            primitive_count += 1;
            let positions =
                &accessors[index(&primitive["attributes"]["POSITION"], accessors.len())?];
            let vertices = positions["count"]
                .as_u64()
                .ok_or("invalid mesh positions")?;
            let indices = if primitive["indices"].is_null() {
                vertices
            } else {
                accessors[index(&primitive["indices"], accessors.len())?]["count"]
                    .as_u64()
                    .ok_or("invalid mesh indices")?
            };
            vertex_count += vertices;
            triangle_count += match primitive["mode"].as_u64().unwrap_or(4) {
                4 => indices / 3,
                5 | 6 => indices.saturating_sub(2),
                _ => 0,
            };
            morph_target_count += array(primitive, "targets")?.len() as u64;
        }
    }
    let mut decoded = 0_u64;
    for accessor in accessors {
        let width = component_size(&accessor["componentType"])? as u64;
        let components = match accessor["type"].as_str() {
            Some("SCALAR") => 1,
            Some("VEC2") => 2,
            Some("VEC3") => 3,
            Some("VEC4") => 4,
            Some("MAT2") => (2 * width).div_ceil(4) * 4 * 2 / width,
            Some("MAT3") => (3 * width).div_ceil(4) * 4 * 3 / width,
            Some("MAT4") => 16,
            _ => return Err("invalid accessor type".into()),
        };
        decoded += accessor["count"]
            .as_u64()
            .ok_or("invalid accessor allocation")?
            * width
            * components;
    }
    // This is logical decoded accessor storage, not a GPU/process measurement.
    Ok(
        json!({"fileBytes":file_bytes,"nodeCount":array(model,"nodes")?.len(),"meshCount":meshes.len(),"primitiveCount":primitive_count,"materialCount":array(model,"materials")?.len(),"textureCount":array(model,"textures")?.len(),"imageCount":array(model,"images")?.len(),"vertexCount":vertex_count,"triangleCount":triangle_count,"morphTargetCount":morph_target_count,"decodedAccessorBytes":decoded}),
    )
}
fn animation_duration(glb: &Glb<'_>) -> Result<f64, String> {
    let animations = array(&glb.json, "animations")?;
    if animations.len() != 1 {
        return Err("VRMA must contain exactly one animation".into());
    }
    clip_duration(glb, &animations[0])
}

fn embedded_animations(glb: &Glb<'_>) -> Result<Vec<(String, f64)>, String> {
    let animations = array(&glb.json, "animations")?;
    if animations.len() > 64 {
        return Err("at most 64 embedded animations are supported".into());
    }
    let mut names = HashSet::new();
    animations
        .iter()
        .enumerate()
        .map(|(index, animation)| {
            let name = animation["name"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Animation_{}", index + 1));
            if name.trim().is_empty()
                || name.len() > 128
                || name.chars().any(char::is_control)
                || name == DEFAULT_IDLE_NAME
                || !names.insert(name.clone())
            {
                return Err("invalid or duplicate embedded animation name".into());
            }
            Ok((name, clip_duration(glb, animation)?))
        })
        .collect()
}

fn clip_duration(glb: &Glb<'_>, animation: &Value) -> Result<f64, String> {
    let accessors = array(&glb.json, "accessors")?;
    let views = array(&glb.json, "bufferViews")?;
    let samplers = array(animation, "samplers")?;
    let nodes = array(&glb.json, "nodes")?;
    let mut duration = 0.0_f64;
    let channels = array(animation, "channels")?;
    if channels.is_empty() || channels.len() > 4096 || samplers.is_empty() || samplers.len() > 4096
    {
        return Err("animation channels are empty or exceed limits".into());
    }
    let mut targets = HashSet::new();
    for channel in channels {
        let sampler = &samplers[index(&channel["sampler"], samplers.len())?];
        index(&channel["target"]["node"], nodes.len())?;
        let path = channel["target"]["path"]
            .as_str()
            .ok_or("invalid animation channel")?;
        if !targets.insert((channel["target"]["node"].as_u64(), path)) {
            return Err("duplicate animation target".into());
        }
        let input = &accessors[index(&sampler["input"], accessors.len())?];
        let output = &accessors[index(&sampler["output"], accessors.len())?];
        let multiplier = if sampler["interpolation"] == "CUBICSPLINE" {
            3
        } else {
            1
        };
        let expected_count = offset(&input["count"])?
            .checked_mul(multiplier)
            .ok_or("invalid animation output")?;
        let output_count = offset(&output["count"])?;
        let valid_output = match path {
            "translation" | "scale" => output["type"] == "VEC3" && output_count == expected_count,
            "rotation" => output["type"] == "VEC4" && output_count == expected_count,
            "weights" => {
                output["type"] == "SCALAR"
                    && expected_count > 0
                    && output_count % expected_count == 0
                    && output_count / expected_count <= 256
            }
            _ => false,
        };
        if !valid_output || output["componentType"] != 5126 {
            return Err("invalid animation output".into());
        }
    }
    for sampler in samplers {
        index(&sampler["output"], accessors.len())?;
        if !sampler["interpolation"].is_null()
            && !matches!(
                sampler["interpolation"].as_str(),
                Some("LINEAR" | "STEP" | "CUBICSPLINE")
            )
        {
            return Err("invalid animation interpolation".into());
        }
        let a = &accessors[index(&sampler["input"], accessors.len())?];
        if a["type"] != "SCALAR"
            || a["componentType"] != 5126
            || !a["sparse"].is_null()
            || a["bufferView"].is_null()
        {
            return Err("invalid animation timeline".into());
        }
        let count = offset(&a["count"])?;
        let start = span(
            views,
            &a["bufferView"],
            &a["byteOffset"],
            count,
            4,
            4,
            false,
        )?;
        let mut last = -1.0;
        for i in 0..count {
            let time = f32::from_bits(u32_at(glb.bin, start + i * 4)?) as f64;
            if !time.is_finite() || time <= last || !(0.0..=600.0).contains(&time) {
                return Err("invalid animation times".into());
            }
            last = time;
        }
        if a["max"][0]
            .as_f64()
            .is_none_or(|n| (n - last).abs() > 0.001)
        {
            return Err("animation duration does not match timeline".into());
        }
        duration = duration.max(last);
    }
    if let Some(expressions) = animation["extras"]["starlite"]["expressions"].as_object() {
        if expressions.len() > 64 {
            return Err("too many animated expressions".into());
        }
        for (name, sampler) in expressions {
            if name.trim().is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
                return Err("invalid animated expression name".into());
            }
            let sampler = &samplers[index(sampler, samplers.len())?];
            let input = &accessors[index(&sampler["input"], accessors.len())?];
            let output = &accessors[index(&sampler["output"], accessors.len())?];
            let multiplier = if sampler["interpolation"] == "CUBICSPLINE" {
                3
            } else {
                1
            };
            if output["type"] != "SCALAR"
                || output["componentType"] != 5126
                || offset(&output["count"])? != offset(&input["count"])? * multiplier
            {
                return Err("invalid animated expression values".into());
            }
        }
    } else if !animation["extras"]["starlite"]["expressions"].is_null() {
        return Err("invalid animated expressions".into());
    }
    if duration <= 0.0 {
        return Err("animation duration must be positive".into());
    }
    Ok(duration * 1000.0)
}

fn validate_profile(
    profile: &Value,
    model: &Value,
    animations: &HashSet<&str>,
) -> Result<(), String> {
    if profile["schemaVersion"] != 1 || profile["type"] != "weiguang" {
        return Err("unsupported character profile".into());
    }
    if !profile["neutralAnimation"].is_null() && !profile["neutralAnimation"].is_string() {
        return Err("invalid neutral animation".into());
    }
    if let Some(name) = profile["neutralAnimation"].as_str() {
        if !animations.contains(name) {
            return Err("profile neutral animation is missing".into());
        }
    }
    let nodes: HashSet<_> = array(model, "nodes")?
        .iter()
        .filter_map(|v| v["name"].as_str())
        .collect();
    let ears = array(profile, "earBones")?;
    if !profile["earBones"].is_array() || ears.len() > 32 {
        return Err("too many ear bones".into());
    }
    for ear in ears {
        if !ear.as_str().is_some_and(|name| nodes.contains(name)) {
            return Err("profile ear bone is missing".into());
        }
    }
    let poses = profile["earPoses"].as_object().ok_or("missing ear poses")?;
    if !profile["earPoses"]["Neutral"].is_object()
        || ears.iter().any(|ear| {
            profile["earPoses"]["Neutral"]
                .get(ear.as_str().unwrap_or(""))
                .is_none()
        })
    {
        return Err("neutral ear pose is missing".into());
    }
    for pose in poses
        .values()
        .chain(std::iter::once(&profile["neutralPose"]))
    {
        let bones = pose.as_object().ok_or("invalid bone poses")?;
        if bones.len() > 256 {
            return Err("too many bone poses".into());
        }
        for bone in bones.values() {
            let rotation = array(bone, "rotation")?;
            if rotation.len() != 4
                || rotation.iter().any(|v| {
                    v.as_f64()
                        .is_none_or(|n| !n.is_finite() || !(-1.0..=1.0).contains(&n))
                })
                || (rotation
                    .iter()
                    .map(|v| v.as_f64().unwrap_or(0.0).powi(2))
                    .sum::<f64>()
                    .sqrt()
                    - 1.0)
                    .abs()
                    > 0.01
            {
                return Err("invalid bone rotation".into());
            }
            if !bone["position"].is_null() {
                let p = array(bone, "position")?;
                if p.len() != 3
                    || p.iter()
                        .any(|v| v.as_f64().is_none_or(|n| !(-10.0..=10.0).contains(&n)))
                {
                    return Err("invalid bone position".into());
                }
            }
        }
    }
    let expressions = profile["expressions"]
        .as_object()
        .ok_or("missing expression mapping")?;
    if expressions.len() > 64 {
        return Err("too many expressions".into());
    }
    let morphs: HashSet<_> = array(model, "meshes")?
        .iter()
        .flat_map(|mesh| {
            mesh["extras"]["targetNames"]
                .as_array()
                .into_iter()
                .flatten()
        })
        .filter_map(Value::as_str)
        .collect();
    for (name, value) in expressions {
        if value["expression"].as_str().is_none_or(str::is_empty) {
            return Err("invalid expression name".into());
        }
        if !value["blink"].is_null() && !value["blink"].is_string() {
            return Err("invalid blink morph name".into());
        }
        if let Some(blink) = value["blink"].as_str() {
            if !morphs.contains(blink) {
                return Err("profile blink morph is missing".into());
            }
        }
        for ear in ears {
            if poses
                .get(name)
                .and_then(|p| p.get(ear.as_str().unwrap_or("")))
                .is_none()
            {
                return Err("incomplete ear poses".into());
            }
        }
    }
    for key in ["collar", "cone"] {
        if !profile["accessories"][key]
            .as_str()
            .is_some_and(|name| nodes.contains(name))
        {
            return Err("profile accessory is missing".into());
        }
    }
    for key in ["collarVisible", "coneVisible"] {
        if !profile["accessories"][key].is_boolean() {
            return Err("invalid accessory visibility".into());
        }
    }
    let period = profile["blink"]["period"]
        .as_f64()
        .filter(|n| (1.0..=60.0).contains(n))
        .ok_or("invalid blink period")?;
    let curve = array(&profile["blink"], "curve")?;
    if !(2..=64).contains(&curve.len()) {
        return Err("invalid blink curve".into());
    }
    let mut last = -1.0;
    for point in curve {
        if point.as_array().is_none_or(|values| values.len() != 2) {
            return Err("invalid blink curve point".into());
        }
        let time = point[0]
            .as_f64()
            .filter(|n| *n >= 0.0 && *n > last && *n <= period)
            .ok_or("invalid blink time")?;
        point[1]
            .as_f64()
            .filter(|n| (0.0..=1.0).contains(n))
            .ok_or("invalid blink weight")?;
        last = time;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn glb(value: Value, mut bin: Vec<u8>) -> Vec<u8> {
        if bin.is_empty() && value["buffers"][0]["byteLength"] == 12 {
            bin = vec![0; 12];
        }
        let mut text = serde_json::to_vec(&value).unwrap();
        while text.len() % 4 != 0 {
            text.push(b' ')
        }
        while bin.len() % 4 != 0 {
            bin.push(0)
        }
        let size = 20 + text.len() + if bin.is_empty() { 0 } else { 8 + bin.len() };
        let mut bytes = Vec::new();
        for value in [0x46546c67, 2, size as u32, text.len() as u32, 0x4e4f534a] {
            bytes.extend(value.to_le_bytes())
        }
        bytes.extend(text);
        if !bin.is_empty() {
            bytes.extend((bin.len() as u32).to_le_bytes());
            bytes.extend(0x004e4942u32.to_le_bytes());
            bytes.extend(bin)
        }
        bytes
    }
    fn model() -> Value {
        let names = [
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
        let mut value = json!({"asset":{"version":"2.0"},"nodes":names.iter().map(|name|json!({"name":name})).collect::<Vec<_>>(),"extensions":{"VRM":{"specVersion":"0.0","humanoid":{"humanBones":names.iter().enumerate().map(|(i,name)|json!({"bone":name,"node":i})).collect::<Vec<_>>()},
            "blendShapeMaster":{"blendShapeGroups":[{"presetName":"blink","binds":[{"mesh":0,"index":0,"weight":100}]}]}}}});
        value["buffers"] = json!([{"byteLength":12}]);
        value["bufferViews"] = json!([{"buffer":0,"byteLength":12}]);
        value["accessors"] = json!([{"bufferView":0,"componentType":5126,"count":1,"type":"VEC3"}]);
        value["meshes"] =
            json!([{"primitives":[{"attributes":{"POSITION":0},"targets":[{"POSITION":0}]}]}]);
        value["nodes"][2]["mesh"] = 0.into();
        value
    }
    fn model_vrm1() -> Value {
        let mut value = model();
        let bones = value["extensions"]["VRM"]["humanoid"]["humanBones"]
            .as_array()
            .unwrap()
            .iter()
            .map(|bone| {
                (
                    bone["bone"].as_str().unwrap().to_string(),
                    json!({"node":bone["node"]}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        value["extensions"] = json!({"VRMC_vrm":{
            "specVersion":"1.0", "humanoid":{"humanBones":bones},
            "expressions":{"preset":{"blink":{"morphTargetBinds":[{"node":2,"index":0,"weight":1}]}}}
        }});
        value
    }
    #[test]
    fn rejects_external_references_and_cycles() {
        let mut value = model();
        value["images"] = json!([{"uri":"file:///private"}]);
        assert!(parse_glb(&glb(value, vec![]), false).is_err());
        let mut value = model();
        value["nodes"][0]["children"] = json!([0]);
        assert!(parse_glb(&glb(value, vec![]), false).is_err());
    }
    #[test]
    fn rejects_truncated_chunks_and_unbounded_allocation() {
        let valid = glb(model(), vec![]);
        assert!(parse_glb(&valid[..valid.len() - 4], false).is_err());
        let mut value = model();
        value["accessors"] = json!([{"type":"VEC3","componentType":5126,"count":999999999}]);
        assert!(parse_glb(&glb(value, vec![]), false).is_err());
    }
    #[test]
    fn rejects_non_finite_geometry() {
        let mut value = model();
        value["buffers"] = json!([{"byteLength":4}]);
        value["bufferViews"] = json!([{"buffer":0,"byteLength":4}]);
        value["accessors"] =
            json!([{"bufferView":0,"componentType":5126,"count":1,"type":"SCALAR"}]);
        assert!(
            parse_glb(&glb(value, f32::NAN.to_le_bytes().to_vec()), false)
                .err()
                .unwrap()
                .contains("non-finite")
        );
    }
    #[test]
    fn vrm0_and_vrm1_without_blink_can_be_imported_and_installed() {
        for mut value in [model(), model_vrm1()] {
            if let Some(vrm) = value["extensions"].get_mut("VRM") {
                vrm.as_object_mut().unwrap().remove("blendShapeMaster");
            } else {
                value["extensions"]["VRMC_vrm"]
                    .as_object_mut()
                    .unwrap()
                    .remove("expressions");
            }
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("model.vrm");
            let bytes = glb(value.clone(), vec![]);
            fs::write(&source, &bytes).unwrap();
            let prepared = inspect(&source, &[], None).unwrap();
            assert_eq!(prepared.default_mappings.idle, DEFAULT_IDLE_NAME);
            let (path, data) = prepared.write(&temp.path().join("installed")).unwrap();
            assert_eq!(fs::read(path).unwrap(), bytes);
            assert_eq!(data.animations[0].name, DEFAULT_IDLE_NAME);
            if let Some(vrm) = value["extensions"].get_mut("VRM") {
                vrm["humanoid"]["humanBones"]
                    .as_array_mut()
                    .unwrap()
                    .remove(0);
            } else {
                value["extensions"]["VRMC_vrm"]["humanoid"]["humanBones"]
                    .as_object_mut()
                    .unwrap()
                    .remove("hips");
            }
            fs::write(&source, glb(value, vec![])).unwrap();
            assert!(inspect(&source, &[], None)
                .err()
                .unwrap()
                .contains("required humanoid bone"));
        }
    }
    #[test]
    fn blink_presets_are_optional_but_declared_resource_bindings_are_checked() {
        for vrm0 in [true, false] {
            let baseline = if vrm0 { model() } else { model_vrm1() };
            let bind = if vrm0 {
                json!({"mesh":0,"index":0,"weight":100})
            } else {
                json!({"node":2,"index":0,"weight":1})
            };
            let field = if vrm0 { "binds" } else { "morphTargetBinds" };
            let set_presets = |value: &mut Value, presets: Vec<(&str, Value)>| {
                if vrm0 {
                    value["extensions"]["VRM"]["blendShapeMaster"]["blendShapeGroups"] = presets
                        .into_iter()
                        .map(|(name, mut expression)| {
                            expression["presetName"] = name.into();
                            expression
                        })
                        .collect();
                } else {
                    value["extensions"]["VRMC_vrm"]["expressions"]["preset"] = presets
                        .into_iter()
                        .map(|(name, expression)| (name.to_owned(), expression))
                        .collect::<serde_json::Map<_, _>>()
                        .into();
                }
            };
            let expression = json!({field:[bind.clone()]});
            let mut zero_bind = bind.clone();
            zero_bind["weight"] = 0.into();
            let left = if vrm0 { "blink_l" } else { "blinkLeft" };
            let right = if vrm0 { "blink_r" } else { "blinkRight" };
            for presets in [
                vec![],
                vec![("blink", json!({}))],
                vec![("blink", json!({field:[]}))],
                vec![("blink", json!({field:[zero_bind]}))],
                vec![("blink", expression.clone())],
                vec![(left, expression.clone())],
                vec![(right, expression.clone())],
                vec![(left, expression.clone()), (right, expression.clone())],
            ] {
                let mut value = baseline.clone();
                set_presets(&mut value, presets);
                let temp = tempfile::tempdir().unwrap();
                let source = temp.path().join("model.vrm");
                fs::write(&source, glb(value, vec![])).unwrap();
                assert!(inspect(&source, &[], None).is_ok());
            }
            for (key, invalid) in [
                (if vrm0 { "mesh" } else { "node" }, json!(99)),
                ("index", json!(9)),
                ("index", json!(-1)),
                ("weight", json!(-1)),
                ("weight", json!(if vrm0 { 101 } else { 2 })),
                ("weight", Value::Null),
            ] {
                let mut value = baseline.clone();
                let mut invalid_bind = bind.clone();
                invalid_bind[key] = invalid;
                set_presets(
                    &mut value,
                    vec![
                        ("blink", expression.clone()),
                        (left, json!({field:[invalid_bind]})),
                    ],
                );
                let temp = tempfile::tempdir().unwrap();
                let source = temp.path().join("model.vrm");
                fs::write(&source, glb(value, vec![])).unwrap();
                assert!(inspect(&source, &[], None).err().unwrap().contains("眨眼"));
                assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
            }
            let mut malformed = baseline;
            set_presets(&mut malformed, vec![("blink", json!({field:42}))]);
            assert!(validate_blink_bindings(&malformed).is_err());
        }
    }
    #[test]
    fn inspection_names_missing_invalid_and_duplicate_standard_bones() {
        for baseline in [model(), model_vrm1()] {
            let vrm0 = baseline["extensions"]["VRM"].is_object();
            for name in REQUIRED_HUMAN_BONES {
                let mut value = baseline.clone();
                if vrm0 {
                    value["extensions"]["VRM"]["humanoid"]["humanBones"]
                        .as_array_mut()
                        .unwrap()
                        .retain(|bone| bone["bone"] != name);
                } else {
                    value["extensions"]["VRMC_vrm"]["humanoid"]["humanBones"]
                        .as_object_mut()
                        .unwrap()
                        .remove(name);
                }
                let error = validate_humanoid(&value).unwrap_err();
                assert!(
                    error.contains(name) && error.contains("VRM 导出器"),
                    "{error}"
                );
                assert!(error.contains("required humanoid bone"));
            }
            let mut value = baseline;
            value["nodes"][0]["name"] = "file:///private/token=secret".into();
            if vrm0 {
                let bones = value["extensions"]["VRM"]["humanoid"]["humanBones"]
                    .as_array_mut()
                    .unwrap();
                bones[0]["node"] = 999.into();
                bones[3]["node"] = bones[6]["node"].clone();
            } else {
                let bones = &mut value["extensions"]["VRMC_vrm"]["humanoid"]["humanBones"];
                bones["hips"]["node"] = 999.into();
                bones["leftUpperArm"]["node"] = bones["rightUpperArm"]["node"].clone();
            }
            let error = validate_humanoid(&value).unwrap_err();
            assert!(
                error.contains("hips")
                    && error.contains("leftUpperArm")
                    && error.contains("rightUpperArm")
            );
            assert!(!error.contains("secret") && !error.contains("file:"));
        }
        let mut value = model();
        let bones = value["extensions"]["VRM"]["humanoid"]["humanBones"]
            .as_array_mut()
            .unwrap();
        bones.push(bones[0].clone());
        assert!(validate_humanoid(&value)
            .unwrap_err()
            .contains("重复绑定：hips"));
    }
    #[test]
    fn reports_actual_optional_blink_capability_and_logical_resource_metrics() {
        for mut value in [model(), model_vrm1()] {
            let vrm0 = value["extensions"]["VRM"].is_object();
            let field = if vrm0 { "binds" } else { "morphTargetBinds" };
            let mut expression = if vrm0 {
                value["extensions"]["VRM"]["blendShapeMaster"]["blendShapeGroups"][0].clone()
            } else {
                value["extensions"]["VRMC_vrm"]["expressions"]["preset"]["blink"].clone()
            };
            let set = |model: &mut Value, presets: Vec<(&str, Value)>| {
                if vrm0 {
                    model["extensions"]["VRM"]["blendShapeMaster"]["blendShapeGroups"] = presets
                        .into_iter()
                        .map(|(name, mut expression)| {
                            expression["presetName"] = name.into();
                            expression
                        })
                        .collect();
                } else {
                    model["extensions"]["VRMC_vrm"]["expressions"]["preset"] = presets
                        .into_iter()
                        .map(|(name, expression)| (name.to_owned(), expression))
                        .collect::<serde_json::Map<_, _>>()
                        .into();
                }
            };
            let bones = validate_humanoid(&value).unwrap();
            assert_eq!(
                inspect_capabilities(&value, &bones).unwrap()["blink"],
                json!({"automatic":true,"combined":true,"left":false,"right":false})
            );
            set(
                &mut value,
                vec![(
                    if vrm0 { "blink_l" } else { "blinkLeft" },
                    expression.clone(),
                )],
            );
            assert_eq!(
                inspect_capabilities(&value, &bones).unwrap()["blink"],
                json!({"automatic":false,"combined":false,"left":true,"right":false})
            );
            set(
                &mut value,
                vec![
                    (
                        if vrm0 { "blink_l" } else { "blinkLeft" },
                        expression.clone(),
                    ),
                    (
                        if vrm0 { "blink_r" } else { "blinkRight" },
                        expression.clone(),
                    ),
                ],
            );
            assert_eq!(
                inspect_capabilities(&value, &bones).unwrap()["blink"]["automatic"],
                true
            );
            expression[field][0]["weight"] = 0.into();
            set(&mut value, vec![("blink", expression)]);
            assert_eq!(
                inspect_capabilities(&value, &bones).unwrap()["blink"]["automatic"],
                false
            );
            value["meshes"][0]["primitives"][0]["targets"] = json!([{}]);
            assert_eq!(
                inspect_capabilities(&value, &bones).unwrap()["blink"]["combined"],
                false
            );
            let metrics = inspect_metrics(&value, 1000).unwrap();
            assert_eq!(metrics["fileBytes"], 1000);
            assert_eq!(metrics["nodeCount"], 15);
            assert_eq!(metrics["primitiveCount"], 1);
            assert_eq!(metrics["vertexCount"], 1);
            assert_eq!(metrics["triangleCount"], 0);
            assert_eq!(metrics["decodedAccessorBytes"], 12);
            assert_eq!(
                inspect_capabilities(&value, &bones).unwrap()["lookAt"],
                json!({"mode":"none","head":true,"eyes":false,"horizontal":false,"vertical":false})
            );
        }
    }
    #[test]
    fn eye_tracking_requires_real_bones_or_usable_expression_pairs_and_ranges() {
        for mut value in [model(), model_vrm1()] {
            let vrm0 = value["extensions"]["VRM"].is_object();
            let extension = if vrm0 { "VRM" } else { "VRMC_vrm" };
            let config = if vrm0 { "firstPerson" } else { "lookAt" };
            value["extensions"][extension][config] = if vrm0 {
                json!({"lookAtTypeName":"Bone"})
            } else {
                json!({"type":"bone"})
            };
            let mut bones = validate_humanoid(&value).unwrap();
            assert_eq!(inspect_look_at(&value, &bones).unwrap()["eyes"], false);
            for name in ["leftEye", "rightEye"] {
                let node = value["nodes"].as_array().unwrap().len();
                value["nodes"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"name":name}));
                if vrm0 {
                    value["extensions"][extension]["humanoid"]["humanBones"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!({"bone":name,"node":node}));
                } else {
                    value["extensions"][extension]["humanoid"]["humanBones"][name] =
                        json!({"node":node});
                }
            }
            bones = validate_humanoid(&value).unwrap();
            assert_eq!(
                inspect_look_at(&value, &bones).unwrap(),
                json!({"mode":"bone","head":true,"eyes":true,"horizontal":true,"vertical":true})
            );
            for key in if vrm0 {
                [
                    "lookAtHorizontalInner",
                    "lookAtHorizontalOuter",
                    "lookAtVerticalUp",
                    "lookAtVerticalDown",
                ]
            } else {
                [
                    "rangeMapHorizontalInner",
                    "rangeMapHorizontalOuter",
                    "rangeMapVerticalUp",
                    "rangeMapVerticalDown",
                ]
            } {
                value["extensions"][extension][config][key] = if vrm0 {
                    json!({"yRange":0})
                } else {
                    json!({"outputScale":0})
                };
            }
            assert_eq!(inspect_look_at(&value, &bones).unwrap()["eyes"], false);
            value["extensions"][extension][config] = if vrm0 {
                json!({"lookAtTypeName":"BlendShape"})
            } else {
                json!({"type":"expression"})
            };
            let expression = if vrm0 {
                value["extensions"][extension]["blendShapeMaster"]["blendShapeGroups"][0].clone()
            } else {
                value["extensions"][extension]["expressions"]["preset"]["blink"].clone()
            };
            for name in ["lookLeft", "lookRight", "lookUp", "lookDown"] {
                if vrm0 {
                    let mut item = expression.clone();
                    item["presetName"] = name.to_ascii_lowercase().into();
                    value["extensions"][extension]["blendShapeMaster"]["blendShapeGroups"]
                        .as_array_mut()
                        .unwrap()
                        .push(item);
                } else {
                    value["extensions"][extension]["expressions"]["preset"][name] =
                        expression.clone();
                }
            }
            assert_eq!(
                inspect_look_at(&value, &bones).unwrap(),
                json!({"mode":"expression","head":true,"eyes":true,"horizontal":true,"vertical":true})
            );
            if vrm0 {
                value["extensions"][extension]
                    .as_object_mut()
                    .unwrap()
                    .remove("blendShapeMaster");
            } else {
                value["extensions"][extension]
                    .as_object_mut()
                    .unwrap()
                    .remove("expressions");
            }
            assert_eq!(inspect_look_at(&value, &bones).unwrap()["mode"], "none");
        }
    }
    #[test]
    fn actionable_external_resource_errors_never_echo_the_resource_url() {
        let mut value = model();
        value["images"] =
            json!([{"uri":"https://user:password@example.invalid/private?token=secret"}]);
        let bytes = glb(value, vec![]);
        let error = parse_glb(&bytes, false).err().unwrap();
        assert!(error.contains("内嵌") && error.contains("external"));
        assert!(
            !error.contains("password") && !error.contains("secret") && !error.contains("private")
        );
    }
    #[test]
    fn corrupt_motion_does_not_create_installed_files() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("model.vrm");
        fs::write(&source, glb(model(), vec![])).unwrap();
        let clip = temp.path().join("bad.vrma");
        fs::write(&clip, b"invalid").unwrap();
        let result = inspect(
            &source,
            &[AnimationSource {
                name: "Idle".into(),
                path: clip.to_string_lossy().into_owned(),
            }],
            None,
        );
        assert!(result.is_err());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
    }
    #[test]
    fn an_animation_free_vrm_gets_the_authored_idle_and_can_be_installed() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("model.vrm");
        fs::write(&source, glb(model(), vec![])).unwrap();
        let prepared = inspect(&source, &[], None).unwrap();
        assert_eq!(prepared.catalog().len(), 1);
        assert_eq!(prepared.catalog()[0]["name"], DEFAULT_IDLE_NAME);
        assert!(prepared.catalog()[0]["durationMs"].as_f64().unwrap() > 0.0);
        assert_eq!(prepared.default_mappings.idle, DEFAULT_IDLE_NAME);
        assert!(prepared.default_mappings.click.is_empty());
        let (_, installed) = prepared.write(&temp.path().join("installed")).unwrap();
        assert_eq!(installed.animations.len(), 1);
        assert!(installed.embedded_animations.is_empty());
        assert_eq!(
            fs::read(&installed.animations[0].path).unwrap(),
            DEFAULT_IDLE
        );
        assert_eq!(prepared.source_sha256.len(), 64);
        assert!(prepared.license.is_none());
    }
    fn animated_model() -> (Value, Vec<u8>) {
        let mut value = model();
        value["buffers"] = json!([{"byteLength":52}]);
        value["bufferViews"] = json!([{"buffer":0,"byteLength":8},{"buffer":0,"byteOffset":8,"byteLength":32},{"buffer":0,"byteOffset":40,"byteLength":12}]);
        value["accessors"] = json!([
            {"bufferView":0,"componentType":5126,"count":2,"type":"SCALAR","min":[0],"max":[1]},
            {"bufferView":1,"componentType":5126,"count":2,"type":"VEC4"},
            {"bufferView":2,"componentType":5126,"count":1,"type":"VEC3"}
        ]);
        value["meshes"][0]["primitives"][0]["attributes"]["POSITION"] = 2.into();
        value["meshes"][0]["primitives"][0]["targets"][0]["POSITION"] = 2.into();
        value["animations"] = json!([{"name":"Wave", "samplers":[{"input":0,"output":1}],
            "channels":[{"sampler":0,"target":{"node":2,"path":"rotation"}}]}]);
        let mut bin = vec![];
        for number in [0.0_f32, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0] {
            bin.extend(number.to_le_bytes());
        }
        bin.extend([0; 12]);
        (value, bin)
    }
    #[test]
    fn reads_embedded_gltf_clips_license_profile_and_explicit_mappings() {
        let (mut value, bin) = animated_model();
        value["extras"]["starlite"] = json!({
            "license":{"title":"Example","text":"# Model license\n\nRead these terms."},
            "mappings":{"idle":"Wave","working":null,"completed":null,"error":null,"blocked":null,
                "approval":null,"click":["Wave"],"ambient":[]},
            "profile":{"schemaVersion":1,"type":"weiguang","neutralAnimation":"Wave","neutralPose":{},
                "earBones":[],"earPoses":{"Neutral":{}},"expressions":{},
                "accessories":{"collar":"hips","cone":"head","collarVisible":true,"coneVisible":false},
                "blink":{"period":4,"curve":[[0,0],[0.1,1],[0.2,0]]}}
        });
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("model.vrm");
        fs::write(&source, glb(value, bin)).unwrap();
        let prepared = inspect(&source, &[], None).unwrap();
        assert_eq!(prepared.catalog().len(), 2);
        assert_eq!(
            prepared.catalog()[1],
            json!({"name":"Wave","durationMs":1000.0})
        );
        assert_eq!(prepared.default_mappings.idle, "Wave");
        assert_eq!(prepared.default_mappings.click, ["Wave"]);
        assert!(prepared
            .license
            .as_ref()
            .unwrap()
            .text
            .contains("Read these terms."));
        let (_, data) = prepared.write(&temp.path().join("installed")).unwrap();
        assert_eq!(data.embedded_animations, ["Wave"]);
        assert_eq!(data.animations.len(), 1);
        assert!(Path::new(data.profile_path.as_ref().unwrap()).is_file());
    }
    #[test]
    fn profile_baseline_precedes_automatic_idle_but_not_explicit_mappings() {
        let (mut value, bin) = animated_model();
        let mut idle = value["animations"][0].clone();
        idle["name"] = "Idle".into();
        value["animations"].as_array_mut().unwrap().push(idle);
        value["extras"]["starlite"]["profile"] = json!({
            "schemaVersion":1,"type":"weiguang","neutralAnimation":"Wave","neutralPose":{},
            "earBones":[],"earPoses":{"Neutral":{}},"expressions":{},
            "accessories":{"collar":"hips","cone":"head","collarVisible":true,"coneVisible":false},
            "blink":{"period":4,"curve":[[0,0],[0.1,1],[0.2,0]]}
        });
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("model.vrm");
        fs::write(&source, glb(value.clone(), bin.clone())).unwrap();
        assert_eq!(
            inspect(&source, &[], None).unwrap().default_mappings.idle,
            "Wave"
        );
        value["extras"]["starlite"]["mappings"] = json!({"idle":"Idle","working":null,"completed":null,"error":null,"blocked":null,"approval":null,"click":[],"ambient":[]});
        fs::write(&source, glb(value.clone(), bin.clone())).unwrap();
        assert_eq!(
            inspect(&source, &[], None).unwrap().default_mappings.idle,
            "Idle"
        );
        value["extras"]["starlite"]["profile"]["neutralAnimation"] = "Missing".into();
        fs::write(&source, glb(value, bin)).unwrap();
        assert!(inspect(&source, &[], None)
            .err()
            .unwrap()
            .contains("profile neutral animation is missing"));
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }
    #[test]
    fn refuses_corrupt_embedded_clips_reserved_names_and_unavailable_mappings() {
        let (value, bin) = animated_model();
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("model.vrm");
        for mutate in [0, 1, 2, 3, 4, 5] {
            let mut invalid = value.clone();
            match mutate {
                0 => invalid["animations"][0]["name"] = DEFAULT_IDLE_NAME.into(),
                1 => invalid["animations"][0]["channels"][0]["sampler"] = 9.into(),
                2 => invalid["animations"][0]["channels"][0]["target"]["node"] = 99.into(),
                3 => {
                    invalid["animations"][0]["channels"][0]["target"]["path"] = "translation".into()
                }
                4 => invalid["animations"]
                    .as_array_mut()
                    .unwrap()
                    .push(value["animations"][0].clone()),
                _ => {
                    invalid["extras"]["starlite"]["mappings"] = json!({"idle":"Missing","working":null,
                    "completed":null,"error":null,"blocked":null,"approval":null,"click":[],"ambient":[]})
                }
            }
            fs::write(&source, glb(invalid, bin.clone())).unwrap();
            assert!(
                inspect(&source, &[], None).is_err(),
                "invalid variant {mutate} was accepted"
            );
        }
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }
    #[test]
    fn reads_vrm0_author_and_license_metadata_without_resolving_urls() {
        let mut value = model();
        value["extensions"]["VRM"]["meta"] = json!({
            "title":"测试角色", "author":"作者 #1", "version":"1.2",
            "licenseName":"Other", "allowedUserName":"ExplicitlyLicensedPerson",
            "commercialUssageName":"Disallow",
            "otherLicenseUrl":"https://example.invalid/model-license",
            "otherPermissionUrl":"file:///not-opened"
        });
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("model.vrm");
        fs::write(&source, glb(value, vec![])).unwrap();
        let prepared = inspect(&source, &[], None).unwrap();
        assert_eq!(prepared.model_name.as_deref(), Some("测试角色"));
        let license = prepared.license.unwrap();
        assert_eq!(license.title, "测试角色");
        assert!(license.text.contains("作者 \\#1"));
        assert!(license.text.contains("许可标识：Other"));
        assert!(license.text.contains("角色扮演使用者：另获授权者"));
        assert!(license.text.contains("商业使用：禁止"));
        assert!(license
            .text
            .contains("https://example.invalid/model-license"));
        assert!(license.text.contains("file:///not-opened"));
    }
    #[test]
    fn reads_vrm1_permissions_and_preserves_third_party_license_text() {
        let mut value = model();
        let bones = value["extensions"]["VRM"]["humanoid"]["humanBones"]
            .as_array()
            .unwrap()
            .iter()
            .map(|bone| {
                (
                    bone["bone"].as_str().unwrap().to_string(),
                    json!({"node":bone["node"]}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        value["extensions"] = json!({"VRMC_vrm":{
            "specVersion":"1.0", "humanoid":{"humanBones":bones},
            "expressions":{"preset":{"blink":{"morphTargetBinds":[{"node":2,"index":0,"weight":1}]}}},
            "meta":{"name":"角色 B", "authors":["Author A","Author B"],
                "licenseUrl":"https://example.invalid/vrm1",
                "avatarPermission":"everyone", "commercialUsage":"personalNonProfit",
                "creditNotation":"required", "allowRedistribution":false,
                "modification":"allowModification",
                "thirdPartyLicenses":"# 第三方条款\n\n保留原始署名。"}
        }});
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("model.vrm");
        fs::write(&source, glb(value, vec![])).unwrap();
        let license = inspect(&source, &[], None).unwrap().license.unwrap();
        assert_eq!(license.title, "角色 B");
        for expected in [
            "作者：Author A、Author B",
            "商业使用：个人非商业使用",
            "署名：必须署名",
            "再分发：禁止",
            "修改模型：允许修改",
            "# 第三方条款\n\n保留原始署名。",
        ] {
            assert!(license.text.contains(expected), "missing {expected}");
        }
    }
    #[test]
    fn rejects_unbounded_or_control_character_license_metadata() {
        assert!(
            metadata_license(&json!({"thirdPartyLicenses":"x".repeat(64 * 1024 + 1)})).is_err()
        );
        assert!(metadata_license(&json!({"author":"bad\u{0000}name"})).is_err());
        assert!(metadata_license(&json!({"authors":vec!["author";65]})).is_err());
    }
    #[test]
    #[ignore = "requires local private Weiguang VRM"]
    fn private_single_vrm_passes_native_import_without_sidecars() {
        let source = std::env::var("DSH_PET_VRM_FILE").expect("set DSH_PET_VRM_FILE");
        let prepared = inspect(Path::new(&source), &[], None).unwrap();
        assert_eq!(prepared.embedded_animations.len(), 14);
        assert_eq!(prepared.catalog().len(), 15);
        assert_eq!(prepared.default_mappings.idle, "Idle");
        assert_eq!(prepared.default_mappings.click.len(), 5);
        assert_eq!(prepared.default_mappings.ambient.len(), 3);
        assert!(prepared
            .license
            .as_ref()
            .unwrap()
            .text
            .contains("StarCried"));
        let temp = tempfile::tempdir().unwrap();
        let (model, data) = prepared.write(&temp.path().join("installed")).unwrap();
        assert_eq!(fs::read(model).unwrap(), fs::read(source).unwrap());
        assert_eq!(data.animations.len(), 1);
        assert_eq!(data.animations[0].name, DEFAULT_IDLE_NAME);
        assert_eq!(data.embedded_animations.len(), 14);
        assert!(Path::new(data.profile_path.as_ref().unwrap()).is_file());
    }
}
