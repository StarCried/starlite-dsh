# Contributing

感谢你改进 StarLite for DSH。项目面向 Windows 11 x64 + WebView2，支持同机的官方 Windows DSH 桌面版、Windows 原生 CLI/Web 和 WSL2 CLI/Web；WSL2 不是前两种形态的前置条件。CI 检查已发布 DSH latest 契约，具体版本和验收边界见 [兼容性记录](docs/dsh-compatibility.md)，不保证未来版本自动兼容。请先在 issue 中讨论超出该范围的平台、通用连接器或大型架构变更。

## 补丁边界

- 通用渲染、动画播放和模型准备属于 [StarLite 组件仓库](https://github.com/StarCried/starlite)；本仓库只保留 DSH、协议和 Tauri 集成。DSH 当前仅启用 VRM；不要在此重新引入已停用的 Inochi2D 导入或运行时。
- 不要提交第三方 `.vrm`／`.vrma`／`.inp`、Blender／Creator 工程、私有角色素材、真实会话内容、令牌、本机路径或原始测试日志。使用可再分发的合成测试数据。
- 不要为未知 DSH 事件猜测旧语义。先更新 `tools/check-dsh-contract.mjs`、适配器和契约测试。
- 无动作标准人形 VRM 的导入和程序自带基础待机已经交付；不要重新要求用户准备动作包。基础待机包含第三方呼吸层，来源见 [默认 Idle 记录](apps/desktop/src-tauri/assets/default-idle.md)，不能称为完全原创。缺少可选 blink／lookAt 时只关闭对应行为；声明了但引用损坏的资源仍须拒绝。可选事件动作缺失时保持禁用，不隐式映射到别的动作。
- 保持项目安静、轻量；不新增遥测、自动质量切换或后台更新。性能参数只在用户启用时显示，不收集或上传设备数据。

## 本地检查

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm pack:plugin

cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy --locked --release --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

涉及 DSH 的变更还应使用当前已公开 `@deepseek-ai/dsh@latest` 运行契约检查和隔离 profile tarball 安装；依受影响范围验证 Windows 原生、官方桌面版或 WSL2。只通过 npm CLI 测试不能声称官方桌面 GUI 已通过。涉及渲染、窗口或模型的变更需说明人工测试的 Windows 版本、DPI、显示器与模型授权。具体命令及隔离方法见 [开发说明](docs/development.md)。

## Pull request 清单

- 行为和公共契约有对应测试；隐私负载测试明确断言敏感字段未出现。
- TypeScript、Rust debug/release、npm pack 内容和 `git diff --check` 通过。
- 没有无关格式化、生成产物或用户素材。
- 新依赖有必要性、固定版本/lockfile，并进入 SBOM 与许可证汇编。
- 用户可见变更更新 README 或 `docs/`。
- 区分自动检查、实机观测和用户验收；给出精确候选身份，不将旧版结果或未发布修复写成公开版本已通过。

普通用户反馈用 [issue 模板](https://github.com/StarCried/starlite-dsh/issues/new/choose)，安装与升级见 [用户指南](docs/user-guide.md) 和 [升级与支持](docs/upgrade.md)。安全问题遵循 [安全政策](SECURITY.md)，不要在公开 PR 或 issue 中附上利用细节或秘密。

提交者应理解并能够解释补丁，对其正确性、授权和测试结果负责。审查标准与代码来源无关，不会以自动生成作为跳过人工审查、测试或许可确认的理由。
