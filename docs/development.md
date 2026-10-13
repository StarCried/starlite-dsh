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
pnpm desktop:build
pnpm release:metadata -- "apps/desktop/src-tauri/target/release/bundle/nsis/StarLite for DSH_0.1.0-alpha.0_x64-setup.exe"
```

本机维护者 checkout 的同步源为 `//wsl.localhost/Ubuntu/home/pc/StarCried/starlite/packages/inochi2d/dist`。同步源必须显式给出，也可用 `STARLITE_INOCHI2D_DIST` 环境变量。工具从同一个 checkout 收集 `packages/core`、`packages/inochi2d`、`packages/vrm`，写入未跟踪的 `apps/desktop/public/runtime/{core,inochi2d,vrm}`，校验包名、官方 WASM 哈希和许可证，并记录 Git revision／dirty 与各文件哈希。发布只接受干净且匹配 pin 的运行时。

原生 exe 位于 `apps/desktop/src-tauri/target/release/dsh-inochi2d-pet.exe`，可选安装器位于 `apps/desktop/src-tauri/target/release/bundle/nsis/`。普通用户使用包含 Windows 程序的统一插件，不需要安装器。不要在同一 checkout 混用 Windows 与 WSL 的 node_modules。

### 准备统一插件和本地下载服务

程序包只带 `assets/windows-x64/` 中的 EXE、两份程序许可和固定清单。微光始终是独立 ZIP，不进入 npm tarball、桌宠资源或源码。

维护者本地验收时，在 **WSL 的另一个终端**启动只监听 `127.0.0.1` 的资源服务，保持运行。将三个参数分别换为私有 ZIP、包内桌面模型的 SHA-256，以及本仓库 `release-output` 中一个尚不存在的描述文件路径：

```bash
node /mnt/e/path/to/starlite-dsh/tools/local-character-server.mjs \
  /mnt/e/path/to/Weiguang.zip DESKTOP_MODEL_SHA256 \
  /mnt/e/path/to/starlite-dsh/release-output/local-character.json
```

服务只向本机提供该 ZIP 的不可变快照，不开放目录或 CORS。描述文件包含本机 URL、ZIP 长度／SHA-256、模型 SHA-256 和 `localTest: true`。使用显式模型哈希是因为资源导入由 Windows 原生 ZIP 检查完成，资源服务不重复实现导入器。不要把私有 ZIP 放进项目目录。

回到 **Windows PowerShell**，显式 staging 并打包：

```powershell
pnpm stage:plugin -- release-output/local-character.json
pnpm pack:plugin
```

`stage:plugin` 只从固定 release 构建路径收集程序和通知，检查 Windows x64 GUI PE、版本与 SHA-256。`pack:plugin` 要求恰好 11 个允许文件，检查内嵌程序和清单，拒绝多余资产。普通 JS 构建／测试不要求 EXE 已存在。生成的本地 tarball 只用于本机验收，不可发布。

公开发布前，维护者必须在获得资源公开分发批准后提供独立 HTTPS 下载地址的描述文件，再重新 staging 和打包。`pnpm check:release` 拒绝本机地址；`pnpm check:release -- --local-test` 仅用于本地构建验收，不代表允许发布。它仍检查干净工作树、固定运行时来源、版本和程序资源。

## 3. 隔离 DSH 安装检查

在 WSL 中安装生成的统一插件即可，不必先安装 Windows 程序。把示例绝对路径换成实际路径，使用单独的测试 profile：

```bash
export PATH="$HOME/.local/bin:$PATH"
node /mnt/e/path/to/starlite-dsh/tools/check-dsh-contract.mjs \
  "$HOME/.local/lib/node_modules/@deepseek-ai/dsh"
dsh plugin --profile starlite-test add \
  /mnt/e/path/to/starlite-dsh/packages/dsh-plugin/.pack/dsh-starlite-0.1.0-alpha.0.tgz
dsh --profile starlite-test --dump-config
```

契约检查验证实际事件和 settings／credentials／sessionPersistence 的公开只读接口。费用服务不可用只使费用卡不可用，不阻止状态桥接或 DSH 启动。不要向普通会话发送测试提示来满足安装检查，不需要调用付费模型 API。

随后运行 `dsh --profile starlite-test` 检查自动准备程序、首次下载、许可确认与原偏好保留。测试下载流程不需要填写模型 API Key 或发送任何会话请求。新旧名桥接不能同时加入一个 profile。

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

`check:core` 不需要浏览器运行时或 Windows EXE；完整 `check` 与桌宠构建需要先同步运行时。CI 在 Linux 构建官方 WASM，再把三个组件传给 Windows job。Windows CI 为打包结构检查生成不含资产、不可下载的本机测试清单；产物明确标记为 `local-only-windows-validation`，不能给普通用户使用或发布。私有微光不会传到 CI。公开发布仍需要独立 HTTPS 资源来源及完整发布门检查。

## 模拟与人工检查

开发用 Mock 不发起模型或余额 API 请求：

```powershell
$env:DSH_INOCHI2D_PET_EXE = "E:\path\to\dsh-inochi2d-pet.exe"
pnpm --dir tools/mock-source build
node tools/mock-source/dist/index.js
```

Mock 会轮换状态并尝试拉起 Windows 程序，仅在用户明确开始该项验收时运行。真实验收还需检查多会话、工具、普通问题、权限批准、阻塞、完成、错误、重连、DPI／显示器与睡眠。动作艺术效果由用户逐一确认。

工作气泡默认两行精简模式；详细模式显示经过限制的思考／输出，不把工具参数或结果发给 Windows。实时流每 200 ms 合并，最多 120 个 Unicode 字素；完整边界见 [气泡与互动](companion-interactions.md)。费用测试注入固定服务数据，不访问网络。VRM 内嵌贴图通过 Blob 解码，CSP 的 `img-src` 与 `connect-src` 需保留 `blob:`。
