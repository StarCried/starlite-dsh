# StarLite for DSH

用动作和气泡陪伴你的 DSH 工作。**安装一个插件，启动 DSH 即默认使用微光**，无需另装软件或手动导入资源。

需要 Windows 11 x64、WebView2，以及 WSL2 中已经可用的 DSH。当前为未发布的本地 alpha 候选。

## 安装与启动

在 **WSL 终端**给平时使用的 profile 安装候选包，然后启动 DSH：

```bash
dsh plugin --profile web add /path/to/dsh-starlite-0.1.0-alpha.0.tgz
dsh --profile web
```

将路径和 `web` 换成自己的包位置及 profile。插件自动准备 Windows 程序，资源未缓存时自动下载并配置微光；已有 VRM 模型、映射与偏好保留。以后只需启动 DSH。当前本地测试包依赖作者在本机运行的资源服务，不能作为公开发行包。

**使用微光即表示同意其独立许可；不同意请在模型列表选择「不显示模型」。** 模型卡片可切换模型或查看许可，「添加模型」可导入新资源；设置自动保存。当前仅支持 VRM，Inochi2D 导入和显示已停用。

公开 npm 发布后，安装命令可改为 `dsh plugin --profile web add dsh-starlite@alpha`。目前还没有可安装的公开版本。

## 日常使用

单击模型回应并查看费用；双击打开当前会话，无会话时打开 Web UI；拖动身体移动桌宠。右键或托盘打开设置。工作气泡可选精简／详细模式，普通问题可直接在气泡里选择或输入。

在 DSH「设置 → 插件 → 插件列表 → 全局」查找 `dsh-starlite`。若同一 profile 装过 `dsh-inochi2d-pet`，先移除旧包，避免同时运行新旧桥接。

## 进阶

[安装、升级与卸载](https://github.com/StarCried/starlite-dsh/blob/feat/dual-model-backends/docs/user-guide.md) · [换模型与动作](https://github.com/StarCried/starlite-dsh/blob/feat/dual-model-backends/docs/model-import.md) · [气泡、费用与隐私](https://github.com/StarCried/starlite-dsh/blob/feat/dual-model-backends/docs/companion-interactions.md)

当前桌宠导入自己的模型仍需真实 Idle 动作。桌宠准备、下载或兼容性检查失败时，DSH 仍可正常运行。插件不向 Windows 发送 API Key、用户提示、工具参数／结果或真实会话 ID。当前仅支持 WSL2 DSH。

程序 BSD-2-Clause；微光和第三方动作独立授权，不打包在 npm 插件内。Windows 程序目前未签名。
