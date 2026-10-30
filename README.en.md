# StarLite for DSH

[简体中文](README.md) · English

Bring your own VRM character to DeepSeek Harness. StarLite quietly shows task progress through motions and bubbles, and lets you answer ordinary session questions from your desktop.

**[Try a model in your browser](https://starcried.github.io/)** before installing. The blog demo uses Weiguang; DSH task updates and question bubbles require the plugin below.

Alpha `0.1.0-alpha.2`. Requires **Windows 11 x64 and WebView2**. Supports the official Windows desktop app, native Windows CLI/Web, and WSL2 DSH.

## Install and try Weiguang

**Official Windows desktop app:** open **Plugins → Add plugin**, enter `dsh-starlite@alpha`, install, and enable it. If DSH requests a restart, fully exit from its tray before reopening.

**CLI/Web, on Windows or WSL2:** install into the profile you actually use, then start DSH:

```sh
dsh plugin --profile web add dsh-starlite@alpha
dsh --profile web
```

Replace `web` with your profile. This is the only plugin you need. It prepares the Windows companion and downloads the separately licensed Weiguang example when its verified cache is missing. Model, motions, and mappings are configured automatically; existing VRM models and preferences are retained. No separate desktop installer or EXE path is needed.

Using Weiguang means accepting its [separate license](docs/weiguang-license.en.md). Otherwise choose **Hide model** in settings. Each model has its own **View license** entry. This version enables VRM only; Inochi2D import/display is disabled.

## Ask an Agent

Give an Agent with local computer access this prompt:

```text
Read https://github.com/StarCried/starlite-dsh/blob/main/docs/user-guide.en.md
and install the published npm package dsh-starlite@alpha into my existing DeepSeek Harness.
Identify my Windows Desktop, native CLI/Web, or WSL2 installation and actual profile first.
Preserve my models and preferences; do not upgrade DSH or start a second Host.
Verify locally without a paid model API call, then explain how to start it and open settings.
```

To understand the project first, ask the Agent to read that guide and explain installation, model import, upgrades, and bubbles without changing anything.

## Everyday use

- **Click the body:** play an idle interaction and show official DeepSeek balance and estimated DSH usage.
- **Double-click:** open the displayed session, or DSH when no session is active. Desktop sessions open in the official app; CLI/Web sessions open in your browser.
- **Drag the body:** move the character. Transparent areas let clicks reach the application behind it.
- **Right-click:** change size, frame rate, tracking, and bubbles; restore position or open full settings.
- **Answer a question:** choose options or type in the bubble. Tool permission approvals remain in DSH.

The interface follows the Windows display language: Chinese for Chinese Windows, English otherwise. Model names, session content, and third-party license text stay unchanged.

## Customize

The additional bundled gestures and English UI are development changes pending the next release. The install command above targets the currently published alpha channel.

[Install, use, and uninstall](docs/user-guide.en.md) · [Models and motions](docs/model-import.en.md) · [Downloads and local storage](docs/network-and-storage.en.md) · [Upgrade and troubleshoot](docs/upgrade.en.md)

Import a standard humanoid VRM through **Add VRM model**. Models without animations receive a default idle and optional bundled gestures; embedded motions are listed for mapping. Blinking and eye tracking depend on model capabilities. Adjust the default pose per model without modifying the source.

One companion connects to one DSH Host at a time. When switching, stop the original Host; the waiting Host connects after the reconnect period.

Program code: [BSD-2-Clause](LICENSE). Example artwork is separately licensed and downloaded separately. Windows alpha binaries are unsigned and use the system WebView2 runtime. Read the [network disclosure](docs/network-and-storage.en.md) before use.
