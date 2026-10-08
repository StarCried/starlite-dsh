# dsh-inochi2d-pet

DeepSeek Harness bundle for the Windows **DSH Companion** companion.

This package runs inside DSH under WSL2. It exposes only a short-lived,
token-protected status stream on IPv4 loopback and starts the separately
installed Windows companion through its registered URL protocol.

The alpha supports Windows 11 x64 with one DSH process. It does not send
prompts, tool arguments/results, error details, session identifiers, or paths
across the WSL boundary.

See the repository README for installation and compatibility details.

The companion can answer ordinary DSH questions (single/multiple selections and
custom text). It claims a question only while its visible input UI is connected;
disconnecting or disabling input returns it to DSH's existing answerer. Each
answer is bounded and bound to one pending request. Tool permission approvals
remain in DSH. The additive status fields carry the session title, fixed activity
code and ephemeral references, never the actual session identity.

Double clicking opens the exact displayed session through DSH's authenticated
local Web UI. WSL hands the authenticated URL directly to the browser launcher;
the companion never receives the real identity or browser credentials. The
included Web client consumes a fragment hint after finding the authoritative
session/catalog entry; it never creates a session or sends a prompt.

Click the model to query the official DeepSeek account balance and today's DSH
cost estimate. This uses the existing `llm-pi-ai.providers.deepseek` route and
DSH's credential service; no API key is copied to Windows. Custom gateways or
model-level endpoint/authentication overrides are refused. Requests only query
`GET https://api.deepseek.com/user/balance`, on demand (balance cache: 60 seconds).
No paid model request is made by this feature or its tests.

Configure the official `deepseek` route in DSH's Models page first; an empty
provider profile is reported as unconfigured and never triggers a network
request. Existing stored API keys or credential references are resolved by DSH,
not entered in the companion. A negative balance reported by the provider is
preserved rather than converted to zero.

Today's estimate reads the profile's existing session records through read-only
persistence handles, including records from before a restart. It excludes
fork-inherited events, replaces repeated settlements of the same attempt, and
counts retries separately. No extra history or financial ledger is saved. Dates
use Asia/Shanghai. Only official Flash/V4 Pro model IDs listed in the pricing
table are priced; missing usage, unknown models and incomplete reads are shown
explicitly. Reasoning tokens are already included in output tokens.

Prices were verified on 2026-10-08 against the official
[CNY](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) and
[USD](https://api-docs.deepseek.com/quick_start/pricing/) tables. The displayed
range covers off-peak/peak prices, rather than guessing provider billing time or
holidays. It is a DSH-only estimate, not the account's official daily bill;
unfinished requests and other apps are not included. Review the table before
each release. Scans are bounded to 512 sessions, 16 MiB per session and 100,000
events per session; hitting a limit reports a partial estimate. Unsupported
credential/persistence services affect only the fee query, never DSH startup.

No prebuilt companion or npm package is published yet. For the current BYOM
source preview, build and install the Windows companion and packed bundle using
the repository development guide. After a prebuilt alpha is published, install
the unsigned Windows companion first, then in WSL2:

```bash
npm install -g --prefix "$HOME/.local" @deepseek-ai/dsh@latest
export PATH="$HOME/.local/bin:$PATH"
dsh plugin --profile web add dsh-inochi2d-pet@latest
dsh --profile web --dump-config
dsh web
```

If the Windows app is missing or a developer-preview DSH update changes the
required event contract, this bundle disables only the companion and lets DSH
continue. The bundle has no reverse API for controlling DSH.
