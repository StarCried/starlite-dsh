# Model components

The native model service accepts Inochi2D `.inp` or self-contained VRM 0/1
`.vrm` files. VRM animations are explicitly selected external `.vrma` files;
expressions alone do not become animation choices. A data-only Weiguang profile
is optional. Neither model nor profile code is executed during inspection.

`inspect_model` accepts `path`, optional `animationSources` (`name`, `path`), and
optional `profilePath`. The response includes `backend` and a common animation
catalog containing only `name` and `durationMs`. Inochi2D track data and VRM
resource paths remain in their respective backend payloads.

The settings format is version 3. Reading version 1 migrates its model to the
Inochi2D backend, preserves its exact mappings and preferences, and retains the
authored tracks under `model.inochi2d.animations`. The next successful save writes
version 3. Version 2 migrates the former Thinking mapping into Working and turns
click/ambient choices into arrays. Unsupported settings versions fail validation.

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
`release/model-companion-web.rev` pins all JavaScript components; the unchanged native
preparation library has its own `release/inochi2d-pipeline.rev` pin. New runtime
commits remain local until separately approved for publication; CI checkout
requires that publication before this branch can run remotely.

## Desktop selection

The default pet window is 320 × 480 CSS pixels, two thirds of its previous
480 × 720 dimensions. The renderer fills the window with the same portrait
framing; the settings window keeps its existing size.

Choose `.inp` or `.vrm` in settings. VRM accepts a separate selection of VRMA
files (exact file stems become action names) and an optional data-only character
profile. Standard VRM has no Weiguang-specific behavior. Idle must be explicitly
selected, even when an action named Idle exists. New untouched VRM preferences
start at 30 FPS / DPR 1.5; existing preferences are preserved. A failed inspection
or save leaves the installed component intact. Runtime mounts use the shared
cancellation slot; old requests and late controllers cannot replace a new model.

Only the explicitly selected Idle animation loops. Working (including Thinking),
Blocked, Approval, Completed and Error play once and return to that Idle. An Idle
snapshot cannot truncate an unfinished gesture. A different non-idle state
immediately replaces the previous gesture; approval, blocked and outcome
notifications never wait behind an obsolete work animation. Late completions
from replaced gestures cannot restore Idle or overwrite the current state.
Click and occasional idle gestures have lower priority: work states interrupt
them, and clicks cannot interrupt work, entry or another response. Logical busy
states continue blocking clicks even after their gesture has returned to Idle.
Disabled mappings explicitly stop playback and remain neutral. Disconnect and
mapping changes cancel pending completions and clear ambient timers.
The VRM component receives the selected Idle as its explicit return clip, so
completion blends directly into Idle without rendering a neutral frame first.
Its portrait framing and bounded pointer gaze match the local review page.

## Mouse interaction

The main pet window accepts bounded `set_model_viewport` geometry from the VRM
renderer. A 320 × 480 logical model area can acquire transparent canvas margins;
native resizing offsets the window by the padding difference at its current
DPI, preserving the character's screen anchor. Resizing clears obsolete model
and bubble coverage and rebases an active drag instead of cancelling it. A null
viewport restores the logical window. Settings windows cannot invoke this
command; no additional window permissions or desktop-input logging are needed.

The desktop accepts clicks and drag starts only on the rendered model silhouette.
The native window polls the global cursor and switches transparent background
areas to mouse passthrough, including transparent gaps inside the model and the
non-interactive bubble. Masks contain bounded alpha coverage bits, not screenshots.
CSS-to-physical coordinate conversion handles DPI and window size changes.
Holding the primary button on a model keeps capture until release; a press on
the background cannot steal a drag from the application underneath. The tray's
mouse passthrough toggle overrides silhouette interaction. Cursor coordinates
stay in memory and are used only for the renderer's bounded gaze tracking.
The hidden window stops cursor/mask processing until it becomes visible again.
Drag movement uses a captured physical cursor/window origin and coalesced
position updates, including the final movement before mouse release. It does
not rely on an asynchronous system move-loop starting while the button is held.

## Local validation (2026-10-05)

The desktop frontend passes 56 tests and `pnpm check`. Native format, Clippy,
17 ordinary tests and the isolated release build pass. The ignored private
companion import check was run separately: 12 desktop and 8 blog motions pass.
The packed DSH bundle was installed in the separate `vrm-local-validation`
profile; the installed DSH 0.1.5-rc.1 exposes the existing protocol contracts.
Invoking the packed plugin with an incompatible event subscription returns a
no-op disposer and contains the failure. No real session prompt was submitted.

The reusable runtime's full workspace validation and browser regression pass.
VRM Hexo checks cover deferred loading, mobile zero model/runtime requests,
20 PJAX completions without duplicate instances, and visible static fallback.
Private character testing covers all 20 selected clips, 20 mounts/destroys and
15 minutes in both embedded Chromium and standalone WebView2. Silhouette
coverage, bounded gaze outside the window, pause/resume and destruction checks
pass at 30 and 60 FPS. The desktop's five interaction unit tests cover alpha
holes, DPI mapping, drag capture, background presses and physical drag origins.
Actual native mouse passthrough and dragging remain subject to manual acceptance:
the automation target precheck rejects a passthrough window before moving its
cursor. Edge control remains unavailable; the user explicitly waived that test.
The current native test source emits Idle only and makes no model API requests.
WebView2 measurements are from the isolated test process tree.
No model was installed into the user's existing desktop settings.

VRM movement-sensitive physics uses the optional public `setHostPosition(x, y)`
capability. The desktop forwards window positions in CSS pixels; the renderer
feeds bounded world movement to imported spring bones and removes that movement
before drawing. Coordinates stay local and are cleared on pause/destruction.
Inochi2D retains its existing authored physics behavior.
