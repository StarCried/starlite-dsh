# DSH 兼容性与本地验收

2026-10-14，当前功能源码基线为 `6881daf`，保持一个 `dsh-starlite` 插件和同一个 Windows x64 Tauri 程序。未推送源码、发布 npm／Release、部署或公开模型；候选的默认模型地址仍是作者本机资源服务。

## 验证矩阵

| 使用形态 | 实际版本 | 本地结果 |
| --- | --- | --- |
| Windows 原生 CLI/Web | npm `@deepseek-ai/dsh@0.2.1-alpha.2`、Node 24 | 最终 `6881daf` 候选通过实际打包隔离安装／启动、状态桥、认证首页、fail-open 及退出回收；实际 Chrome 首页和准确目标会话的既有结果保留，未冒充最新包全面视觉复验 |
| 官方 Windows Desktop | 已安装官方签名版 `0.2.0-rc.2`，内置 Electron 44／Node 24、ASAR | 最终 `6881daf` 候选安装的 Host／client／EXE 与包内逐字节匹配，原宿主退出／等待宿主接管／到期退出已实际通过；准确导航、官方题目和限时界面为 `442eb08` 候选结果。continued 待清理隔离数据后复验 |
| WSL2 CLI/Web | CLI `0.1.5-rc.1`、Node 22.22.1，主要运行包为 `0.1.5-rc.2` | 最终 `6881daf` 候选实际打包隔离安装／启动、认证首页、状态桥、fail-open 与退出回收通过；WSL 系统打开器的实际 Chrome 首页和准确 Target 为既有结果，其他会话未选、标题一致、片段已消费，退出后监听关闭且临时 home 已清理 |

Desktop 使用独立 DSH_HOME；日常 profile 和凭据没有作为测试输入。既有安装／启停、自动微光、× 隐藏保留 Host／桌宠、真正退出及恢复结果保持有效；无会话双击唤起主界面已由用户在此前候选确认。修正导航路由的候选经用户手动验收准确会话和官方题目；包含倒计时修复的 `442eb08` 候选正常重启、微光和原设置保持。最终 `6881daf` 候选已安装，并逐项核对 Host／client／EXE 与包内字节一致。

普通单选、多选附加文字及独立文本回答已过。`442eb08` 候选的 12 秒限时题实际显示 9 秒至 1 秒，Host 超时后零答案、界面撤回；「转到 DSH 回答」从 Questions 准确切到 Continued，会话标题和官方题目一致，提交后 Host 接受一份自定义答案、导航 HTTP 200。欢迎页未完成时的失败保留草稿结果仍有效。最终 `6881daf` 只修改启动生命周期、原生程序未变，但没有将此前导航外推为最终包完整界面复验。

此前 continued 题显示补答提示、官方原子接口接受一份晚答，QA 手动接纳后在公开 pre-step 钩子拒绝下一步，没有运行模型。旧 QA seed 不符合官方 persisted V4 格式，仅属隔离测试素材问题；已校正为 `0.0.2` 并通过官方 JSONL 往返检查，安装后尚未启动。需清理旧隔离项目数据，再复验 continued，暂不标最终通过。

多 Host 实际测试发现的原宿主退出会提前关闭桌宠问题已由 `6881daf` 的原生 Windows detached 启动修复。最终候选实测：原 Host 退出后同一个桌宠进程隐藏存活，约 60 秒后恢复同一窗口并显示等待 Host 的题目标题；等待 Host 截止后桌宠自行退出。所有权接管与生命周期通过，但接管后的题目没有提交，不标为完整多 Host 答题业务通过。此修复不改变 Rust 或前端，原生 EXE 与 `442eb08` 实际界面候选相同。

Windows／WSL 实际 Chrome 视觉证据对应源码 `78e4013` 的候选；最终 `6881daf` 候选已分别完成实际打包安装、启动及回收 smoke，未将旧浏览器截图当作最终包全面视觉验收。

WSL 浏览器结果对应混合版本组合：CLI 为 `0.1.5-rc.1`，`dsh-app-boot`、`dsh-agent`、`dsh-agent-loop`、`dsh-client-connection`、`dsh-api-session-controller`、`dsh-web-app` 实际均为 `0.1.5-rc.2`，不声称纯 `rc.1` 依赖树通过。macOS/Linux 桌宠、远程 Host 和同时聚合多个 Host 不在本版支持范围。

## 接口与自动回归

- 官方源码固定核对到 [`d743267`](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c)，没有把源码版本当作实际安装包版本。
- npm `0.2.1-alpha.2` 的完整状态、流式文字、迁移状态、问答、Desktop／Web 导航及只读费用契约通过。上述 WSL `0.1.5-rc.1` CLI／`rc.2` 运行包组合保持原有阻塞问题和 Web 导航；它不被标为 Desktop 合格版本。
- npm 与 ASAR 两版官方 Host／浏览器 Connection 实现通过真实认证 RPC 检查，包含导航先于 Connection 加载、服务撤销／重建、重载、取消、过期及重复确认、Origin 和 Cookie 认证限制。官方 `ClientSessions` 与真实 Cordis sibling service 挂载也已通过；observable store 和目录／界面动作使用内存 fixture，不能代替真实浏览器 store、界面及会话导航验收。
- 官方安装器不携带完整 TypeScript 声明，因此未声称 ASAR 通过声明扫描；使用实际运行时检查补足证据。
- 限时与 continued 问题服务的 `0.2.0-rc.2`／`0.2.1-alpha.2` 实现一致。回归覆盖官方剩余时间、claim 释放、晚答的原子接受／拒绝、非阻塞动画、前台优先、隐私、委托和随机引用隔离。
- `6881daf` 已重新运行完整 `pnpm check`，45 个测试文件、423 项通过；候选文件白名单和哈希通过，原生程序沿用已构建验收的版本。Rust：44 项常规测试通过，1 项私有模型专项另行显式通过，fmt、严格 Clippy 通过；最终干净工作树的本地发布门另行核验，这些结果不代表可公开发布。
- 真实 VRM 首次下载、长度／SHA-256、离线缓存、不显示时不下载及失败不阻止 DSH 已在本地验证。当前来源仍为本机服务，不能代替正式 HTTPS 交付验证。
- 自动测试未提交模型提示、查询真实余额或使用真实账户凭据。托管 CI 已加入 Windows／Ubuntu 的 Desktop 契约与实际 RPC 检查；本轮没有推送来触发托管作业。

## 仍需人工确认

按 [候选验收清单](release-candidate-review.md) 完成校正素材后的 continued 复验；多 Host 接管后的答题提交尚未验收。Desktop 准确导航、答题交接、限时、普通回答、安装、窗口生命周期及所有权接管已有结果，不重复要求用户确认。既有模型、动画和博客验收保持有效；本次没有重测性能。

安装入口见 [用户指南](user-guide.md)；开发者复验命令见 [开发说明](development.md)、[桌面导航](desktop-navigation.md) 和 [问答生命周期](dsh-questions-contract.md)。最终包哈希与详细本地结果保存在未跟踪的 `release-output/windows-host-qualification`，不包含认证 URL、API Key 或会话内容。
