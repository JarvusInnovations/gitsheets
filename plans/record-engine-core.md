---
status: planned
depends: [toml-canonical-core, definition-logic-core]
specs:
  - specs/rust-core.md
  - specs/behaviors/indexing.md
  - specs/behaviors/patch-semantics.md
issues: [127]
---

# Plan: record engine in the core — CRUD, query, index, diff/patch

## Scope

The record-level data engine in `gitsheets-core`, composed from the bytes-authority

+ definition-logic layers below it. **In:** record read/write/list, query
traversal + filtering, secondary indexing, and diff + patch semantics — all over
the core `Value` and the holo-tree substrate. **Out:** the `Sheet`/`Transaction`/
`Store` orchestration on top (that's [`sheet-store-core`](sheet-store-core.md)) and
the bindings.

## Implements

+ [`specs/rust-core.md`](../specs/rust-core.md) — "Query traversal + filtering;
  secondary indexing; diff + patch" in the core.
+ [`specs/behaviors/indexing.md`](../specs/behaviors/indexing.md),
  [`specs/behaviors/patch-semantics.md`](../specs/behaviors/patch-semantics.md) —
  re-implemented behavior-preserving in Rust.

## Approach

+ **Record CRUD.** read (parse), write (render path + normalize + serialize + tree
  write), delete, list — over holo-tree blobs and the core `Value`.
+ **Query.** traversal of the data tree + native filtering (declarative predicates
  in Rust; the embedded-engine escape-hatch for arbitrary predicates). Batch-first
  (`queryAll` crosses once).
+ **Indexing.** secondary indices built natively; lazy or persisted (the persisted
  variant is a deferred option — keep the door open).
+ **Diff / patch.** record-level diff (gix diff, replacing `git.diffTree`) and the
  RFC 7396 / 6902 patch semantics in Rust.

## Validation

+ [ ] CRUD round-trips records byte-identically to the (re-baselined) on-disk form.
+ [ ] Query results (and filter semantics, incl. an escape-hatch predicate) match
      the JS implementation on a fixture corpus.
+ [ ] Indexing produces the same lookups as the JS index.
+ [ ] Diff + patch outputs match the JS `Sheet.diffFrom` / patch behavior.
+ [ ] Bulk query/CRUD over a large corpus (≈18k records) benchmarked vs the JS path.

## Risks / unknowns

+ **Scope creep** — this is the largest single core plan; if it grows, split query
  + index into their own plan before starting (don't restructure mid-flight).
+ **gix diff fidelity** vs `git diffTree` for record-level diffs.
+ **The read-heavy perf headroom** (hologit#464: per-call `to_thread_local`,
  object cache, per-read clone) lands here — measure and feed back upstream.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
