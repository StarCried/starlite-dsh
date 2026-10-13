# StarLite for DSH 开发与验证

普通用户看 [安装与使用](user-guide.md)。本文用于从源码构建，不会自动安装到真实 DSH profile、替换当前用户设置或发布任何内容。

## 环境与仓库

- Windows 11 x64、Node.js 24、pnpm 11.7。
- Rust stable（`x86_64-pc-windows-msvc`）、Visual Studio C++ Build Tools、WebView2。
- Ubuntu WSL2 中的 DSH。已有契约验收记录对应 `0.1.5-rc.1`；CI 跟踪 latest，不能把每日检查理解为永远兼容未来版本。
- 单独的 StarLite 组件 checkout：core、VRM、可选 Inochi2D 共用一个源码 revision。

源码、包元数据和本地 checkout 统一使用 `StarCried/starlite` 与 `StarCried/starlite-dsh`。本机路径为 `/home/pc/StarCried/starlite` 和 `E:/StarCried/starlite-dsh`。alpha 源码候选位于 `feat/dual-model-backends` 分支；公开 npm 与安装器发布是后续独立步骤。原生 Cargo 依赖使用新仓库 URL，并保留既有固定 revision。

## 1. 在 WSL 构建共享运行时

正式源码候选需要 `release/starlite.rev` 中的 40 位 revision 已公开，并包含当前包结构。维护者须先提交共享源码，再更新 pin 并从该干净 revision 构建；不要改用旧包的 dist 绕过检查。

公开候选准备好后，在 WSL 中执行（将占位 revision 换为 pin 的值）：

```bash
git clone https://github.com/StarCried/starlite.git starlite
cd starlite
git checkout REPLACE_WITH_RELEASE_RUNTIME_REV
npm ci
npm run fixtures
npm run build:wasm
npm run build --workspace @starcried/starlite-core
npm run build --workspace @starcried/starlite-inochi2d
npm run build --workspace @starcried/starlite-vrm
```

Inochi2D 的官方 SDK／WASM 工具链按共享仓库开发说明准备。桌宠当前构建仍 staging 两种后端；更名阶段不更改该依赖结构。VRM 运行使用 WebGL2，不需要浏览器执行 Blender。

## 2. 在 Windows 构建桌宠与桥接包

在 Windows PowerShell 执行。`<user>`、checkout 路径按自己的工作区调整：

```powershell
git clone https://github.com/StarCried/starlite-dsh.git starlite-dsh
Set-Location starlite-dsh
pnpm install --frozen-lockfile
pnpm sync:runtime -- "//wsl.localhost/Ubuntu/home/<user>/starlite/packages/inochi2d/dist"
pnpm check
pnpm pack:plugin
pnpm desktop:build
```

本机维护者 checkout 的同步源为 `//wsl.localhost/Ubuntu/home/pc/StarCried/starlite/packages/inochi2d/dist`。同步源必须显式给出，也可用 `STARLITE_INOCHI2D_DIST` 环境变量。工具从同一个 checkout 收集 `packages/core`、`packages/inochi2d`、`packages/vrm`，写入未跟踪的 `apps/desktop/public/runtime/{core,inochi2d,vrm}`，校验包名、官方 WASM 哈希和许可证，并记录 Git revision／dirty 与各文件哈希。发布只接受干净且匹配 pin 的运行时。

产物分别在 `packages/dsh-plugin/.pack/dsh-starlite-0.1.0-alpha.0.tgz` 与 `apps/desktop/src-tauri/target/release/bundle/nsis/`。原生 exe 名仍为 `dsh-inochi2d-pet.exe`，安装器显示名为 StarLite for DSH。不要在同一 checkout 混用 Windows 与 WSL 的 node_modules；Windows 构建打包，WSL 只安装生成的桥接 tarball。

## 3. 隔离 DSH 安装检查

先在 Windows 安装候选程序，再在 WSL 中安装生成的包。把示例绝对路径换成实际路径，使用单独的测试 profile：

```bash
export PATH="$HOME/.local/bin:$PATH"
node /mnt/e/path/to/starlite-dsh/tools/check-dsh-contract.mjs \
  "$HOME/.local/lib/node_modules/@deepseek-ai/dsh"
dsh plugin --profile starlite-test add \
  /mnt/e/path/to/starlite-dsh/packages/dsh-plugin/.pack/dsh-starlite-0.1.0-alpha.0.tgz
dsh --profile starlite-test --dump-config
```

契约检查验证实际事件和 settings／credentials／sessionPersistence 的公开只读接口。费用服务不可用只使费用卡不可用，不阻止状态桥接或 DSH 启动。不要向普通会话发送测试提示来满足安装检查，不需要调用付费模型 API。

如果直接测试本地原生构建，在启动 DSH 的 WSL 环境设置：

```bash
export DSH_INOCHI2D_PET_EXE='E:\path\to\starlite-dsh\apps\desktop\src-tauri\target\release\dsh-inochi2d-pet.exe'
dsh --profile starlite-test
```

该现有变量继续保留，仅接受本机盘符绝对路径和原生 exe 文件名，不接受参数；未设置时使用 Windows 协议注册。新旧名桥接不能同时加入一个 profile。

## 自动检查

```powershell
pnpm check:core
pnpm check
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy --locked --release --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
```

`check:core` 不需要生成浏览器运行时；完整 `check` 与桌宠构建需要先同步运行时。CI 在 Linux 构建官方 WASM，再把三个组件传给 Windows job。更名后的本地 source pin 仍需在后续公开候选时更新，不能在本轮伪造干净 provenance 或绕过发布门。

## 模拟与人工检查

开发用 Mock 不发起模型或余额 API 请求：

```powershell
$env:DSH_INOCHI2D_PET_EXE = "E:\path\to\dsh-inochi2d-pet.exe"
pnpm --dir tools/mock-source build
node tools/mock-source/dist/index.js
```

Mock 会轮换状态并尝试拉起 Windows 程序，仅在用户明确开始该项验收时运行。真实验收还需检查多会话、工具、普通问题、权限批准、阻塞、完成、错误、重连、DPI／显示器与睡眠。动作艺术效果由用户逐一确认。

工作气泡默认两行精简模式；详细模式显示经过限制的思考／输出，不把工具参数或结果发给 Windows。实时流每 200 ms 合并，最多 120 个 Unicode 字素；完整边界见 [气泡与互动](companion-interactions.md)。费用测试注入固定服务数据，不访问网络。VRM 内嵌贴图通过 Blob 解码，CSP 的 `img-src` 与 `connect-src` 需保留 `blob:`。
