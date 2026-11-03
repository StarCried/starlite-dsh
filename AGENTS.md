# StarLite for DSH project instructions

## Product boundary

- The product is a Windows 11 x64 companion for one DeepSeek Harness Host:
  WSL2 CLI/Web, native Windows CLI/Web, or the official Windows Desktop app.
  It is not a general desktop-pet framework. Do not silently replace a live
  Host connection when another profile or installation starts.
- An explicit `host-stopped` terminal event on the authenticated current SSE
  stream releases ownership immediately and adopts the first queued successor.
  Unexpected EOF/errors retain the 60-second lease; disconnected arrivals queue
  silently, and only a live connected Host conflict warns. Never infer shutdown
  from a timeout. Pause the retained renderer while offline and reuse it on
  reconnect instead of remounting the model.
- Keep the Cordis bundle, cross-process protocol, and Tauri desktop app in this
  repository. Reusable Inochi2D/VRM rendering and model preparation stay in the
  StarLite component repository (`StarCried/starlite`). Local checkout paths use
  `starlite` and `starlite-dsh`. The GitHub repositories have been renamed to
  `StarCried/starlite` and `StarCried/starlite-dsh` with user approval.
  Pushing source and publishing releases require explicit user approval.
- Do not add Linux/macOS desktop targets, remote Hosts, voice, chat,
  memory, telemetry, or auto-update without an approved
  scope change.
- Model-only alpha hit testing and transparent background passthrough are approved.
  Keep cursor coordinates in memory; do not log or transmit desktop input.
- Optional environment lighting samples at most eight 12x12 visible patches
  outside the main window, at most four times a second. Native sampling must
  respect the native enabled preference and stop when paused, hidden or on a secure
  desktop. Return only reduced RGB, never pixels; do not write captures, upload
  them, hide the pet to sample, or exclude it from other applications' recordings.
  New or omitted strength settings default to 1.0 (100%), with a 0–2 range;
  preserve explicit saved strengths and disabled choices. New or omitted enabled
  settings default to true; the user approved default-on environment lighting.
- Keep `docs/network-and-storage.md` and the packaged README's download disclosure
  aligned with bootstrap, billing and launcher behavior. External directories may
  compare static call-pattern scans with runtime events; do not invent unsupported
  DSH permission fields or change request timing merely to avoid those scans.
- Bubble placement uses the runtime's cached reference-pose `getBubbleAnchor()`
  in host CSS pixels (no DPR or canvas padding). Reproject after resize, clear on
  model replacement, and never resize the native window from animated bounds.
- Resolve UI locale from the native Windows display language before importing
  label modules; pass it explicitly to shared controls and VRM. Translate only
  application-owned text, never session content or arbitrary model metadata.
  Translate known example terms only when both model ID and canonical text match.

## Security and privacy

- Bind the status service to IPv4 loopback on an ephemeral port and require the
  in-memory bearer token created for that DSH process.
- The wire may contain only the aggregate state and sanitized model-visible
  reasoning/text. Never send user prompts, tool arguments or results, error
  stacks, file paths, credentials, or session identifiers.
- User-authorized companion interactions additionally allow the session title,
  fixed activity codes, ephemeral random references, structured user questions
  and their explicit answers. Keep real session identities and Web credentials
  in the DSH Host (WSL or Windows), never in the companion. Answers must target
  one still-pending request; do not add general
  agent control or intercept tool permission approvals.
- Render bubble content as plain text. Do not persist or log bubble text or the
  bearer token.
- Login-account billing consumes only `deepseekAccount.getState/getBalance/watch`.
  Never resolve account tokens or parse credential files. Keep recharge and bonus
  wallets separate, and never reuse API prices for account charges. Credential
  changes must invalidate both cached and pending results, including same-status
  account switches. Account queries need a dedicated timeout beyond the official
  30-second balance request; navigation and question deadlines remain unchanged.
- Treat VRM files, deep links, manifests, and status frames as untrusted.
  Invalid inputs fail closed without preventing DSH itself from starting.

## Assets and releases

- Never commit Aka, private StarCried art, Creator projects, or unlicensed
  puppets. Tests use generated artwork-free fixtures.
- Program releases include the approved default humanoid Idle and three optional
  generic gestures (CuriousPeek, HappyWave, SleepyStartle).
  Preserve its recorded provenance; its breathing layer comes from Warudo,
  so do not describe the motion as wholly original. Weiguang uses its own
  license and stays in a separately delivered, self-contained VRM, never in
  program artifacts. Other model artwork and unapproved motions stay out of the program.
  The gestures live in the shared runtime; native catalogs add them to existing
  imports without altering mappings or creating per-model motion files. Preserve
  the recorded Warudo upper-body source for HappyWave.
  When a program motion's duration changes, update the shared and native
  catalogs together. Migrate only known previous durations on settings load;
  keep mappings/resources unchanged and still reject malformed catalog values.
- Creating a remote repository, pushing, publishing npm, publishing a Windows
  installer, and releasing a model each require separate approval.
- Windows installers currently remain unsigned, including 0.1.0; document SmartScreen without asking users to disable system protections.
- Default examples remain separate VRMs. The launcher accepts legacy schema 2
  Weiguang descriptors and schema 3 metadata catalogs with `weiguang-default`
  and optional `bluefish-default`; acquire only the selected ID. Never add an
  unverified URL/hash to make an unavailable example appear in settings.
  Catalog licenses must be readable without downloading model bytes. The model
  terms in `docs/` mirror the same documents in the StarLite component repository;
  keep those texts synchronized without changing the program's BSD license.
- Acquisition must mirror native `needs_default`: a selected example already
  present in the user's model library needs no download. Program cache keys
  include the EXE hash, so checking that cache alone causes needless downloads
  and a 30-second launch delay after upgrades when GitHub is unavailable.
  Keep model path/content validation in the native loader; the Host only reads
  the bounded selection/library metadata and does not follow model paths.

## Validation

- Run narrow package tests first, then `pnpm check` and Rust checks.
- Test the packed bundle in an isolated DSH profile and verify fail-open DSH
  behavior when the adapter is incompatible.
- Native GUI acceptance uses `tauri build --no-bundle`; plain `cargo build
  --release` can retain the development URL instead of embedded frontend assets.
  For isolated native acceptance, override the Tauri identifier in a local-only
  build config; changing APPDATA/USERPROFILE is not a reliable Windows Known
  Folder or single-instance boundary. Never replace the daily companion instance.
- Preserve exact-name animation validation. Disabled mappings stay neutral.
  Model-only onboarding directly imports standard humanoid VRM 0/1 files.
  Blink and eye tracking are optional capabilities; missing bindings disable
  the corresponding behavior without rejecting an otherwise valid model.
  Declared bindings must still reference valid resources. The bundled StarLiteIdle provides baseline
  standing and breathing when the model has no Idle. List embedded standard
  glTF motions and the three program gestures for optional mappings; never
  invent missing event actions or automatically replace existing user choices.
  Do not restore the retired custom ZIP resource-pack format or import UI.
- `extras.starlite.adjustments` seeds a new import's model-local settings only.
  Validate it with `ModelAdjustments`; never reapply it on load, selection or
  upgrade, because clearing saved adjustments intentionally restores the program
  baseline. Pose values directly calibrate `StarLiteIdle`, without rewriting
  mappings. The runtime's three generated gestures rebase to the selected Idle
  reference pose, including calibration; model-authored or imported clips are
  not rebased. Animated forearms and fingers retain their authored gesture
  shape between corrected entry and exit poses.

## Commit discipline

- Treat the protocol, DSH bundle, desktop webview, native Tauri backend,
  reusable runtime integration, tests, and documentation/release tooling as
  separate modules.
- After completing and validating one module, commit that module before
  starting the next. Keep each commit focused and include the module's tests
  and documentation updates with the implementation they verify.
- Do not combine unrelated modules in one catch-all commit, manufacture empty
  commits, or rewrite already published history merely to reach a commit-count
  threshold.
