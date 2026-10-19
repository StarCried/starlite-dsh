# StarLite for DSH

用动作和气泡陪伴你的 DSH 工作。**安装一个插件，启动 DSH 即默认使用微光**，无需另装软件或手动导入资源。

Alpha `0.1.0-alpha.2`，需要 Windows 11 x64、WebView2，以及官方 Windows 桌面版、Windows 原生 CLI/Web 或 WSL2 DSH。

[先看模型效果](https://starcried.github.io/)（桌面浏览器，无需安装；工作状态与问答需安装插件）。

**快速开始**：[自己安装](#安装与启动) · [让 Agent 安装](#让-agent-帮你)

## 安装与启动

**Windows 桌面版**：侧栏「插件 → 添加插件」，输入 `dsh-starlite@alpha`，安装并启用；按 DSH 提示重启。

**CLI/Web**：在运行 DSH 的 Windows 或 WSL 终端给日常 profile 安装插件，然后启动：

```bash
dsh plugin --profile web add dsh-starlite@alpha
dsh --profile web
```

将 `web` 换成自己的 profile。插件自动准备 Windows 程序，资源未缓存时自动下载并配置微光；已有 VRM 模型、映射与偏好保留。以后只需启动 DSH。

**使用微光即表示同意其独立许可；不同意请在模型列表选择「不显示模型」。** 模型卡片可切换模型或查看许可，「添加 VRM 模型」直接选择文件，详细要求可点「查看导入说明」；设置自动保存。当前仅支持 VRM，Inochi2D 导入和显示已停用。

## 让 Agent 帮你

把下面这段发给能操作本机的 Agent，它会按[安装指南](https://github.com/StarCried/starlite-dsh/blob/main/docs/user-guide.md)识别环境并完成安装：

```text
请阅读 https://github.com/StarCried/starlite-dsh/blob/main/docs/user-guide.md
为我正在使用的 DeepSeek Harness 安装 npm 已发布的 dsh-starlite@alpha。
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

## 日常使用

单击模型回应并查看费用；双击在桌面应用或浏览器打开当前会话，无会话时打开 DSH；拖动身体移动桌宠。右键或托盘打开设置。工作气泡可选精简／详细模式，普通问题可直接在气泡里选择或输入。

在 DSH 侧栏「插件」查找 `dsh-starlite`；旧版 DSH 在设置的插件列表中查看。若同一 profile 装过 `dsh-inochi2d-pet`，先移除旧包。桌面版的插件安装与 CLI/Web profile 独立，需要分别安装；一次只连接一个 Host，切换时停止原 Host（桌面版从 DSH 托盘退出），桌宠会在重连期结束后连接等待者。

## 进阶

[安装、升级与卸载](https://github.com/StarCried/starlite-dsh/blob/main/docs/user-guide.md) · [换模型与动作](https://github.com/StarCried/starlite-dsh/blob/main/docs/model-import.md) · [气泡、费用与隐私](https://github.com/StarCried/starlite-dsh/blob/main/docs/companion-interactions.md)

自己的标准人形 VRM 需要有效的人形映射，无动作时自动使用自带基础待机；眨眼和眼球跟随是可选能力，缺少时仍可使用。模型内的动作会自动列出供映射；模型卡片可移除不用的模型，源文件保留，重启不重新添加。桌宠准备、下载或兼容性检查失败时，DSH 仍可正常运行。API Key、用户提示、工具参数／结果和真实会话 ID 不发送给桌宠。桌面版关闭主窗口只隐藏界面，须从 DSH 托盘退出才停止 Host。

程序 BSD-2-Clause；默认待机随程序提供，来源见开发文档。微光及其其他动作独立授权，不打包在 npm 插件内。Windows 程序目前未签名。
