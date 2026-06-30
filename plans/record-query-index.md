---
status: planned
depends: [record-engine-core]
specs:
  - specs/rust-core.md
  - specs/behaviors/indexing.md
issues: [127]
---

# Plan: query traversal + filtering + secondary indexing

## Scope

The read-query half of the record engine, on top of the CRUD layer from
[`record-engine-core`](record-engine-core.md). **In:** query traversal of the data
tree + native filtering (declarative predicates in Rust, with the embedded-engine
escape-hatch for arbitrary predicates), secondary indexing, and the bulk
query/CRUD benchmark vs the JS path. **Out:** record CRUD + diff/patch (the
predecessor), `Sheet`/`Transaction`/`Store` ([`sheet-store-core`](sheet-store-core.md)),
and the bindings.

> **Split note.** Carved out of `record-engine-core` per that plan's "split query +
> index into their own plan before starting" risk note. It builds directly on the
> CRUD/holo-tree seam that plan lands.

## Implements

- [`specs/rust-core.md`](../specs/rust-core.md) — "Query traversal + filtering;
  secondary indexing" in the core.
- [`specs/behaviors/indexing.md`](../specs/behaviors/indexing.md) — re-implemented
  behavior-preserving in Rust.

## Approach

- **Query.** traversal of the data tree + native filtering: declarative predicates
  evaluated natively in Rust; the `definition-logic-core` embedded engine as the
  escape-hatch for arbitrary predicates. Batch-first (`queryAll` crosses the FFI
  once). Includes the **path-template query-pruning** half (the renderer's prune
  side, deferred from `definition-logic-core`) and **`getFieldNames`** for query
  auto-derivation.
- **Indexing.** secondary indices built natively; lazy or persisted (the persisted
  variant is a deferred option — keep the door open).
- **Benchmark.** bulk query/CRUD over a large corpus (≈18k records) vs the JS path;
  this is where the hologit#464 read-heavy perf headroom is measured and fed back
  upstream.

## Validation

- [ ] Query results (and filter semantics, incl. an escape-hatch predicate) match
      the JS implementation on a fixture corpus.
- [ ] Indexing produces the same lookups as the JS index.
- [ ] Path-template query-pruning matches the JS renderer's prune behavior;
      `getFieldNames` returns the JS-equivalent set.
- [ ] Bulk query/CRUD over ≈18k records benchmarked vs the JS path; result recorded.
- [ ] `cargo build/test` + clippy clean; napi boundary suite passes; the main JS
      suite stays green and independent.

## Risks / unknowns

- **Filter-predicate parity** — the escape-hatch predicate runs through the boa
  engine; reuse `definition-logic-core`'s node:vm parity discipline.
- **Index persistence** — lazy vs persisted is a design fork; default to lazy,
  keep the door open, don't bake a persisted format in prematurely.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
