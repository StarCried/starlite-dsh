# 升级与支持

StarLite for DSH 目前处于 alpha。只维护最新已公开 alpha；安装使用 `dsh-starlite@alpha`，精确版本与来源查看 [npm](https://www.npmjs.com/package/dsh-starlite) 和 [Releases](https://github.com/StarCried/starlite-dsh/releases)。本文介绍 `0.1.0-alpha.2`；源码版本和本地构建不等于 registry 已公开版本，发行状态见 [兼容性记录](dsh-compatibility.md)。

支持 Windows 11 x64 + WebView2，Host 可以是同机的官方 Windows DSH 桌面版、Windows 原生 CLI/Web 或 WSL2 CLI/Web。不同 Host／profile 要分别安装插件，但使用同一 Windows 用户的模型和偏好；一次只连接一个 Host。支持范围与实测 DSH 版本见 [兼容性记录](dsh-compatibility.md)。

## 更新插件

1. 查看 [版本变化](../CHANGELOG.md) 和对应发行说明。
2. 完全退出正在使用的 DSH 和 Windows 托盘中的 StarLite。DSH 桌面窗口的 × 只隐藏窗口，请从 DSH 托盘退出。
3. 在原来的 Host／profile 中更新插件，重新启动该 DSH。

官方 Windows 桌面版使用侧栏「插件」中的更新或重新安装入口，按 DSH 提示重启。若通过命令行管理，使用桌面版注册的内置 `dsh` 和其受管 `desktop` profile；独立 npm CLI 不能替代它。详见 [桌面版安装说明](user-guide.md#官方-windows-桌面版)。

CLI/Web 在原来的 Windows 或 WSL 终端操作；将 `web` 换成实际 profile。若 DSH 版本没有更新入口，可以先移除同名插件，再安装 alpha：

```sh
dsh plugin --profile web remove dsh-starlite
dsh plugin --profile web add dsh-starlite@alpha
dsh --profile web
```

移除插件不会删除 Windows 端已导入的模型、动作映射或显示／隐私／气泡偏好。新版程序随插件准备，系统 WebView2 沿用现有安装；不要通过删除 AppData 来升级。已有微光可以复用本机缓存，独立模型版本是否更新以发行说明为准。不要同时保留旧名 `dsh-inochi2d-pet` 桥接和 `dsh-starlite`。

若需固定已公开版本，将安装命令中的 `@alpha` 换成该版本号；不要把本地候选当作 npm 已发布包。旧版本不保证读取未来格式的设置，降级前先核对发行说明，不要删除模型或设置来绕过错误。

## 升级后检查

- 模型、动作映射与原有显示偏好保持正常。
- 待机、单击和双击可用；透明背景可操作下面的窗口。
- 无需发送付费请求即可检查基本显示、拖动、设置和导航；工作状态及问答可在日常使用中继续确认。
- 停止 DSH 后桌宠会隐藏，并在重连等待结束后退出；窗口 × 隐藏不等同于退出 DSH。

更完整的行为及已知限制见 [安装与使用](user-guide.md)。升级失败时先确认使用了哪个 Host／profile、是否有另一实例占用连接，再按指南排查；不要启动第二个 Host 来替换仍在运行的连接。

## 性能参数（alpha.2 起）

从 StarLite 托盘打开「设置 → 显示」，勾选「显示性能参数（FPS 等）」。开关自动保存、立即生效，不重新加载模型；默认关闭。alpha.1 及更早版本没有这个入口。

模型角落显示实际渲染 FPS、帧间隔 p95、CPU 侧帧耗时 p95、draw calls 和三角面。每 500ms 最多更新一次，统计最近 240 个绘制帧；暂停、隐藏和恢复会重置数据。CPU 数字是模型更新和 WebGL 提交等工作的墙钟耗时，可能包含驱动等待，不是 GPU 执行时间、CPU 利用率或进程内存。它不代表 DSH 推理或整个系统的性能。

性能参数只在本地显示，不上传；关闭时没有浮层定时器或浮层采样缓存。VRM 原有诊断历史仍保留。排查卡顿时说明帧率、DPR、Windows 缩放、显示器刷新率和显卡；截图只保留模型及参数，避免包含会话正文。

## 模型姿态与跟随（本地候选）

选中模型后展开「姿态与跟随」，可调双臂抬高、掌心朝向、手部张合及独立的头部／眼球灵敏度；「更多调节」提供肘部弯曲和跟随平滑时间。调节即时预览并自动保存到当前模型，切换模型不会共用这些值；每项可还原，也可恢复此模型默认值。公开 alpha.2 尚无此入口。

姿态调节只作用于 StarLite 自带的默认站姿，保留呼吸；模型自带的待机及其他动作保持原样。手部张合未调整时沿用原动作，手动设定后 0% 为张开、100% 为握拳。模型缺少有效手指或眼球配置时，对应项会显示原因并停用；部分手指映射只调整已映射部分。灵敏度改变响应幅度，仍受角度限制；平滑时间越小，跟随越快。原始 VRM 文件不会被改写。

## 反馈问题

alpha.2 的模型卡片提供「模型信息」，可查看必需／可选人形骨骼数、Blink 和眼球跟随能力、动作及几何统计；导入不会额外弹窗。缺少可选眨眼或眼球配置时，其他能力仍可使用。统计按网格 primitive 累加，不等于 GPU 或进程内存。导入错误会指出缺失的标准骨骼等原因；失败保持原有模型与设置。

信息按资源数字卡、基础能力和可展开的详细统计分组，颜色同时配文字。三角面单项参考 [VRChat PC 档位](https://creators.vrchat.com/avatars/avatar-performance-ranking-system/)：不超过 32,000 为「优秀」，不超过 70,000 为「良好」，更高显示「偏高」。这是资源规模参考，不是整体 VRChat 评级或 FPS 预测；材质数并非材质槽、人形映射数并非整个骨架的骨骼数，不能照搬评级。动作等数量使用中性色，眨眼／眼球跟随分别显示「可用」「部分可用」或「未配置」，详细说明保留缺失能力的修复建议。

通过 [问题模板](https://github.com/StarCried/starlite-dsh/issues/new/choose) 提供 StarLite 与 DSH 的实际版本、Host 形态、最小复现和预期／实际行为。模型问题优先说明 VRM0／VRM1、导出工具及检查提示，不要求公开上传私有模型；第三方素材必须遵守原许可。

不要附上 API Key、临时连接链接、DSH 凭据文件、真实会话内容或未脱敏的完整日志。安全问题请先阅读 [安全政策](../SECURITY.md)。
