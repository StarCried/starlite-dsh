# DSH 兼容性与本地验收

2026-10-14，本次保持一个 `dsh-starlite` 插件和同一个 Windows x64 Tauri 程序。未推送源码、发布 npm／Release、部署或公开模型；候选的默认模型地址仍是作者本机资源服务。

## 验证矩阵

| 使用形态 | 实际版本 | 本地结果 |
| --- | --- | --- |
| Windows 原生 CLI/Web | npm `@deepseek-ai/dsh@0.2.1-alpha.2`、Node 24 | 最终 tarball 隔离安装、原生状态桥、认证首页、缺失 EXE 与不兼容订阅不阻止 DSH、日志和退出回收通过 |
| 官方 Windows Desktop Host | 官方签名安装包 `0.2.0-rc.2`，内置 Electron 44／Node 24、ASAR | 使用其内置包管理器安装最终 tarball，运行真实 Desktop Host；状态桥与 Web 共两处回环监听、认证首页、缺失 EXE 不阻止启动、官方 IPC shutdown 后监听关闭通过 |
| WSL2 CLI/Web | `0.1.5-rc.1`、Node 22.22.1 | 官方 CLI 在临时 home/profile 安装最终 tarball；认证首页、状态桥、缺失 EXE 继续运行、SIGTERM 后两处监听关闭通过 |

Desktop 验证只解包官方安装器，没有将 DSH 安装到系统、注册协议或修改日常配置。它验证真实 Host 和 ASAR 运行时，不代替整个桌面壳的人工操作。macOS/Linux 桌宠、远程 Host 和同时聚合多个 Host 不在本版支持范围。

## 接口与自动回归

- 官方源码固定核对到 [`d743267`](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c)，没有把源码版本当作实际安装包版本。
- npm `0.2.1-alpha.2` 的完整状态、流式文字、迁移状态、问答、Desktop／Web 导航及只读费用契约通过。WSL `0.1.5-rc.1` 保持原有阻塞问题和 Web 导航；它不被标为 Desktop 合格版本。
- 两版官方 Host／浏览器 Connection 实现通过真实认证 RPC 检查，包含导航先于 Connection 加载、服务撤销／重建、重载、取消、过期及重复确认、Origin 和 Cookie 认证限制。
- 官方安装器不携带完整 TypeScript 声明，因此未声称 ASAR 通过声明扫描；使用实际运行时检查补足证据。
- 限时与 continued 问题服务的 `0.2.0-rc.2`／`0.2.1-alpha.2` 实现一致。回归覆盖官方剩余时间、claim 释放、晚答的原子接受／拒绝、非阻塞动画、前台优先、隐私、委托和随机引用隔离。
- `pnpm check`：43 个测试文件、382 项通过；Rust：44 项通过，1 项私有模型专用测试保持忽略。fmt、严格 Clippy、Windows GUI 构建、统一插件白名单及本地发布门通过。
- 自动测试未提交模型提示、查询真实余额或使用真实账户凭据。托管 CI 已加入 Windows／Ubuntu 的 Desktop 契约与实际 RPC 检查；本轮没有推送来触发托管作业。

## 仍需人工确认

按 [候选验收清单](release-candidate-review.md) 的「本轮新增的 Windows Host 验收」检查：插件页安装／启停、模型双击准确导航、没有会话时唤起主界面、× 隐藏和真正退出、快速重启及 Host 排队。模型外观和既有动画没有在本次修改，不重复替用户判定通过。

安装入口见 [用户指南](user-guide.md)；开发者复验命令见 [开发说明](development.md)、[桌面导航](desktop-navigation.md) 和 [问答生命周期](dsh-questions-contract.md)。最终包哈希与详细本地结果保存在未跟踪的 `release-output/windows-host-qualification`，不包含认证 URL、API Key 或会话内容。
