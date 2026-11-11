# 历史发布记录（保留当时事实）

## 0.1.2 已发布（2026-11-11）

[`dsh-starlite@0.1.2`](https://www.npmjs.com/package/dsh-starlite/v/0.1.2) 已发布到 npm `latest`，并提供 [GitHub 正式发行](https://github.com/StarCried/starlite-dsh/releases/tag/v0.1.2) 的 Windows 安装器和免安装版。新增可选会话接管、透明悬浮工具条，修复拖动中的环境光取色并更新通用困倦惊醒动作，详细行为见 [版本变化](../CHANGELOG.md#012--2026-11-11)。模型继续引用已公开的微光和蓝鱼固定资源，不另发模型或把角色文件打入程序。

发行源码和不可变 tag `v0.1.2` 对应 [`82a5202`](https://github.com/StarCried/starlite-dsh/commit/82a52029abe5f0dea5c9a9c49750785c4f35faf3)，共享运行时固定为 [`125a66a`](https://github.com/StarCried/starlite/commit/125a66a3a42f6f71b44bb7724da37573be368d2d)，从独立干净 checkout 构建，provenance 为 `dirty: false`。精确源码的三项云端检查、匿名 npm 归档一致性、Windows／WSL2 的真实 registry 安装与生命周期均通过。微光和蓝鱼另通过空缓存 HTTPS 下载及离线复用。哈希、CI 链接及本轮验收范围见 [0.1.2 发布验收](dsh-compatibility.md#公开发行-0122026-11-11)，本机证据保存在 `release-output/release-0.1.2/`。后续文档提交不移动 tag 或重打发布件；Windows 文件仍未签名，保留 SmartScreen 说明。

## 0.1.1 npm 已发布（2026-11-06）

[`dsh-starlite@0.1.1`](https://www.npmjs.com/package/dsh-starlite/v/0.1.1) 已发布到 npm `latest`，`alpha` 保留 `0.1.0-alpha.2`。Windows 0.1.1 EXE 随插件提供；本轮没有另发 GitHub Windows 安装器或模型 Release。新增共享脚下工具条、固定脚点缩放和六像素拖动判定，并将 DSH 新增的 `approval` 意图问答交回官方界面；现有模型来源、许可和用户偏好保留。

发行源码和不可变的 annotated tag `v0.1.1` 对应 [`b6a62e5`](https://github.com/StarCried/starlite-dsh/commit/b6a62e57f20fbe42c9c961177b81e570fc789d3f)，共享运行时固定为已公开的 [`073db625`](https://github.com/StarCried/starlite/commit/073db625111aba345032b5b718bc39e0e8de901d)，provenance 为 `dirty: false`。精确源码的主 CI、依赖审计和 DSH latest 检查均通过；匿名 registry 归档与本地发布件逐字一致，Windows／WSL2 均完成真实 registry 安装与生命周期验证。用户已确认脚下控件手验。哈希、CI 链接和验收边界见 [0.1.1 发布验收](dsh-compatibility.md#公开发行-0112026-11-06)，本机证据保存在 `release-output/release-0.1.1/`。后续文档提交不移动 tag 或替换发布件。

`0.1.0` 已于 2026-11-03 发布到 npm `latest` 和 [GitHub 正式发行](https://github.com/StarCried/starlite-dsh/releases/tag/v0.1.0)，包括统一插件、Windows 安装器和免安装版；蓝鱼另行发布为独立模型资源。变化见 [版本变化](../CHANGELOG.md)，精确源码、公开下载与实际 registry 安装结果见 [发布验收](dsh-compatibility.md#公开发行-0102026-11-03)。本页保留后续构建流程和历史发行证据。

## 0.1.0 发行范围（2026-11-03）

本版统一源码、npm 与 Windows 发行物版本为 0.1.0，npm 使用 latest。共享运行时以 release/starlite.rev 的精确源码构建；蓝鱼以独立模型发行物提供，微光仍为初始默认。新版本包含账号余额、默认环境补光、中文／英文界面、已调校的通用动作，以及正常退出重连和重复示例下载修复。

发布前的模型与动作、启动重连、蓝鱼调校和环境补光候选已由用户验收。本次已完成自动化检查、Windows／WSL2 官方 DSH 的实际 registry 安装、公开下载及完整性验证，详见[兼容性记录](dsh-compatibility.md#公开发行-0102026-11-03)。未把既有 DPI、睡眠或长期性能结果改记为新包全面复验。Windows 安装器和免安装程序仍未代码签名。

## 历史公开发行 alpha.2

安装使用 [`dsh-starlite@alpha`](https://www.npmjs.com/package/dsh-starlite/v/0.1.0-alpha.2)，当时 `alpha` 为 alpha.2，`latest` 保留 alpha.0。发行源码为 [`80f9220`](https://github.com/StarCried/starlite-dsh/commit/80f92200393b58f617864af5b2fb910171b8347a)，共享运行时为 [`f83a4ec`](https://github.com/StarCried/starlite/commit/f83a4ec0f795a14f36d6724465e3a89f9c1e8529)。该精确源码的[主 CI](https://github.com/StarCried/starlite-dsh/actions/runs/39753442237)、[依赖审计](https://github.com/StarCried/starlite-dsh/actions/runs/39753442269) 与 [DSH latest 兼容检查](https://github.com/StarCried/starlite-dsh/actions/runs/39753656026) 全部成功。

匿名公开 npm tarball 为 4,040,458 字节，SHA-256 `51641fd8539568f9d305c985ba35d89ca52734639b30003925ba55973f171bc7`，SHA-512/SRI 也与 registry 一致。这个真正公开下载的包已在 Windows DSH `0.2.1-rc.2`／Node 24.15.0 和 WSL2 DSH `0.2.0-rc.2`／Node 22.22.1 通过隔离安装、认证首页、fail-open 与退出回收；没有调用付费 API、启动桌宠或修改日常 profile。

[GitHub 预发行 `v0.1.0-alpha.2`](https://github.com/StarCried/starlite-dsh/releases/tag/v0.1.0-alpha.2) 的七个公开附件已匿名重新下载，逐项校验字节、哈希、平铺校验和及源码 tag；包括插件 tarball、未签名 Windows 安装器、免安装 ZIP、SHA256SUMS、SOURCE_REVISION、SBOM 和依赖许可。微光模型仍作为独立资产分发。完整 SRI、公开附件哈希与人工验收边界见[发布验收](dsh-compatibility.md#公开发行-010-alpha22026-10-22)，不将旧长测或新增手腕控件的浏览器验收改记为原生 GUI 全面通过。

## 上次公开发行 alpha.1

[`dsh-starlite@0.1.0-alpha.1`](https://www.npmjs.com/package/dsh-starlite/v/0.1.0-alpha.1) 与 [Release `v0.1.0-alpha.1`](https://github.com/StarCried/starlite-dsh/releases/tag/v0.1.0-alpha.1) 已公开，发行源码为 [`918f15c`](https://github.com/StarCried/starlite-dsh/commit/918f15ce1d342a79a90c9c1ac0d6646939ced2e6)，共享运行时为 [`903fe2c`](https://github.com/StarCried/starlite/commit/903fe2cab9e0f37ad36cd904e301fa482af2508e)。精确源码的[主 CI](https://github.com/StarCried/starlite-dsh/actions/runs/38703696617) 与 [DSH latest 兼容作业](https://github.com/StarCried/starlite-dsh/actions/runs/38704010721) 均成功；更改见[版本变化](../CHANGELOG.md)。

匿名公开下载的 npm tarball 为 3,922,149 字节，SHA-256 `e7abb12285656a12bac3bd896c426755afd3d4bc9abcb7060f593d6a10d84e7d`，与最终本地发行包逐字节一致，SHA-512 完整性值与 registry 一致。这个真正公开下载的包已在官方 DSH `0.2.1-alpha.2` 的 Windows 与 WSL2 环境中通过隔离安装、认证首页、fail-open 和退出回收，未调用付费 API。该次发行后 `alpha` 指向 alpha.1，`latest` 仍保留 alpha.0；安装使用 `dsh-starlite@alpha`。完整 SRI、来源和验收边界见[发布验收](dsh-compatibility.md)。旧版和本地开发候选的记录保留原身份，没有改写为本次程序的全面复验。

## 首次发行基线

`dsh-starlite@0.1.0-alpha.0` 已发布到 [npm alpha 渠道](https://www.npmjs.com/package/dsh-starlite/v/0.1.0-alpha.0)，[软件 Release `v0.1.0-alpha.0`](https://github.com/StarCried/starlite-dsh/releases/tag/v0.1.0-alpha.0) 对应源码 `ee86d3984d300621812f16016b08450ec860ec13`。从公开 registry 全新下载的 tarball 与正式包完全一致，并通过官方 npm DSH `0.2.1-alpha.2` 的隔离安装和 fail-open 检查，详见[发布验收](dsh-compatibility.md)。

现行操作见 [发布流程](release.md)；本页只保留历史事实。

## 依赖审计记录

2026-11-03：正式版重新审计，更新已撤回的 async-executor 1.14.0 至兼容补丁 1.14.1。JavaScript 未报告漏洞，Rust 未报告漏洞或撤回版本；原有精确的维护／非 Windows 告警规则保留，未新增例外。RustSec 数据库 revision 为 `263a4d951a0867d4bddc29dddd6d59427c78f9a7`。

2026-10-22 已更新 Vite 8.2.4 和 Vitest 4.1.12，修复新披露的开发服务器公告。完整在线审计未报告 JavaScript 或 Rust 漏洞；既有 Rust 维护与非 Windows 警告保留到期复核规则，并重新核对 Windows 依赖树。精确数据库 revision、范围和例外见[依赖维护](dependency-audit.md)。以下日期记录只代表各次扫描，不替代每次发行前的最新检查。

2026-10-14 已修复可用的构建依赖补丁，并将撤回的 `chacha20 0.10.1` 更新为 `0.10.2`。DSH 的 npm 完整／生产依赖审计均无已知漏洞；共享包的浏览器运行时和插件自身不携带 Hexo 主程序，私有 Hexo 7 示例及使用者的 Hexo 依赖仍有 9 条上游审计记录，不能称整个 Hexo 生态已无告警。

使用隔离的 cargo-audit 0.22.2 与官方 RustSec 数据库 `6aed84668c23d7f535077a9fe918bf1fa0f6a5bc` 检查两个 Cargo.lock，未发现已知漏洞或仍撤回的版本。Windows 运行链中的 5 个 `unic` 库仍有停止维护提示；其他目标的 `glib`／`proc-macro-error` 警告不在 Windows x64 依赖树。保留真实审计结果，后续发布仍须重新扫描，不强行替换不兼容的传递依赖。
