# StarLite for DSH alpha 发布检查

当前是本地候选，未发布 npm 或公开模型。统一插件包含 Windows 程序、通知及下载清单；程序仅内嵌已批准的基础待机，微光角色及其他动作仍作为独立授权的单文件 VRM 下载。源码推送、npm、Windows Release、模型分发和博客部署分别需要批准，本地脚本不执行这些外部动作。

## 构建来源

发布使用独立干净 checkout，只 staging 同一 revision 的 `core` 与 `vrm`。`release/starlite.rev` 固定共享源码，provenance 记录真实 revision、文件哈希及 `dirty: false`。正式发布前，该源码 revision 必须已公开；不手改 provenance、不使用旧 dist，也不重置用户工作区满足检查。

当前 DSH 不包含 Inochi2D 或 WASM。程序基础待机来源见 [记录](../apps/desktop/src-tauri/assets/default-idle.md)，包含第三方呼吸层，不称为完全原创。程序源码 BSD-2-Clause 与模型、动作的许可分别处理。

## 程序候选

1. 构建并验证共享运行时，更新 pin，再同步其 revision 和哈希。
2. 通过 `pnpm check`、Rust fmt／clippy／test、DSH 契约检查及隔离 profile 的实际 tarball 安装和 fail-open 检查。
3. `pnpm desktop:build` 生成 Windows x64 GUI EXE 和可选未签名 NSIS。生成依赖通知后，用明确的单文件 VRM 来源描述 staging，再打包。tarball 必须恰好包含 11 个允许文件，EXE 的版本、GUI 子系统、长度和 SHA-256 匹配，不夹带角色资源。
4. 运行安装 CI，检查新装、合成基线升级、重装、卸载及用户数据保留；该结果不代替真实旧设置迁移和 Windows 人工验收。
5. 保持 workspace、desktop、protocol、plugin、Cargo、Tauri 版本一致。正式升级使用新版本。

```powershell
pnpm release:metadata -- "apps/desktop/src-tauri/target/release/bundle/nsis/StarLite for DSH_0.1.0-alpha.0_x64-setup.exe"
pnpm stage:plugin -- release-output/default-model.json
pnpm pack:plugin
pnpm check:release
pnpm release:metadata -- packages/dsh-plugin/.pack/dsh-starlite-0.1.0-alpha.0.tgz "apps/desktop/src-tauri/target/release/bundle/nsis/StarLite for DSH_0.1.0-alpha.0_x64-setup.exe"
```

资源描述只包含 `title`、固定 HTTPS `url`、VRM 的 `sha256` 和 `bytes`；程序清单 schema 为 2，使用 `defaultModel` 字段。首次元数据命令提供 staging 所需的依赖通知，打包后再生成最终 SHA256SUMS、CycloneDX SBOM 和第三方许可证。

本地验收来源使用 `localTest: true` 及只监听 `127.0.0.1` 的资源服务，可执行 `pnpm check:release -- --local-test` 检查其余发布门。默认发布门拒绝本机来源，该开关不构成发布批准。CI 仅用无角色、不可下载的测试清单检查结构，产物为 `local-only-windows-validation`，不能公开发行。私有模型不进入 CI。

## 人工验收

- WSL 自动准备 Windows 程序、默认 VRM 下载、离线缓存、下载／长度／哈希失败以及 DSH 继续启动。
- 模型列表切换、许可排版、不显示后重启保持、已有模型与偏好迁移。
- 单个 VRM 直接导入；无动作时基础站姿、呼吸、眨眼与限角跟随；有动作时完整目录和精确映射；失败保留旧模型。
- 微光 14 个动作、手指、表情、耳尾物理、大动作边界、中途切换及低帧率恢复。
- 透明区域穿透、拖动、DPI、多显示器、睡眠、重连与关闭 DSH 后退出。
- 工作、费用、普通问题表单、隐私、单击与双击；不使用付费模型请求来替代可模拟的检查。
- Windows SmartScreen 与未签名说明。时间戳检查只防止明显过期产物，不证明可复现或安装验收。

普通用户只安装统一 DSH 插件，NSIS 是独立程序验收方式，不是使用前置条件。安装 CI 只在无现有协议注册或用户数据的 runner 执行；合成升级基线不保证旧产品名的快捷方式和卸载项自动迁移。

## 微光单文件

微光 VRM 包含运行所需的模型、贴图、标准 glTF 动作以及可选角色、许可和默认映射元数据，不包含 Blender 母版、VRChat／Warudo 工程或原始动作库。记录模型、贴图、动作和呼吸层的来源、哈希、授权及署名。

微光使用与普通 VRM 相同的验证和事务安装。使用即同意独立许可，不同意可选择「不显示模型」；已有 VRM、映射和偏好保留。程序提供基础待机，其他事件动作由模型提供，不隐式补齐。角色授权不代替第三方动作授权，格式转换和烘焙不改变这一点。

## 发布顺序

先公开并验证共享运行时及相关依赖，再在模型分发获准后核验固定 HTTPS 来源。重新 staging 统一插件，通过默认发布门，最后发布固定运行时 revision 的桌宠源码和同版本插件。npm alpha 使用 `--tag alpha`，不覆盖 latest。没有公开模型来源时只验证本地候选。

安装见 [用户指南](user-guide.md)，模型约定见 [模型导入](model-import.md)。发布检查失败不得阻止 DSH 本身运行。
