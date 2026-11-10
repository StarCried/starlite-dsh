# Bubbles and model interactions

[简体中文](companion-interactions.md) · English · [User guide](user-guide.en.md)

The hover toolbar uses transparent buttons without a shared background panel. Icons retain hover, press and keyboard-focus feedback. During session control it gains a robot button to release control, hidden with the other hover controls. Session speech has no title header; ordinary work bubbles keep their session title.

Optional [session control](session-control.en.md) lets DSH temporarily control animations, bubbles and layout. It is off by default; manual visibility, pause, privacy and bubble preferences retain priority.

Right-click the character for size, frame rate, tracking, bubbles, pause, and position controls. Changes save automatically without reloading the model or restarting its motions. Hover near the character to show smaller, larger, bubbles, and hide buttons below its feet. Resizing keeps the toolbar in place. Restore a hidden character from the tray.

**Display → Show debug info** shows rendered FPS, frame intervals, and CPU-side frame timing in the model's corner. With **Environment lighting** also enabled, outlines show the actual sample regions around the character. Regions are laid out automatically and cannot be dragged or edited. Turning either option off, pausing, or hiding the character hides the outlines. Debug information stays local and is not uploaded. See [measurement details](upgrade.en.md#show-debug-info).

Work bubbles use a compact session title and activity by default. Choose **DSH → Work bubbles → Detailed** to show the existing reasoning or response text. **Hide session content** suppresses private text and questions. Turning **Show bubbles** off hides all bubbles and returns questions to DSH while preserving animation.

A body click triggers the configured idle interaction and billing display when available; a double-click opens the current session or DSH. Moving more than six CSS pixels after a press begins dragging and suppresses the click. Transparent areas pass clicks through to the application below.

Ordinary questions can be answered in bubbles. Answers must match a still-pending request and are accepted once; tool permission approvals stay in DSH. **Answer in DSH** opens the corresponding session and returns that question to its original interface. A failed handoff keeps the bubble draft. For detailed Host ownership and connection behavior, see the [Chinese reference](companion-interactions.md#桥接与会话导航).
