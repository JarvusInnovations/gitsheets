---
status: in-progress
depends: [toml-canonical-core, definition-logic-core]
specs:
  - specs/rust-core.md
  - specs/behaviors/patch-semantics.md
issues: [127]
---

# Plan: record engine in the core — CRUD + diff/patch (the substrate seam)

## Scope

The record read/write layer in `gitsheets-core`, composed from the bytes-authority
(`canonical`) + definition-logic (`path_template`, `validation`) layers below it,
and the first consumer to **wire holo-tree into `gitsheets-core`**. **In:** record
read/write/delete/list over holo-tree blobs and the core `Value`, plus diff + patch
(RFC 7396 / 6902) semantics. **Out:** query traversal/filtering + secondary
indexing (split into [`record-query-index`](record-query-index.md) per this plan's
original scope-creep note), the `Sheet`/`Transaction`/`Store` orchestration
([`sheet-store-core`](sheet-store-core.md)), and the bindings.

> **Split note.** This plan originally bundled query + index too; per its own
> "split before starting" risk, those moved to `record-query-index` (depends on
> this). This plan lands the substrate seam (CRUD over holo-tree) and diff/patch
> cleanly first; query/index build on it.

## Implements

- [`specs/rust-core.md`](../specs/rust-core.md) — record CRUD and "diff + patch" in
  the core, over the holo-tree substrate.
- [`specs/behaviors/patch-semantics.md`](../specs/behaviors/patch-semantics.md) —
  re-implemented behavior-preserving in Rust.

## Approach

- **Wire holo-tree.** Add the holo-tree Cargo git dependency to `gitsheets-core`
  (the form decided in `gitsheets-core-foundation`: a git dep on the hologit repo).
  This is the first plan that needs tree ops — confine the engine's thread model as
  holo-tree's thread-local cache requires.
- **Record CRUD.** read (tree blob → parse), write (render path + normalize +
  serialize + tree write), delete, list — over holo-tree blobs and the core
  `Value`. Batch-first signatures.
- **Diff / patch.** record-level diff (gix diff, replacing `git.diffTree`) and the
  RFC 7396 / 6902 patch semantics in Rust.

## Validation

- [ ] CRUD round-trips records byte-identically to the (re-baselined) on-disk form.
- [ ] Diff + patch outputs match the JS `Sheet.diffFrom` / patch behavior on a
      fixture corpus.
- [ ] holo-tree is wired and exercised (a write produces the expected tree/blob).
- [ ] `cargo build/test` + clippy clean; napi boundary suite passes; the main JS
      suite stays green and independent.

## Risks / unknowns

- **gix diff fidelity** vs `git diffTree` for record-level diffs — parity-check.
- **The read-heavy perf headroom** (hologit#464: per-call `to_thread_local`,
  object cache, per-read clone) first surfaces here — measure and feed back
  upstream (the bulk benchmark itself is in `record-query-index`).

## Inbound deferrals to absorb

- From [`toml-canonical-core`](toml-canonical-core.md): parse/serialize currently
  map TOML failures to `Error::ConfigInvalid`. Now that records flow through the
  engine, decide whether a **record-specific parse error code** is warranted; if
  so it's a spec change to [`errors.md`](../specs/api/errors.md) owned here.
- From [`definition-logic-core`](definition-logic-core.md): **datetime-for-validation
  marshalling** — how a datetime-typed field is presented to shape-validation
  (string vs `Date`) is settled now that the engine owns the write path.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
