# Let a DSH session control the character

[简体中文](session-control.md) · English

Session control is optional and off by default. It gives an existing DSH session temporary access to character animations, plain-text bubbles and layout. It adds no chat backend, persona memory or voice service.

## Start

Enable **Allow session control** in the character's DSH quick-menu tab or full settings, then tell DSH:

> Use StarLite to interact with me. Inspect the current model's animations, temporarily take control, greet me with a suitable animation and a short bubble, then release control.

The plugin registers native tools and an embedded Skill. No separate MCP server is required. Tools are offered only when enabled; acquiring control additionally requires a ready character. Unsupported DSH tool services do not prevent the ordinary companion from running.

During control, hovering near the character reveals a robot button in its foot toolbar; click it to release control. The right-click menu also retains the exit action. Session bubbles show only their message, without a session-title header. Automatic state, ambient, click and billing interactions yield to the session; baseline idle, blinking and physics continue. Manual dragging, pausing, hiding or model changes end control. Hidden bubbles and privacy preferences still apply. Questions return to DSH, and permission approvals always stay there.

Only one session can control the model. Control expires after five minutes without new assistant output (text, reasoning or tool calls) from the owning session or a valid control operation; an ongoing conversation can last longer. Other sessions, connection heartbeats and read-only inspection do not extend it. Cancellation, disconnect and disposal release it. Release restores the latest DSH state and the user's original layout; commands are not replayed after reconnect.

| Tool | Purpose |
| --- | --- |
| `starlite_inspect` | Read the current model, named animations, durations, capabilities and control status |
| `starlite_control` | Acquire or release this session's control |
| `starlite_perform` | Play an animation, show text, combine both, or stop the current performance |
| `starlite_stage` | Temporarily change position, size and cursor tracking |

Text is limited to 1000 characters and 1–30 seconds. Size is 50%–150%; position uses 0–1 coordinates within the current monitor's work area. Actions must use the actual animation catalog. Results distinguish started, completed, interrupted and rejected operations. There are no arbitrary scripts, paths, screenshots or unbounded queues.

Other chat plugins can use this presentation layer if they route messages through a DSH session with these tools. StarLite itself sends no QQ/Bilibili messages and provides no platform connector. Existing DSH model calls remain subject to your provider's billing; local playback and communication do not consume tokens. See [network and storage](network-and-storage.en.md).
