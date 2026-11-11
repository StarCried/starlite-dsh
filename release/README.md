# Release inputs

`starlite.rev` pins the shared source independently of the DSH version.
`default-models.json` contains public URLs, byte counts, SHA-256 and readable
licenses, with no model bytes. It was copied unchanged from the verified 0.1.2
publication inputs. Model terms remain in `docs/`, mirrored from `StarCried/starlite`.
Changing delivery metadata must not silently change those terms.

Only change model references for a separately approved model release, not for a
program version bump. No local paths or mutable URLs. See [the workflow](../docs/release.md).
