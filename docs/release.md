# Alpha 发布门

程序与微光示例模型分别交付。程序采用 BSD-2-Clause，不内置角色、贴图或 VRMA；微光独立资源包采用单独的使用许可，不能按程序许可证再分发。公开仓库、npm、Windows Release、模型与博客部署都是分别批准的外部动作，本地脚本不会自动执行。

## 程序候选

1. 完成共享运行时验证，并把干净 Git revision 写入 `release/model-companion-web.rev`；同步 core、Inochi2D、VRM 的同一 revision 及内容哈希。正式发布前该 revision 必须已公开。
2. 通过 `pnpm check`、Rust fmt/clippy/test、浏览器检查、DSH 契约检查，以及隔离 profile 的实际 tarball 安装与 fail-open 检查。测试不调用付费模型或余额 API。
3. `pnpm desktop:build` 生成当前产品名、版本、x64 的未签名 NSIS；`pnpm pack:plugin` 生成插件。程序资源检查拒绝角色文件，即使它们被 Git 忽略。
4. 安装、首次启动无模型、有效／无效模型导入、旧设置迁移、升级保留设置、卸载、SmartScreen 和实际 WSL2 启动路径均需验收。自动构建通过不代表这些手工步骤已通过。
5. 在干净 checkout 构建，保持 workspace、desktop、protocol、plugin、Cargo、Tauri 版本一致。不清理用户工作区来满足发布检查。

```powershell
pnpm check:release
pnpm release:metadata -- packages/dsh-plugin/.pack/dsh-inochi2d-pet-0.1.0-alpha.0.tgz "apps/desktop/src-tauri/target/release/bundle/nsis/DSH Companion_0.1.0-alpha.0_x64-setup.exe"
```

元数据命令生成 `release-output/SHA256SUMS`、CycloneDX SBOM 和第三方许可证；和候选程序一起审查、上传。安装包时间戳检查只防止明显过期产物，不证明可复现或完成安装验收。Alpha 未签名，会触发 Windows SmartScreen；仅从作者的正式发布页取得并核对哈希，不建议关闭系统防护。

## 微光独立资源包

资源包只收录批准的桌宠／博客派生 VRM、VRMA、数据配置、清单、使用说明及专属许可，不包含 Blender 母版、VRChat／Warudo 工程或原始动作库。记录每个模型、贴图、动作和呼吸层的来源、哈希、授权与署名。角色作者许可不自动覆盖第三方动作；烘焙、裁剪、重复或转换格式不改变这一要求。

用户通过设置导入独立资源包中的模型、动作与配置。未获分发许可的资源保持本地，清单 `allowRedistribution: false`；不能为了让博客生成而改成 true。公开博客必须另获允许向访客发送运行资源的授权。浏览器必需下载文件，技术上不能承诺防提取。

当前状态映射要求明确选择 Idle；其他状态明确映射或禁用，Thinking 合并到 Working。Click／Ambient 为最多 20 项的随机池。仅待机循环；其他动作完整播放一次，工作状态可打断交互。

## 发布顺序

先公开并验证共享运行时与 Hexo 依赖包，再发布固定该 revision 的桌宠源码、插件和安装包。npm alpha 使用 `--tag alpha`，不覆盖 latest。插件和 Windows 安装包须作为同一版本提供。最后独立处理模型包；没有动作授权不阻塞自备模型的程序候选，但阻塞包含这些动作的资源包。

用户安装和使用见 [用户指南](user-guide.md)，模型限制见 [模型导入](model-import.md)。任何失败都只阻止发布或关闭桌宠适配，不得阻止 DSH 本身运行。
