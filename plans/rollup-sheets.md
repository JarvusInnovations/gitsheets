---
status: planned
depends: [aggregate-core]
specs:
  - specs/behaviors/rollups.md
  - specs/concepts.md
  - specs/api/sheet.md
  - specs/api/cli.md
  - specs/api/errors.md
  - specs/behaviors/transactions.md
issues: [342]
---

# Plan: rollup sheets — config, commit-time pass, stamped read-through

## Scope

Persisted rollups: the `[gitsheet.rollup]` config (`from`, `path` as a
source-prefix partition, open-time validation), the rollup record shape
(key fields, `sourceTree`, aggregates), the **rollup pass** in transaction
finalize (regenerate touched partitions into the same tree), stamped
**read-through** on every read of a rollup sheet (walk source partitions,
serve on stamp match, recompute transiently otherwise, `opts.stale`),
read-only enforcement (`TransactionError` `sheet_derived`),
`sheet.materialize()`, `git sheet rollup [--check]`, and the axi twin.
Node and Python both get it because the pass lives in the core transaction.

Out of scope: the pass inside merge and sync replay (`rollup-merge-sync`);
differential / compositional shortcuts (a later optimization plan if a
consumer needs it; the spec permits but does not require them).

## Implements

- `specs/behaviors/rollups.md` — Declaration, The rollup record,
  Maintenance at commit, Reads, Materializing explicitly, Why the stamp
  lives in the record.
- `specs/concepts.md` — Rollup sheet.
- `specs/api/sheet.md` — Rollup sheets, `materialize`.
- `specs/api/cli.md` — `git sheet rollup`.
- `specs/api/errors.md` — `sheet_derived`.
- `specs/behaviors/transactions.md` — Rollup pass.

## Approach

1. **Config** (`config.rs`): parse `[gitsheet.rollup]`; at open, resolve the
   source config from the same tree, check `path` is a component-wise prefix
   of the source template (bucket format prefixes allowed; `YYYY/WW` only
   whole), reject disallowed component kinds, chains, reserved names, body
   fields, non-TOML format. Store `RollupDef { source, depth, key_components,
   aggregates }` on the sheet handle.
2. **Partition enumeration** (`path_template.rs`/`query.rs`): a walk that
   yields `(partition_path, tree_id, key_values)` at depth N, pruned by a
   filter on the key fields — the existing candidate walk stopped early, with
   bucket period-start derivation for the key value.
3. **Compute one partition**: list records under the partition tree in path
   order (body-less), `aggregate::fold`, add key fields + `sourceTree`,
   normalize, serialize — the same write pipeline as a record (schema
   validation if declared).
4. **Rollup pass** in `Transaction::finalize` before the commit object is
   built: for each rollup sheet discovered in the tx tree, `diff` parent tree
   vs tx tree under the source root (holo-tree dirty tracking makes this
   cheap), bucket changed paths by partition, recompute, write/delete rollup
   blobs into the tx tree. Errors → `RollupFailed`, which aborts finalize.
5. **Read-through**: `query_records*` on a sheet with a `RollupDef` runs the
   partition walk instead of the record walk; per partition compare the
   stored record's `sourceTree` to the live tree id; on mismatch/missing,
   compute (step 3) and yield without writing. `stale: 'serve'` short-circuits
   to the stored records. `count`/`get`/index builds route through the same
   path.
6. **Read-only**: write methods on a sheet with `RollupDef` throw
   `sheet_derived` in core and binding.
7. **`materialize`**: run step 5's check over every partition plus a scan of
   stored rollup records for orphans; stage writes/deletes in a transaction
   (or the current tx); return `{ recomputed, deleted }`. CLI `rollup`
   (`--check` exits 1 on any entry, writes nothing); axi `rollup`.
8. **Tests**: fixtures with the spec's `transactions` / `transactions-monthly`
   pair; a tx touching two months regenerates exactly those two; deleting a
   month's last record removes its rollup; stale stamp after a raw
   `git commit` is recomputed on read and persisted by `materialize`;
   `--check` exit code; range-pruned rollup query; `prefix` scoping; schema
   validation of generated records; Python parity on the committed bytes.

## Validation

- [ ] `cargo test` + vitest cover every bullet of step 8.
- [ ] A 10k-record partitioned fixture: a single-record upsert's commit time
  is within 2× the pre-rollup baseline (the pass touches one partition).
- [ ] Node and Python writes to the fixture produce byte-identical rollup
  blobs (`rust-core.yml` parity gate).
- [ ] `npm run type-check` clean; docs and skill references cover rollup
  config, `materialize`, and `git sheet rollup`.

## Risks / unknowns

- **Diffing parent vs tx tree** when the parent is `null` (orphan) or the
  tx wrote the config itself (first rollup over existing data): treat every
  partition as touched.
- **Read-through cost on huge partition counts** (daily buckets over years):
  one tree lookup per partition is still a walk; the filter pruning keeps
  typical queries bounded. Measure in the 10k fixture.

## Notes

## Follow-ups
