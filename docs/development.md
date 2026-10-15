# StarLite for DSH 开发与验证

普通用户看 [安装与使用](user-guide.md)。本文用于从源码构建，不会自动安装到真实 DSH profile、替换当前用户设置或发布任何内容。

## 环境与仓库

- Windows 11 x64、Node.js 24、pnpm 11.7。
- Rust stable（`x86_64-pc-windows-msvc`）、Visual Studio C++ Build Tools、WebView2。
- 以下任一种 DSH Host：官方 Windows Desktop、Windows 原生 CLI/Web、Windows 上的 WSL2 CLI/Web。各形态的实际版本与验收范围见 [兼容性记录](dsh-compatibility.md)；WSL2 不是 Windows 原生或桌面版的前置依赖。CI 跟踪 latest，不能把每日检查理解为永远兼容未来版本。
- 单独的 StarLite 组件 checkout：core 和 VRM 共用一个源码 revision。

启动器接受 Windows x64 和 WSL2 x64 Host，共用插件内的 Windows GUI 程序、校验缓存及独立模型下载。原生 Windows 直接启动 EXE，WSL2 使用 Windows 互操作和 `wslpath`；Windows Known Folder 由固定 PowerShell 查询取得。普通 Node 与 Electron Node-mode Host 均不需要额外系统 Node。子进程仅接收启动所需的 OS 环境变量，不继承服务商凭据、`NODE_OPTIONS` 或 `ELECTRON_RUN_AS_NODE`。其他操作系统或架构会在创建桥接前禁用插件，不影响 DSH 启动。

源码和包元数据统一使用 `StarCried/starlite` 与 `StarCried/starlite-dsh`，当前版本为 `0.1.0-alpha.1`。用户安装选择 `@alpha`；实际公开版本、来源及验证结果见 [兼容性记录](dsh-compatibility.md)，不要将本地构建记为公开包的验收。本文中的构建、打包和测试命令不会推送或发布。

## 1. 构建共享运行时

正式源码候选需要 `release/starlite.rev` 中的 40 位 revision 已公开，并包含当前包结构。维护者须先提交共享源码，再更新 pin 并从该干净 revision 构建；不要改用旧包的 dist 绕过检查。

在 Windows PowerShell 或 WSL 中均可构建 core 和 VRM。将占位 revision 换为 DSH 仓库 `release/starlite.rev` 的值：

```bash
git clone https://github.com/StarCried/starlite.git starlite
cd starlite
git checkout REPLACE_WITH_RELEASE_RUNTIME_REV
npm ci
npm run build --workspace @starcried/starlite-core
npm run build --workspace @starcried/starlite-vrm
```

当前 DSH 构建只 staging core 和 VRM，不需要 Inochi2D SDK、D 编译器或 WASM 工具链。VRM 使用 WebGL2，不需要浏览器执行 Blender。

## 2. 在 Windows 构建桌宠与桥接包

共享组件构建结束后，回到两个 checkout 的父目录，再在 Windows PowerShell 执行。checkout 路径按自己的工作区调整：

```powershell
git clone https://github.com/StarCried/starlite-dsh.git starlite-dsh
Set-Location starlite-dsh
pnpm install --frozen-lockfile
pnpm sync:runtime -- "../starlite"
pnpm check
pnpm desktop:build
pnpm release:metadata -- "apps/desktop/src-tauri/target/release/bundle/nsis/StarLite for DSH_0.1.0-alpha.1_x64-setup.exe"
```

示例假设两个 checkout 位于同一父目录。若共享组件在 WSL 中，改为 `//wsl.localhost/Ubuntu/home/<user>/starlite`。同步源必须显式给出，也可用 `STARLITE_SOURCE` 环境变量。工具从同一个 checkout 收集 `packages/core/dist` 和 `packages/vrm/dist`，写入未跟踪的 `apps/desktop/public/runtime/{core,vrm}`，校验包名和许可证，并记录 Git revision／dirty 与各文件哈希。同步会移除已停用后端的受管生成目录，发布门拒绝残留的 Inochi2D 或 WASM 资源。发布只接受干净且匹配 pin 的运行时。

原生 exe 位于 `apps/desktop/src-tauri/target/release/dsh-inochi2d-pet.exe`，可选安装器位于 `apps/desktop/src-tauri/target/release/bundle/nsis/`。普通用户使用包含 Windows 程序的统一插件，不需要安装器。不要在同一 checkout 混用 Windows 与 WSL 的 node_modules。

### 准备统一插件和本地下载服务

程序包只带 `assets/windows-x64/` 中的 EXE、两份程序许可和固定清单。EXE 内嵌已批准的基础待机，来源见 [default-idle.md](../apps/desktop/src-tauri/assets/default-idle.md)。微光角色和其他动作保存在独立、自包含 VRM 中，不进入 npm tarball、桌宠资源或源码。

需要测试私有或尚未发布的模型时，在 **Windows 或 WSL 的另一个终端**启动只监听 `127.0.0.1` 的资源服务，保持运行。两个参数分别是私有 VRM，以及本仓库 `release-output` 中一个尚不存在的描述文件路径。Windows PowerShell 示例：

```powershell
node tools/local-character-server.mjs "E:/path/to/Weiguang-StarLite.vrm" "release-output/local-character.json"
```

服务只向本机提供该 VRM 的不可变快照，不开放目录或 CORS。描述文件包含 `title`、本机 `url`、文件 `sha256`／`bytes` 和 `localTest: true`。程序 manifest 使用 schema 2 的 `defaultModel` 字段引用这些信息；没有第二个模型摘要或解包步骤。不要把私有模型放进项目目录。

回到 **Windows PowerShell**，显式 staging 并打包：

```powershell
pnpm stage:plugin -- release-output/local-character.json
pnpm pack:plugin
```

`stage:plugin` 只从固定 release 构建路径收集程序和通知，检查 Windows x64 GUI PE、版本与 SHA-256。`pack:plugin` 要求恰好 11 个允许文件，检查内嵌程序和清单，拒绝多余资产。普通 JS 构建／测试不要求 EXE 已存在。生成的本地 tarball 只用于本机验收，不可发布。

公开微光已通过独立 [模型 Release](https://github.com/StarCried/starlite/releases/tag/weiguang-v3.0.0-starlite.1) 交付。制作新公开版本时仍须使用获准分发的独立 HTTPS 来源描述文件，重新 staging 和打包；本机资源描述文件不能用于公开交付。`pnpm check:release` 拒绝本机地址；`pnpm check:release -- --local-test` 仅用于本地构建验收，不代表允许发布。它仍检查干净工作树、固定运行时来源、版本和程序资源。已有 npm 版本不可覆盖，本地修复经验收后须使用新的版本号。

## 3. 隔离 DSH 安装检查

在原生 Windows CLI/Web 或 WSL2 CLI/Web 中安装生成的统一插件，不必先安装 Windows 程序。使用独立 `DSH_HOME` 和测试 profile，避免改动日常配置；下面是 Windows PowerShell 示例，绝对路径按实际官方 DSH 包和本地 tarball 调整：

```powershell
$env:DSH_HOME = "E:/path/to/isolated-starlite-test-home"
node tools/check-dsh-contract.mjs "E:/path/to/node_modules/@deepseek-ai/dsh"
dsh plugin --profile starlite-test add "E:/path/to/starlite-dsh/packages/dsh-plugin/.pack/dsh-starlite-0.1.0-alpha.1.tgz"
dsh --profile starlite-test --dump-config
```

WSL2 使用同样命令，将环境变量写法改为 `export DSH_HOME=/path/to/isolated-starlite-test-home`，并使用 Linux／`/mnt/...` 路径。官方 Desktop 使用自己的受管 `desktop` profile，测试也要指定独立 `DSH_HOME`；其内置命令与独立 npm CLI 不可混用，见 [桌面版安装说明](user-guide.md#官方-windows-桌面版)。

契约检查验证实际事件和 settings／credentials／sessionPersistence 的公开只读接口。费用服务不可用只使费用卡不可用，不阻止状态桥接或 DSH 启动。不要向普通会话发送测试提示来满足安装检查，不需要调用付费模型 API。

随后运行 `dsh --profile starlite-test` 检查自动准备程序、默认微光、许可查看、不显示后重启不下载／显示，以及原偏好保留。另用合成 VRM 验证「添加模型」直接导入、无动作自动待机、眨眼、人形与损坏文件检查；私有模型只在本机按需验证。测试不需要填写模型 API Key 或发送任何会话请求。新旧名桥接不能同时加入一个 profile。

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

每日 `DSH latest compatibility` 在 Ubuntu 与 Windows 上安装 **npm 已发布 latest**，强制检查 Desktop 声明契约、真实官方认证 RPC 与服务冷启动，以及实际 tarball 的隔离安装／启动／fail-open／销毁；不把 GitHub main 的新 API 当成已发布客户端，也不发布任何产物。Windows 检查原生 Host 桥接，普通 Ubuntu 检查不支持的 Host 会禁用桌宠但不妨碍 DSH。平台不支持时明确提示需要 Windows 11 x64 或其上的 WSL2 x64；所需 DSH API 不可用、状态桥启动失败和 Windows 程序启动失败分别提示，不打印原始错误、凭据或会话内容。

本机可对明确的官方 DSH 包目录和最终插件 tarball 运行同一检查：

```sh
node tools/smoke-dsh-plugin.mjs /absolute/path/node_modules/@deepseek-ai/dsh /absolute/path/dsh-starlite-0.1.0-alpha.1.tgz
```

工具先调用官方 CLI 安装真实 tarball，再通过 `profile-boot` 公开的初始化／`runProfile`、返回的 shutdown、Cordis Context／Logger 和已安装插件的 `apply` 接口验收。它创建自己的临时 Harness home、user home 与 cwd，用不存在的 EXE 覆盖阻止启动桌宠／下载角色，不继承账户凭据、代理或 Node hooks；不提交提示，不调用模型或余额 API。只检查认证首页，不执行页面脚本，日志和认证 URL 不进入输出。检查结束删除自己的临时目录。CI 的 `stage-dsh-contract-fixture.mjs` 仅在干净 checkout 生成不可执行的 PE 头 fixture，已有程序构建会被拒绝覆盖；本机 smoke 应使用真实候选 tarball，无须运行该 staging 工具。

安装检查失败时会给出阶段和固定错误类别，例如 `install-packed-plugin: network-dns`、`registry-authentication` 或 `boot-lifecycle: missing-runtime-dependency`，据此检查 registry 连接／权限或官方 DSH 运行时依赖。非零退出还包含退出码；无法分类的错误明确标为 `nonzero-exit`，不会伪装成已知原因。子进程原始输出只在内存中用于分类，不打印或保存认证链接、密钥和会话信息。

此检查不代替 packaged Desktop 的窗口、会话导航、模型外观和系统交互验收。

`check:core` 不需要浏览器运行时或 Windows EXE；完整 `check` 与桌宠构建需要先同步运行时。CI 在 Linux 构建 core 和 VRM，再传给 Windows job。Windows CI 为打包结构检查生成不含资产、不可下载的本机测试清单；产物明确标记为 `local-only-windows-validation`，不能给普通用户使用或发布。私有源工程不会传到 CI；模型只通过独立许可的 Release 交付。每次新公开版本均需通过完整发布门检查。

## 模拟与人工检查

开发用 Mock 不发起模型或余额 API 请求：

```powershell
$env:DSH_INOCHI2D_PET_EXE = "E:\path\to\dsh-inochi2d-pet.exe"
pnpm --dir tools/mock-source build
node tools/mock-source/dist/index.js
```

Mock 会轮换状态并尝试拉起 Windows 程序，仅在用户明确开始该项验收时运行。真实验收还需检查多会话、工具、普通问题、权限批准、阻塞、完成、错误、重连、DPI／显示器与睡眠。动作艺术效果由用户逐一确认。

工作气泡默认两行精简模式；详细模式显示经过限制的思考／输出，不把工具参数或结果发给 Windows。实时流每 200 ms 合并，最多 120 个 Unicode 字素；完整边界见 [气泡与互动](companion-interactions.md)。费用测试注入固定服务数据，不访问网络。VRM 内嵌贴图通过 Blob 解码，CSP 的 `img-src` 与 `connect-src` 需保留 `blob:`。
