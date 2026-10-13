# StarLite for DSH alpha 发布检查

程序与微光示例模型分别交付。统一 `dsh-starlite` 插件包含 Windows 程序和通知，自动准备桌宠，资源未缓存时自动取得独立授权的微光资源包，默认配置并使用。程序采用 BSD-2-Clause，不内置角色、贴图或 VRMA；微光不能按程序许可证再分发。公开仓库、npm、Windows Release、模型与博客部署都是分别批准的外部动作，本地脚本不会自动执行。

这是当前 alpha 候选的检查流程，不是已发布记录。默认微光自动准备、持续许可提示、模型禁用、独立 ZIP 检查、自动动作映射和事务导入已有实现；通用原创 Idle、无动作导入与气泡独立使用仍是下一阶段目标。引入原创 Idle 时需明确记录来源与许可；当前程序资源检查仍拒绝所有角色／动作文件。

## 源码与构建来源

发布构建使用独立干净 checkout，只 staging 当前的 `core` 与 `vrm` 运行时。开发目录的 `dist` 和被忽略的生成缓存不能作为发布输入，也不为满足发布检查而重置开发者工作区。

`release/starlite.rev` 固定已提交的 StarLite 源码候选。先从该干净 revision 构建共享运行时，再 staging 真实 revision、文件哈希与 `dirty: false`，最后从干净桌宠 checkout 打包。正式发布前该 revision 必须能从公开仓库读取；不能手改 provenance 或把开发目录的旧 `dist` 当作发布产物。

## 程序候选

DSH `0.1.5-rc.1`／`0.2.0-rc.2` 已有实际官方包契约和隔离 Cordis 生命周期回归。每次候选仍需重新检查统一 tarball、Windows 自动准备、默认下载、持续许可与禁用流程；既有测试不能替代下述 Windows 与 Web UI 人工验收。测试不调用真实余额或付费模型 API。

1. 完成共享运行时验证，并把干净 Git revision 写入 `release/starlite.rev`；同步 core、VRM 的同一 revision 及内容哈希，确认程序不包含 Inochi2D 或 WASM 资源。正式发布前该 revision 必须已公开。
2. 通过 `pnpm check`、Rust fmt/clippy/test、浏览器检查、DSH 契约检查，以及隔离 profile 的实际 tarball 安装与 fail-open 检查。测试不调用付费模型或余额 API。
3. `pnpm desktop:build` 生成 Windows x64 GUI EXE 和可选的未签名 NSIS，先生成依赖许可，再用明确的资源来源描述执行 `pnpm stage:plugin -- <descriptor.json>`，最后 `pnpm pack:plugin`。统一 tarball 必须恰好包含 11 个允许文件，内嵌 EXE 的版本、GUI 子系统、长度与 SHA-256 均须匹配。程序资源检查拒绝角色文件，即使它们被 Git 忽略。
4. Windows CI 运行 `tools/test-installer.ps1`，检查新装、从合成低版本基线升级、同版本重装和卸载，并核对程序文件、协议注册及合成用户数据保留。它验证 NSIS 安装机制，不代表真实旧应用或旧设置迁移已通过。
5. 在干净 checkout 构建，保持 workspace、desktop、protocol、plugin、Cargo、Tauri 版本一致。不清理用户工作区来满足发布检查。

```powershell
pnpm release:metadata -- "apps/desktop/src-tauri/target/release/bundle/nsis/StarLite for DSH_0.1.0-alpha.0_x64-setup.exe"
pnpm stage:plugin -- release-output/starter-character.json
pnpm pack:plugin
pnpm check:release
pnpm release:metadata -- packages/dsh-plugin/.pack/dsh-starlite-0.1.0-alpha.0.tgz "apps/desktop/src-tauri/target/release/bundle/nsis/StarLite for DSH_0.1.0-alpha.0_x64-setup.exe"
```

首次元数据命令提供 staging 所需的依赖通知，打包后再次生成最终 `SHA256SUMS`、CycloneDX SBOM 和第三方许可证。正式资源描述包含独立 HTTPS 下载地址、ZIP 长度／哈希和桌面模型哈希；不能在程序包中加入资源 ZIP。当前只有本地测试来源，尚不满足公开发布条件。

本地候选使用 `localTest: true` 和仅监听 `127.0.0.1` 的资源服务，可执行 `pnpm check:release -- --local-test` 检查其余构建门。该开关不是发布批准；默认发布门拒绝本地来源。Windows CI 使用不含资产、不可下载的明确测试清单，产物标记为 `local-only-windows-validation`。每日 DSH 契约 CI 使用生成的最小 GUI PE 和测试清单，只检查 tarball 安装，不运行 Windows 程序，不发布产物。

安装包时间戳检查只防止明显过期产物，不证明可复现或完成安装验收。Alpha 程序未签名，Windows 可能显示 SmartScreen；仅核对作者提供的来源与哈希，不关闭系统防护。普通用户只安装统一 DSH 插件，可选 NSIS 仍用于独立程序验收，不是使用前置条件。

安装 CI 仅在没有现有协议注册或用户数据的 GitHub Windows runner 执行。WSL 自动准备 Windows 程序、默认下载、完整许可查看、禁用／重新启用、手动 ZIP 许可确认／取消、离线缓存、下载或哈希失败、有效／无效 ZIP、已有模型与偏好保留、角色外观、真实旧设置迁移和 SmartScreen 仍需人工验收，不能由静态检查或安装脚本代替。

保留原生用户数据身份不等于安装器会自动迁移旧产品名。旧 DSH Companion／DSH Inochi2D Pet 的快捷方式和卸载项迁移不在首发保证范围；合成低版本基线使用当前产品身份，不是旧产品名的迁移测试。

## 微光独立资源包

资源包只收录批准的桌宠／博客派生 VRM、VRMA、数据配置、清单、使用说明及专属许可，不包含 Blender 母版、VRChat／Warudo 工程或原始动作库。记录每个模型、贴图、动作和呼吸层的来源、哈希、授权与署名。角色作者许可不自动覆盖第三方动作；烘焙、裁剪、重复或转换格式不改变这一要求。

插件在资源未缓存时自动取得独立 ZIP，默认导入微光模型、动作、角色配置和作者映射；已有 VRM 不会被默认资源覆盖。使用微光即表示同意独立许可，不同意可在模型列表选择「不显示模型」；之后不下载默认资源、不显示或渲染模型，DSH 继续正常工作。每个模型的许可均可从卡片查看。「添加模型」支持其他 ZIP 或 VRM，导入后保留已有模型。未获分发许可的资源保持本地，清单 `allowRedistribution: false`；不能为了让博客生成而改成 true。公开博客必须另获允许向访客发送运行资源的授权。浏览器必需下载文件，技术上不能承诺防提取。

当前状态映射要求有效的作者 Idle；资源包自动使用预设，单文件导入仍须选择。其他状态明确映射或禁用，Thinking 合并到 Working。Click／Ambient 为最多 20 项的随机池。仅待机循环；其他动作完整播放一次，工作状态可打断交互。

## 发布顺序

先公开并验证共享运行时与 Hexo 依赖包。资源独立发布获准后，验证其固定 HTTPS 来源，再制作引用该来源的统一插件并通过默认发布门；随后发布固定运行时 revision 的桌宠源码和同版本插件，可另提供 NSIS。npm alpha 使用 `--tag alpha`，不覆盖 latest。没有独立资源来源时仍可验证本地程序候选，不得将本地测试包公开发布。

用户安装和使用见 [用户指南](user-guide.md)，模型限制见 [模型导入](model-import.md)。任何失败都只阻止发布或关闭桌宠适配，不得阻止 DSH 本身运行。
