# StarLite for DSH

- This repository owns the DSH adapter, protocol and Windows desktop app. Shared
  rendering belongs to `StarCried/starlite`; `release/starlite.rev` pins it.
- Read [engineering constraints](docs/engineering-constraints.md) before changing
  Host lifecycle, native rendering/input, privacy, model import or session tools.
  It preserves the product, security, compatibility and asset rules.
- Preserve the user's daily DSH installation, profiles, models and preferences.
  Use isolated profiles and native identifiers for tests; no paid API tests
  without authorization. Windows-only product scope remains unchanged.
- Keep both `docs/network-and-storage` translations and packaged README disclosures
  aligned with behavior. Do not persist credentials, screen captures, session/bubble
  text or private models.
- Add a Changeset for a user-visible change; only `dsh-starlite` is public here.
  `pnpm release version` synchronizes private/native versions. Do not replace old
  versions or compatibility identifiers throughout the repository.
- [Release workflow](docs/release.md): `pnpm release doctor|plan|version|prepare|publish|verify`.
  Prepare rebuilds the shared pin in a fresh checkout. Publish consumes the exact
  reviewed manifest without repacking. Same published bytes may be retried;
  conflicting content must fail. Tags and published artifacts are immutable.
- Source push, npm/Windows/model release and blog deployment require authorization.
  Workflow/OIDC configuration alone is not proof it was enabled or exercised.
  Record verification evidence and its limits accurately.
- Run focused tests and appropriate checks. Do not rerun native builds for prose
  changes or call historical manual checks a fresh full validation.
- Keep commits focused; follow the current task's commit/push instructions.
