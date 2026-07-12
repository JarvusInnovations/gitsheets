---
status: planned
depends: []
specs:
  - specs/behaviors/distribution.md
  - specs/api/python-binding.md
issues: [255]
---

# Publish the Python binding to PyPI

## Scope

Take `rust/gitsheets-py` from builds-in-CI to `pip install gitsheets`: the `py-v*` publish workflow (abi3 wheel matrix + sdist, trusted publishing via a PyPI pending publisher), the version-match guard, a consumer-facing README, and the CLAUDE.md Releases third track. First tag rides when the release train un-pauses.

## Implements

- `specs/behaviors/distribution.md` (the `py-v*` track, wheel matrix, parity ordering rule, pending-publisher bootstrap)
- `specs/api/python-binding.md` (the 0.x supported surface and its honestly-documented gaps)

## Approach

1. `python-publish.yml` (or fold into `rust-core.yml` family): `py-v*` tag trigger; maturin-action builds — manylinux x86_64 + aarch64 (native runners), musllinux x86_64, macOS x86_64 + arm64, Windows x86_64 — plus sdist; a guard step fails the run if `rust/gitsheets-py/Cargo.toml` version != tag; publish via `pypa/gh-action-pypi-publish` with OIDC.
2. Configure the pending publisher on pypi.org for project `gitsheets` → this repo + this workflow (one-time, manual, Chris's PyPI account).
3. README pass on `rust/gitsheets-py/README.md`: install, quick start (transact/upsert), the parity guarantee as the headline, the #240 gaps stated plainly, version/track note.
4. CLAUDE.md Releases: add the `py-v*` track with its committed-version rule (deliberately different from the npm addon's tag-stamped rule — cite the spec).
5. On release-train resume: set `Cargo.toml` version 0.1.0 (if not already), tag `py-v0.1.0` from a rust-core-green develop commit, watch the publish, verify `pip install gitsheets` cold.

## Validation

- [ ] Workflow builds all six wheels + sdist green on a dry-run (workflow_dispatch, publish skipped)
- [ ] Version-mismatch guard proven (deliberate mismatch fails)
- [ ] Pending publisher configured (manual step recorded here when done)
- [ ] `py-v0.1.0` published; `pip install gitsheets` works on a clean machine; import + a transact round-trip succeeds
- [ ] CLAUDE.md documents the track

## Risks / unknowns

- PyPI name squatting between now and first publish (name verified free 2026-07-12; the pending publisher can be configured immediately to reduce the window).
- aarch64 manylinux runner availability/cost; fall back to QEMU cross-build via maturin-action if needed.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
