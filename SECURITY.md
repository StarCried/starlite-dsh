# Security Policy

只有最新已公开发布的 alpha 接收安全修复；旧版请先升级。源码 main、本地候选和未发布的修复不代表已交付版本。公开版本与来源见 [Releases](https://github.com/StarCried/starlite-dsh/releases) 和 [发布记录](docs/release.md)。

支持范围是 Windows 11 x64 + WebView2，连接同机的官方 Windows DSH 桌面版、Windows 原生 CLI/Web 或 WSL2 CLI/Web。未来 DSH 版本的兼容性须重新验证，不能由每日 CI 自动保证。信任边界见 [安全与隐私](docs/security.md)。

截至 2026-10-19，本仓库没有启用 GitHub Private vulnerability reporting。请先[创建公开 issue](https://github.com/StarCried/starlite-dsh/issues/new)，只写「需要私下报告安全问题」和受影响的 StarLite 版本，请求维护者提供私密联系方式。不要在公开 issue、截图或附件中提供漏洞利用步骤、认证深链接、令牌、模型、真实会话内容或本机路径。维护者提供私密渠道后再发送完整报告；不承诺固定响应时间。

私下报告可包含受影响版本、已去敏的最小复现、影响范围和建议修复。不要发送真实 API Key、凭据、用户提示、工具参数/结果或私有模型。一般功能错误和公开可安全描述的兼容性问题使用 [问题反馈](https://github.com/StarCried/starlite-dsh/issues/new/choose)；升级说明见 [升级与支持](docs/upgrade.md)。
