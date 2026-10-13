# StarLite for DSH

让微光陪你使用 DeepSeek Harness：安静待机，用动作和气泡显示工作状态，也能直接回答会话里的选择题。

需要 **Windows 11 x64 + WebView2**，DSH 运行在 **WSL2**。当前为本地候选，新名称的公开下载尚未发布。

## 安装并使用微光

1. 在 Windows 安装 **StarLite for DSH**。首次打开时选择独立授权的 **Weiguang for StarLite** ZIP 并确认许可，模型、动作和状态映射自动导入并保存。
2. 在 WSL 中，为平时使用的 DSH profile 安装桥接插件：

   ```sh
   dsh plugin --profile web add /path/to/dsh-starlite-0.1.0-alpha.0.tgz
   ```

不想运行安装器时，可使用[免安装 ZIP](docs/user-guide.md#免安装版可选)：解压后指定一次 Windows EXE 路径。安装器会自动完成路径发现，操作更少；两种方式使用同一个桌宠程序。

以后只需启动 DSH，桌宠会自动出现：

```sh
dsh --profile web
```

桌宠在 DSH 连接后出现；单独打开 Windows 程序用于导入模型和调整设置，不会自动启动 DSH。程序不打包浏览器，使用 Windows 的 WebView2。

## 日常操作

- **单击**：互动并显示官方 DeepSeek 余额和今日 DSH 用量估算。
- **双击**：打开气泡显示的会话；没有会话时打开 Web UI。
- **拖动身体**：移动桌宠，透明背景允许点击后面的程序。
- **右键或托盘**：打开设置，切换精简／详细气泡。
- **等待回答时**：直接在气泡中选择或输入；工具权限审批仍在 DSH 中处理。

## 进阶使用

[自定义模型与动作](docs/model-import.md) · [气泡与互动](docs/companion-interactions.md) · [开发说明](docs/development.md) · [项目结构](docs/model-components.md)

程序采用 [BSD-2-Clause](LICENSE)。微光资源包单独授权，不包含在程序安装包内。
