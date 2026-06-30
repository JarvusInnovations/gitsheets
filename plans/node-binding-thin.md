---
status: planned
depends: [sheet-store-core, canonical-rebaseline, markdown-codec-core, locale-collation-core, markdown-normalize-core]
specs:
  - specs/rust-core.md
  - specs/api/conventions.md
issues: [127]
---

# Plan: re-thin the Node binding over the full core (the cutover)

## Scope

Make the published `gitsheets` npm package a **thin marshalling shell** over
`gitsheets-core`, and retire the JS engine implementation. This is the Node
**cutover**: the moment consumers run on the Rust core end-to-end. **In:** the
`gitsheets-napi` surface, the idiomatic JS API preserved unchanged, the consumer
(Standard Schema) validator hook, error mapping, removal of the now-dead JS
engine, and the live re-baseline. **Out:** Python (parallel plan).

## Implements

- [`specs/rust-core.md`](../specs/rust-core.md) — the thin-binding half of the
  split; "no consumer-visible public-API change" except the deliberate, documented
  bytes re-baseline.
- [`specs/api/conventions.md`](../specs/api/conventions.md) — the public surface is
  preserved exactly.

## Approach

- Wire the public `Repository`/`Sheet`/`Transaction`/`Store` classes to call
  `gitsheets-core` via `gitsheets-napi`, keeping signatures identical.
- Run the **Standard Schema validator** in the binding (native object), before
  marshalling to the core — per the documented write order.
- Map core error variants → the existing typed error classes.
- **Delete** the JS engine (TOML serialize/parse, normalization, path templates,
  validation, query, Sheet/Tx) now that the core owns them; drop `smol-toml`,
  `@iarna`, `ajv` from the JS layer where the core subsumes them.
- Ship the **canonical re-baseline** as part of the cutover (the one
  consumer-visible byte change, documented).

## Validation

- [ ] The **entire** existing gitsheets vitest suite passes against the core-backed
      binding (the no-public-API-change proof).
- [ ] The published `.d.ts` diff is empty — no consumer-visible type change.
- [ ] `/audit-spec-drift` clean against the API + behavior specs.
- [ ] `smol-toml` / `@iarna` / `ajv` removed from the JS layer where superseded;
      no `from 'hologit'` or JS-engine imports remain.
- [ ] Bulk upsert/query benchmarked vs the pre-cutover JS path (expect the core's
      speedup, esp. bulk).

## Risks / unknowns

- **Re-baseline as a consumer-visible change** — the one place the migration breaks
  byte-stability. Document loudly; provide the one-command re-normalize for
  existing repos (from [`canonical-rebaseline`](canonical-rebaseline.md)).
- **The consumer-validator round-trip** (native → core) must not regress validation
  timing or error semantics.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
