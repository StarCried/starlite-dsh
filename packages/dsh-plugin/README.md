# dsh-inochi2d-pet

DeepSeek Harness bundle for the Windows **DSH Companion** companion.

This package runs inside DSH under WSL2. It exposes only a short-lived,
token-protected status stream on IPv4 loopback and starts the separately
installed Windows companion through its registered URL protocol.

The alpha supports Windows 11 x64 with one DSH process. It does not send
prompts, tool arguments/results, error details, session identifiers, or paths
across the WSL boundary.

See the repository README for installation and compatibility details.

In DSH Settings, open Plugins → Plugin list → Global, or search `inochi2d-pet`.
The default Plugin configuration tab only shows web configuration cards; the
companion's settings live in its Windows app. Reopen Settings to refresh the list.
The bridge follows DSH's lifecycle. The separate Windows renderer hides on
disconnect, then exits after a 60-second reconnect grace (stalled sockets first
have a 45-second heartbeat timeout). Native Windows DSH is not supported.

The companion can answer ordinary DSH questions (single/multiple selections and
custom text). It claims a question only while its visible input UI is connected;
disconnecting or disabling input returns it to DSH's existing answerer. Each
answer is bounded and bound to one pending request. Tool permission approvals
remain in DSH. The additive status fields carry the session title, fixed activity
code and ephemeral references, never the actual session identity.

Double clicking opens the exact displayed session through DSH's authenticated
local Web UI, or the Web UI home when no session is displayed. Retired or invalid
session references are rejected rather than silently opening a different target.
WSL hands the authenticated URL directly to the browser launcher;
the companion never receives the real identity or browser credentials. The
included Web client consumes a fragment hint after finding the authoritative
session/catalog entry; it never creates a session or sends a prompt.

Click the model to query the official DeepSeek account balance and today's DSH
cost estimate. This supports DSH's default `llm-deepseek` / `deepseek-official`
route and the optional `llm-pi-ai.providers.deepseek` route, using
DSH's credential service; no API key is copied to Windows. Custom gateways or
model-level endpoint/authentication overrides are refused. Requests only query
`GET https://api.deepseek.com/user/balance`, on demand (balance cache: 60 seconds).
No paid model request is made by this feature or its tests.

Configure DeepSeek in DSH's Models page first; the default official route needs
only its API key, with no separate pi-ai profile. The native route honors its
configured endpoint and trusted `DEEPSEEK_BASE_URL` launch override; gateways
never trigger a balance request. If both routes have credentials, the native
route supplies the displayed balance. Missing credentials are reported as
unconfigured and never trigger a network request. Existing stored API keys or credential references are resolved by DSH,
not entered in the companion. A negative balance reported by the provider is
preserved rather than converted to zero.

Today's estimate reads the profile's existing session records through read-only
persistence handles, including records from before a restart. It excludes
fork-inherited events, replaces repeated settlements of the same attempt, and
counts retries separately. Only routes with a verified official endpoint are
included. No extra history or financial ledger is saved. Dates
use Asia/Shanghai. Only official Flash/V4 Pro model IDs listed in the pricing
table are priced; missing usage, unknown models and incomplete reads are shown
explicitly. Reasoning tokens are already included in output tokens.

Models sharing one official account share its balance; requests are priced by
their actual recorded model. The card identifies the selected configuration.
When native and pi-ai routes use different accounts, today's DSH estimate still
covers both eligible routes in this profile, not a per-account bill. Historical
usage cannot be reliably assigned to an account after a credential change.

Prices were verified on 2026-10-10 against the official
[CNY](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) and
[USD](https://api-docs.deepseek.com/quick_start/pricing/) tables. The displayed
range covers off-peak/peak prices, rather than guessing each request's provider
billing time. A separate badge shows the current published tariff period:
09:00–12:00 and 14:00–18:00 Beijing on Monday–Friday, excluding Chinese public
holidays. All other times are off-peak at half price. The offline 2026 calendar
uses the [official holiday schedule](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm);
an unverified year's weekday daytime period is marked unknown. It is a DSH-only
estimate, not the account's official daily bill;
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
