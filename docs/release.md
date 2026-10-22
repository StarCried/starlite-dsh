# StarLite for DSH alpha 发布检查

本次版本为 `0.1.0-alpha.2`，包含右键快捷菜单、按模型保存的姿态与跟随调节、动作过渡修复、性能参数、模型信息界面及 Vite／Vitest 安全补丁；见 [版本变化](../CHANGELOG.md)。使用下列流程重建匹配版本的所有产物。版本准备不代表外部发布已完成，最终来源与公开下载校验结果按实际执行补记到 [发布验收](dsh-compatibility.md)。

## 上次公开发行 alpha.1

[`dsh-starlite@0.1.0-alpha.1`](https://www.npmjs.com/package/dsh-starlite/v/0.1.0-alpha.1) 与 [Release `v0.1.0-alpha.1`](https://github.com/StarCried/starlite-dsh/releases/tag/v0.1.0-alpha.1) 已公开，发行源码为 [`918f15c`](https://github.com/StarCried/starlite-dsh/commit/918f15ce1d342a79a90c9c1ac0d6646939ced2e6)，共享运行时为 [`903fe2c`](https://github.com/StarCried/starlite/commit/903fe2cab9e0f37ad36cd904e301fa482af2508e)。精确源码的[主 CI](https://github.com/StarCried/starlite-dsh/actions/runs/38703696617) 与 [DSH latest 兼容作业](https://github.com/StarCried/starlite-dsh/actions/runs/38704010721) 均成功；更改见[版本变化](../CHANGELOG.md)。

匿名公开下载的 npm tarball 为 3,922,149 字节，SHA-256 `e7abb12285656a12bac3bd896c426755afd3d4bc9abcb7060f593d6a10d84e7d`，与最终本地发行包逐字节一致，SHA-512 完整性值与 registry 一致。这个真正公开下载的包已在官方 DSH `0.2.1-alpha.2` 的 Windows 与 WSL2 环境中通过隔离安装、认证首页、fail-open 和退出回收，未调用付费 API。该次发行后 `alpha` 指向 alpha.1，`latest` 仍保留 alpha.0；安装使用 `dsh-starlite@alpha`。完整 SRI、来源和验收边界见[发布验收](dsh-compatibility.md)。旧版和本地开发候选的记录保留原身份，没有改写为本次程序的全面复验。

## 首次发行基线

`dsh-starlite@0.1.0-alpha.0` 已发布到 [npm alpha 渠道](https://www.npmjs.com/package/dsh-starlite/v/0.1.0-alpha.0)，[软件 Release `v0.1.0-alpha.0`](https://github.com/StarCried/starlite-dsh/releases/tag/v0.1.0-alpha.0) 对应源码 `ee86d3984d300621812f16016b08450ec860ec13`。从公开 registry 全新下载的 tarball 与正式包完全一致，并通过官方 npm DSH `0.2.1-alpha.2` 的隔离安装和 fail-open 检查，详见[发布验收](dsh-compatibility.md)。

以下流程用于本次与后续版本。统一插件包含 Windows 程序、通知及下载清单；程序仅内嵌已批准的基础待机，微光角色及其他动作仍作为独立授权的单文件 VRM 下载。本地脚本只构建和校验，不自动推送、发布或部署博客。

## 构建来源

发布使用独立干净 checkout，只 staging 同一 revision 的 `core` 与 `vrm`。`release/starlite.rev` 固定共享源码，provenance 记录真实 revision、文件哈希及 `dirty: false`。正式发布前，该源码 revision 必须已公开；不手改 provenance、不使用旧 dist，也不重置用户工作区满足检查。

当前 DSH 不包含 Inochi2D 或 WASM。程序基础待机来源见 [记录](../apps/desktop/src-tauri/assets/default-idle.md)，包含第三方呼吸层，不称为完全原创。程序源码 BSD-2-Clause 与模型、动作的许可分别处理。

## 构建与校验

1. 构建并验证共享运行时，更新 pin，再同步其 revision 和哈希。
2. 通过 `pnpm check`、Rust fmt／clippy／test、DSH 契约检查及隔离 profile 的实际 tarball 安装和 fail-open 检查。
3. `pnpm desktop:build` 生成 Windows x64 GUI EXE 和可选未签名 NSIS。生成依赖通知后，用明确的单文件 VRM 来源描述 staging，再打包。tarball 必须恰好包含 11 个允许文件，EXE 的版本、GUI 子系统、长度和 SHA-256 匹配，不夹带角色资源。发布门直接检查 tarball 的模型来源；内含的程序、清单和通知必须与 staging 逐字节一致，重新 staging 后须重新打包。安装器时效检查也包含内嵌的基础待机文件。
4. 运行安装 CI，检查新装、合成基线升级、重装、卸载及用户数据保留；该结果不代替真实旧设置迁移和 Windows 人工验收。
5. 保持 workspace、desktop、protocol、plugin、Cargo、Tauri 版本一致。正式升级使用新版本。

```powershell
pnpm release:metadata -- "apps/desktop/src-tauri/target/release/bundle/nsis/StarLite for DSH_0.1.0-alpha.2_x64-setup.exe"
pnpm stage:plugin -- release-output/default-model.json
pnpm pack:plugin
pnpm check:release
pnpm release:metadata -- packages/dsh-plugin/.pack/dsh-starlite-0.1.0-alpha.2.tgz "apps/desktop/src-tauri/target/release/bundle/nsis/StarLite for DSH_0.1.0-alpha.2_x64-setup.exe"
```

资源描述只包含 `title`、固定 HTTPS `url`、VRM 的 `sha256` 和 `bytes`；程序清单 schema 为 2，使用 `defaultModel` 字段。首次元数据命令提供 staging 所需的依赖通知，打包后再生成最终 SHA256SUMS、CycloneDX SBOM 和第三方许可证。

模型地址可使用直接返回 VRM 的固定 HTTPS 来源，或规范的 `https://github.com/{owner}/{repo}/releases/download/{tag}/{file}.vrm` Release 资产地址。只有后者允许手动跟随最多 3 次跳转，且每次目标必须是 `release-assets.githubusercontent.com` 的 HTTPS 地址，无用户信息、非 443 端口或片段；不携带 Cookie、Authorization 等请求头。其他来源仍拒绝重定向，不使用泛用分享链接。所有请求和内容下载共用一次 30 秒超时，最终仍严格校验长度及 SHA-256；临时签名地址不写入缓存或日志。正式打包前在全新缓存中验证实际下载，再验证离线缓存；仅通过 URL 格式检查不代表资源可用。

本地验收来源使用 `localTest: true` 及只监听 `127.0.0.1` 的资源服务，可执行 `pnpm check:release -- --local-test` 检查其余发布门。默认发布门拒绝本机来源，该开关不构成发布批准。CI 仅用无角色、不可下载的测试清单检查结构，产物为 `local-only-windows-validation`，不能公开发行。私有模型不进入 CI。

## 人工验收

给用户阅读和逐项检查的简版见[本地候选验收](release-candidate-review.md)。测试结果与当前候选的来源、哈希记录放在本机 `release-output`，不把早期 ZIP 或旧产品名的报告当作本轮发布通过。

- WSL2、Windows 原生 CLI/Web、官方 Windows Desktop 自动准备同一 Windows 程序；默认 VRM 下载、离线缓存、下载／长度／哈希失败以及 DSH 继续启动。
- 模型列表切换、许可排版、不显示后重启保持、已有模型与偏好迁移；移除确认的取消与提交、只清理程序管理副本、源文件保留、重启不重新获取微光。
- 单个 VRM 直接导入；无动作时基础站姿、呼吸与限角头部跟随；缺少可选眨眼／眼球配置时仍能使用，有动作时完整目录和精确映射；损坏引用仍拒绝并保留旧模型。
- 微光 14 个动作、手指、表情、耳尾物理、大动作边界、中途切换及低帧率恢复。
- 透明区域穿透、拖动、DPI、多显示器、睡眠、重连与关闭 DSH 后退出。
- 工作、费用、普通问题表单、隐私、单击与双击；不使用付费模型请求来替代可模拟的检查。
- Desktop 插件页安装／启停、指定会话及无会话双击导航、客户端重载；× 隐藏不停止桌宠、真正退出销毁桥接。
- 多 Host 启动不抢占、重复深链接不重置、按重连期退出后切换 Host；分别记录源码、npm 包和实际桌面安装包版本。
- Windows SmartScreen 与未签名说明。时间戳检查只防止明显过期产物，不证明可复现或安装验收。

普通用户只安装统一 DSH 插件，NSIS 是独立程序验收方式，不是使用前置条件。安装 CI 只在无现有协议注册或用户数据的 runner 执行；合成升级基线不保证旧产品名的快捷方式和卸载项自动迁移。

## 微光单文件

微光 VRM 包含运行所需的模型、贴图、标准 glTF 动作以及可选角色、许可和默认映射元数据，不包含 Blender 母版、VRChat／Warudo 工程或原始动作库。记录模型、贴图、动作和呼吸层的来源、哈希、授权及署名。

微光使用与普通 VRM 相同的验证和事务安装。使用即同意独立许可，不同意可选择「不显示模型」；已有 VRM、映射和偏好保留。程序提供基础待机，其他事件动作由模型提供，不隐式补齐。角色授权不代替第三方动作授权，格式转换和烘焙不改变这一点。

## 发布顺序

先公开并验证固定 pin 的共享源码，单独发布获准分发的微光 VRM 与许可，再核验固定 HTTPS 来源的全新缓存下载和离线复用。推送同版本 DSH 源码并确认 CI，通过默认发布门后发布已校验的 tarball：

```sh
npm publish packages/dsh-plugin/.pack/dsh-starlite-0.1.0-alpha.2.tgz --tag alpha --access public
```

发布后核对 `npm view dsh-starlite@alpha version` 为 `0.1.0-alpha.2`，验证 registry tarball 与本地包一致，并在隔离 profile 安装 `dsh-starlite@alpha`。这些是发布后的验证步骤，不以文档中的安装命令代替实际结果。npm 发布指定 `alpha` 标签；升级必须使用新版本。Windows Release 随附匹配的安装器、可选免安装包、SHA256SUMS、SBOM 和依赖许可；微光作为独立授权资产分发，不夹进程序包。没有公开模型来源时仍只能验证本地候选。

首次发行的实际标签（2026-10-15）：`alpha` 和 `latest` 均指向 `0.1.0-alpha.0`。npm 对新包首次发布会额外创建 `latest`，即使指定其他标签，见[上游记录](https://github.com/npm/cli/issues/8490)。本次删除 `latest` 返回 HTTP 400，保留现状，不重复删除或通过新增版本绕过。此前没有稳定版本，未覆盖已有稳定版的 `latest`；安装继续明确使用 `dsh-starlite@alpha`。

安装见 [用户指南](user-guide.md)，模型约定见 [模型导入](model-import.md)。发布检查失败不得阻止 DSH 本身运行。

## 依赖审计记录

2026-10-22 已更新 Vite 8.2.4 和 Vitest 4.1.12，修复新披露的开发服务器公告。完整在线审计未报告 JavaScript 或 Rust 漏洞；既有 Rust 维护与非 Windows 警告保留到期复核规则，并重新核对 Windows 依赖树。精确数据库 revision、范围和例外见[依赖维护](dependency-audit.md)。以下日期记录只代表各次扫描，不替代每次发行前的最新检查。

2026-10-14 已修复可用的构建依赖补丁，并将撤回的 `chacha20 0.10.1` 更新为 `0.10.2`。DSH 的 npm 完整／生产依赖审计均无已知漏洞；共享包的浏览器运行时和插件自身不携带 Hexo 主程序，私有 Hexo 7 示例及使用者的 Hexo 依赖仍有 9 条上游审计记录，不能称整个 Hexo 生态已无告警。

使用隔离的 cargo-audit 0.22.2 与官方 RustSec 数据库 `6aed84668c23d7f535077a9fe918bf1fa0f6a5bc` 检查两个 Cargo.lock，未发现已知漏洞或仍撤回的版本。Windows 运行链中的 5 个 `unic` 库仍有停止维护提示；其他目标的 `glib`／`proc-macro-error` 警告不在 Windows x64 依赖树。保留真实审计结果，后续发布仍须重新扫描，不强行替换不兼容的传递依赖。
