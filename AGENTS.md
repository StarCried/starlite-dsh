# DSH Companion project instructions

## Product boundary

- The product is a Windows 11 x64 companion for one DeepSeek Harness process
  running in WSL2. It is not a general desktop-pet framework.
- Keep the Cordis bundle, cross-process protocol, and Tauri desktop app in this
  repository. Reusable Inochi2D/VRM rendering and model preparation stay in Model Companion Web at
  `StarCried/inochi2d-web`.
- Do not add native-Windows DSH, Linux/macOS desktop targets, voice, chat,
  memory, telemetry, auto-update, or per-pixel hit testing without an approved
  scope change.

## Security and privacy

- Bind the status service to IPv4 loopback on an ephemeral port and require the
  in-memory bearer token created for that DSH process.
- The wire may contain only the aggregate state and sanitized model-visible
  reasoning/text. Never send user prompts, tool arguments or results, error
  stacks, file paths, credentials, or session identifiers.
- Render bubble content as plain text. Do not persist or log bubble text or the
  bearer token.
- Treat model archives, deep links, manifests, and status frames as untrusted.
  Invalid inputs fail closed without preventing DSH itself from starting.

## Assets and releases

- Never commit Aka, private StarCried art, Creator projects, or unlicensed
  puppets. Tests use generated artwork-free fixtures.
- A source-only BYOM preview may omit a bundled model. The MicroLight demo
  model requires its own explicit redistribution license before it may enter
  any release artifact.
- Creating a remote repository, pushing, publishing npm, publishing a Windows
  installer, and releasing a model each require separate approval.
- Alpha Windows installers remain unsigned and must document SmartScreen.

## Validation

- Run narrow package tests first, then `pnpm check` and Rust checks.
- Test the packed bundle in an isolated DSH profile and verify fail-open DSH
  behavior when the adapter is incompatible.
- Preserve exact-name animation validation. Disabled mappings stay neutral;
  never introduce an implicit Idle or procedural animation fallback.

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
