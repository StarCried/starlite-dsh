# dsh-starlite

**StarLite for DSH** 的桥接插件：让 Windows 桌宠跟随 WSL2 中的 DSH 工作状态，显示气泡并接收普通用户问题的回答。

## 安装与启动

需要 Windows 11 x64、已经可用的 WSL2 DSH，以及同版本的 Windows 桌宠。目前是尚未公开发布的 alpha 候选，已验收 DSH `0.1.5-rc.1`；无需重装已有 DSH。

1. 安装 Windows 桌宠。首次打开时选择独立授权的微光 ZIP、确认许可，资源和动作映射会自动导入。
2. 在 WSL 终端给日常使用的 profile 安装候选插件，然后启动 DSH：

```bash
dsh plugin --profile web add /mnt/c/Downloads/dsh-starlite-0.1.0-alpha.0.tgz
dsh --profile web
```

将路径和 `web` 换成自己的资源位置及 profile。公开 alpha 发布后，安装命令可简化为 `dsh plugin --profile web add dsh-starlite@alpha`。以后只需运行 `dsh --profile web`，插件会自动启动 Windows 桌宠。

模型及第三方动作与程序独立分发。导入自己的模型时当前仍需提供真实 Idle 动作；通用默认 Idle 和无动作自动站姿尚未提供。

## 日常使用

单击模型查看回应与官方 DeepSeek 费用信息；双击打开气泡对应的 DSH 会话，无会话时打开 Web UI 首页。拖动模型身体可移动桌宠，右键或托盘打开设置。气泡默认显示标题和状态，也可切换详细模式；普通用户问题可直接在气泡里回答，工具权限审批仍在 DSH 中处理。

在 DSH「设置 → 插件 → 插件列表 → 全局」查找 `dsh-starlite`。桌宠设置位于 Windows 程序；「插件配置」页不显示桌宠设置卡。

若同一 profile 曾安装 `dsh-inochi2d-pet`，先执行 `dsh plugin --profile web remove dsh-inochi2d-pet`。不要同时运行新旧桥接；已有 Windows 用户模型与设置保留。

## 进阶

[安装、升级与卸载](https://github.com/StarCried/starlite-dsh/blob/feat/dual-model-backends/docs/user-guide.md) · [换模型与动作](https://github.com/StarCried/starlite-dsh/blob/feat/dual-model-backends/docs/model-import.md) · [气泡、费用与隐私边界](https://github.com/StarCried/starlite-dsh/blob/feat/dual-model-backends/docs/companion-interactions.md) · [开发与兼容检查](https://github.com/StarCried/starlite-dsh/blob/feat/dual-model-backends/docs/development.md)

插件不向 Windows 发送 API Key、用户提示、工具参数／结果或真实会话 ID。不兼容或缺少 Windows 程序时只停用桌宠，DSH 继续运行。桥接随 DSH 停止；Windows 桌宠断连后隐藏，等待重连后退出。当前不支持原生 Windows DSH。

BSD-2-Clause；Windows alpha 安装器未签名，安装前核对来源与哈希。
