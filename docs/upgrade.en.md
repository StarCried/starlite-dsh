# Upgrading and troubleshooting

[简体中文](upgrade.md) · English · [User guide](user-guide.en.md)

## Upgrade safely

1. Fully exit the DSH Host. For Desktop, use the tray; × only hides its window.
2. Quit StarLite, update `dsh-starlite` in the same profile, then start DSH again.
3. Confirm your selected model, motion mappings, privacy settings, size, and bubbles are preserved.

The plugin prepares its matching Windows program automatically. User data is separate from the program cache. No installer, administrator permission, Rust toolchain, or manual EXE path is needed. Existing Inochi2D data is preserved but disabled in this release.

## The companion does not appear

Check that the active Host/profile has the plugin installed and enabled, Windows has WebView2, and WSL has Windows interoperability if used. Open StarLite settings from the tray. A connected second Host will not be displaced; stop the original Host and allow its reconnect period to end.

An example marked **Pending download** needs a DSH restart. Check access to the pinned HTTPS source if downloading fails. Existing user models remain unchanged.

For a damaged program cache, fully exit DSH and StarLite, open `%LOCALAPPDATA%\StarCried\StarLite\companions` in Explorer, and remove only the affected version/hash subdirectory. Restart DSH to restage it. Do not remove `%APPDATA%\com.starcried.dsh-inochi2d-pet`, which contains user models and preferences.

## Model, pose, or tracking problems

Open **Model information** for capabilities and resource counts. Triangle color is a single reference threshold, not an overall quality rank or measured FPS.

Check actual VRM humanoid, blink, and lookAt bindings. Correct filenames or bone names alone are insufficient. Missing optional eyes/blinks disable only those behaviors. **Pose and tracking** calibrates the bundled idle for a model's proportions. The three built-in gestures (`StarLiteCuriousPeek`, `StarLiteHappyWave`, `StarLiteSleepyStartle`) start and end from the selected Idle pose, including its calibration when using the bundled idle. The active wave retains its authored elbow and finger motion. Embedded and imported motions remain unchanged. Reset controls individually when needed.

Only idle loops. Other gestures return to idle after one play; state changes can interrupt them. Click and ambient gestures are suppressed while working. Check mappings and Pause animation if a click shows billing but no motion.

## Bubbles, navigation, and billing

Show bubbles off hides all bubbles while preserving animation. Hide session content suppresses private text, questions, and billing. Questions can always be answered in DSH. A failed handoff keeps the bubble draft.

Double-click should open the existing official Desktop app or the CLI/Web interface, not launch another Host. Report the exact DSH installation/version, profile, and error if it does not.

Billing requires an official DeepSeek API key configured in DSH, not merely a desktop account login. Unsupported gateways and incomplete pricing are marked rather than guessed. No paid inference request is necessary to test basic interaction or balance access.

## Show debug info

Enable **Show debug info** under **Settings → Display** or the character's right-click **Display** menu. It is off by default, saves automatically, and takes effect without reloading the model.

The corner display shows rendered FPS, frame-interval p95, CPU-side frame-time p95, draw calls, and triangles. It updates at most twice per second using the latest 240 rendered frames. Pause, hide, and resume reset the measurements. CPU time includes model update and WebGL submission work, including driver waits; it is not GPU execution time, CPU utilization, or DSH inference performance.

With **Environment lighting** also enabled, outlines show the actual sample regions around the character. These regions are laid out automatically and cannot be dragged or edited. Turning either option off, pausing, or hiding the character hides the outlines. Debug information stays local and is not uploaded.

## Reporting a problem

Include StarLite and DSH versions, Windows version, Desktop/CLI/Web/WSL mode, display scaling, reproducible steps, and whether the issue also affects a fresh example. Keep API keys, prompts, session logs, and private models out of public issues. English and Chinese reports are welcome.
