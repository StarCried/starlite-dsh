# 下载、联网与本地存储

StarLite 不在 npm 安装阶段运行模型下载脚本。npm 包携带 Windows 程序；示例 VRM 独立授权，在启动 DSH 后按需获取。下载不是模型推理，不发送提示词，也不消耗模型 token。

## 插件发起的请求

| 用途 | 何时发生 | 目标与数据 |
| --- | --- | --- |
| 示例模型 | 启动时选中了示例，且对应版本缓存缺失或校验失败 | 对程序清单中固定的 GitHub Release VRM 地址发送 HTTPS GET；允许跳转至 `release-assets.githubusercontent.com`。不携带 Cookie、API Key 或会话内容 |
| DeepSeek 余额 | 用户打开费用卡，DSH 已配置支持的官方账户，且余额缓存过期 | GET `https://api.deepseek.com/user/balance`；仅向该官方端点发送 DSH 中已有的账户凭据，不允许重定向。余额缓存 60 秒 |
| 桌宠状态与答题 | DSH 与桌宠运行期间 | 本机 `127.0.0.1` 随机端口，进程级临时令牌认证；状态、受限文字及用户主动提交的回答留在本机链路 |

这些是插件自身的行为，不涵盖 DSH 执行用户任务时产生的模型或工具请求。StarLite 没有遥测或后台检查更新服务。打开项目链接、外部浏览器或 DSH 界面属于用户触发的导航。

当前公开微光来源为：

```text
https://github.com/StarCried/starlite/releases/download/weiguang-v3.0.0-starlite.1/Weiguang-StarLite.vrm
```

下载 URL、文件长度与 SHA-256 在随包发布的 `assets/windows-x64/manifest.json` 中固定，模型不是从任意“最新版本”地址获取。程序限制大小、超时和跳转，校验通过后才提交临时文件；下载失败不导入模型、不阻止 DSH 启动。带示例目录的开发版只获取选中的示例，蓝鱼尚未公开发行时不会提供虚构下载地址。

## 存储与进程

- Windows 程序与示例下载缓存：`%LOCALAPPDATA%\StarCried\StarLite\companions\<版本号-哈希>\`。缓存经过长度与 SHA-256 校验后复用；程序版本或来源变化可能需要重新准备。
- 用户导入模型、映射和偏好：`%APPDATA%\com.starcried.dsh-inochi2d-pet\`。标识沿用旧版以保留用户数据，不表示当前启用 Inochi2D。
- 插件会启动随包提供并校验的 Windows 桌宠 EXE。WSL2 使用 Windows 桌宠和 Windows 缓存，需要 WSL／Windows 互操作；无需第二套渲染程序。
- 用户删除模型不会删除源 VRM。勿为升级清空 AppData；清理步骤见[升级与排错](upgrade.md)。

## 如何不下载

DSH 未启动插件时不会下载示例。模型列表选择「不显示模型」或使用已导入的自定义 VRM 后，后续启动不会获取默认示例；首次使用默认微光会自动下载。完全不需要插件时，在 DSH 中停用或移除它。缓存有效时，动画和跟随可离线运行；余额查询需要联网。

## 给审阅者的核对入口

下载与重定向：[`bootstrap.ts`](../packages/dsh-plugin/src/bootstrap.ts)；余额请求：[`billing.ts`](../packages/dsh-plugin/src/billing.ts)；本机接口：[`server.ts`](../packages/dsh-plugin/src/server.ts)。发布件中的实际清单与源码应一起核对，不能只从压缩后的调用名称推断联网能力。

第三方目录的“未声明行为”可能指其静态扫描结果与运行时观察不一致，并非 DSH 的统一权限声明格式。应提供包版本、上述清单、访问域名及触发条件申请复核；这份说明本身不保证其自动扫描通过。不要添加目录未规定的 `dsh.permissions` 字段，也不要通过改名、延迟请求或隐藏下载来规避检测。
