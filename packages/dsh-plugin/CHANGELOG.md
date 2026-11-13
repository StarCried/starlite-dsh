# 版本变化

## 0.2.0

### Minor Changes

- d70afb8: Inspect a character with middle-button dragging and return with a middle-click, while animations, bubbles and Agent presentation control continue. Preserve transparent-window input capture throughout the orbit and hide the entry hint after three seconds.

### Patch Changes

- 25e2bc6: Hide the account bonus-balance card when there is no nonzero bonus balance.
- 573ed0e: Add model-local tail sway controls for a named tail root, amplitude and cycle period. Preserve imported physics settings and support defaults embedded in VRM metadata.

  Refresh the independently licensed default Weiguang asset with the approved 35-degree, ten-second tail sway preset.
- ee3a705: Make tray Reset model restore the camera, reveal the character and return it to the primary display's bottom-right work area. Check the portrait rather than transparent window margins when recovering a saved off-screen position at startup.

## 0.1.3

### Patch Changes

- 4be06e2: Let a click during idle interrupt an ambient gesture or the previous click response, with a 500 ms cooldown between accepted clicks. Task-state animations retain priority, and stale animation completions cannot replace a newer response.
- Update rustix to 1.1.6, fixing [RUSTSEC-2026-0486](https://rustsec.org/advisories/RUSTSEC-2026-0486.html) in the desktop dependency lockfile.

## 0.1.2

- 新增默认关闭的「允许会话控制角色」。启用后，DSH 会话可通过内置工具和 Skill 播放模型已有动作、发送纯文本气泡，并临时调整位置、大小和光标跟随；不新增语音、记忆或外部聊天连接器。
- 接管只属于一个会话，取代自动工作气泡和事件动作，保留基础待机；拖动、修改设置、暂停、隐藏、断线或取消会退出，并恢复最新 DSH 状态。临时调整不写入用户偏好，隐私和气泡开关优先。
- 五分钟无活动后自动退出接管；所属会话的新输出和有效控制命令续期，无关会话和连接心跳不续期。双击仍准确打开接管会话。
- 脚下工具条改为透明样式，接管时仅在悬浮工具条中增加机器人退出按钮，不常驻显示会话条；自定义接管气泡不添加会话标题。

- 将当前界面与使用说明中的“环境补光”统一为“环境光”，配置字段和已有偏好保持兼容。
- 通用困倦惊醒动作移除回弹后的最后一次歪头，保留困倦、惊醒、眨眼和 5.5 秒时长。
- 环境光改为在角色可视轮廓附近取色，避开气泡和控件；「显示性能参数」更名为「显示调试信息」，同时开启环境光时显示实际采样位置，不增加采样点编辑或距离设置。
- 拖动时继续更新环境光，不再因窗口位置变化丢弃整次采样；只排除可能读到桌宠自身的采样块。
- 短暂取色失败保留最近一次有效环境光，强度调整立即生效；暂停、关闭或切换模型仍清理旧颜色。

沿用已公开的微光和蓝鱼独立模型来源，不随程序重新发布模型。Windows 发行物仍未代码签名；本轮构建、公开下载和实际安装结果分别记录，不把历史长期测试改记为本版复验。

## 0.1.1 · 2026-11-06

- 光标靠近模型时显示与博客共用的脚下工具条，可按 10 个百分点缩小／放大、开关气泡和暂时隐藏；从托盘恢复，完整右键菜单继续保留。
- 缩放围绕脚下中心进行，工具条与已打开的菜单保持屏幕位置；无需重载模型，暂停时也可调整，大小变化不会误触发耳尾位移物理。
- 身体按住移动超过 6 个 CSS 像素才开始拖动；短单击互动、双击打开 DSH 与透明背景穿透保持原有行为，拖动释放、失去捕获或窗口失焦不触发点击。
- 工具条消失后清除其原生命中区域，键盘焦点与临时隐藏同步；程序包仍不包含模型，已有角色、动作映射和偏好保留。
- 跟进 DSH 0.2.2 的公共声明布局；其问答服务新增的 `approval` 意图仍交由官方界面处理，不转换成桌宠问题。

## 0.1.0 · 2026-11-03

首个正式发行版，支持 Windows 11 x64：官方 DSH 桌面版、Windows 原生 CLI/Web、WSL2 CLI/Web。

- 新增独立授权的蓝色大肥鱼示例，可直接选择获取；微光仍为初始默认，模型与偏好不会因升级被替换。
- 提供基础待机与好奇探头、开心招手、困倦惊醒三个可选通用动作；互动姿态跟随 Idle 调校，保留来源与用户映射。
- 环境补光默认开启，强度 100%，可调 0–200%；只在本机采样窗口周围的小范围颜色，暂停、隐藏或安全桌面时停止，不保存或上传画面。显式关闭的设置保留。
- 余额卡支持 DSH 登录账号与 API Key；账号充值和赠送余额分开显示，不使用 API 单价推算账号扣费。
- 修复正常退出并快速重开时等待旧连接，以及已导入示例被重复下载造成的约 30 秒启动延迟；异常断线仍保留重连保护，另一个活跃 Host 不被抢占。
- 新增中文／英文界面与文档，默认隐藏性能面板、启用光标跟随，并按模型参考身高定位气泡。
- 将已撤回的 async-executor 1.14.0 更新到兼容补丁 1.14.1，重新通过完整依赖审计，不增加忽略项。

Windows 发行物仍未代码签名；完整测试与公开下载验证分别记录，不将旧报告算作本次全部复验。

## 0.1.0-alpha.2

- 模型右键菜单统一为与博客一致的样式，可调大小、帧率、跟随、气泡和工作气泡模式，恢复默认位置，或暂时隐藏与暂停。关闭气泡不影响动画触发；打开后的菜单保持位置，不随大小滑条抖动。
- 模型新增折叠的「姿态与跟随」设置：双臂、掌心、手腕抬高、手部张合，以及独立头眼灵敏度；更多调节提供肘部和跟随平滑时间。即时预览、按模型自动保存并支持逐项或全部还原；仅修正系统默认 Idle，模型自带动作保持原样。
- 修复掌心扭转左右方向不对称；手腕抬高支持 −45～45°，可与掌心、抬臂组合，保持腕部位置及上臂、前臂姿态。
- 更新 VRM 运行时，统一内嵌动作和 VRMA 对同一骨骼的引用，修复点击过渡时身体动作被旧姿态覆盖、表情先变化及过渡结束跳变的问题。保留原动作时间轴与 400 ms 平滑过渡；用户已于 2026-10-15 确认本机重复点击复测正常。
- 设置新增默认关闭的「显示性能参数（FPS 等）」；修改立即生效、自动保存，不重新加载模型。参数仅在本地显示，不拦截透明区域输入，也不代表 DSH 推理或整个系统的性能。
- 模型卡片新增「模型信息」，显示人形骨骼、眨眼／眼球跟随能力、动作及几何统计；缺少可选能力仍可使用，损坏映射给出具体提示，导入失败保留原模型与偏好。
- 模型信息改为资源数字卡、带文字的能力状态和可展开的详细统计；三角面采用 VRChat PC 单项参考色，避免将静态数量误作整体性能评分。配置建议、纯文本安全和窄窗滚动保持可用。
- 增加依赖审计与有期限的上游问题复核规则，补齐升级、问题反馈和性能排查说明。
- Vite 更新至 8.2.4、Vitest 更新至 4.1.12，修复开发服务器相关安全公告；完整在线审计通过，没有新增忽略项，见[依赖维护](../../docs/dependency-audit.md)。

用户已通过独立浏览器调校页验收掌心与抬腕效果；新增手腕项未单独进行 DSH 原生界面手验。实际发行状态、源码与人工验收范围见[兼容性记录](../../docs/dsh-compatibility.md)。

## 0.1.0-alpha.1

- 标准人形 VRM 缺少 Blink 表达时仍可导入，只停用自动眨眼；眼球跟随也是可选能力，损坏的资源引用仍拒绝。
- 基础待机优先使用有效角色配置的 `neutralAnimation`，同时保留明确映射和已有用户设置。
- 模型卡片新增「移除」及确认框；清理程序管理的导入副本，保留原始文件与其他模型。移除当前模型后隐藏角色，重启不会重新获取微光。
- 默认模型重试成功或明确停用后，清除已解决的准备错误；独立的偏好及动作映射保存失败仍保留提示。
- 修复同一 DSH Host 短暂断线后点击动画不恢复的问题；继续过滤同一连接内的重复、倒序消息，并保持不同 Host 隔离。
- 不支持的平台明确提示 Windows 11 x64／WSL2 x64；安装检查给出阶段、固定错误类别和退出码，不打印原始认证信息。
- README 增加无需安装的模型效果入口，更新安装、导入与开发说明。

程序和模型许可、安装标识、deep link 及 DSH 状态协议保持不变。微光仍独立授权、独立下载；本版不增加模型或动作资产。

实际发布来源、自动测试和人工验收边界见[兼容性记录](../../docs/dsh-compatibility.md)。

## 0.1.0-alpha.0

首次公开 alpha：一个插件接入官方 Windows Desktop、Windows 原生 CLI/Web 或 WSL2 CLI/Web，自动准备 Windows 桌宠和独立微光 VRM，提供动作映射、光标跟随、工作／费用气泡及会话问答。
