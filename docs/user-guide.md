# DSH Companion 安装与使用

支持 Windows 11 x64 和一个运行于 Ubuntu WSL2 的 DSH。Windows 负责显示，WSL 负责 DSH；不需要同时安装 Windows DSH。程序与微光资源包分别下载、分别授权。当前是未签名 alpha 候选；尚未发布的版本请使用本地候选文件。

## 安装

1. 在作者正式发布页取得同一版本的 Windows 安装包、DSH 插件和校验文件。核对 SHA-256；alpha 安装包未签名，Windows 可能显示 SmartScreen。确认来源后按系统提示处理，不关闭系统防护。安装为当前用户，注册 `dsh-inochi2d-pet` 启动协议。
2. 在 WSL 中安装已验收的 DSH（本次兼容检查为 `0.1.5-rc.1`）。已有 DSH 可先核对版本；不要为桌宠开启第二个 DSH 实例。

```bash
npm install -g --prefix "$HOME/.local" @deepseek-ai/dsh@0.1.5-rc.1
export PATH="$HOME/.local/bin:$PATH"
```

3. 将插件加到自己实际启动的 profile。本例使用 `web`。正式 npm 发布后：

```bash
dsh plugin --profile web add dsh-inochi2d-pet@0.1.0-alpha.0
```

本地候选用完整 tarball 路径代替包名，例如 `/mnt/e/path/dsh-inochi2d-pet-0.1.0-alpha.0.tgz`。仅安装到要使用的 profile，不编辑插件缓存或把临时认证链接保存进配置。

4. 首次打开 Windows 程序，在设置中选择有权使用的 `.inp` 或 `.vrm`。VRM 再多选 `.vrma` 动作，按需选择 `profile.json`。明确选择待机；其他状态映射或禁用；点击回应与偶发动作直接勾选多个，每次随机播放。微光资源包选择 `desktop/Weiguang.vrm`、`desktop/motions` 中所有动作及 `desktop/profile.json`，并按包内映射表配置。博客轻量版不用于替换桌宠包。
5. 保存后在 WSL 启动 `dsh --profile web`。插件随 DSH 拉起桌宠。未配置模型时打开设置；断开后隐藏并等待重连。缺少 Windows 程序或契约不兼容时，DSH 本身仍可运行。

## 日常使用

- 模型身体可拖动，周围透明区域点击穿透；右键身体或托盘打开设置。手动穿透开启后，使用托盘恢复操作。
- 单击：待机时随机回应，并显示官方 DeepSeek 余额与今日 DSH 费用估算。工作时只查费用。双击：打开气泡正在显示的会话；没有当前会话时打开 DSH Web UI 首页。连接已断开或会话已失效时显示不可用，不跳到别的会话。
- 工作气泡默认精简：会话标题＋当前状态。详细模式额外显示经过限制的思考／输出内容；设置中可切换。等待普通用户输入时，气泡显示单选、多选或自定义输入。权限批准仍在 DSH 中处理。
- 只有待机循环。工作、完成、错误、等待确认、阻塞动作各做一次再回待机；逻辑任务仍忙碌时不触发点击或偶发动作。新的状态可以打断动作。
- 费用需先在 DSH 模型设置配置官方 `deepseek` 路由，凭据只由 DSH 保管。网关和未知价格不冒充官方金额；估算只含当前 profile 的今日记录，不是账户正式账单。桌宠不要求填写 API Key。
- 可设置隐私模式、暂停、显示比例、30／60 FPS 和 DPR。首次 VRM 默认 30 FPS、DPR 1.5。电脑耗电或卡顿时降低 DPR／帧率；隐藏和暂停停止动画与物理更新。

模型、动作、配置副本存储在应用数据目录；气泡文本与临时连接令牌不记录。模型不会上传。请遵守每个模型、贴图和动作自身的许可。

## 更新与卸载

更新程序先退出托盘中的桌宠，运行同版本配套的新安装包，再更新 WSL profile 中的插件。设置与模型保持在应用数据目录；旧版设置迁移保留原有偏好，Thinking 映射合并到 Working。更换角色通过设置重新导入，失败不会替换现有可用模型。

在 Windows“已安装的应用”中卸载程序；WSL 运行 `dsh plugin --profile web remove dsh-inochi2d-pet` 移除插件（使用其他 profile 时替换 `web`）。用户模型与设置的删除是独立操作，卸载前确认是否要保留。停止使用公开博客模型时也需清除站点输出中的旧资源。

源码构建、固定运行时和隔离测试见 [开发指南](development.md)。微光未随程序许可授予其他软件使用权；资源包授权与来源未确认前仅保留本地。
