# StarLite for DSH: installation and use

[简体中文](user-guide.md) · English · [README](../README.en.md)

Requires Windows 11 x64, WebView2, and one supported DSH Host: official Windows Desktop, native Windows CLI/Web, or WSL2 CLI/Web. This guide covers `0.1.0-alpha.2`; the install channel is `dsh-starlite@alpha`. Pin `dsh-starlite@0.1.0-alpha.2` when reproducibility is required.

## Install

For **official Windows Desktop**, open **Plugins → Add plugin**, install `dsh-starlite@alpha`, and enable it. Fully exit DSH through its tray if a restart is requested. The desktop app provides its own runtime and package manager.

Desktop uses a managed `desktop` profile. A plugin installed in CLI/Web or WSL is not automatically installed there. Model preferences belong to the Windows user and can be shared, but DSH sessions and credentials in separate homes/profiles are not synchronized.

For **native Windows CLI/Web**, run in PowerShell; for **WSL2**, run in the WSL terminal:

```sh
dsh plugin --profile web add dsh-starlite@alpha
dsh --profile web
```

Replace `web` with the actual profile. WSL requires Windows interoperability. Do not start a second Host just to install the plugin. Older DSH plugin managers may require pnpm; follow DSH's own requirements. End users do not need Rust or Blender.

For command-line management of Desktop, initialize it once, fully exit it, and use the **bundled command registered by Desktop**:

```powershell
dsh plugin --profile desktop add dsh-starlite@alpha
```

Reopen the desktop app afterward. A separately installed npm `dsh` cannot manage this managed profile, and `dsh --profile desktop` is not a desktop-app launcher.

If the same profile has the old bridge, remove it before installing the replacement:

```sh
dsh plugin --profile web remove dsh-inochi2d-pet
```

This does not remove Windows user models or preferences.

## Startup and licenses

Starting DSH verifies and stages the packaged Windows companion, then downloads the selected example only when its verified cache is missing. Download URLs, size, and SHA-256 are pinned. Failure leaves existing models intact and does not block DSH startup. npm installation itself does not download the example. See [network and storage](network-and-storage.en.md).

Weiguang is selected initially. Using an example means accepting its separate license; choose **Hide model** if you disagree. Licenses are accessible from model cards before download. Selecting a custom imported model or Hide model prevents subsequent default-example downloads. Models, mappings, and preferences are retained across program upgrades. Inochi2D is disabled in this version.

Only start DSH for daily use. The desktop app starts from its normal shortcut; CLI/Web uses `dsh --profile web`. The companion appears after connecting. Starting the cached companion directly opens settings but does not start DSH. It does not update itself in the background.

The companion connects to one Host. Closing the DSH desktop window with × only hides it; use its tray to exit. A second Host is queued rather than taking over. After disconnection, StarLite allows 60 seconds for reconnection, then adopts the first waiting Host or exits. A stalled connection can take another 45 seconds to detect. Restarting DSH promptly preserves the original connection.

## Controls and bubbles

Development builds offer **Display → Environment lighting** in the model's right-click menu and full settings. It is off by default, with an initial strength of 20%. Nearby colors also gently adapt brightness: darker surroundings dim the lighting and brighter ones lift it. The target stays within 80%–110% of the original light intensities, blended according to strength; this is not a screen-pixel brightness guarantee. Zero strength or disabling the effect restores the original lighting. Changes apply immediately without reloading the model. Sampling is local and low frequency; see the [data disclosure](network-and-storage.en.md#storage-and-processes).

- Drag the model's body to move it. Transparent surroundings pass clicks through. Right-click opens quick settings; use More settings or the tray for the library and license controls.
- A single click while idle plays a mapped gesture and shows official DeepSeek billing. While working it only queries billing. A pending question is never replaced by the billing card.
- Double-click opens the bubble's session, or the DSH home when there is no session. Desktop navigation stays in the official app. Invalid or unavailable targets show an error instead of opening a different session.
- Compact bubbles show title and activity. Detailed bubbles also show bounded reasoning/response content. **Show bubbles** off suppresses every bubble while keeping animations active.
- Ordinary single-choice, multiple-choice, and free-text questions can be answered in the bubble. Tool permission approvals stay in DSH.
- Only idle loops. Other state motions play once, then return to idle. New states may interrupt; click/ambient gestures are suppressed during work. Thinking and output share Working.
- **Hide session content** hides titles, reasoning, responses, questions, and billing, leaving fixed statuses. User prompts, tool arguments/results, real session identifiers, and credentials are never sent to the companion.

Timed questions display the Host's remaining time. DSH decides when to continue. Questions that allow late answers remain answerable afterward. **Answer in DSH** hands off only after the exact session opens successfully; failure preserves the current draft. Newer questions, privacy changes, and disconnection revoke stale forms.

The interface follows the Windows display language: Chinese for Chinese Windows, English otherwise. It does not translate session text, model-authored names, or arbitrary third-party license terms.

## Models and motions

The additional bundled gestures and dual-example catalog are development features pending the next release. Published alpha.2 retains its original default-idle behavior.

Open settings and select a model card to switch. Each model retains its mappings and pose adjustments. **Add VRM model** imports a single `.vrm`, validates it, then selects it automatically. Changes save automatically. **Import guide** explains required humanoid mappings and optional blink/look-at capabilities.

**Remove** asks for confirmation, then removes the library entry, mappings, and managed copy. The source VRM remains. Removing the active model selects Hide model and does not automatically pick another model. Removed examples are not reinstalled on restart; select an available example again when wanted.

Animation-free humanoid models receive the bundled idle. Optional bundled gestures and embedded standard glTF motions are available for event mapping. Blink and independent eye tracking require valid VRM bindings; missing optional capabilities do not reject a valid humanoid model. See [model import](model-import.en.md).

**Pose and tracking** adjusts arms, symmetric palm rotation, wrist lift, hand curl, elbow bend, and independent head/eye sensitivity. Pose changes affect only the bundled idle. They do not modify the source or authored animations. Each control can be reset.

## Billing

Sign into DeepSeek in a DSH version that provides the account service, then click the model to check your balance. No API key is required. The card identifies the source and shows recharge and bonus wallets separately, without adding different currencies.

The signed-in account takes priority. When signed out, or when an older DSH lacks the account service, StarLite uses an existing official API key (`deepseek-official` before optional `deepseek`). An account query failure never silently switches to a potentially different API account. Balances are cached for 60 seconds; login and credential changes invalidate the cache. Missing wallets and failed queries are not reported as zero. Account queries can take about 30 seconds and do not invoke paid inference.

For account charges, use DSH's usage page: StarLite does not apply API-key prices to account billing. The official Host service handles login credentials; StarLite consumes only the balance. Login tokens, API keys, and personal account details are never sent to the companion.

API-key mode retains today's API usage estimate and the China Standard Time peak/off-peak badge. This estimate covers eligible official API requests in the current profile, not one account's authoritative bill. History cannot be reliably reassigned after changing keys. Unpriced models, gateways, and incomplete records are marked; in-progress requests, account-login requests, and other applications are excluded.

## Upgrade or uninstall

Fully stop DSH and StarLite, update `dsh-starlite` in the same profile, and restart DSH. Desktop users can update/reinstall through Plugins. Existing user data is retained; do not install old and new bridges together.

```sh
dsh plugin --profile web remove dsh-starlite
```

Desktop users can disable/remove it in Plugins, or fully exit Desktop and use its bundled `dsh plugin --profile desktop remove dsh-starlite`. Quit StarLite from the Windows tray. Removing the plugin does not delete user models or preferences.

See [upgrade and troubleshooting](upgrade.en.md) for cache repair. Do not clear AppData as an upgrade step. Windows alpha binaries are unsigned; verify the official release and SHA-256 rather than disabling Windows protection.
