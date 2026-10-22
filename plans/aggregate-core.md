---
status: planned
depends: []
specs:
  - specs/behaviors/rollups.md
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
contributing-value and omission rules, `RollupError`. `reduce` runs in the
core's existing boa `Engine` from day one (no `node:vm` phase).

Out of scope: `[gitsheet.rollup]` config, persisted rollup records, stamps
(`rollup-sheets`).

## Implements

- `specs/behaviors/rollups.md` — Aggregate forms, Canonical computation
  (the fold; no differential shortcuts needed yet), Ad-hoc aggregation.
- `specs/api/sheet.md` — `sheet.aggregate`.
- `specs/api/cli.md` — `git sheet aggregate`.
- `specs/api/errors.md` — `RollupError` (`rollup_failed`).
- `specs/rust-core.md` — aggregation listed under the core; `reduce` as
  embedded code.

## Approach

1. **`rust/gitsheets-core/src/aggregate.rs`**: `AggregateSpec` (parsed from
   a `Value` table — the same shape in TOML config and in a binding's
   object), `Aggregator` state machine per form, `fold(records_in_path_order,
   specs, engine) -> Value` (a table of results). `where` reuses
   `query::Filter` + `matches`; `groupBy` keys by `Value` → string. `min`/
   `max` reuse `query::compare_values`; mixed kinds → `Error::RollupFailed
   { sheet, partition, aggregate, cause }`. `reduce` compiles once via
   `engine::Engine::compile` and calls per record; `finalize` likewise;
   result marshalled back through `value.rs` with a TOML-representability
   check.
2. **Query integration**: `query::aggregate_records(ctx, tree, sheet, filter,
   specs)` walks candidates exactly as `query_records_format` with
   `with_body: false` and feeds the fold in walk (= canonical path) order.
3. **napi**: `recordAggregate(gitDir, treeRef, sheet, filter, specs)`;
   **Node** `Sheet.aggregate` marshals specs (camelCase `groupBy`) and maps
   the error to `RollupError`; honors `signal` via the existing cancellation
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

- [ ] `cargo test -p gitsheets-core` covers every form and modifier.
- [ ] `rust-core.yml` parity job: Node and Python `aggregate` over the
  fixture repo serialize to identical canonical TOML.
- [ ] `gitsheets-axi query repos --group-by target_team` answers the #223
  faceted-count ask in one call.
- [ ] `npm run type-check` clean; docs/api.md, docs/cli.md, docs/axi.md,
  skill references updated.

## Risks / unknowns

- **boa parity for `reduce`**: the escape hatch is specced as core-only, so
  there is no `node:vm` baseline to gate against; cover it with the parity
  fixture instead.
- **`distinct` on large cardinalities** builds an in-memory set; fine at
  gitsheets' scale, note in docs.

## Notes

## Follow-ups
