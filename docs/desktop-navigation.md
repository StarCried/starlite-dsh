# Desktop 与 Web 的会话导航

双击桌宠会打开气泡对应的会话。没有会话时，打开 DSH 主界面。

Host 根据官方公开的 `profileContext.name === "desktop"` 选择桌面模式。
Desktop 自带的 CLI 也使用 Electron，因此不能根据可执行文件或
`process.versions.electron` 判断用户正在使用哪种界面。旧 Web Host 没有
`profileContext` 时仍使用原来的浏览器导航。

桌面模式通过官方 `connection.rpc.handle` / `connection.rpc.call` 注册插件自己的
`/starlite-navigation` 通道。DSH 的 Host/Origin 检查、浏览器 cookie 认证和请求取消
继续由官方 Connection 执行。客户端的 `dsh.client.platform` 保持 `web`。

Host 的各个插件并行启动。导航注册通过公开的 `ctx.inject(["connection"], ...)`
等待服务就绪，并随该服务撤销和重新注册；不会因为冷启动时 Connection 尚未提供
而停用整个桌宠插件。撤销服务或禁用插件会取消旧目标，禁止迟到确认继续导航。

只有 `dsh-app://app/` 中具有官方 Desktop 标记的客户端会订阅导航。它通过
`uiWorkspace.openSession` 选择准确会话，再确认临时请求。Host 通过官方
`dsh://open` 显示窗口；该协议本身没有指定会话的能力。

桌宠只发送现有的随机会话引用。真实会话标识仅在 Host 和已认证的 DSH 客户端之间
传递，认证 URL、cookie、API Key 不进入桌宠。此通道只能导航，不能创建会话、
发送消息、回答问题或控制 Agent。

每个 Host 只接受一个客户端的导航确认。长轮询在等待目标元数据时保持连接，
重载或取消会撤销旧的确认身份；新客户端仅能继续未过期的目标。请求最多等待
8 秒（含唤起窗口），早于桌宠交互请求的 10 秒超时。错误、重复、其他客户端和
过期的确认均被拒绝。Desktop 加载或重载期间
不会退回浏览器，也不会选择其他会话。关闭主窗口只是隐藏；退出 DSH 或禁用插件
会关闭待处理请求并撤销 RPC 路由。

Web 模式仍通过 Host 打开自己的回环认证 URL，在片段中携带目标提示；认证跳转
后，插件客户端只选择会话列表或子代理目录中明确存在的目标，并移除提示。

## 发布验证

声明检查必须明确要求 Desktop 合同：

```powershell
node tools/check-dsh-contract.mjs <DSH包目录> --desktop
```

真实 RPC 验证直接加载指定安装中官方的 Host 和浏览器实现，使用临时回环 HTTP
服务与内存凭据，从 Connection 尚未提供的冷启动开始，检查服务撤销和重建、
cookie 认证、Origin 限制、取消、确认身份和释放。
它不启动用户 profile、不注册系统协议，也不调用模型 API：

```powershell
node tools/qualify-dsh-navigation.mjs <DSH包目录>
```

官方安装器内的 ASAR 运行时应使用其自带 Electron 的 Node 模式执行同一验证。
声明检查通过不能替代实际安装器和人工双击导航验收。
