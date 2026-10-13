# StarLite for DSH

让微光陪你使用 DeepSeek Harness：安静待机，用动作和气泡显示工作状态，也能直接回答会话里的选择题。

需要 **Windows 11 x64 + WebView2**，DSH 运行在 **WSL2**。当前是本地测试候选，尚未发布 npm 包。

## 安装并体验微光

在 **WSL 终端**给平时使用的 DSH profile 安装插件，然后启动：

```sh
dsh plugin --profile web add /path/to/dsh-starlite-0.1.0-alpha.0.tgz
dsh --profile web
```

把路径和 `web` 换成自己的候选包位置及 profile。**只安装这一个插件**：启动 DSH 后自动准备 Windows 桌宠，并默认使用微光。资源尚未缓存时自动下载，模型、动作和状态映射一起配置；已有 VRM 模型和偏好保留。

以后只需启动 DSH，桌宠随之出现。无需另装桌宠软件、手动解压模型或填写 EXE 路径。程序使用系统 WebView2，不打包浏览器。当前候选使用作者在本机启动的资源服务测试下载流程，尚无公开资源下载地址。

**使用微光即表示同意其独立许可；不同意请在设置中禁用模型。** 设置中可随时阅读完整许可；禁用后不显示或渲染模型，DSH 继续正常运行。本版本仅启用 VRM，Inochi2D 暂不提供导入和显示。

## 日常操作

- **单击**：互动并显示官方 DeepSeek 余额和今日 DSH 用量估算。
- **双击**：打开气泡显示的会话；没有会话时打开 Web UI。
- **拖动身体**：移动桌宠，透明背景允许点击后面的程序。
- **右键或托盘**：打开设置，切换精简／详细气泡。
- **等待回答时**：直接在气泡中选择或输入；工具权限审批仍在 DSH 中处理。

## 进阶使用

[安装、升级与卸载](docs/user-guide.md) · [自定义模型与动作](docs/model-import.md) · [气泡与互动](docs/companion-interactions.md) · [开发说明](docs/development.md)

程序采用 [BSD-2-Clause](LICENSE)。微光资源包单独授权、单独下载，不包含在 npm 程序包内。
