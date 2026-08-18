# Contributing

感谢你改进 DSH Inochi2D Pet。项目目前面向 Windows 11 x64 + WSL2 DSH latest；请先在 issue 中讨论超出该范围的平台、通用连接器或大型架构变更。

## 补丁边界

- 通用 Inochi2D 渲染、动画播放和模型 pipeline 变更应提交到 `StarCried/inochi2d-web`；本仓库只保留 DSH、协议和 Tauri 集成。
- 不要提交第三方 `.inp`、Creator 工程、私有角色素材、会话内容、令牌、路径或测试日志。
- 不要为未知 DSH 事件猜测旧语义。先更新 `tools/check-dsh-contract.mjs`、适配器和契约测试。
- 可选动画缺失时必须保持禁用；不要加入隐式 Idle 或程序动作 fallback。

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

涉及 DSH 的变更还应使用当前 `@deepseek-ai/dsh@latest` 运行契约检查、隔离 profile tarball 安装和真实 WSL2 联调。涉及渲染、窗口或模型的变更需说明人工测试的 Windows 版本、DPI、显示器与模型授权。

## Pull request 清单

- 行为和公共契约有对应测试；隐私负载测试明确断言敏感字段未出现。
- TypeScript、Rust debug/release、npm pack 内容和 `git diff --check` 通过。
- 没有无关格式化、生成产物或用户素材。
- 新依赖有必要性、固定版本/lockfile，并进入 SBOM 与许可证汇编。
- 用户可见变更更新 README 或 `docs/`。

提交者应理解并能够解释补丁，对其正确性、授权和测试结果负责。审查标准与代码来源无关，不会以自动生成作为跳过人工审查、测试或许可确认的理由。
