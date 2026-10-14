# StarLite for DSH project instructions

## Product boundary

- The product is a Windows 11 x64 companion for one DeepSeek Harness Host:
  WSL2 CLI/Web, native Windows CLI/Web, or the official Windows Desktop app.
  It is not a general desktop-pet framework. Do not silently replace a live
  Host connection when another profile or installation starts.
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
- Treat VRM files, deep links, manifests, and status frames as untrusted.
  Invalid inputs fail closed without preventing DSH itself from starting.

## Assets and releases

- Never commit Aka, private StarCried art, Creator projects, or unlicensed
  puppets. Tests use generated artwork-free fixtures.
- Program releases include only the approved default humanoid Idle motion.
  Preserve its recorded provenance; its breathing layer comes from Warudo,
  so do not describe the motion as wholly original. Weiguang uses its own
  license and stays in a separately delivered, self-contained VRM, never in
  program artifacts. Other model artwork and motions stay out of the program.
- Creating a remote repository, pushing, publishing npm, publishing a Windows
  installer, and releasing a model each require separate approval.
- Alpha Windows installers remain unsigned and must document SmartScreen.

## Validation

- Run narrow package tests first, then `pnpm check` and Rust checks.
- Test the packed bundle in an isolated DSH profile and verify fail-open DSH
  behavior when the adapter is incompatible.
- Preserve exact-name animation validation. Disabled mappings stay neutral.
  Model-only onboarding directly imports standard humanoid VRM 0/1 files with
  usable blink morph bindings. The bundled StarLiteIdle provides baseline
  standing and breathing when the model has no Idle. List embedded standard
  glTF motions for optional mappings; never invent missing event actions.
  Do not restore the retired custom ZIP resource-pack format or import UI.

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
