# DSH Inochi2D Pet

面向 Windows 11 + WSL2 DeepSeek Harness 的开源 Inochi2D 桌宠。DSH 的聚合状态驱动模型作者制作的动画；可选气泡只显示经过清洗、且 DSH 已经暴露给对话前端的文本。

> 当前状态：公开源码 BYOM（Bring Your Own Model）预览版。源码可以构建并导入用户自己的 `.inp`；尚未发布 npm 包、Windows 安装包或任何第三方模型。“微光”演示模型及其可再分发许可完成前，预构建 alpha 的发布检查会强制失败。

## 支持范围

- Windows 11 x64、WebView2，以及运行在 WSL2 中的单个 DSH 进程。
- DSH 状态：Idle、Thinking、Working、Approval、Blocked、Completed、Error；Idle 时可触发 Click。
- 模型必须精确提供已映射的 Inochi2D 动画。除 Idle 必填外，其余状态可以显式禁用；不会偷偷回退到 Idle 或程序生成动作。
- alpha 不支持原生 Windows DSH、多个 DSH 进程、Linux/macOS 桌面、聊天/语音/记忆、自动更新和透明像素级命中。

## 从源码试用（当前可用）

源码构建会从公开、固定 revision 的
[`StarCried/inochi2d-web`](https://github.com/StarCried/inochi2d-web)
生成 WebGL2 运行时，并构建未签名的 Windows 桌宠与 DSH bundle。仓库不包含
Aka、微光或其他 `.inp`；首次运行会打开设置，由用户选择自己有权使用的模型。

完整命令、Windows/WSL 分工和本地 tarball 安装方式见
[开发与 BYOM 试用](docs/development.md)。

## 安装预构建 alpha（尚未发布）

先在 Windows 安装未签名的 `DSH Inochi2D Pet` NSIS 安装包。Windows SmartScreen 可能显示“未知发布者”，请先从 Release 校验 SHA-256；本 alpha 不要求购买代码签名证书。

在 WSL2 中执行：

```bash
mkdir -p "$HOME/.local/bin"
npm install -g --prefix "$HOME/.local" \
  pnpm@11.7.0 \
  @deepseek-ai/dsh@latest
export PATH="$HOME/.local/bin:$PATH"

dsh plugin --profile web add dsh-inochi2d-pet@latest
dsh --profile web --dump-config
dsh web
```

把 `export PATH="$HOME/.local/bin:$PATH"` 加入 shell 启动文件后即可日常直接运行。更新 DSH 时重新执行上面的 npm 安装命令；程序不会在后台自动更新 DSH。Windows 安装器会注册 `dsh-inochi2d-pet://`，WSL 插件从注册表解析并直接启动该 Windows 程序。

安装或插件契约不兼容时，桌宠会停用并输出一次诊断，但不能阻止 DSH 启动。卸载时先执行 `dsh plugin --profile web remove dsh-inochi2d-pet`，再从 Windows“已安装的应用”卸载桌宠。

## 模型设置

从托盘打开“设置”，选择本地 `.inp`。导入器会先检查模型与资源边界，再准备 Web 版本并以原子方式替换旧模型。请选择模型中真实存在的动画名：

- `Idle`：必填、循环。
- `Thinking`、`Working`、`Approval`、`Blocked`：可选、持续循环。
- `Completed`、`Error`、`Click`：可选、单次播放。

模型损坏、格式不兼容、动画不存在或准备失败时不会写入部分结果，旧模型和设置保持不变。详见 [模型导入说明](docs/model-import.md)。

## 隐私与架构

Cordis bundle 在 DSH 内聚合全部会话，在随机 IPv4 回环端口提供带 256 位临时令牌的 SSE。Windows Tauri/WebView2 客户端通过 WSL localhost forwarding 连接：

```text
DSH / Cordis (WSL2) -> token-authenticated localhost SSE
                     -> Tauri 2 / WebView2 (Windows)
                     -> inochi2d-web / WebGL2 / .inp
```

跨边界协议只有状态、单调序号、时间和短气泡。它不包含用户提示词、工具参数/结果、错误栈、路径、会话 ID 或凭据；文本只按纯文本渲染且不落盘。托盘可随时开启固定文案隐私模式。完整威胁边界见 [安全说明](docs/security.md)。

## 源码布局与开发

- `packages/protocol`：版本化线协议、严格解析和 Unicode 文本清洗。
- `packages/dsh-plugin`：Cordis bundle、全局状态聚合、SSE 与 Windows 拉起。
- `apps/desktop`：Tauri 外壳、渲染器、托盘、设置和事务式模型导入。
- `tools/mock-source`：只用于开发/自动测试的 `PetStateSource` Mock。

构建、测试和 DSH tarball 联调见 [开发说明](docs/development.md)，发布审批门见 [发布说明](docs/release.md)。

提交补丁前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题按 [SECURITY.md](SECURITY.md) 报告。

## 许可证

代码使用 BSD-2-Clause。每个模型与美术资产使用独立声明的许可证；仓库许可证不自动授予任何模型权利。
