# Model components

The native model service accepts Inochi2D `.inp` or self-contained VRM 0/1
`.vrm` files. VRM animations are explicitly selected external `.vrma` files;
expressions alone do not become animation choices. A data-only Weiguang profile
is optional. Neither model nor profile code is executed during inspection.

`inspect_model` accepts `path`, optional `animationSources` (`name`, `path`), and
optional `profilePath`. The response includes `backend` and a common animation
catalog containing only `name` and `durationMs`. Inochi2D track data and VRM
resource paths remain in their respective backend payloads.

The settings format is version 2. Reading version 1 migrates its model to the
Inochi2D backend, preserves its exact mappings and preferences, and retains the
authored tracks under `model.inochi2d.animations`. The next successful save writes
version 2. Unsupported settings versions fail validation.

VRM import validates bounded GLB containers, buffer/accessor ranges, sparse
indices, node hierarchies, required humanoid bones, animation timelines and
profile references. External glTF URIs and unsupported required codecs are
rejected. Limits are 64 MiB per model, 16 MiB per motion, 64 MiB total motions,
64 named motions and 1 MiB per profile. The renderer validates again before use.

All sources are read before installation; exact-name mappings (including an
explicit Idle) must validate before any settings replacement. Installed assets
receive generated local filenames inside the existing application model
directory. An invalid source or failed settings commit leaves the old model
selected. The DSH status protocol and installation identity are unchanged.

Run native unit tests with `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.
The ignored private-bundle test is opt-in: set `DSH_PET_VRM_ASSETS` to the local
companion output directory and run `cargo test --manifest-path
apps/desktop/src-tauri/Cargo.toml private_companion_bundles -- --ignored`.
No private assets are required or copied into this repository's test fixtures.

## Runtime staging

`pnpm sync:runtime -- <inochi2d-web dist>` stages core, Inochi2D and VRM
from the same checkout, including hashes and license texts. Build core before
Inochi2D and VRM upstream. Only the selected renderer is imported.
`release/inochi2d-web.rev` pins all JavaScript components; the unchanged native
preparation library has its own `release/inochi2d-pipeline.rev` pin. New runtime
commits remain local until separately approved for publication; CI checkout
requires that publication before this branch can run remotely.

## Desktop selection

Choose `.inp` or `.vrm` in settings. VRM accepts a separate selection of VRMA
files (exact file stems become action names) and an optional data-only character
profile. Standard VRM has no Weiguang-specific behavior. Idle must be explicitly
selected, even when an action named Idle exists. New untouched VRM preferences
start at 30 FPS / DPR 1.5; existing preferences are preserved. A failed inspection
or save leaves the installed component intact. Runtime mounts use the shared
cancellation slot; old requests and late controllers cannot replace a new model.

## Local validation (2026-09-20)

The desktop frontend passes 44 tests and `pnpm check`. Native format, Clippy,
10 ordinary tests, both private companion import checks and a debug build pass.
The packed DSH bundle was installed in the separate `vrm-local-validation`
profile; the installed DSH 0.1.5-rc.1 exposes the existing protocol contracts.
Invoking the packed plugin with an incompatible event subscription returns a
no-op disposer and contains the failure. No real session prompt was submitted.

The reusable runtime's full workspace validation and browser regression pass.
VRM Hexo checks cover deferred loading, mobile zero model/runtime requests,
20 PJAX completions without duplicate instances, and visible static fallback.
Private character testing covers eight animations, 20 mounts/destroys and
15 minutes in both embedded Chromium and standalone WebView2. Independent
Windows Chrome/Edge and a live DSH-to-desktop user session still need manual
acceptance; WebView2 measurements are from the separate preview process tree.
No model was installed into the user's existing desktop settings.
