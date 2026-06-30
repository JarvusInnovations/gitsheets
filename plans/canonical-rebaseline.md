---
status: planned
depends: [toml-canonical-core]
specs:
  - specs/rust-core.md
  - specs/behaviors/normalization.md
issues: [196]
---

# Plan: canonical-form re-baseline

## Scope

Execute the **one-time, deliberate** canonical-form change that adopting the Rust
serializer implies, and update the spec to match. **In:** amend
`normalization.md` to the new canonical form, provide a re-normalize routine, and
re-baseline this repo's own fixtures/corpora. **Out:** the serializer itself
([`toml-canonical-core`](toml-canonical-core.md)) and migrating *external* repos
(that's each consumer's one-shot, documented here as a recipe).

## Implements

- [`specs/behaviors/normalization.md`](../specs/behaviors/normalization.md) — the
  canonical form is amended (the integer-underscore change, per #196) as the
  spec-first step before any re-baseline.
- [`specs/rust-core.md`](../specs/rust-core.md) — "Canonical-form rebaseline":
  do it while gitsheets effectively has a single user.

## Approach

- **Spec first.** Amend `normalization.md` to state the new canonical form and why
  (link #196), in its own commit, before touching any bytes.
- **Re-normalize routine.** A `git sheet normalize`-style pass (or a one-shot)
  that reads every record, re-serializes via the core, and writes the new
  canonical bytes in a single commit per repo. Idempotent: a second run is a no-op.
- **Re-baseline in-repo.** Apply it to gitsheets' own test fixtures / any sample
  corpora so the suite reflects the new canonical form.
- **Consumer recipe.** Document the one-command re-normalize for external repos.

## Validation

- [ ] `normalization.md` describes the new canonical form; the change is its own
      reviewable commit.
- [ ] The re-normalize routine is idempotent (second run produces no diff).
- [ ] After re-baseline, the core serializer is byte-identical to on-disk for the
      whole corpus (0 diff — the churn is now absorbed).
- [ ] Documented consumer recipe for re-baselining an existing repo in one commit.

## Risks / unknowns

- **Timing vs adoption.** Decision D in the analysis: bundle into the Node cutover
  vs an isolated commit first. This plan does the spec + routine; the
  *cutover-bearing* re-baseline of a live repo is sequenced with
  [`node-binding-thin`](node-binding-thin.md).
- **Surprise churn.** If the parity harness in `toml-canonical-core` missed a
  formatting difference, it shows up here as unexpected diff — fix upstream, not by
  re-normalizing around it.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
