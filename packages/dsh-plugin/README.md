# StarLite for DSH

简体中文 · [English](https://github.com/StarCried/starlite-dsh/blob/main/packages/dsh-plugin/README.en.md)

用动作和气泡陪伴你的 DSH 工作。**安装一个插件，启动 DSH 即默认使用微光**，无需另装软件或手动导入资源。

正式版 `0.1.1`，需要 Windows 11 x64、WebView2，以及官方 Windows 桌面版、Windows 原生 CLI/Web 或 WSL2 DSH。

[先看模型效果](https://starcried.github.io/)（桌面浏览器，无需安装；工作状态与问答需安装插件）。

**快速开始**：[自己安装](#安装与启动) · [让 Agent 安装](#让-agent-帮你)

## 安装与启动

**Windows 桌面版**：侧栏「插件 → 添加插件」，输入 `dsh-starlite`，安装并启用；按 DSH 提示重启。

**CLI/Web**：在运行 DSH 的 Windows 或 WSL 终端给日常 profile 安装插件，然后启动：

```bash
dsh plugin --profile web add dsh-starlite
dsh --profile web
```

将 `web` 换成自己的 profile。插件自动准备 Windows 程序，资源未缓存时自动下载并配置微光；已有 VRM 模型、映射与偏好保留。以后只需启动 DSH。

**使用微光即表示同意其独立许可；不同意请在模型列表选择「不显示模型」。** 模型卡片可切换模型或查看许可，「添加 VRM 模型」直接选择文件，详细要求可点「查看导入说明」；设置自动保存。当前仅支持 VRM，Inochi2D 导入和显示已停用。

## 让 Agent 帮你

把下面这段发给能操作本机的 Agent，它会按[安装指南](https://github.com/StarCried/starlite-dsh/blob/main/docs/user-guide.md)识别环境并完成安装：

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

## 日常使用

单击模型回应并查看费用；双击在桌面应用或浏览器打开当前会话，无会话时打开 DSH；拖动身体移动桌宠。右键打开快捷菜单，选择「更多设置」或使用托盘打开设置。工作气泡可选精简／详细模式，普通问题可直接在气泡里选择或输入。

靠近模型时，脚下显示缩小／放大、气泡与暂时隐藏按钮；大小每次改变 10 个百分点，工具条位置保持固定，不重载模型。暂停时仍可使用，隐藏后从托盘恢复。身体移动超过 6 个 CSS 像素才算拖动，透明背景继续穿透。

在 DSH 侧栏「插件」查找 `dsh-starlite`；旧版 DSH 在设置的插件列表中查看。若同一 profile 装过 `dsh-inochi2d-pet`，先移除旧包。桌面版的插件安装与 CLI/Web profile 独立，需要分别安装；一次只连接一个 Host，切换时停止原 Host（桌面版从 DSH 托盘退出），桌宠会在重连期结束后连接等待者。

## 进阶

[安装、升级与卸载](https://github.com/StarCried/starlite-dsh/blob/main/docs/user-guide.md) · [换模型与动作](https://github.com/StarCried/starlite-dsh/blob/main/docs/model-import.md) · [气泡、费用与隐私](https://github.com/StarCried/starlite-dsh/blob/main/docs/companion-interactions.md)

开发版支持可选的[会话控制](https://github.com/StarCried/starlite-dsh/blob/main/docs/session-control.md)，默认关闭。开启后，DSH 会话可临时调用已列出的动作、简短气泡与位置大小设置；用户操作始终优先，退出后恢复普通工作状态。仍使用同一个插件，无需另配 MCP。

自己的标准人形 VRM 需要有效的人形映射，无动作时自动使用自带基础待机；眨眼和眼球跟随是可选能力，缺少时仍可使用。模型内的动作会自动列出供映射；模型卡片可移除不用的模型，源文件保留，重启不重新添加。桌宠准备、下载或兼容性检查失败时，DSH 仍可正常运行。API Key、用户提示、工具参数／结果和真实会话 ID 不发送给桌宠。桌面版关闭主窗口只隐藏界面，须从 DSH 托盘退出才停止 Host。

程序 BSD-2-Clause；默认待机随程序提供，本版另提供三个可选通用动作，来源记录随程序保留。微光外观和专属动作独立授权，不打包在 npm 插件内。Windows 程序目前未签名。

<details>
<summary>模型下载、联网与存储</summary>

安装阶段没有模型下载脚本。启动 DSH 时，所选示例尚未导入且没有有效下载缓存时，插件从 `github.com/StarCried/starlite/releases/download/` 获取，允许 GitHub 跳转至 `release-assets.githubusercontent.com`。已导入的模型直接复用，升级程序不会重复下载。下载不携带 API Key、Cookie 或会话内容；URL、长度及 SHA-256 固定在随包的 `assets/windows-x64/manifest.json` 中。

程序和下载缓存位于 `%LOCALAPPDATA%\StarCried\StarLite\companions`，导入模型与偏好位于 `%APPDATA%\com.starcried.dsh-inochi2d-pet`。插件启动随包的 Windows EXE，DSH 与桌宠通过有临时令牌认证的本机 `127.0.0.1` 随机端口通信。WSL 也使用 Windows 程序和缓存。

环境光默认开启，可在右键菜单或设置中关闭，已有关闭设置会保留。它只在本机低频读取角色周边的小块颜色，不保存或上传图像；隐藏、暂停或锁屏时停止取色。

打开费用卡时优先通过 DSH 官方账号服务查询充值余额和赠金，由 DSH 请求其 Platform origin 的 `/api/v0/users/get_user_summary`；未登录或无账号服务时，使用已配置的官方 API Key 查询 `https://api.deepseek.com/user/balance`。余额缓存 60 秒，不发起付费模型请求；登录令牌和 API Key 不交给桌宠。账号费用以 DSH 用量页为准，今日估算仅用于 API Key 模式。没有遥测或后台更新检查。选择「不显示模型」或自定义模型后，后续启动不获取默认示例；停用插件可停止其运行。

[完整联网说明与源码核对入口](https://github.com/StarCried/starlite-dsh/blob/main/docs/network-and-storage.md)

</details>
