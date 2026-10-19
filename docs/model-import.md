# 导入模型

本文对应 `0.1.0-alpha.2`：眨眼是可选能力，不再使用的模型可以移除，模型卡片提供能力和资源信息。旧版的导入限制与发布验收保留在[兼容性记录](dsh-compatibility.md)。

从托盘打开设置，点击模型列表末尾的「添加 VRM 模型」，直接选择一个 `.vrm` 文件。检查成功后自动加入列表并切换；原有模型及其动作映射保留。需要了解模型要求时，点击同一卡片内的「查看导入说明」打开详细文档。

不再使用的模型可点卡片上的「移除」。确认后删除列表项、动作映射及程序管理的导入副本，原始 VRM 文件保留。移除当前模型会切为「不显示模型」；移除微光后也不会在重启时重新添加。更新模型可先导入新文件，验收后再移除旧项。恢复微光可从[独立模型发行](https://github.com/StarCried/starlite/releases/tag/weiguang-v3.0.0-starlite.1)下载 `Weiguang-StarLite.vrm`，通过「添加 VRM 模型」重新导入。

## 模型要求

| 项目 | 要求 |
| --- | --- |
| 格式 | 自包含的 VRM 0 或 VRM 1，包含模型、贴图及需要的动作数据；不接受外部 buffer 或贴图 URI |
| 人形 | VRM 内正确设置标准 humanoid 映射，包含下列 15 个必需骨骼 |
| 眨眼 | 可选；有效的 Blink 预设或左右 Blink 配对后启用，缺少时不自动眨眼 |
| 眼球跟随 | 可选；需要模型正确配置 VRM lookAt |
| 动作 | 可选；读取 VRM 内嵌的标准 glTF animation，无动作时自动使用程序的基础待机 |

必需的人形映射名称：

```text
hips, spine, head
leftUpperArm, leftLowerArm, leftHand
rightUpperArm, rightLowerArm, rightHand
leftUpperLeg, leftLowerLeg, leftFoot
rightUpperLeg, rightLowerLeg, rightFoot
```

这些是 VRM humanoid 字段，**不是 Blender 对象或骨骼的强制名称**。实际骨骼可使用其他名称，但导出器必须把它们映射到相应字段。肩、胸、颈、脚趾、眼睛和手指等按模型已提供的标准映射识别；缺少手指映射时不能自动补出手指动画。

没有眨眼表达的模型仍可导入，使用基础待机、轻呼吸和头部跟随。眨眼依据 VRM 预设绑定，形态键不必叫 Blink。VRM 0 使用 `presetName: "blink"`，或同时提供 `blink_l`／`blink_r`；VRM 1 使用 `expressions.preset.blink`，或同时提供 `blinkLeft`／`blinkRight`。预设需指向真实 morph target，并有非零权重。空预设、零权重或仅有单侧表达时，不启用自动眨眼；引用不存在的资源仍视为文件损坏。

VRM 0／1 的元数据、材质与物理由 VRM 后端读取。Blender 母版、FBX 和 Unity `.anim` 不能直接导入；应先在模型编辑工具中完成绑定、导出并检查。

## 没有动作时

程序提供一段基础待机 `StarLiteIdle`，采用当前微光已验收的放松站姿和轻呼吸。模型未指定基础动作时，优先选用名为 `Idle` 的模型动作，否则使用 `StarLiteIdle`；角色配置的有效 `neutralAnimation` 可指定模型的基础动作。明确提供的默认动作映射及用户保存的映射优先，可在设置中更换。

该片段通过标准人形映射重定向，模型的身材、骨骼和权重仍会影响姿态，不能保证所有非标准身体都无穿模。限角头部跟随使用人形映射；自动眨眼和眼球跟随分别依赖有效 Blink 与 lookAt 配置。程序只提供这段基础动作，不自动生成挥手、工作、完成等事件动作。

基础待机的最终姿态和烘焙由 StarCried 制作，包含 Warudo `Human@SM Breathe` 呼吸层，不能称为完全原创。来源记录见 [default-idle.md](../apps/desktop/src-tauri/assets/default-idle.md)。

## 有动作时

模型内嵌的标准 glTF 动作自动列入目录。建议用唯一英文名称，名称区分大小写；`StarLiteIdle` 为程序保留名称。推荐的事件名称为 `Idle`、`Working`、`Completed`、`Error`、`Blocked`、`Approval`、`Click` 和 `Ambient`，其他名称仍可手动映射。

| 映射 | 播放方式 |
| --- | --- |
| Idle | 必填，循环；默认已配置基础待机 |
| Working（含思考）、Blocked、Approval、Completed、Error | 可选，播放一次后回待机；新状态可以打断 |
| Click | 可多选，每次待机点击随机播放一个 |
| Ambient | 可多选，待机中每 60–120 秒随机播放一个 |

Click／Ambient 各最多 20 项。空列表禁用该交互；其他可选映射设为「禁用」时保持中性姿态，不借用别的动作。逻辑状态仍忙碌时，即使动作已回 Idle，也不会触发点击或偶发小动作。修改映射自动保存。

已安装的旧模型及其外部 VRMA 保持可用；当前「添加模型」只要求选择单个 VRM。原生接口的外部 VRMA 参数供开发集成使用，见 [请求示例](examples/vrm-import.json)；界面不导入该 JSON，也不要用它覆盖设置文件。

## 许可、数据与失败

模型卡片可以查看 VRM 内的作者与许可元数据。可选的 `extras.starlite.license` 提供完整许可文本，`extras.starlite.profile` 提供角色专属配置，`extras.starlite.mappings` 提供默认动作映射；普通标准 VRM 无需这些扩展元数据。

许可仅安全排版，不执行 HTML，也不会自动访问模型提供的网址。缺少许可不代表可以自由使用。微光是单独授权的 VRM；使用即表示同意其许可，不同意可选择「不显示模型」。

导入在本机建立独立副本，不上传或遥测，不改写源文件。文件损坏、外部引用、资源越界、缺少必需人形、已声明的眨眼绑定无效、动作损坏、无效映射或提交失败都会拒绝导入，保留当前可用模型。缺少可选的眨眼或眼球跟随配置不会阻止导入，只停用对应能力。模型、贴图和动作各自的授权不会因格式转换、重定向或烘焙而改变。
