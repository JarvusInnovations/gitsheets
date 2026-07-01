---
status: done
depends: [record-engine-core]
specs:
  - specs/rust-core.md
  - specs/behaviors/indexing.md
issues: [127]
pr: https://github.com/JarvusInnovations/gitsheets/pull/209
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

- [x] Query results (and filter semantics, incl. an escape-hatch predicate) match
      the JS implementation on a fixture corpus.
      (`test/record-query.mjs` — recordQuery vs host `queryTree` + `queryMatches`,
      incl. `$pred` snippets that are the *same* logic as the node:vm reference.)
- [x] Indexing produces the same lookups as the JS index.
      (`test/record-index.mjs` — unique/non-unique lookup, keyFn-undefined
      exclusion, unique-conflict with `conflictingPaths`, vs a transcribed `Sheet`
      index build.)
- [x] Path-template query-pruning matches the JS renderer's prune behavior;
      `getFieldNames` returns the JS-equivalent set.
      (`recordQueryCandidates` vs host `queryTree` candidate set; `templateFieldNames`
      vs host `getFieldNames`.)
- [x] Bulk query/CRUD over ≈18k records benchmarked vs the JS path; result recorded.
      (18,203 `people` records — see Notes.)
- [x] `cargo build/test` + clippy clean; napi boundary suite passes; the main JS
      suite stays green and independent.
      (`cargo test -p gitsheets-core` 74 lib; `cargo clippy --workspace --all-targets
      -- -D warnings` clean; napi `node --test` 50 tests; root `npm run build && npm
      test` 287+66 + `npm run type-check` green; main build never imports the `.node`.)

## Risks / unknowns

- **Filter-predicate parity** — the escape-hatch predicate runs through the boa
  engine; reuse `definition-logic-core`'s node:vm parity discipline.
- **Index persistence** — lazy vs persisted is a design fork; default to lazy,
  keep the door open, don't bake a persisted format in prematurely.

## Notes

**What was built.** Three new core layers on top of the `record`/holo-tree seam,
plus their folded-in path-template additions:

- `query.rs` — path-template **pruning** walk (`Template::plan_query` +
  `walk_query`, a port of the host `Template.queryTree`) + native filtering
  (`matches`, a port of `queryMatches`). Declarative equality / nested-table
  predicates evaluate natively over the core `Value`; the boa `engine` is the
  escape hatch for `(value, record)` predicate snippets. `query_records` returns
  `(path, record)` in sorted order; `query_candidate_paths` exposes the prune set
  alone (the direct prune-parity target). Batch-first.
- `index.rs` — `UniqueIndex` / `MultiIndex` lazy in-memory builds over a listed
  record set (port of `Sheet`'s `#ensureIndexBuilt`). keyFn snippet → `String(v)`
  or `None` (null/undefined excluded); unique conflict → `IndexUniqueConflict`
  naming both paths.
- `path_template.rs` — `get_field_names` (identifier scan minus JS keywords,
  manual lookbehind-free port of the host regex) and `plan_query` (prune half).
  `Part::Expression` now retains its source for the scan.
- `engine.rs` — `call_filter` (predicate → ECMAScript ToBoolean, `undefined` for
  absent fields) + `call_index_key` (keyFn → `String(value)` | `None`).
- napi: `recordQuery`, `recordQueryCandidates`, `templateFieldNames`,
  `recordIndexUnique`/`recordIndexMulti`, `substrateStats`/`substrateReset`.

**Filter marshalling convention** (the binding's only query-specific shape): a
literal → equality; `{ "$pred": "<js src>" }` → engine predicate
`(value, record) => ( <src> )`; a plain object → nested filter.

**Query / index parity results — all green, no divergences on the tested surface.**

- Pruning: `recordQueryCandidates` === host `queryTree` candidate set on flat +
  composite templates, partial keys, and the "leading-field-only" / "no-fields"
  expansion cases.
- Query+filter: `recordQuery` === `queryTree` + `queryMatches` on equality,
  non-path scan, and `$pred` escape-hatch predicates (numeric, string-method,
  whole-record, and combined). The boa snippet and the node:vm function are the
  *same* logic, so a divergence would be a real engine difference — none seen.
- Indexing: unique/non-unique lookup, keyFn-undefined exclusion, unique-conflict
  (`conflictingPaths`) === transcribed `Sheet` index build.
- `getFieldNames` === host across field/expression/recursive/literal templates.

**Two enumerated divergences**, both on unrealistic filter shapes (documented in
the `query.rs` header, not hidden): (1) datetime *equality* — the host compares a
`Date` literal by reference (`!==`, a footgun that never matches), the core
compares structurally; (2) integer-vs-float equality — the host (JS) sees `30`
and `30.0` as one `number`, the core keeps them distinct (the bytes-authority
distinction the value type carries everywhere). Realistic filters use predicates
for both, where there is no divergence. The parity tests deliberately exercise
string/number/bool equality + predicates.

**Bulk benchmark — 18,203 `people` records, CodeForPhilly `origin/published`,
release build, best-of-3, read WITHOUT touching that repo's working tree (resolve
a ref via gix, never check out).** Methodology in `bench/query-bench.mjs`:

- *Bulk read+parse:* Rust `recordList` **1057 ms (17.2k rec/s)** vs JS
  `git cat-file --batch` + `smol-toml` **988 ms (18.4k rec/s)** → ~0.9x. The Rust
  number includes FFI marshalling of every record's every field into a JS object
  (the dominant cost); the JS baseline uses an optimized C git batch reader + the
  production parser, no FFI. Competitive, not a regression.
- *Point query (pruned):* `recordQuery({ slug })` **30.9 ms**, reads ~1 record not
  18,203 (`trees_read=2`) — the path-template pruning win, ~34x faster than a full
  scan. This is the headline result.
- *Full-scan `$pred` filter:* **1772 ms** (read all + a boa call per record) — the
  escape-hatch per-record engine cost; declarative equality stays native (no boa).

CI runs the committed ~60-record `people` fixture as a SMOKE (`npm run bench`,
timings meaningless at that size — just proves the path); the 18k numbers are a
local/opt-in run via `GITSHEETS_BENCH_REPO/REF/BASE`.

**hologit#464 (read-heavy headroom).** The per-call `to_thread_local` / object-cache
/ per-read-clone overhead #464 targets is in the **JS @hologit/holo-tree binding's
per-call FFI**, not the Rust core — the core holds the `MutableTree` in-process and
reads the whole tree once (`trees_read=2`, `cache_misses=2` for a flat 18k sheet),
so it is *avoided by construction*. Net upstream finding for #464: the Rust-core
read path is the structural fix for that overhead; no further hologit change is
needed for the read path this plan exercises. (Caveat recorded in the bench: the
`blobs_read` counter only increments in `MutableTree::read_blob`; the list/query
paths read blob bytes via `repo.find_object` after the walk hands them a hash, so
that counter under-reports — `trees_read`/`cache_*` are the meaningful signals.)

**Lazy-index decision.** Built lazy + in-memory per the spec's default and its
explicit deferral of a persisted format. The core exposes pure build/lookup
primitives over a listed record set; the build-caching + ref-move invalidation
state machine (host `#ensureIndexBuilt` keyed by tree hash) is a `Sheet`-level
concern left to `sheet-store-core`. No persisted on-disk format was baked in.

## Follow-ups

- **Deferred to plan (`sheet-store-core`)** — index build-caching across operations
  - ref-move invalidation (the host keys the build by the data tree's commit hash);
  the `Sheet`/`Transaction`/`Store` orchestration that wires `query`/`index` into
  the public surface; the host's pre-write unique-index check on `upsert`.
- **Deferred (per spec)** — persisted secondary indices
  (`specs/behaviors/indexing.md#persisted-indices`, `deferred.md`); a design fork
  to revisit only if a consumer's corpus outgrows the <1s rebuild threshold. The
  lazy primitive here keeps that door open without committing to a format.
- **None (upstream)** — no hologit#464 change is required for the read path this
  plan measures (see Notes); the core's in-process tree read is the structural fix.
- **Tracked as** — the `substrateStats.blobsRead` under-count (find_object vs
  read_blob) is a benchmark-instrumentation caveat only, noted in the bench source;
  not worth a holo-tree change.
