//! Self-contained VRM/VRMA import. No model-supplied URI is ever resolved.
use crate::settings::{path_string, AnimationSource, VrmModelData};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Read,
    path::Path,
};

const MODEL_LIMIT: usize = 64 * 1024 * 1024;
const ANIMATION_LIMIT: usize = 16 * 1024 * 1024;
const PROFILE_LIMIT: usize = 1024 * 1024;

pub struct Prepared {
    pub source_sha256: String,
    pub source_bytes: u64,
    pub model_name: Option<String>,
    model: Vec<u8>,
    animations: Vec<(String, f64, Vec<u8>)>,
    profile: Option<Vec<u8>>,
}

impl Prepared {
    pub fn catalog(&self) -> Vec<Value> {
        self.animations
            .iter()
            .map(|(name, duration, _)| json!({"name":name,"durationMs":duration}))
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
    validate_humanoid(&parsed.json)?;
    let meta = if parsed.json["extensions"]["VRM"].is_object() {
        &parsed.json["extensions"]["VRM"]["meta"]
    } else {
        &parsed.json["extensions"]["VRMC_vrm"]["meta"]
    };
    let model_name = meta["title"]
        .as_str()
        .or_else(|| meta["name"].as_str())
        .map(str::to_owned);
    let mut names = HashSet::new();
    let mut animations = Vec::new();
    let mut total = 0;
    for source in sources {
        if source.name.trim().is_empty()
            || source.name.len() > 128
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
    let profile = if let Some(path) = profile {
        let bytes = read_limited(path, PROFILE_LIMIT)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        validate_profile(&value, &parsed.json, &names)?;
        Some(bytes)
    } else {
        None
    };
    let source_sha256 = format!("{:x}", Sha256::digest(&model));
    Ok(Prepared {
        source_sha256,
        source_bytes: model.len() as u64,
        model_name,
        model,
        animations,
        profile,
    })
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
        return Err("invalid GLB header or size".into());
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
            return Err("invalid GLB chunk size".into());
        }
        match (count, kind) {
            (0, 0x4e4f534a) => {
                if size > 8 * 1024 * 1024 {
                    return Err("GLB JSON exceeds 8 MiB".into());
                }
                value = Some(
                    serde_json::from_slice::<Value>(&bytes[at..at + size])
                        .map_err(|e| e.to_string())?,
                )
            }
            (1, 0x004e4942) => bin = &bytes[at..at + size],
            _ => return Err("unexpected GLB chunk".into()),
        }
        at += size;
        count += 1;
    }
    let json = value.ok_or("GLB JSON is missing")?;
    if json["asset"]["version"] != "2.0" {
        return Err("glTF 2.0 is required".into());
    }
    let ext = &json["extensions"];
    if animation {
        if ext["VRMC_vrm_animation"]["specVersion"] != "1.0" {
            return Err("VRMA 1.0 is required".into());
        }
    } else if ext["VRM"].is_object() {
        if ext["VRM"]["specVersion"] != "0.0" || ext["VRMC_vrm"].is_object() {
            return Err("unsupported VRM version".into());
        }
    } else if ext["VRMC_vrm"]["specVersion"] != "1.0" {
        return Err("VRM 0 or VRM 1 is required".into());
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
        return Err("unsupported required glTF extension".into());
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
        if view["buffer"] != 0 || start.checked_add(length).is_none_or(|n| n > bin.len()) {
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
            span(
                views,
                &a["bufferView"],
                &a["byteOffset"],
                count,
                element,
                width,
                true,
            )?;
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
            span(
                views,
                &s["values"]["bufferView"],
                &s["values"]["byteOffset"],
                n,
                element,
                width,
                false,
            )?;
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
                    return Err("external glTF resources are not supported".into());
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
fn validate_humanoid(json: &Value) -> Result<(), String> {
    let mut bones = HashSet::new();
    let node_count = array(json, "nodes")?.len();
    if json["extensions"]["VRM"].is_object() {
        for bone in array(&json["extensions"]["VRM"]["humanoid"], "humanBones")? {
            let name = bone["bone"].as_str().ok_or("invalid humanoid bone")?;
            if !bones.insert(name) {
                return Err("duplicate humanoid bone".into());
            }
            index(&bone["node"], node_count)?;
        }
    } else {
        for (name, bone) in json["extensions"]["VRMC_vrm"]["humanoid"]["humanBones"]
            .as_object()
            .ok_or("missing humanoid bones")?
        {
            bones.insert(name.as_str());
            index(&bone["node"], node_count)?;
        }
    }
    for name in [
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
    ] {
        if !bones.contains(name) {
            return Err(format!("required humanoid bone is missing: {name}"));
        }
    }
    Ok(())
}
fn animation_duration(glb: &Glb<'_>) -> Result<f64, String> {
    let animations = array(&glb.json, "animations")?;
    if animations.len() != 1 {
        return Err("VRMA must contain exactly one animation".into());
    }
    let accessors = array(&glb.json, "accessors")?;
    let views = array(&glb.json, "bufferViews")?;
    let samplers = array(&animations[0], "samplers")?;
    let nodes = array(&glb.json, "nodes")?;
    let mut duration = 0.0_f64;
    if array(&animations[0], "channels")?.is_empty() {
        return Err("VRMA animation is empty".into());
    }
    for channel in array(&animations[0], "channels")? {
        index(&channel["sampler"], samplers.len())?;
        index(&channel["target"]["node"], nodes.len())?;
        if !matches!(
            channel["target"]["path"].as_str(),
            Some("translation" | "rotation" | "scale" | "weights")
        ) {
            return Err("invalid animation channel".into());
        }
    }
    for sampler in samplers {
        index(&sampler["output"], accessors.len())?;
        let a = &accessors[index(&sampler["input"], accessors.len())?];
        if a["type"] != "SCALAR" || a["componentType"] != 5126 || !a["sparse"].is_null() {
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
    if duration <= 0.0 {
        return Err("VRMA duration must be positive".into());
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
        json!({"asset":{"version":"2.0"},"nodes":names.iter().map(|name|json!({"name":name})).collect::<Vec<_>>(),"extensions":{"VRM":{"specVersion":"0.0","humanoid":{"humanBones":names.iter().enumerate().map(|(i,name)|json!({"bone":name,"node":i})).collect::<Vec<_>>()}}}})
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
    fn an_animation_free_vrm_can_be_inspected() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("model.vrm");
        fs::write(&source, glb(model(), vec![])).unwrap();
        let prepared = inspect(&source, &[], None).unwrap();
        assert!(prepared.catalog().is_empty());
        assert_eq!(prepared.source_sha256.len(), 64);
    }
    #[test]
    #[ignore = "requires local private companion assets"]
    fn private_companion_bundles_pass_native_import() {
        let root = std::env::var("DSH_PET_VRM_ASSETS").expect("set DSH_PET_VRM_ASSETS");
        for variant in ["desktop", "blog"] {
            let folder = Path::new(&root).join(variant);
            let names = [
                "Idle",
                "Thinking",
                "Working",
                "Blocked",
                "Approval",
                "Completed",
                "Error",
                "Click",
            ];
            let sources = names
                .iter()
                .map(|name| AnimationSource {
                    name: (*name).into(),
                    path: folder
                        .join("motions")
                        .join(format!("{name}.vrma"))
                        .to_string_lossy()
                        .into_owned(),
                })
                .collect::<Vec<_>>();
            let prepared = inspect(
                &folder.join("Weiguang.vrm"),
                &sources,
                Some(&folder.join("profile.json")),
            )
            .unwrap();
            assert_eq!(prepared.catalog().len(), 8);
            let temp = tempfile::tempdir().unwrap();
            let (model, data) = prepared.write(&temp.path().join("installed")).unwrap();
            assert!(Path::new(&model).is_file());
            assert_eq!(data.animations.len(), 8);
            assert!(Path::new(data.profile_path.as_ref().unwrap()).is_file());
        }
    }
}
