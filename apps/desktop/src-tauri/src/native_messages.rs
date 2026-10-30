//! Translations of application-owned diagnostics and generated license labels.
pub fn english(source: &str) -> &str {
    match source {
        "无法读取示例模型目录。" => "Could not read the example catalog.",
        "模型检查失败，请重试。" => "Model inspection failed. Please retry.",
        "模型移除失败，请重试。" => "Could not remove the model. Please retry.",
        "无法读取模型许可，请重试。" => "Could not read the model license. Please retry.",
        "模型设置操作失败，请重试。" => "Could not update model settings. Please retry.",
        "模型已移除，但本机副本清理未完成；原始 VRM 文件未改变。" => "Model removed, but its managed local copy could not be fully cleaned up. The source VRM is unchanged.",
        "没有找到该模型，请重新打开设置。" => "Model not found. Reopen settings.",
        "当前版本暂不支持 Inochi2D，请使用 VRM 模型。" => "This version does not support Inochi2D. Use a VRM model.",
        "请选择 VRM .vrm 模型文件。" => "Select a VRM .vrm model file.",
        "示例模型准备失败。请重启 DSH 重试，原模型和设置未改变。" => "Could not prepare the example. Restart DSH to retry. Existing models and settings are unchanged.",
        "此示例尚未配置下载来源，请使用当前模型或导入 VRM。" => "No download source is configured for this example. Use the current model or import a VRM.",
        "模型设置忙，请重试。" => "Model settings are busy. Please retry.",
        "请选择已导入的 VRM 模型。" => "Select an imported VRM model.",
        "本版本仅支持调整 VRM 模型。" => "Only VRM models can be adjusted in this version.",
        "模型库设置已达到容量上限，请使用更精简的许可信息。" => "The model library settings size limit was reached. Use shorter license metadata.",
        "Inochi2D 模型" => "Inochi2D model",
        "VRM 模型" => "VRM model",
        "模型" => "Model",
        "版本" => "Version",
        "作者" => "Author",
        "版权信息" => "Copyright",
        "作者联系方式" => "Author contact",
        "来源" => "References",
        "许可标识" => "License identifier",
        "许可文件" => "License URL",
        "补充许可文件" => "Additional license URL",
        "补充使用条件" => "Additional permission URL",
        "角色扮演使用者" => "Avatar use",
        "暴力内容" => "Violent content",
        "成人内容" => "Sexual content",
        "商业使用" => "Commercial use",
        "署名" => "Attribution",
        "修改模型" => "Modification",
        "仅作者" => "Author only",
        "另获授权者" => "Separately licensed users only",
        "所有人" => "Everyone",
        "禁止" => "Prohibited",
        "允许" => "Allowed",
        "个人非商业使用" => "Personal non-commercial use",
        "个人营利使用" => "Personal commercial use",
        "企业商业使用" => "Corporate commercial use",
        "必须署名" => "Attribution required",
        "无需署名" => "Attribution not required",
        "允许修改" => "Modification allowed",
        "允许修改并再分发" => "Modification and redistribution allowed",
        "过激暴力内容" => "Excessively violent content",
        "过激成人内容" => "Excessively sexual content",
        "政治或宗教内容" => "Political or religious content",
        "反社会或仇恨内容" => "Antisocial or hateful content",
        "再分发" => "Redistribution",
        "missing VRM extension declaration：请使用 VRM 导出器重新导出模型。" => "missing VRM extension declaration: re-export using a VRM exporter.",
        "invalid GLB header or size：请使用完整的二进制 VRM / VRMA 文件（模型不超过 64 MiB，单个动作不超过 16 MiB）；FBX 或普通 JSON glTF 不能直接导入。" => "invalid GLB header or size: use a complete binary VRM / VRMA (model up to 64 MiB, individual motion up to 16 MiB). FBX and JSON glTF cannot be imported directly.",
        "invalid GLB chunk size：文件不完整或已损坏，请重新下载或导出。" => "invalid GLB chunk size: the file is incomplete or damaged. Download or export it again.",
        "invalid GLB JSON：请使用 VRM 导出器重新导出文件。" => "invalid GLB JSON: re-export using a VRM exporter.",
        "unexpected GLB chunk：请重新导出单文件 VRM / VRMA。" => "unexpected GLB chunk: re-export a self-contained VRM / VRMA.",
        "glTF 2.0 is required：请使用 VRM 0.0 / 1.0 导出器。" => "glTF 2.0 is required: use a VRM 0.0 / 1.0 exporter.",
        "unsupported VRM version：请导出 VRM 0.0 或 1.0。" => "unsupported VRM version: export VRM 0.0 or 1.0.",
        "VRM 0 or VRM 1 is required：普通 GLB、FBX 需要先通过 VRM 导出器转换。" => "VRM 0 or VRM 1 is required: convert ordinary GLB / FBX through a VRM exporter first.",
        "unsupported required glTF extension：请关闭额外的几何或贴图压缩扩展后重新导出。" => "unsupported required glTF extension: disable additional geometry or texture compression extensions and export again.",
        "external glTF resources are not supported：请将全部贴图和缓冲区内嵌到同一个 VRM / VRMA 文件后重新导出。" => "external glTF resources are not supported: embed all textures and buffers in one VRM / VRMA file and export again.",
        "invalid humanoid bone：人形骨骼条目缺少标准名称，请重新导出 VRM。" => "invalid humanoid bone: a mapping is missing its standard name. Export the VRM again.",
        "duplicate humanoid bone：额外的人形骨骼条目重复，请在导出器中移除重复映射。" => "duplicate humanoid bone: remove duplicate optional mappings in the exporter.",
        "invalid humanoid bone：额外的人形骨骼条目引用了无效节点，请重新导出 VRM。" => "invalid humanoid bone: an optional mapping references an invalid node. Export the VRM again.",
        "眨眼" => "Blink",
        "视线" => "Look-at",
        "格式无效" => " has an invalid format",
        "绑定列表无效" => " has an invalid bindings list",
        "绑定数量超过 256 个" => " has more than 256 bindings",
        "引用了无效的模型网格" => " references an invalid mesh",
        "的形态键索引无效" => " has an invalid morph index",
        "引用了不存在的形态键" => " references a missing morph target",
        "的形态键权重无效" => " has an invalid morph weight",
        "眨眼表达格式无效：invalid VRM blendShapeMaster。请重新导出 VRM。" => "Invalid blink expressions: invalid VRM blendShapeMaster. Export the VRM again.",
        "眨眼表达格式无效：invalid VRM expressions。请重新导出 VRM。" => "Invalid blink expressions: invalid VRM expressions. Export the VRM again.",
        "眨眼表达格式无效：invalid VRM expression presets。请重新导出 VRM。" => "Invalid blink expressions: invalid VRM expression presets. Export the VRM again.",
        "视线配置格式无效，请重新导出 VRM。" => "Invalid look-at configuration. Export the VRM again.",
        "视线类型无效，请在 VRM 导出器中选择骨骼或表达视线模式。" => "Invalid look-at type. Choose bone or expression mode in the VRM exporter.",
        "视线角度范围格式无效，请重新导出 VRM。" => "Invalid look-at angle range format. Export the VRM again.",
        "视线角度范围无效，请设置有限、非负的输入和输出角度。" => "Invalid look-at angle range. Set finite, non-negative input and output angles.",
        _ => source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_messages_have_english_translations_and_do_not_translate_user_values() {
        let source = include_str!("native_messages.rs");
        let mut count = 0;
        for line in source.lines() {
            let Some((key, _)) = line.trim().split_once("\" => \"") else {
                continue;
            };
            let Some(key) = key.strip_prefix('"') else {
                continue;
            };
            let translated = english(key);
            assert_ne!(translated, key);
            assert!(!translated
                .chars()
                .any(|c| ('\u{3400}'..='\u{9fff}').contains(&c)));
            count += 1;
        }
        assert!(count > 60);
        assert_eq!(english("用户模型 <script>"), "用户模型 <script>");
    }
}
