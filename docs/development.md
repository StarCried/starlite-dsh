# 开发与验证

## 环境

- Windows 11 x64，Node.js 24，pnpm 11.7；
- Rust stable（`x86_64-pc-windows-msvc`）；
- Visual Studio C++ Build Tools 与 WebView2；
- Ubuntu WSL2 中的 DSH latest；
- 公开的 `inochi2d-web` 固定 revision，用于生成浏览器运行时。

## BYOM 源码试用

先在 WSL2 构建 `release/model-companion-web.rev` 指定的公开运行时。
当前双后端分支的新增提交仍在本地，尚不能把下面的公开构建步骤当作已发布版本；
待共享运行时公开并更新固定 revision 后再执行。不要改用旧 revision 的构建产物。
把 `REPLACE_WITH_RELEASE_RUNTIME_REV` 替换为该文件中的 40 位 revision。

```bash
git clone https://github.com/StarCried/inochi2d-web.git
cd inochi2d-web
git checkout REPLACE_WITH_RELEASE_RUNTIME_REV
npm ci
npm run fixtures
npm run build:wasm
npm run build --workspace model-widget-core
npm run build --workspace inochi2d-web
npm run build --workspace vrm-web
```

再在 Windows PowerShell 构建桌宠。把 `<user>` 替换为自己的 WSL 用户名：

```powershell
git clone https://github.com/StarCried/dsh-inochi2d-pet.git
Set-Location dsh-inochi2d-pet
pnpm install --frozen-lockfile
pnpm sync:runtime -- "//wsl.localhost/Ubuntu/home/<user>/inochi2d-web/packages/inochi2d-web/dist"
pnpm desktop:build
```

同步源必须显式给出，也可以通过 `INOCHI2D_WEB_DIST` 环境变量设置。同步会从同一工作区收集 core、Inochi2D 和 VRM 三个组件，写入未跟踪的 `apps/desktop/public/runtime/`，并记录 Git revision/dirty 状态；发布只接受来自干净、已固定 revision 的运行时。

运行 `apps/desktop/src-tauri/target/release/bundle/nsis` 中生成的未签名安装程序。
然后在 WSL2 中从 Windows 仓库的 `/mnt/<drive>/...` 路径打包并安装 bundle：

```bash
cd /mnt/<drive>/path/to/dsh-inochi2d-pet
pnpm pack:plugin
dsh plugin --profile web add \
  ./packages/dsh-plugin/.pack/dsh-inochi2d-pet-0.1.0-alpha.0.tgz
dsh --profile web
```

首次连接时桌宠没有内置模型，会打开设置。选择自己有权使用的 `.inp` 或 `.vrm`；
VRM 还需导入外部 VRMA 动作，可选择角色配置。明确选择待机动作，其余状态可映射
或禁用；点击回应与偶发小动作可多选。仅待机循环，其他动作完整播放一次。
模型不会上传。

本地验证新构建时，可在启动 DSH 的 WSL 环境中指定 Windows 可执行文件，避免旧协议注册
启动另一个构建。例如：

```bash
export DSH_INOCHI2D_PET_EXE='E:\StarCried\dsh-inochi2d-pet\apps\desktop\src-tauri\target\release\dsh-inochi2d-pet.exe'
dsh --profile web
```

该变量仅接受本机盘符上的绝对路径及 `dsh-inochi2d-pet.exe` 文件名，不接受命令参数。
未设置时使用已安装的协议注册；无效路径会停止桌宠启动，但不妨碍 DSH 运行。
实际思考和回答通过 `agent/assistant-stream` 同步到气泡，每 200 ms 合并更新一次，
长文本显示开头，最多 120 个 Unicode 字素，超出部分以省略号表示；后续分片不会滚走开头，重试或新一轮流会清空旧内容。开启固定文案隐私模式时只显示状态文案。

桌面气泡最多显示两行，多余的可见内容由省略号收起，避免长回答遮住模型。
思考内容使用浅灰色；首次切换到回答时渐显，尊重系统的减少动态效果设置。

费用气泡使用独立的认证只读接口，不修改状态 SSE。点击查询官方 DeepSeek
余额，以及当前 DSH profile 的北京时间当日用量估算；工作中点击不会启动
点击动作。估算范围、缺失记录、支持的模型和已核实价格见插件 README。
支持 DSH 默认 `llm-deepseek` / `deepseek-official` 路由，以及可选的
`llm-pi-ai.providers.deepseek` 路由；默认路由填好 key 即可。按实际设置与
可信启动环境检查官方地址，只统计通过检查的路由。凭据由 DSH 解析，不能填入桌宠。
测试注入余额与持久化服务的固定数据，不调用模型或余额网络 API。

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

发布检查还核对费用功能使用的 settings/credentials/sessionPersistence
公开只读契约。旧 DSH 缺少这些可选服务时，运行中的状态桥接继续工作，
费用显示不可用；不能据此把完整费用功能标记为该版本已验收。

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
