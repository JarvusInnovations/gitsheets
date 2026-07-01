---
status: done
pr: https://github.com/JarvusInnovations/gitsheets/pull/206
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

- [x] `normalization.md` describes the new canonical form **including all three
      reformat classes**; the change is its own reviewable commit
      (`docs(specs): rebaseline normalization.md to the Rust canonical form`).
- [x] The re-normalize routine is idempotent (second run produces no diff —
      demonstrated below).
- [x] After re-baseline, the core serializer is byte-identical to on-disk for the
      fixtures touched (the re-normalized inputs match the goldens exactly);
      no live corpus exists in-repo to re-base (see Notes).
- [x] Documented consumer recipe for re-baselining an existing repo in one commit
      (in `normalization.md`).
- [x] `cargo build --workspace` + `cargo test` green; `npm run type-check`,
      `npm run build`, `npm test` green (gitsheets 287/287, gitsheets-axi 66/66).

## Risks / unknowns

- **Timing vs adoption.** Decision D in the analysis: bundle into the Node cutover
  vs an isolated commit first. This plan does the spec + routine; the
  *cutover-bearing* re-baseline of a live repo is sequenced with
  [`node-binding-thin`](node-binding-thin.md).
- **Surprise churn.** If the parity harness in `toml-canonical-core` missed a
  formatting difference, it shows up here as unexpected diff — fix upstream, not by
  re-normalizing around it.

## Notes

**Spec change (the headline deliverable).** `specs/behaviors/normalization.md` now
defines the canonical bytes by the Rust core serializer
(`gitsheets-core::canonical::serialize` — the `toml` crate's default formatting
over a deep-key-sorted value) instead of `@iarna/toml`. It documents **all three**
value-preserving reformat classes (#196 predicted only the first; the
[PR #205](https://github.com/JarvusInnovations/gitsheets/pull/205) corpus run over
all 29,556 records — 0 data-loss / 0 non-idempotent / 0 parse errors — proved that
incomplete):

1. **Integer digit-group underscores dropped** (`31_618` → `31618`) — dominant,
   originally-predicted class.
2. **String requote** — a string holding both `"` and `'` moves from `@iarna`'s
   escaped single-line basic string to the `toml` crate's readable `"""…"""`.
3. **Multiline trailing-quote layout** — a multiline string ending in `"` uses
   adjacent quotes before the delimiter (`…UAE""""`) vs `@iarna`'s
   `\`-line-continuation.

The spec also gained a *v1.0 substrate note* (Node still emits `@iarna` bytes; the
live cutover is `node-binding-thin`) and a one-command consumer re-normalize
recipe. Committed alone, spec-first.

**Re-normalize routine.** `rust/gitsheets-core/examples/normalize_tree.rs` — a
minimal one-shot reusing only the existing public canonical API (no new workspace
deps, no new `lib.rs` modules, no edits to `canonical.rs`/`value.rs`/`error.rs`),
so it merges cleanly alongside the sibling `definition-logic-core` work. It walks a
directory, re-serializes every `.toml` in place, and guards against data loss
(refuses to write if the fresh bytes don't re-parse to the same value).

**Idempotence demonstration.** Over copies of the committed parity fixtures:

- Pass 1 over the OLD `@iarna` `*.input.toml` bytes → re-normalized exactly the 3
  divergent fixtures (one per class) and left the 2 already-canonical ones; the
  results were **byte-identical to the `*.expected.toml` goldens**.
- Pass 2 over the same dir → **0 files re-normalized** (idempotent fixpoint).
- A pass over the already-canonical `*.expected.toml` copies → **0 changes**.

**Re-baselined vs deferred.**

- *Re-baselined in-repo: nothing* — the repo holds **no gitsheets-record corpora**
  to re-base. The only on-disk `.toml` are `.holo/*` (hologit holomapping config,
  not gitsheets records, not under the canonical-serialization regime) and the
  rust parity fixtures.
- *Deferred (with reason):*
  - `rust/gitsheets-core/tests/fixtures/*.input.toml` — intentionally hold the OLD
    `@iarna` bytes as parity input; the paired `*.expected.toml` goldens are
    already the new canonical form. Re-basing the inputs would defeat the harness.
  - The **main JS suite's** inline TOML expectations — the v1.0 Node substrate
    still serializes via `@iarna/toml`, so its round-trip expectations remain
    correct against `@iarna`. Re-baselining anything the JS suite compares against
    `@iarna` output now would break the green suite; that is the live cutover,
    sequenced with `node-binding-thin`.

**JS suite stayed green** — no JS test was weakened to accommodate a premature
re-baseline (a hard requirement): gitsheets 287/287, gitsheets-axi 66/66.

## Follow-ups

- **Deferred to `node-binding-thin`:** the live-repo *cutover* re-baseline — swap
  the Node serializer from `@iarna/toml` to the core serializer and run the
  one-time `normalize_tree` commit over a real repo, then re-base the JS suite's
  inline TOML expectations onto the new canonical bytes. That closes the bounded,
  documented spec↔substrate drift this plan records.
- **None** for the spec/routine themselves — the three reformat classes are
  enumerated and proven, and the routine is idempotent.
