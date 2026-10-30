# Dependency maintenance

Run the online dependency gate before a release:

```powershell
pnpm install --frozen-lockfile
cargo install cargo-audit --version 0.22.2 --locked
pnpm check:dependencies
```

`pnpm test:dependency-audit` tests the gate without network requests and is
included in `pnpm test`. The separate `Dependency audit` workflow runs on every
pull request, main push, Monday, and manual dispatch. It retains raw scanner
reports, a sanitized Windows package list, and the decision summary in
`target/dependency-audit` as a 14-day workflow artifact. It does not collect
models, credentials, bubble text, or scanner stderr.

The gate scans the full pnpm and Cargo lockfiles, including non-Windows entries.
It uses neither severity filtering nor ignored RustSec IDs, and never retries
with a stale/offline database. New vulnerabilities or informational warnings,
changed warning kinds/versions, expired exceptions, scanner/network failures,
and incomplete reports fail the check.

## Reviewed baseline: 2026-10-31

| Scan | Result |
| --- | --- |
| `pnpm audit --json` | 173 dependencies, no reported vulnerabilities |
| Full desktop Cargo.lock, cargo-audit 0.22.2 | 500 dependencies, 0 vulnerability entries, 9 unmaintained notices, 1 unsoundness warning |

Happy DOM is updated from 20.11.0 to 21.0.4, including the upstream fix for
[ESM import-alias code execution](https://github.com/advisories/GHSA-834v-8h66-3h79).
It is a development test dependency and is not part of the desktop runtime.

Tokio is updated from 1.53.1 to 1.53.3, the compatible patch for
[RUSTSEC-2026-0386](https://rustsec.org/advisories/RUSTSEC-2026-0386.html).
The advisory concerns Unix `AsyncFd` constructors and I/O unsoundness. Although
the affected API is Unix-specific, the full lockfile is patched rather than
adding another exception. Cargo also resolves four existing Windows dependency
edges to the already installed windows-sys 0.61.2 within their declared ranges;
no new windows-sys version is introduced.

The complete online gate passed against RustSec database
`2295466c4e9df26647fd67d8fa1c705ac2fc7f81`, including the supported Windows
target-graph check. No new advisory exception was added. Raw findings and the
summary remain in the ignored `target/dependency-audit/` directory. These are
point-in-time results; run the online gate again for each release.

The Rust warnings are intentionally visible in the report and summary. The
following narrowly scoped maintenance decisions expire on **2026-11-18**:

| Exact package | RustSec ID | Exposure |
| --- | --- | --- |
| unic-char-property 0.9.0 | [RUSTSEC-2025-0081](https://rustsec.org/advisories/RUSTSEC-2025-0081.html) | Supported Windows graph |
| unic-char-range 0.9.0 | [RUSTSEC-2025-0075](https://rustsec.org/advisories/RUSTSEC-2025-0075.html) | Supported Windows graph |
| unic-common 0.9.0 | [RUSTSEC-2025-0080](https://rustsec.org/advisories/RUSTSEC-2025-0080.html) | Supported Windows graph |
| unic-ucd-ident 0.9.0 | [RUSTSEC-2025-0100](https://rustsec.org/advisories/RUSTSEC-2025-0100.html) | Supported Windows graph |
| unic-ucd-version 0.9.0 | [RUSTSEC-2025-0098](https://rustsec.org/advisories/RUSTSEC-2025-0098.html) | Supported Windows graph |
| proc-macro-error 1.0.4 | [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) | Absent from supported Windows graph |
| zbus_names 4.3.4 | [RUSTSEC-2026-0371](https://rustsec.org/advisories/RUSTSEC-2026-0371.html) | Absent from supported Windows graph |
| zvariant 5.14.0 | [RUSTSEC-2026-0370](https://rustsec.org/advisories/RUSTSEC-2026-0370.html) | Absent from supported Windows graph |
| zvariant_derive 5.14.0 | [RUSTSEC-2026-0372](https://rustsec.org/advisories/RUSTSEC-2026-0372.html) | Absent from supported Windows graph |
| glib 0.18.5 | [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) | Unsoundness warning, absent from supported Windows graph |

The five UNIC notices are **maintenance notices, not reported security
vulnerabilities**. Their active chain is `urlpattern 0.3.0 → tauri-utils 2.9.3 →
Tauri` (including build and runtime dependencies). Replacing these transitive
crates independently of the compatible Tauri chain is not an established fix.

The `glib` notice describes real undefined behavior in iterator implementations;
it is not simply an unmaintained-project notice. Its upstream fix is glib 0.20.0.
It remains in Tauri's cross-platform lockfile but is not part of this product's
Windows build. The other inactive notices similarly remain visible rather than
being globally ignored. Every scan runs `cargo tree --locked --target
x86_64-pc-windows-msvc` and fails if any package with an inactive-platform decision
enters that target graph. This does not authorize Linux/macOS desktop support.

## Maintaining a decision

`tools/dependency-audit-policy.json` pins each warning's ID, package version, kind,
target exposure and review date. No Rust vulnerability exceptions are allowed;
the JavaScript dependency policy currently permits no advisories at all.
Check primary advisories and the current target graph before extending a date.
Prefer a compatible Tauri update and rerun native, packed-install and runtime
checks before deleting resolved entries. Never suppress all `unmaintained` or
`unsound` notices. A service failure is an incomplete audit, not a clean result.
