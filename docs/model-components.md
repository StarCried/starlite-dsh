# StarLite 模型组件边界

桌宠依赖统一模型控制器，DSH 状态协议不携带模型类型。共享 StarLite 仓库提供渲染、动作和角色行为；本仓库保留窗口、安装、状态聚合、气泡及输入交互。

## 运行时

| 组件 | npm 身份 | staging 路径 |
| --- | --- | --- |
| 公共控制器、生命周期、对话调度 | `@starcried/starlite-core` | `runtime/core` |
| VRM 0／1、VRMA、材质、物理、内嵌动作 | `@starcried/starlite-vrm` | `runtime/vrm` |

`pnpm sync:runtime -- <StarLite checkout>` 从同一 checkout staging 两个组件，记录来源 revision、内容哈希与许可证。`release/starlite.rev` 固定同一源码 revision。当前 DSH 只启用 VRM，不包含 Inochi2D JavaScript、WASM 或原生准备库；共享仓库的独立 Inochi2D 组件不受影响。

原生用户数据身份和深链接保持不变，停用 Inochi2D 不删除原有模型文件及偏好。

## 单文件导入

设置中的「添加模型」直接选择 VRM，然后检查并事务安装。原生 `inspect_model`／`install_model` 接口读取标准 humanoid、眨眼绑定、模型元数据及内嵌 glTF animation。公共动作目录只有名称与时长；内嵌动作名称放在 VRM 载荷的 `embeddedAnimations` 中。

程序随原生 EXE 提供单个基础动作 `StarLiteIdle`，所有导入模型均可选择。没有自己的 `Idle` 时自动映射到它；存在模型 Idle 时优先使用。其他事件动作只来自用户模型，缺失时保持未映射。基础动作来源见 [记录](../apps/desktop/src-tauri/assets/default-idle.md)，不将含第三方呼吸层的片段表述为完全原创。

VRM 内嵌动作使用标准 glTF 骨骼、位移及形态权重通道。运行时将原始人形骨骼轨道转换到 VRM normalized 骨骼，再统一更新人形、表情与物理，避免动画覆盖或重复更新。可选 `animation.extras.starlite.expressions` 用表达名称关联 SCALAR sampler，使表情与自动眨眼、视线协作；普通形态动画仍可播放。

可选 `extras.starlite.profile`、`license` 和 `mappings` 分别提供角色配置、完整许可与默认映射，不是导入的必需格式。微光单文件保留已验收动作、角色配置及独立许可，和其他 VRM 使用相同检查和安装路径。

原生接口仍接受可选 `animationSources`（name／path）和 `profilePath`，供现有模型及开发集成使用；设置界面不要求选择这些外部文件。表情预设不是动作，不自动变成动作目录。

## 校验与安装

VRM 必须自包含，提供 15 个必需 humanoid 骨骼映射和真实眨眼 morph 绑定。对象名称不作为判据。眼球跟随需要正确的 lookAt；详细约定见 [模型导入](model-import.md)。

外部 URI、不支持的必需编码、损坏节点／骨架／accessor／时间轴拒绝导入。上限为模型 64 MiB、单个外部动作 16 MiB、外部动作合计 64 MiB、64 个内嵌动作、角色配置 1 MiB。配置仅作数据处理，不执行模型或配置代码。

检查、复制、复检、映射验证和设置提交全部成功后才切换模型。导入失败保留原模型；源码测试只使用无角色素材的合成夹具。私有模型检查使用 `DSH_PET_VRM_FILE` 配合忽略测试，不能提交私有模型或日志。

## 设置与动作调度

设置 schema 为 4：`models` 保存模型列表，`activeModelId` 选择当前模型，`null` 表示不显示。每个模型独立保存资源、映射及许可。旧版本当前模型、映射、许可和偏好自动迁移，旧禁用状态转为不显示；旧 Inochi2D 文件保留但不可选用。

`update_preferences` 自动保存显示偏好，`update_model_mappings` 按模型 ID 保存映射，`select_model` 切换选择。原生写入和设置事件使用同一互斥锁保证顺序。映射与隐私修改不重建渲染器。

只有 Idle 循环；其他状态各播放一次后回待机。忙碌时不触发点击或偶发动作，新状态可以打断旧片段，旧 Promise 迟到完成不能恢复旧状态。暂停、隐藏、断线、模型或映射变化取消待完成动作及偶发计时。Click／Ambient 各最多 20 项，随机选一项。快速切换模型会销毁迟到实例。

## 固定画布与输入

逻辑模型区域为 320 × 480 CSS 像素。挂载时预留固定透明边距和气泡空间；动作与气泡变化不调整窗口或模型屏幕锚点。气泡靠近屏幕边缘时只移动自身。

原生层只在模型轮廓及可交互问题表单中接收点击，透明区域穿透。命中遮罩仅含有界 alpha 覆盖位，不是截图；DPI 与坐标由本地层转换。拖动使用捕获的物理光标／窗口起点，合并位置更新。光标只在内存中存在，隐藏后停止处理。

VRM 的 `setHostPosition(x,y)` 用有界世界位移驱动物理，渲染前移除位移以保持锚点。暂停或销毁清除坐标。人工验收覆盖动作边界、耳尾物理、轮廓命中、拖动、气泡与表单；详见 [开发说明](development.md)。
