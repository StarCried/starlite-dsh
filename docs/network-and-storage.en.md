# Downloads, network access, and local storage

[简体中文](network-and-storage.md) · English

StarLite does not download example models during npm installation. The npm package includes the Windows program; separately licensed example VRMs are acquired on demand when DSH starts. Downloads are not inference requests and consume no model tokens.

| Purpose | Trigger | Destination and data |
| --- | --- | --- |
| Selected example model | Startup with an example selected that has not yet been imported, and its download cache missing or invalid | HTTPS GET to a pinned GitHub Release URL; redirects to `release-assets.githubusercontent.com` are allowed. No cookies, API keys, or session content |
| Signed-in DeepSeek account balance | Opening the billing card while signed in, with an expired cache | Calls the official Host's `deepseekAccount.getBalance`; DSH queries `/api/v0/users/get_user_summary` on its configured Platform origin for recharge and bonus wallets. DSH handles the login token; StarLite and the companion do not receive it. Cached for 60 seconds |
| DeepSeek API-key balance | Signed out or no account service, a supported official key configured, and the billing card opened with an expired cache | GET `https://api.deepseek.com/user/balance`; the existing API key is sent only to this endpoint, without redirects. Cached for 60 seconds |
| Status and question answers | While the Host and companion run | An ephemeral IPv4 `127.0.0.1` port with an in-memory process token. Sanitized status/content and explicit answers stay on the local connection |

This table covers the plugin, not the model/tool requests DSH makes for your tasks. StarLite has no telemetry or background update service. Opening a project link, browser, or DSH window is user-triggered navigation.

The public Weiguang source is pinned to:

```text
https://github.com/StarCried/starlite/releases/download/weiguang-v3.0.0-starlite.1/Weiguang-StarLite.vrm
```

The packaged `assets/windows-x64/manifest.json` pins URL, byte length, and SHA-256. It does not fetch an arbitrary latest model. Size, timeout, and redirect limits apply; temporary downloads are committed only after validation. Failure neither imports a model nor blocks DSH. Catalog builds download only the selected example and do not invent unavailable BlueFish URLs.

## Storage and processes

Development builds offer optional **Environment lighting**, disabled by default. When enabled, the Windows companion samples small screen patches around its window at up to about four times per second and passes only the average color to its local renderer. It does not save, log, upload, or send screen images to DSH. Sampling stops while hidden, paused, or locked; unavailable samples restore the original lighting. This approximates nearby colors, does not reveal the layer hidden by the model, and does not exclude the companion from screenshots or recordings.

- Program and example cache: `%LOCALAPPDATA%\StarCried\StarLite\companions\<version-hash>\`. Cached bytes are checked before reuse. A new program or source may require restaging the program. Already imported examples load from the user's model directory and are not downloaded again during program upgrades.
- User models, mappings, and preferences: `%APPDATA%\com.starcried.dsh-inochi2d-pet\`. The legacy identifier preserves user data; it does not enable Inochi2D.
- The plugin starts its verified Windows EXE. WSL2 uses the same Windows runtime and cache through Windows interoperability.
- Removing a model preserves its original source VRM. Do not clear AppData during upgrades.

## Avoiding downloads

No example downloads occur while the plugin is not running. Choosing **Hide model** or an imported custom VRM prevents default-example downloads on later startups. The initial default Weiguang selection downloads automatically. Disable/remove the plugin if unwanted. Valid cached animation and tracking work offline; balance queries require a network connection.

## Review entry points

Inspect [bootstrap.ts](../packages/dsh-plugin/src/bootstrap.ts), [billing.ts](../packages/dsh-plugin/src/billing.ts), and [server.ts](../packages/dsh-plugin/src/server.ts), together with the actual release manifest. A directory's “undeclared behavior” warning may describe differences between its scanner and runtime observations, not a standard DSH permission format. Provide package version, destinations, triggers, and manifest for review. Do not invent `dsh.permissions` fields or hide requests to evade scanning.
