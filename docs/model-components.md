# StarLite 模型组件边界

桌宠只依赖统一模型控制器，DSH 状态协议不携带模型类型。复用的渲染、动作播放和资源准备属于独立 StarLite 组件仓库；本仓库保留窗口、安装、状态聚合、气泡与输入交互。

## 运行时与导入

| 组件 | npm 身份 | 桌宠 staging 路径 |
| --- | --- | --- |
| 公共控制器／生命周期／对话调度 | `@starcried/starlite-core` | `runtime/core` |
| VRM 0／1、VRMA、材质与物理 | `@starcried/starlite-vrm` | `runtime/vrm` |
| 可选 Inochi2D WASM 与参数动画 | `@starcried/starlite-inochi2d` | `runtime/inochi2d` |

`pnpm sync:runtime -- <StarLite packages/inochi2d/dist>` 从同一 checkout staging 三个组件并记录来源 revision、内容哈希与许可证。浏览器只导入所选渲染后端；当前构建依赖仍包含两者。本轮不改变为 VRM 默认安装路径。

`release/starlite.rev` 固定 JavaScript 组件；原生 Inochi2D 准备库另有 `release/inochi2d-pipeline.rev`。本地 checkout 与包元数据使用 StarLite；两个 GitHub 仓库已按用户批准完成更名。本轮没有 push 或 release，本地新源码尚未公开；更名不改变已有用户设置身份或深链接。

原生 `inspect_model` 接受 `path`、可选 `animationSources`（`name`／`path`）和 `profilePath`。结果包含 `backend` 和仅有 `name`／`durationMs` 的公共动作目录。Inochi2D 轨道、VRM 文件路径与角色数据留在各后端载荷中。表情预设不是动作，当前不把 VRM 内嵌 glTF animation 自动列成可选 VRMA。

作者 ZIP 资源包通过 `inspect_resource_pack` 检查并显示独立许可；用户同意后，`install_resource_pack` 再次核对整包 SHA-256，自动读取 `desktop/manifest.json` 中的模型、动作、角色配置和映射，复用同一事务安装。解包与检查在后台线程执行，临时目录随操作清理；取消或失败保留原模型。ZIP 只作为数据，不执行包内文件。

VRM 必须自包含；外部 URI、不支持的必需编码、损坏的节点／骨架／accessor／时间轴会拒绝。上限为模型 64 MiB、单动作 16 MiB、动作合计 64 MiB、64 个命名动作、角色配置 1 MiB。角色配置仅数据，检查阶段不执行模型或配置代码。

读取与检查全部成功、精确名称映射有效并成功提交设置后才替换当前模型；失败保留已安装资源。源码仅使用无角色素材的合成测试，微光等私有资源不进入测试夹具。

## 当前能力与下一阶段

当前模型可以在独立播放器中无动作预览；桌宠保存仍要求显式选择作者提供的 Idle。普通 VRM 的眨眼和眼球跟随依赖可用的 blink／lookAt 配置，不套用微光逻辑。

已批准的下一阶段目标是：仅自带一段原创通用 Idle，为没有动作的标准人形 VRM 提供自然基础姿态、轻呼吸、眨眼与限角跟随；用户动作按需映射，气泡可独立工作。此文档整理不实现这些能力，也不以其他动作填补缺失事件。

## 设置与动作调度

设置 schema 为版本 3。版本 1 按 Inochi2D 迁移并保留原映射／偏好；版本 2 把 Thinking 合并到 Working，并把 Click／Ambient 转成列表。再次成功保存才写新版，未知 schema 拒绝读取。

只有显式 Idle 循环。工作（含思考）、阻塞、等待确认、完成和错误各播放一次再回 Idle；逻辑任务仍忙碌时不会启动点击或偶发动作。新状态打断旧片段，旧 Promise 迟到完成不能恢复旧状态。禁用映射保持中性，暂停、断线、模型或映射变化取消待完成动作和偶发计时。

Click／Ambient 为最多 20 项的随机池。挂载使用公共取消槽；快速更换模型时，迟到实例销毁，不能覆盖当前模型。

## 固定画布与输入

桌宠逻辑模型区域为 320 × 480 CSS 像素。VRM 挂载时一次预留固定透明边距和气泡空间；播放动作、气泡大小变化不调整原生窗口或模型屏幕锚点。气泡靠近屏幕边缘时只移动自身。Inochi2D 保留自己的窗口填充布局。

原生层仅在模型轮廓和可交互问题表单中接收点击；其他透明区域穿透。命中遮罩只含有界 alpha 覆盖位，不是截图；DPI 与坐标转换由本地层处理。拖动使用捕获的物理光标／窗口起点并合并位置更新。光标仅存在于内存，隐藏时停止遮罩与光标处理。

VRM 可接收 `setHostPosition(x,y)`，以有界世界位移驱动物理，再在渲染前移除该位移，保持屏幕锚点。暂停／销毁清除坐标；Inochi2D 保留作者的物理行为。人工验收需覆盖动作边界、耳尾物理、轮廓命中、拖动、工作气泡与表单。

原生单元测试见 [开发说明](development.md)。私有资源导入检查仅按需设置 `DSH_PET_VRM_ASSETS` 并运行忽略测试；不能把本地模型或测试日志提交进仓库。
