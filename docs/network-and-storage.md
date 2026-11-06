# 下载、联网与本地存储

简体中文 · [English](network-and-storage.en.md)

StarLite 不在 npm 安装阶段运行模型下载脚本。npm 包携带 Windows 程序；示例 VRM 独立授权，在启动 DSH 后按需获取。下载不是模型推理，不发送提示词，也不消耗模型 token。

## 插件发起的请求

| 用途 | 何时发生 | 目标与数据 |
| --- | --- | --- |
| 示例模型 | 启动时选中的示例尚未导入模型列表，且下载缓存缺失或校验失败 | 对程序清单中固定的 GitHub Release VRM 地址发送 HTTPS GET；允许跳转至 `release-assets.githubusercontent.com`。不携带 Cookie、API Key 或会话内容 |
| DeepSeek 登录账号余额 | 用户打开费用卡，DSH 账号已登录，且余额缓存过期 | 调用官方 Host 的 `deepseekAccount.getBalance`；由 DSH 向其配置的 Platform origin 的 `/api/v0/users/get_user_summary` 查询充值与赠金。登录令牌由 DSH 处理，不交给 StarLite 或桌宠。余额缓存 60 秒 |
| DeepSeek API Key 余额 | 未登录／无账号服务，已配置支持的官方 API Key，用户打开费用卡且缓存过期 | GET `https://api.deepseek.com/user/balance`；仅向该官方端点发送 DSH 中已有的 API Key，不允许重定向。余额缓存 60 秒 |
| 桌宠状态与答题 | DSH 与桌宠运行期间 | 本机 `127.0.0.1` 随机端口，进程级临时令牌认证；状态、受限文字及用户主动提交的回答留在本机链路 |

这些是插件自身的行为，不涵盖 DSH 执行用户任务时产生的模型或工具请求。StarLite 没有遥测或后台检查更新服务。打开项目链接、外部浏览器或 DSH 界面属于用户触发的导航。

当前公开微光来源为：

```text
https://github.com/StarCried/starlite/releases/download/weiguang-v3.0.0-starlite.1/Weiguang-StarLite.vrm
```

下载 URL、文件长度与 SHA-256 在随包发布的 `assets/windows-x64/manifest.json` 中固定，模型不是从任意“最新版本”地址获取。程序限制大小、超时和跳转，校验通过后才提交临时文件；下载失败不导入模型、不阻止 DSH 启动。带示例目录的开发版只获取选中的示例，蓝鱼尚未公开发行时不会提供虚构下载地址。

## 存储与进程

「环境补光」默认开启，可在右键菜单或设置中关闭，已有明确关闭的设置会保留。开启时，Windows 桌宠每秒最多四次读取角色可视轮廓附近的小块屏幕颜色，每次最多八块 12×12 像素；避开角色、气泡、按钮和调试信息，不以整块透明窗口作为取色范围。仅将平均颜色和采样位置传给本机界面；不保存、记录或上传屏幕图像，也不发送给 DSH。隐藏、暂停、锁屏时停止取色。运行期间短暂取色失败会保留最近一次有效补光，新颜色到达后平滑更新；关闭、暂停或切换模型时清除保留颜色。它近似周边环境，不能读取被模型遮住的下一层画面，也不改变桌宠的截图／录屏可见性。启用「显示调试信息」可查看实际参与取色的位置；位置由程序自动安排，调试框不拦截点击，也不参与颜色计算。

- Windows 程序与示例下载缓存：`%LOCALAPPDATA%\StarCried\StarLite\companions\<版本号-哈希>\`。缓存经过长度与 SHA-256 校验后复用；程序版本或来源变化可能需要重新准备程序。已经导入的示例直接从用户模型目录加载，升级程序不会重新下载它。
- 用户导入模型、映射和偏好：`%APPDATA%\com.starcried.dsh-inochi2d-pet\`。标识沿用旧版以保留用户数据，不表示当前启用 Inochi2D。
- 插件会启动随包提供并校验的 Windows 桌宠 EXE。WSL2 使用 Windows 桌宠和 Windows 缓存，需要 WSL／Windows 互操作；无需第二套渲染程序。
- 用户删除模型不会删除源 VRM。勿为升级清空 AppData；清理步骤见[升级与排错](upgrade.md)。

## 如何不下载

DSH 未启动插件时不会下载示例。模型列表选择「不显示模型」或使用已导入的自定义 VRM 后，后续启动不会获取默认示例；首次使用默认微光会自动下载。完全不需要插件时，在 DSH 中停用或移除它。缓存有效时，动画和跟随可离线运行；余额查询需要联网。

## 给审阅者的核对入口

下载与重定向：[`bootstrap.ts`](../packages/dsh-plugin/src/bootstrap.ts)；余额请求：[`billing.ts`](../packages/dsh-plugin/src/billing.ts)；本机接口：[`server.ts`](../packages/dsh-plugin/src/server.ts)。发布件中的实际清单与源码应一起核对，不能只从压缩后的调用名称推断联网能力。

第三方目录的“未声明行为”可能指其静态扫描结果与运行时观察不一致，并非 DSH 的统一权限声明格式。应提供包版本、上述清单、访问域名及触发条件申请复核；这份说明本身不保证其自动扫描通过。不要添加目录未规定的 `dsh.permissions` 字段，也不要通过改名、延迟请求或隐藏下载来规避检测。
