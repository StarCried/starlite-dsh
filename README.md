# StarLite for DSH

让微光陪你使用 DeepSeek Harness：安静待机，用动作和气泡显示工作状态，也能直接回答会话里的选择题。

需要 **Windows 11 x64 + WebView2**。支持官方 Windows 桌面版、Windows 原生 CLI/Web 和 WSL2 DSH。当前是本地测试候选，尚未发布 npm 包。

## 安装并体验微光

**官方 Windows 桌面版**：打开侧栏「插件 → 添加插件」，填入候选 `.tgz` 的 Windows 绝对路径，安装后启用；如 DSH 提示需要重启，请从托盘退出后重新打开。

**CLI/Web（Windows 或 WSL2）**：给平时使用的 DSH profile 安装插件，然后启动：

```sh
dsh plugin --profile web add /path/to/dsh-starlite-0.1.0-alpha.0.tgz
dsh --profile web
```

把路径换成当前终端可用的候选包绝对路径，把 `web` 换成自己的 profile。**只安装这一个插件**：启动 DSH 后自动准备 Windows 桌宠，并默认使用微光。资源尚未缓存时自动下载，模型、动作和状态映射一起配置；已有 VRM 模型和偏好保留。

以后只需启动 DSH，桌宠随之出现。无需另装桌宠软件、手动解压模型或填写 EXE 路径。程序使用系统 WebView2，不打包浏览器。当前候选使用作者在本机启动的资源服务测试下载流程，尚无公开资源下载地址。

**使用微光即表示同意其独立许可；不同意请在模型列表选择「不显示模型」。** 每个模型都可查看自己的许可。本版本仅启用 VRM，Inochi2D 暂不提供导入和显示。

## 日常操作

- **单击**：互动并显示官方 DeepSeek 余额和今日 DSH 用量估算。
- **双击**：打开气泡显示的会话；没有会话时打开 DSH。桌面版在应用内打开，CLI/Web 在浏览器中打开。
- **拖动身体**：移动桌宠，透明背景允许点击后面的程序。
- **右键或托盘**：打开设置，点击模型卡片切换，点击「添加 VRM 模型」导入；详细要求在「查看导入说明」中，设置自动保存。
- **等待回答时**：直接在气泡中选择或输入；工具权限审批仍在 DSH 中处理。

## 进阶使用

[安装、升级与卸载](docs/user-guide.md) · [自定义模型与动作](docs/model-import.md) · [气泡与互动](docs/companion-interactions.md) · [开发说明](docs/development.md)

添加自己的模型只需选择一个 VRM：无动作时使用自带的基础待机，有动作时自动列出供映射。

一次连接一个 DSH Host。切换时停止原 Host（桌面版从 DSH 托盘退出），桌宠会在重连期结束后连接等待者。

程序采用 [BSD-2-Clause](LICENSE)。微光是独立授权、单独下载的 VRM，不包含在 npm 程序包内。
