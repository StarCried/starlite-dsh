# StarLite for DSH

[简体中文](https://github.com/StarCried/starlite-dsh/blob/main/packages/dsh-plugin/README.md) · English

A lightweight VRM companion for DeepSeek Harness. Install one plugin, start DSH, and the Weiguang example is prepared automatically. Bring your own model whenever you like.

Alpha `0.1.0-alpha.2`. Requires Windows 11 x64 and WebView2. Supports official Windows Desktop, native Windows CLI/Web, and WSL2 DSH.

## Install

**Windows Desktop:** open **Plugins → Add plugin**, enter `dsh-starlite@alpha`, install, and enable. Fully exit through the DSH tray before restarting when requested.

**CLI/Web, in Windows or WSL:**

```sh
dsh plugin --profile web add dsh-starlite@alpha
dsh --profile web
```

Use your actual profile in place of `web`. No separate desktop installer, archive extraction, or EXE-path configuration is required. Existing models and preferences are retained. The program uses system WebView2 rather than bundling a browser.

Using Weiguang means accepting its [separate license](https://github.com/StarCried/starlite-dsh/blob/main/docs/weiguang-license.en.md). Otherwise select **Hide model**. Each model has a View license entry. This version supports VRM only.

## Ask an Agent

```text
Read https://github.com/StarCried/starlite-dsh/blob/main/docs/user-guide.en.md
and install the published dsh-starlite@alpha into my existing DeepSeek Harness.
Identify my Desktop, native CLI/Web, or WSL2 installation and actual profile first.
Keep my models and preferences. Do not upgrade DSH or start a second Host.
Verify locally without paid model API calls, then explain startup and settings.
```

To learn first, ask the Agent to explain that guide without installing or changing anything.

## Use and customize

Click the body for an idle gesture and billing; double-click opens the current session or DSH. Drag the body to move it; transparent areas pass clicks through. Right-click opens size, frame-rate, tracking, bubble, and position controls. Questions can be answered directly in bubbles; tool permission approvals remain in DSH.

Import a standard humanoid `.vrm` through **Add VRM model**. The Import guide explains bones, blink, and lookAt requirements. Changes save automatically. User models and source files are preserved when upgrading; removing a library model does not delete its source.

The English interface and additional bundled gestures on the main branch are development changes pending the next release. Published alpha.2 retains its original default-idle behavior. The development UI follows Windows display language; user content and model-authored names are preserved.

[Full installation and usage guide](https://github.com/StarCried/starlite-dsh/blob/main/docs/user-guide.en.md) · [Models and motions](https://github.com/StarCried/starlite-dsh/blob/main/docs/model-import.en.md) · [Upgrade and troubleshoot](https://github.com/StarCried/starlite-dsh/blob/main/docs/upgrade.en.md)

## Downloads and privacy

npm installation runs no model-download script. On DSH startup, the selected example is downloaded from a pinned GitHub Release URL when its verified cache is missing. GitHub redirects to `release-assets.githubusercontent.com` are permitted. URL, length, and SHA-256 are recorded in the packaged `assets/windows-x64/manifest.json`; no cookies, API keys, or session content accompany model downloads.

Program/example cache: `%LOCALAPPDATA%\StarCried\StarLite\companions`. User models/preferences: `%APPDATA%\com.starcried.dsh-inochi2d-pet`. WSL uses the same Windows program and cache. Status and explicit answers travel only over token-authenticated local `127.0.0.1` connections. User prompts, tool arguments/results, real session IDs, and API keys are not sent to the companion.

Opening billing prefers DSH's official account service, which queries `/api/v0/users/get_user_summary` on DSH's Platform origin for recharge and bonus wallets. When signed out or no account service exists, an official API key queries `https://api.deepseek.com/user/balance`. Balances are cached for 60 seconds; no paid inference is requested and no login token or API key reaches the companion. Account charges belong to DSH's usage page; today's estimate applies only to API-key mode. There is no telemetry or background updater. Hide model or a custom model prevents subsequent default-example downloads; disabling the plugin stops it.

[Full network disclosure and implementation references](https://github.com/StarCried/starlite-dsh/blob/main/docs/network-and-storage.en.md)

Program code uses BSD-2-Clause. Example artwork has separate terms and is not included in the npm package. Windows alpha binaries are unsigned.
