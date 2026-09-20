# Alpha 发布门

公开仓库、npm 包、Windows Release 和“微光”模型是四个独立外部动作，必须分别得到批准。本仓库中的脚本只生成候选产物，不会自动发布。

公开源码采用 BYOM 预览边界：可以不包含演示模型，但必须固定公开的
`inochi2d-web` revision、保持私有模型禁入、通过核心/桌面构建和真实模型导入测试，
并明确说明没有预构建安装包。下面的门针对附带安装包和演示模型的完整 alpha，
不会因为源码仓库已经公开而放宽。

## 必须满足

1. `inochi2d-web` 的动态动画 API 与 pipeline 变更已经进入公开、干净的固定 revision；把 40 位 revision 写入 `release/model-companion-web.rev`，并同步生成带同一 revision 的运行时 provenance。
2. `assets/microlight/model.inp` 与 `assets/microlight/ASSET_LICENSE.md` 存在；授权文本包含 SPDX 标识与明确的再分发许可。
3. 完整 Node、Rust、浏览器、Windows build、DSH latest 契约、隐私负载和真实 WSL2 验收全部通过。
4. npm tarball 和未签名 NSIS 安装包已经生成；安装、升级、卸载和 SmartScreen 路径经过人工检查。
5. 工作树干净，版本号在 workspace、npm bundle、Cargo 和 Tauri 配置中一致。

执行：

```powershell
pnpm check:release
pnpm release:metadata -- \
  packages/dsh-plugin/.pack/dsh-inochi2d-pet-0.1.0-alpha.0.tgz \
  "apps/desktop/src-tauri/target/release/bundle/nsis/DSH Companion_0.1.0-alpha.0_x64-setup.exe"
```

第二条命令在 `release-output` 生成 `SHA256SUMS`、CycloneDX SBOM 和完整第三方许可证汇编。Release 必须一起上传这些文件。

## 当前明确阻塞项

在首次公开 alpha 前，以下任何一项存在都会停止发布：模型授权不清、运行时 provenance 为 dirty、固定 revision 不公开、契约检查失败、隐私测试失败、打包异常或验收指标未达标。失败只阻止发布，不应影响 DSH 本身启动。
