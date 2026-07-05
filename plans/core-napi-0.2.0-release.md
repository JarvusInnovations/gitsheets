---
status: in-progress
depends: []
specs: []
issues: []
---

# Ship @gitsheets/core-napi 0.2.0 and unblock the gitsheets npm release

## Scope

gitsheets v2.3.0's `publish-npm` failed: the workspace napi tests resolve platform binaries from the published `@gitsheets/core-napi` packages (optionalDependencies), which were still 0.1.x — predating #241's core marshal changes, whose tests assert the new error messages. Core changes require a core-napi release before a gitsheets release; this plan ships 0.2.0 and re-cuts the JS package as v2.3.1.

## Implements

Release engineering only; no spec changes.

## Approach

1. Bump `@gitsheets/core-napi` → 0.2.0 (main + 6 platform packages via `napi version`), `packages/gitsheets` dep → `^0.2.0`.
2. Tag `core-napi-v0.2.0` on the bump commit **before** merging — the platform packages must exist on npm for the PR's own `npm ci` to resolve; the tag workflow builds all targets natively from the tagged commit (no registry dependency).
3. After publish: refresh `package-lock.json` against the live 0.2.0 packages, then merge.
4. Re-run the release flow as v2.3.1 (v2.3.0's GitHub release exists; its npm publish never landed — v2.3.1 is the npm release of the same content).

## Validation

- [ ] @gitsheets/core-napi 0.2.0 (+6 platform packages) live on npm
- [x] Local fresh linux-x64-gnu build passes the 108-test napi suite
- [ ] PR CI green with lockfile resolving 0.2.0
- [ ] gitsheets 2.3.1 on npm; `publish-npm` green

## Risks / unknowns

- Trusted-publishing config must already cover all 7 packages (bootstrapped at 0.1.0; assumed intact).

## Notes

Lesson: core-behavior changes must bump/release core-napi in the same batch as the consuming JS release.

## Follow-ups

- Consider a CI guard: fail fast with a clear "release core-napi first" message when workspace napi tests would resolve platform binaries older than the workspace core, instead of a mid-publish test failure.
