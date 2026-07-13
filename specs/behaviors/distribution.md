# Behavior: Distribution and release tracks

## Rule

Every published gitsheets artifact ships from this repo on a prefix-namespaced git-tag track with its own publish workflow, and every workflow authenticates via trusted publishing (OIDC) — no long-lived registry tokens anywhere. Tag prefixes never collide; a tag on one track must never trigger another track's workflow.

## Applies To

- `publish-npm.yml` (`v*`), `core-napi.yml` (`core-napi-v*`), and the Python publish workflow this spec introduces (`py-v*`)
- CLAUDE.md's Releases section (the operator-facing summary of this spec)

## The tracks

| Artifact | Registry | Tag track | Version source |
| --- | --- | --- | --- |
| `gitsheets` (JS lib + CLI) | npm | `v*` via the develop→main Release-PR flow | Release PR title; stamped at publish |
| `@gitsheets/core-napi` (+6 platform packages) | npm | `core-napi-v*` | **Tag-stamped at publish; never pre-committed.** Workspace manifests sync to the released version *after* publish |
| `gitsheets` (Python) | PyPI | `py-v*` | **Committed in `rust/gitsheets-py/Cargo.toml`** (maturin reads it); the tag must match the committed version, and the workflow fails loudly on mismatch |

The three version-source rules differ deliberately; each matches its toolchain's grain. The npm-addon rule and its rationale are recorded in `plans/core-napi-0.2.0-release.md` (learned from the v2.3.0 publish failure).

## Python wheels

- **abi3-py39**: one wheel per platform covers CPython >= 3.9. The wheel matrix is the same platform spread as `core-napi.yml`: manylinux x86_64 + aarch64, musllinux x86_64, macOS x86_64 + arm64, Windows x86_64 — built with `maturin-action`, natively where runners exist, plus an sdist.
- **Ordering rule**: a `py-v*` release must be built from a commit whose `gitsheets-core` passes the cross-binding byte-parity suite against the *same commit's* Node binding — the parity guarantee is the product; a Python release that could disagree with npm's bytes is a defect. In practice: tag only commits where CI is green on `rust-core.yml`.
- **Trusted publishing bootstrap**: unlike npm (which required packages to exist before configuring trusted publishers), PyPI supports **pending publishers** — the publisher is configured on pypi.org before the project exists, and the first workflow publish creates and claims the project name. No manual first upload.

## Release sequencing across tracks

When a batch touches `gitsheets-core`, releases order as: `core-napi-v*` → workspace manifest sync → `v*` (npm). The Python track is independent of the npm sequencing (it builds the core from source at the tagged commit) but follows the same parity gate.

## Principles

- Registry trust is workflow-shaped: OIDC everywhere, no tokens to leak or rotate.
- A release's provenance is its git tag; nothing publishes from a branch tip.
