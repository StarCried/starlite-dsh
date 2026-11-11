# StarLite for DSH

简体中文 · [English](README.en.md)

把自己的 VRM 角色带到 DeepSeek Harness：安静待机，用动作和气泡显示工作状态，也能直接回答会话里的选择题。

**[先看模型效果](https://starcried.github.io/)**：无需安装，用桌面浏览器体验博客中的微光；DSH 的工作状态与问答气泡需安装下方插件。

正式版 `0.1.2`，需要 **Windows 11 x64 + WebView2**。支持官方 Windows 桌面版、Windows 原生 CLI/Web 和 WSL2 DSH。[版本变化](CHANGELOG.md)

**快速开始**：[自己安装](#安装并体验微光) · [让 Agent 安装](#让-agent-帮你)

## 安装并体验微光

**官方 Windows 桌面版**：打开侧栏「插件 → 添加插件」，填入 `dsh-starlite`，安装后启用；如 DSH 提示需要重启，请从托盘退出后重新打开。

**CLI/Web（Windows 或 WSL2）**：给平时使用的 DSH profile 安装插件，然后启动：

```sh
dsh plugin --profile web add dsh-starlite
dsh --profile web
```

把 `web` 换成自己的 profile。**只安装这一个插件**：启动 DSH 后自动准备 Windows 桌宠，并默认使用微光。资源尚未缓存时自动下载，模型、动作和状态映射一起配置；已有 VRM 模型和偏好保留。

以后只需启动 DSH，桌宠随之出现。无需另装桌宠软件、手动解压模型或填写 EXE 路径。程序使用系统 WebView2，不打包浏览器。

**使用微光即表示同意其独立许可；不同意请在模型列表选择「不显示模型」。** 每个模型都可查看自己的许可。本版本仅启用 VRM，Inochi2D 暂不提供导入和显示。

## 让 Agent 帮你

把下面这段发给能操作本机的 Agent，它会按[安装指南](docs/user-guide.md)识别环境并完成安装：

```text
请阅读 https://github.com/StarCried/starlite-dsh/blob/main/docs/user-guide.md
为我正在使用的 DeepSeek Harness 安装 npm 已发布的 dsh-starlite。
先识别 Windows 桌面版、Windows CLI/Web 或 WSL2 及实际 profile，使用对应安装入口。
保留模型和偏好，不升级 DSH、不另开第二个 Host。
完成不调用付费模型 API 的本地检查，告诉我如何启动和打开设置。
```

<details>
<summary>只想先了解用法？复制这个提示词</summary>

```text
请阅读 https://github.com/StarCried/starlite-dsh/blob/main/docs/user-guide.md
结合我的 DSH 安装方式，简要说明如何启动、升级、换模型和设置气泡。
这次只解释，不安装或修改配置。
```

</details>

## 日常操作

- **单击**：互动并显示 DeepSeek 余额；支持账号登录和 API Key，API 模式另显示今日用量估算。
- **双击**：打开气泡显示的会话；没有会话时打开 DSH。桌面版在应用内打开，CLI/Web 在浏览器中打开。
- **拖动身体**：移动桌宠，透明背景允许点击后面的程序。
- **悬停工具条**：靠近模型后可缩小／放大、开关气泡或暂时隐藏；从托盘恢复显示。
- **右键身体**：调整大小、帧率、跟随和气泡，或恢复默认位置；「更多设置」和托盘可打开完整设置，切换或导入模型。
- **等待回答时**：直接在气泡中选择或输入；工具权限审批仍在 DSH 中处理。

## 进阶使用

[安装、升级与卸载](docs/user-guide.md) · [自定义模型与动作](docs/model-import.md) · [气泡与互动](docs/companion-interactions.md) · [下载与联网说明](docs/network-and-storage.md) · [开发说明](docs/development.md)

提供可选的[会话控制](docs/session-control.md)：让 DSH 用角色的动作和气泡与你互动，默认关闭。

添加自己的标准人形 VRM：无动作时使用自带的基础待机，有动作时自动列出供映射。眨眼和眼球跟随按模型能力启用，缺少对应配置仍可使用；不再需要的模型可在卡片上移除，源文件保留。

一次连接一个 DSH Host。切换时停止原 Host（桌面版从 DSH 托盘退出），正常退出会立即释放连接，快速重启复用模型；异常断线才保留重连期。

程序采用 [BSD-2-Clause](LICENSE)。微光与蓝色大肥鱼均为独立授权、单独下载的 VRM，不包含在 npm 程序包内。
