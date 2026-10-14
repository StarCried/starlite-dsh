# DSH 兼容性与本地验收

2026-10-14，当前功能源码基线为 `78e4013`，保持一个 `dsh-starlite` 插件和同一个 Windows x64 Tauri 程序。未推送源码、发布 npm／Release、部署或公开模型；候选的默认模型地址仍是作者本机资源服务。

## 验证矩阵

| 使用形态 | 实际版本 | 本地结果 |
| --- | --- | --- |
| Windows 原生 CLI/Web | npm `@deepseek-ai/dsh@0.2.1-alpha.2`、Node 24 | 本轮重打包通过隔离安装／启动、状态桥、认证首页、fail-open 及退出回收；实际 Chrome 首页和准确目标会话通过，标题一致、目标选中且片段已消费 |
| 官方 Windows Desktop | 已安装官方签名版 `0.2.0-rc.2`，内置 Electron 44／Node 24、ASAR | 既有安装／启停、自动微光、× 隐藏、退出及恢复结果保留；现已通过官方内置 CLI 安装准确的当前包，Host／client 文件逐字节匹配，重启及新包独立文本回答通过；当前包导航仍待实测 |
| WSL2 CLI/Web | CLI `0.1.5-rc.1`、Node 22.22.1，主要运行包为 `0.1.5-rc.2` | 当前包隔离安装／启动、认证首页、状态桥、fail-open 与退出回收通过；WSL 系统打开器的实际 Chrome 首页和准确 Target 通过，其他会话未选、标题一致、片段已消费，退出后监听关闭且临时 home 已清理 |

Desktop 使用独立 DSH_HOME；日常 profile 和凭据没有作为测试输入。上一候选完成生命周期及用户无会话双击验收；其原生 EXE 与当前包相同，但系统打开器等待方式已改变，旧导航结果不外推。当前已完全退出 DSH／桌宠，用官方内置 CLI 移除并安装准确的当前包，确认 Host／client 文件与包内哈希一致；正常重启、微光和原设置 SHA 保持通过。新包无会话双击、指定会话及转交答题仍待实测。

普通单选已实际返回一项答案；用户已完成多选附加文字，后端接受一项回答、两个选项及一份自定义文字。新包独立文本也实际返回一项自定义回答、零选项。欢迎页未完成时的一次「转到 DSH 回答」超时实际保留了草稿；欢迎页完成后的再次交接仍待用户操作。未将全部 GUI、限时／continued、性能或多 Host 验收标为通过。

WSL 浏览器结果对应混合版本组合：CLI 为 `0.1.5-rc.1`，`dsh-app-boot`、`dsh-agent`、`dsh-agent-loop`、`dsh-client-connection`、`dsh-api-session-controller`、`dsh-web-app` 实际均为 `0.1.5-rc.2`，不声称纯 `rc.1` 依赖树通过。macOS/Linux 桌宠、远程 Host 和同时聚合多个 Host 不在本版支持范围。

## 接口与自动回归

- 官方源码固定核对到 [`d743267`](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c)，没有把源码版本当作实际安装包版本。
- npm `0.2.1-alpha.2` 的完整状态、流式文字、迁移状态、问答、Desktop／Web 导航及只读费用契约通过。上述 WSL `0.1.5-rc.1` CLI／`rc.2` 运行包组合保持原有阻塞问题和 Web 导航；它不被标为 Desktop 合格版本。
- npm 与 ASAR 两版官方 Host／浏览器 Connection 实现通过真实认证 RPC 检查，包含导航先于 Connection 加载、服务撤销／重建、重载、取消、过期及重复确认、Origin 和 Cookie 认证限制。官方 `ClientSessions` 与真实 Cordis sibling service 挂载也已通过；observable store 和目录／界面动作使用内存 fixture，不能代替真实浏览器 store、界面及会话导航验收。
- 官方安装器不携带完整 TypeScript 声明，因此未声称 ASAR 通过声明扫描；使用实际运行时检查补足证据。
- 限时与 continued 问题服务的 `0.2.0-rc.2`／`0.2.1-alpha.2` 实现一致。回归覆盖官方剩余时间、claim 释放、晚答的原子接受／拒绝、非阻塞动画、前台优先、隐私、委托和随机引用隔离。
- `pnpm check`：44 个测试文件、409 项通过；Rust：44 项常规测试通过，1 项私有模型专项另行显式通过。fmt、严格 Clippy 通过；统一插件仍按白名单、程序完整性及本地发布门核验，不据此宣称可公开发布。
- 真实 VRM 首次下载、长度／SHA-256、离线缓存、不显示时不下载及失败不阻止 DSH 已在本地验证。当前来源仍为本机服务，不能代替正式 HTTPS 交付验证。
- 自动测试未提交模型提示、查询真实余额或使用真实账户凭据。托管 CI 已加入 Windows／Ubuntu 的 Desktop 契约与实际 RPC 检查；本轮没有推送来触发托管作业。

## 仍需人工确认

按 [候选验收清单](release-candidate-review.md) 只补未完成项：当前包的 Desktop 无会话／指定会话导航及答题交接、限时／continued 实际界面和 Host 排队。单选、多选／自定义回答、安装／启停、窗口生命周期、当前包安装及 Windows／WSL 浏览器导航已有结果，不重复要求用户确认。既有模型、动画和博客验收保持有效；本次没有重测性能。

安装入口见 [用户指南](user-guide.md)；开发者复验命令见 [开发说明](development.md)、[桌面导航](desktop-navigation.md) 和 [问答生命周期](dsh-questions-contract.md)。最终包哈希与详细本地结果保存在未跟踪的 `release-output/windows-host-qualification`，不包含认证 URL、API Key 或会话内容。
