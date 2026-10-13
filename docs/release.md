# StarLite for DSH alpha 发布检查

程序与微光示例模型分别交付。程序采用 BSD-2-Clause，不内置角色、贴图或 VRMA；微光独立资源包采用单独的使用许可，不能按程序许可证再分发。公开仓库、npm、Windows Release、模型与博客部署都是分别批准的外部动作，本地脚本不会自动执行。

这是当前 alpha 候选的检查流程，不是已发布记录。独立 ZIP 资源包的检查、许可确认、自动动作映射和事务导入已有实现；通用原创 Idle、无动作导入与气泡独立使用仍是下一阶段目标。引入原创 Idle 时需明确记录来源与许可；当前程序资源检查仍拒绝所有角色／动作文件。

## 源码与构建来源

发布构建使用独立干净 checkout，只 staging 当前的 `core`、`inochi2d` 与 `vrm` 运行时。开发目录的 `dist` 和被忽略的生成缓存不能作为发布输入，也不为满足发布检查而重置开发者工作区。

`release/starlite.rev` 固定已提交的 StarLite 源码候选。先从该干净 revision 构建共享运行时，再 staging 真实 revision、文件哈希与 `dirty: false`，最后从干净桌宠 checkout 打包。正式发布前该 revision 必须能从公开仓库读取；不能手改 provenance 或把开发目录的旧 `dist` 当作发布产物。

## 程序候选

2026-10-13 的本地兼容复验通过 `pnpm check`（28 个测试文件、202 项测试）、插件 tarball 白名单检查，以及 DSH `0.1.5-rc.1`／`0.2.0-rc.2` 的实际官方包契约检查。重新打包并在全新目录 npm 安装后，两版官方 Cordis Context 均通过桥接启动、模拟余额查询、实时配置刷新及重复销毁检查。没有调用真实余额或付费模型 API，也不替代下述 Windows 与 Web UI 人工验收。

1. 完成共享运行时验证，并把干净 Git revision 写入 `release/starlite.rev`；同步 core、Inochi2D、VRM 的同一 revision 及内容哈希。正式发布前该 revision 必须已公开。
2. 通过 `pnpm check`、Rust fmt/clippy/test、浏览器检查、DSH 契约检查，以及隔离 profile 的实际 tarball 安装与 fail-open 检查。测试不调用付费模型或余额 API。
3. `pnpm desktop:build` 生成当前产品名、版本、x64 的未签名 NSIS；`pnpm pack:plugin` 生成插件。程序资源检查拒绝角色文件，即使它们被 Git 忽略。
4. Windows CI 运行 `tools/test-installer.ps1`，检查新装、从合成低版本基线升级、同版本重装和卸载，并核对程序文件、协议注册及合成用户数据保留。它验证 NSIS 安装机制，不代表真实旧应用或旧设置迁移已通过。
5. 在干净 checkout 构建，保持 workspace、desktop、protocol、plugin、Cargo、Tauri 版本一致。不清理用户工作区来满足发布检查。

```powershell
pnpm check:release
pnpm release:metadata -- packages/dsh-plugin/.pack/dsh-starlite-0.1.0-alpha.0.tgz "apps/desktop/src-tauri/target/release/bundle/nsis/StarLite for DSH_0.1.0-alpha.0_x64-setup.exe"
```

元数据命令生成 `release-output/SHA256SUMS`、CycloneDX SBOM 和第三方许可证；和候选程序一起审查、上传。安装包时间戳检查只防止明显过期产物，不证明可复现或完成安装验收。Alpha 未签名，会触发 Windows SmartScreen；仅从作者的正式发布页取得并核对哈希，不建议关闭系统防护。

安装 CI 仅在没有现有协议注册或用户数据的 GitHub Windows runner 执行。首次无模型启动、有效／无效 ZIP 的导入界面、角色外观、真实旧设置迁移、SmartScreen 和实际 WSL2 自动启动仍需人工验收，不能由静态资源检查或安装脚本代替。

保留原生用户数据身份不等于安装器会自动迁移旧产品名。旧 DSH Companion／DSH Inochi2D Pet 的快捷方式和卸载项迁移不在首发保证范围；合成低版本基线使用当前产品身份，不是旧产品名的迁移测试。

## 微光独立资源包

资源包只收录批准的桌宠／博客派生 VRM、VRMA、数据配置、清单、使用说明及专属许可，不包含 Blender 母版、VRChat／Warudo 工程或原始动作库。记录每个模型、贴图、动作和呼吸层的来源、哈希、授权与署名。角色作者许可不自动覆盖第三方动作；烘焙、裁剪、重复或转换格式不改变这一要求。

用户在设置中选择独立 ZIP 并确认许可，即可自动导入模型、动作、角色配置和作者映射。未获分发许可的资源保持本地，清单 `allowRedistribution: false`；不能为了让博客生成而改成 true。公开博客必须另获允许向访客发送运行资源的授权。浏览器必需下载文件，技术上不能承诺防提取。

当前状态映射要求有效的作者 Idle；资源包自动使用预设，单文件导入仍须选择。其他状态明确映射或禁用，Thinking 合并到 Working。Click／Ambient 为最多 20 项的随机池。仅待机循环；其他动作完整播放一次，工作状态可打断交互。

## 发布顺序

先公开并验证共享运行时与 Hexo 依赖包，再发布固定该 revision 的桌宠源码、插件和安装包。npm alpha 使用 `--tag alpha`，不覆盖 latest。插件和 Windows 安装包须作为同一版本提供。最后独立处理模型包；没有动作授权不阻塞自备模型的程序候选，但阻塞包含这些动作的资源包。

用户安装和使用见 [用户指南](user-guide.md)，模型限制见 [模型导入](model-import.md)。任何失败都只阻止发布或关闭桌宠适配，不得阻止 DSH 本身运行。
