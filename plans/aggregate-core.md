---
status: done
pr: 348
depends: []
specs:
  - specs/behaviors/aggregation.md
  - specs/api/sheet.md
  - specs/api/cli.md
  - specs/api/errors.md
  - specs/rust-core.md
issues: [342, 223]
---

# Plan: aggregate grammar and fold in the core; ad-hoc `aggregate()`

## Scope

The aggregate vocabulary and its evaluation, as a core primitive, surfaced
first as **ad-hoc, query-time aggregation**: `sheet.aggregate(filter,
aggregates)` on Node, `git sheet aggregate`, `gitsheets-axi aggregate` plus
`query --group-by`, and a Python `record_aggregate` batch function. Forms:
`count`, `sum`, `min`, `max`, `avg`, `distinct`, `reduce`/`initial`/`finalize`;
modifiers `where`, `groupBy`. Canonical path order, body-less reads, the
contributing-value and omission rules, `AggregationError`. `reduce` runs in the
core's existing boa `Engine` from day one (no `node:vm` phase).

Out of scope: persisted rollup sheets (their own feature branch,
`rollup-sheets`, which builds on this fold).

## Implements

- `specs/behaviors/aggregation.md` — all of it.
- `specs/api/sheet.md` — `sheet.aggregate`.
- `specs/api/cli.md` — `git sheet aggregate`.
- `specs/api/errors.md` — `AggregationError` (`aggregation_failed`).
- `specs/rust-core.md` — aggregation listed under the core; `reduce` as
  embedded code.

## Approach

1. **`rust/gitsheets-core/src/aggregate.rs`**: `AggregateSpec` (parsed from
   a `Value` table — the same shape in TOML config and in a binding's
   object), `Aggregator` state machine per form, `fold(records_in_path_order,
   specs, engine) -> Value` (a table of results). `where` reuses
   `query::Filter` + `matches`; `groupBy` keys by `Value` → string. `min`/
   `max` reuse `query::compare_values`; mixed kinds → `Error::AggregationFailed
   { sheet, aggregate, partition: None, cause }`. `reduce` compiles once via
   `engine::Engine::compile` and calls per record; `finalize` likewise;
   result marshalled back through `value.rs` with a TOML-representability
   check.
2. **Query integration**: `query::aggregate_records(ctx, tree, sheet, filter,
   specs)` walks candidates exactly as `query_records_format` with
   `with_body: false` and feeds the fold in walk (= canonical path) order.
3. **napi**: `recordAggregate(gitDir, treeRef, sheet, filter, specs)`;
   **Node** `Sheet.aggregate` marshals specs (camelCase `groupBy`) and maps
   the error to `AggregationError`; honors `signal` via the existing cancellation
   token. **Python**: `record_aggregate(...)` mirroring `record_query`.
4. **CLI** `aggregate` command: `--agg name=form[:field]`, `--group-by`,
   `--filter` shared with `query`, JSON/TOML output. **axi**: `aggregate`
   with the same flags and TOON output; `query --group-by <field>` as sugar
   for `aggregate --agg count=count --group-by`.
5. **Tests**: core unit tests per form incl. int/float promotion, omission
   rules, `where`+`groupBy` composition, mixed-kind errors, `reduce` with
   `finalize`; a cross-binding parity fixture (same repo, Node vs Python
   results byte-identical when serialized canonically); CLI/axi snapshot
   tests.

## Validation

- [x] `cargo test -p gitsheets-core` covers every form and modifier.
- [ ] `rust-core.yml` parity job: Node and Python `aggregate` over the
  fixture repo serialize to identical canonical TOML.
- [x] `gitsheets-axi query repos --group-by target_team` answers the #223
  faceted-count ask in one call.
- [x] `npm run type-check` clean; docs/api.md, docs/cli.md, docs/axi.md,
  skill references updated.

## Risks / unknowns

- **boa parity for `reduce`**: the escape hatch is specced as core-only, so
  there is no `node:vm` baseline to gate against; cover it with the parity
  fixture instead.
- **`distinct` on large cardinalities** builds an in-memory set; fine at
  gitsheets' scale, note in docs.

## Notes

- **Ships a `gitsheets-core` behavior change.** Per the release rules in
  `CLAUDE.md`, a `core-napi-v*` release must land (and the manifest/lockfile
  sync PR merge) before the next JS `v*` release, or `publish-npm` will test
  against stale platform binaries without `recordAggregate`.
- **Parity checkbox:** the `rust-core.yml` job itself runs in CI. Its
  equivalent ran locally: release napi build, then the gitsheets-py job's
  steps (`maturin build --release`, `pytest tests/` → 82 passed), including
  `test_aggregate_results_byte_identical_across_bindings` (Node vs Python
  `aggregate` over one fixture repo, now with a `__proto__` group key →
  identical canonical TOML). Left unchecked until CI is green.
- **Spec amendments first** (`183830f`): edge rules the grammar left implicit
  (sum overflow → `AggregationError`, the float-fold definition, `avg` as
  sum/count, first-wins ties for `min`/`max`/`distinct`, compare-equal
  dedupe in `distinct`, booleans sorting false-first, grouped results always a
  table with groups present only when something contributes, and the
  engine→core marshal rules for a `reduce` result); the Node filter accepting
  `query`'s function predicates; signal checkpoints; the body-field
  `TypeError` covering the filter; Python `record_aggregate`.
- **Function predicates on Node:** the host can't send functions over the FFI,
  and re-marshalling records host→core would lose int/float fidelity. So a
  filter with functions runs a body-less host `query` to collect admitted
  paths, and the core re-walks and folds over exactly those (`paths` /
  `only`). Records are read twice on that path only.
- **Error split:** `aggregate::prepare` (parse + body check + snippet
  compile) fails with `ConfigInvalid`; the bindings turn that into a
  call-site `TypeError`. The fold fails with `AggregationFailed`. A future
  rollup config can surface the same `ConfigInvalid` as `ConfigError`.
- **Placement:** `aggregate_records` lives in `aggregate.rs`, not `query.rs`
  as the plan sketched; it calls `query::query_records_format` with
  `with_body: false`. `Filter::from_table` was added to `query.rs` for the
  binding-neutral `where` form.
- **Engine:** `reduce` accumulators stay live boa values between calls
  (`call_engine` / `to_engine`); only the final value is marshalled back
  (`to_core_value`, depth-capped at 128 to catch cycles). The tx path folds
  with a fresh engine so per-call snippets don't pile up in the sheet's
  long-lived one.
- **axi:** `query --group-by` stays its develop implementation (host-side
  `facetCounts`: any value kind, Dates as ISO, missing under `''`) — making it
  sugar for `aggregate` regressed datetime/float grouping, body-field
  filters, and pruning, so review round 1 reverted it. `aggregate` builds its
  filter from the pushdown ranges on date-bucket path fields plus one
  combined host predicate under a synthetic key no record carries, so the
  walk prunes while the DSL stays authoritative; a body-field clause is
  `VALIDATION_ERROR` naming the clause.
- **Fold order (review round 1):** the contract is the tree-walk order — the
  byte order of the full path *with* its extension (`k-1.toml` before
  `k.toml`). `query` returns rows sorted extensionless (`k` before `k-1`),
  which is fine for `query` (its order is unspecified) but not for a fold, so
  `fold_rows` re-sorts by path + extension. Tested against `git ls-tree -r`
  with prefix-colliding ids (`a`, `a-b`, `a.b`).
- **Engine hardening (review round 1):** each `reduce` group folds in a fresh
  engine realm under loop (1M per loop) / recursion (256) / stack limits;
  breaching one is `AggregationError`. Engine→core conversion caps depth (128)
  and total nodes (1M), and rejects a `Date` outside years 0–9999. Purity
  (`Math.random`, `Date.now`) is required but **not enforced**; that must be
  fixed before rollups persist `reduce` results — #354.
- **Other review-round fixes:** exact integer/float comparison in
  `compare_values` (also tightens `query` range filters on large integers);
  `__proto__` keys become own properties in the napi Value→JS conversion
  (records too); all-integer `avg` overflow is `AggregationError`; host-shape
  `TypeError`s name `initial: null` and functions in `where`; duplicate
  `--agg` names are checked on a null-prototype object.
- **Cross-binding parity caveat:** the Node binding surfaces an integral
  float (e.g. `2.0`) as a JS number that re-marshals as an integer, so the
  parity fixture keeps every float result non-integral. That is a
  host-projection limit, not a core divergence.

## Follow-ups

- Issue [#354](https://github.com/JarvusInnovations/gitsheets/issues/354) — harden the embedded engine for committed aggregates (freeze `Math.random` / `Date.now`, deterministic realm). Blocks persisting `reduce` results in rollups.
