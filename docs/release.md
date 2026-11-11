# StarLite for DSH release workflow

One public package (`dsh-starlite`) includes the Windows program. Example VRMs
remain separate downloads. Published artifacts and tags are immutable.
[Current releases](https://github.com/StarCried/starlite-dsh/releases) and
[historical evidence](release-history.md) describe past deliveries; a new release's
`release-manifest.json` identifies exactly what is prepared and verified.

## Record and review changes

```sh
pnpm exec changeset
pnpm release plan
pnpm release version
```

Select only `dsh-starlite`. Changesets owns its version and
[changelog](../packages/dsh-plugin/CHANGELOG.md); the version command synchronizes
workspace/private packages, Tauri and owned Cargo entries. It does not commit.
Review the diff and both packaged READMEs: install commands, released/development
wording and data disclosure. Guides normally use `latest`, avoiding routine number
rewrites. Historical records and compatibility names retain their original versions.

## Prepare a reviewable batch

Requires Windows x64, Node 24, pinned pnpm, Git, Rust/MSVC, WebView2 and cargo-audit
(CI uses 0.22.2; set `CARGO_AUDIT_BIN` for a separate local binary). The shared pin
must be committed and publicly available.

```sh
pnpm release doctor
pnpm release prepare --dry-run
pnpm release prepare --out release-output/candidate
```

Commit reviewed source before real preparation. The command creates new clean DSH
and shared checkouts, installs locked dependencies, rebuilds core/VRM at the pin,
runs existing checks, builds Tauri, stages the tracked public model catalog and
packs the plugin/portable app. It never touches the daily installation.
`--core-source /path/to/starlite` can clone an existing Git checkout; it still checks
out the pin and rebuilds. Existing output directories are not overwritten. Inspect
failed preparations and retry with a new output directory.

The output has `release-manifest.json` and seven public files: npm archive, NSIS,
portable ZIP, `SOURCE_REVISION`, `SHA256SUMS`, SBOM and third-party notices. The
manifest binds version, source SHA, runtime pin, channel and hashes. Model metadata
comes from [the public catalog](../release/default-models.json); program releases do
not modify model files. Public release gates reject private/local model references.

## Publish the same batch

After reviewing the manifest, notes and artifacts, with publication approval:

```sh
pnpm release publish --manifest release-output/candidate/release-manifest.json --dry-run
pnpm release publish --manifest release-output/candidate/release-manifest.json
pnpm release verify --manifest release-output/candidate/release-manifest.json
```

Publish uploads archived bytes, never rebuilds or repacks. Identical published npm
versions and GitHub assets are verified and skipped; differing content or tag targets
fail. Upload all GitHub assets to a draft before publishing, including for immutable
releases. Retries use the same manifest. Do not solve timeouts by repacking or
overwriting a version. Verify anonymously downloads all public artifacts, checks the
channel/source tag and writes `publication-result.json`. Registry propagation can
lag; rerun verify later.

For a real isolated registry installation/lifecycle check, add
`--dsh /path/to/node_modules/@deepseek-ai/dsh` to verify on Windows or WSL2. It reuses
the official DSH smoke test without launching the daily desktop or calling model
APIs. NSIS lifecycle tests run only on isolated GitHub-hosted Windows runners.
Manual DPI/sleep/long tests remain change-dependent and are not implied by CI.

## Workflow and npm OIDC

Dispatch `release.yml` on `main`. It only prepares downloadable artifacts and never
publishes. Review the `prepared-release` artifact, then dispatch `publish.yml` on
`main` with that preparation's `run_id` (the number in its Actions URL). Publication
checks the successful preparation's repository, workflow, branch and source SHA
against the manifest, then waits for the `npm-release` environment. It downloads
that same run's files without rebuilding. Retry with the same `run_id`; artifacts
are retained for 14 days, so retain a local reviewed copy for longer recovery.
Configure required reviewers for that environment. In npm configure the trusted
publisher for `StarCried/starlite-dsh`, workflow `publish.yml`, environment
`npm-release`, allowing `npm publish` and `npm dist-tag`. This is account-side setup
after pushing the workflow, **not already verified by adding the file**.
The workflow uses GitHub-hosted runners, Node 24, npm 11.21.0 (OIDC dist-tag support)
and `id-token: write`,
without persistent npm tokens. [Official setup](https://docs.npmjs.com/trusted-publishers/).

Documentation-only CI returns a lightweight check without native builds. Product,
lockfile, pin and release-tool changes run full checks. Scheduled dependency audits
and upstream DSH checks remain. Windows files are unsigned; do not disable SmartScreen.

After publication, the workflow requires a fresh registry installation and lifecycle
check with official DSH on an isolated Windows runner. WSL2 checks can use the same
verify command locally; this workflow does not claim a new WSL2 GUI or sleep test.

## Historical links

<a id="012-已发布2026-11-11"></a>
<a id="011-npm-已发布2026-11-06"></a>
<a id="010-发行范围2026-11-03"></a>
<a id="历史公开发行-alpha2"></a>
<a id="上次公开发行-alpha1"></a>
<a id="首次发行基线"></a>
<a id="依赖审计记录"></a>

Original publication records and test boundaries remain in [release history](release-history.md).
[Compatibility evidence](dsh-compatibility.md) retains existing anchors; no historical
result is promoted to a newer version.
