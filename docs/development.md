# 开发与验证

## 环境

- Windows 11 x64，Node.js 24，pnpm 11.7；
- Rust stable（`x86_64-pc-windows-msvc`）；
- Visual Studio C++ Build Tools 与 WebView2；
- Ubuntu WSL2 中的 DSH latest；
- 公开的 `inochi2d-web` 固定 revision，用于生成浏览器运行时。

## BYOM 源码试用

先在 WSL2 构建固定的公开运行时：

```bash
git clone https://github.com/StarCried/inochi2d-web.git
cd inochi2d-web
git checkout ab24c2bc627ef5acde6685ee20096cef0128baaa
npm ci
npm run fixtures
npm run build:wasm
npm run build --workspace inochi2d-web
```

再在 Windows PowerShell 构建桌宠。把 `<user>` 替换为自己的 WSL 用户名：

```powershell
git clone https://github.com/StarCried/dsh-inochi2d-pet.git
Set-Location dsh-inochi2d-pet
pnpm install --frozen-lockfile
pnpm sync:runtime -- "//wsl.localhost/Ubuntu/home/<user>/inochi2d-web/packages/inochi2d-web/dist"
pnpm desktop:build
```

同步源必须显式给出，也可以通过 `INOCHI2D_WEB_DIST` 环境变量设置。同步会写入未跟踪的 `apps/desktop/public/runtime/inochi2d-web`，并记录 Git revision/dirty 状态；发布只接受来自干净、已固定 revision 的运行时。

运行 `apps/desktop/src-tauri/target/release/bundle/nsis` 中生成的未签名安装程序。
然后在 WSL2 中从 Windows 仓库的 `/mnt/<drive>/...` 路径打包并安装 bundle：

```bash
cd /mnt/<drive>/path/to/dsh-inochi2d-pet
pnpm pack:plugin
dsh plugin --profile web add \
  ./packages/dsh-plugin/.pack/dsh-inochi2d-pet-0.1.0-alpha.0.tgz
dsh --profile web --dump-config
dsh web
```

首次连接时桌宠没有内置模型，会打开设置。选择自己有权使用的 `.inp` 或 `.vrm`；
VRM 还需导入外部 VRMA 动作，可选择角色配置。明确选择待机动作，其余状态可映射
或禁用；点击回应与偶发小动作可多选。仅待机循环，其他动作完整播放一次。
模型不会上传。

VRM 的内嵌贴图通过本地 Blob 解码。桌宠 CSP 的 `img-src` 和 `connect-src`
均需允许 `blob:`，否则 Three.js 的图片解码会被 WebView2 拦截，模型加载失败。

## 自动检查

```powershell
pnpm check
pnpm pack:plugin

cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm desktop:build
```

`pnpm check:core` 不需要生成桌面运行时，适合普通提交的快速 CI。完整 Windows 构建要求 `release/model-companion-web.rev` 存在，并由 CI 在 Linux 构建官方 WASM 后传给 Windows job。

## DSH latest 契约与本地 bundle

```bash
export PATH="$HOME/.local/bin:$PATH"
npm install -g --prefix "$HOME/.local" @deepseek-ai/dsh@latest
node /mnt/<drive>/path/to/dsh-inochi2d-pet/tools/check-dsh-contract.mjs \
  "$HOME/.local/lib/node_modules/@deepseek-ai/dsh"

cd /mnt/<drive>/path/to/dsh-inochi2d-pet
pnpm pack:plugin
dsh plugin --profile inochi2d-test add \
  ./packages/dsh-plugin/.pack/dsh-inochi2d-pet-0.1.0-alpha.0.tgz
dsh --profile inochi2d-test --dump-config
```

契约检查验证当前适配器依赖的实际事件签名和事件形状。每日 CI 跟踪 `@latest`，相关插件、协议或检查脚本推送到 `main` 时也会立即验证；失败表示需要人工审查 DSH 变更，不能通过猜测旧事件语义来兼容。

DSH `0.1.5-rc.1` 的实时文本使用 `agent/assistant-stream`，嵌套工具使用
`tool/ptc-dispatch-start` / `tool/ptc-dispatch`。适配器同时保留已验证的
`0.1.2-rc.1` 事件支持。新文本流每次开始请求或重试时清空上一轮文本；最终回复仍来自
`assistant/message`，只读取可见文本，不读取其中保存的原始流、工具参数或结果。

## Mock 与手工检查

先安装或直接构建 Windows 程序，然后运行：

```powershell
$env:DSH_INOCHI2D_PET_EXE = "E:\path\to\dsh-inochi2d-pet.exe"
pnpm --dir tools/mock-source build
node tools/mock-source/dist/index.js
```

Mock 只用于开发，会轮换七种状态。真实验收仍需在 WSL 中启动当前 DSH，并验证多会话、工具、批准、阻塞、完成、错误、重连、DPI/显示器、睡眠以及模型动画。
