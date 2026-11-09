---
status: done
depends: [aggregate-core]
specs:
  - specs/behaviors/rollups.md
  - specs/concepts.md
  - specs/api/sheet.md
  - specs/api/cli.md
  - specs/api/errors.md
  - specs/behaviors/transactions.md
  - specs/behaviors/merge.md
  - specs/behaviors/push-sync.md
  - specs/api/python-binding.md
issues: [342, 240, 354, 360]
pr: 349
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
The pass also runs inside `repo.merge` / `git sheet merge` (rollup paths
dropped from the record pass, regenerated for partitions changed on either
side since the base) and inside each `repo.sync` replayed commit, so every
gitsheets-produced commit carries rollups matching its records. The Python
binding gets the pass for free (it lives in the core transaction) and gains
the explicit surface: rollup-sheet reads through the stamped read-through
(`stale=` keyword), `materialize_rollups`, and the error mapping.

Out of scope: differential / compositional shortcuts (an optimization issue
if a consumer needs it; the spec permits but does not require them); a merge
driver that regenerates rollups (it cannot — one file at a time).

## Implements

- `specs/behaviors/rollups.md` — Declaration, The rollup record,
  Maintenance at commit, Reads, Materializing explicitly, Why the stamp
  lives in the record.
- `specs/concepts.md` — Rollup sheet.
- `specs/api/sheet.md` — Rollup sheets, `materialize`.
- `specs/api/cli.md` — `git sheet rollup`.
- `specs/api/errors.md` — `sheet_derived`.
- `specs/behaviors/transactions.md` — Rollup pass.
- `specs/behaviors/merge.md`, `specs/behaviors/push-sync.md` — the pass in
  merge and replay (rollups.md § Merge and sync).
- `specs/api/python-binding.md` — `materialize_rollups`, `stale=`, errors.

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
   blobs into the tx tree. Errors → `AggregationFailed`, which aborts finalize.
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
8. **Merge and sync**: factor the pass into `rollup::pass(ctx, parents,
   new_tree)`; call it in `merge.rs` after the record pass with `(base,
   merged)` and exclude rollup roots from conflict classification; in
   `sync.rs` run it per replayed commit after its 3-way tree merge.
9. **Python**: pyo3 wrappers for `materialize_rollups` and the `stale`
   keyword on `record_query`; `AggregationError` with `sheet` / `aggregate`
   / `partition` attributes; `TransactionError` code `sheet_derived`; README
   example.
10. **Tests**: fixtures with the spec's `transactions` / `transactions-monthly`
   pair; a tx touching two months regenerates exactly those two; deleting a
   month's last record removes its rollup; stale stamp after a raw
   `git commit` is recomputed on read and persisted by `materialize`;
   `--check` exit code; range-pruned rollup query; `prefix` scoping; schema
   validation of generated records; two branches each adding March
  transactions → merged rollup covers both (and in a dry-run tree); sync
  replay over a remote that added to the same month; merge-driver fixture
  healed by `git sheet rollup`; Python parity on the committed bytes and
  pytest coverage of the Python surface.

## Validation

- [x] `cargo test` + vitest cover every bullet of step 10, plus the review
  round. Core: `rust/gitsheets-core/src/rollup_tests.rs` (canonical record
  bytes with both stamps; exactly-touched partitions; delete → rollup
  deleted; raw `writeFile`; stale stamp → read-through / `serve` / survey /
  materialize; tx-bound reads; range + equality pruning, ISO-string and
  midnight-UTC equality on the date key; prefix scoping; schema validation;
  `AggregationError` partition + abort; read-only; whole-sheet / ISO week /
  plain-field partitions, plain-field key from the first record carrying it;
  every `config_invalid` case incl. overlap with a rollup source, a
  coexisting `root = '.'` ordinary sheet allowed, a source at `.` refused,
  and dotted fields; an invalid rollup config failing only the commits that touch it;
  the deterministic reduce realm; config-over-existing-data backfill; a
  config change regenerating every prefix; a plain-git config change caught
  on read; merge (commit + dry run), multi-tenant merge, a both-sides-edited
  rollup in an untouched partition; sync replay, multi-tenant sync replay;
  merge-driver heal). Node: `sheet-rollup.test.ts` (incl. aggregate over a
  stale rollup, multi-tenant `repo.merge`), `cli/cli-rollup.test.ts`, axi
  `test/rollup.test.ts`, napi `test/rollups.mjs`. Python:
  `tests/test_rollups.py`.
- [x] Warm steady state: a single-record upsert's commit time on the
  10k-record partitioned fixture (120 monthly partitions of ~83 records) is
  within 2× the pre-rollup baseline — after the review round, baseline
  median 7.44 / 5.19 ms vs 9.69 / 8.68 ms with a monthly rollup (ratio 1.30
  / 1.67; earlier runs 1.37–1.91) on a heavily loaded host (load average
  ~20). `cargo test --release -p gitsheets-core rollup_commit_timing --
  --ignored --nocapture` (asserts ≤ 2×; `#[ignore]` because it is a timing
  test).
- [x] Cold first commit recorded, not bounded: the first commit in a process
  (empty decode cache, rollup sheet not yet compiled) took 24–57 ms vs 6–15
  ms baseline across runs. The one-shot CLI (`git sheet upsert`) always pays
  this cold cost; long-lived processes pay it once.
- [ ] Node and Python writes to the fixture produce byte-identical rollup
  blobs (`rust-core.yml` parity gate). Verified locally
  (`test_rollup_commit_bytes_identical_across_bindings`: identical rollup
  blobs, tree, and commit, plus identical read-through rows); the CI job
  runs on the PR.
- [x] `npm run type-check` clean; docs and skill references cover rollup
  config, `materialize`, and `git sheet rollup`.

## Risks / unknowns

- **Diffing parent vs tx tree** when the parent is `null` (orphan) or the
  tx wrote the config itself (first rollup over existing data): treat every
  partition as touched.
- **Read-through cost on huge partition counts** (daily buckets over years):
  one tree lookup per partition is still a walk; the filter pruning keeps
  typical queries bounded. Measure in the 10k fixture.

## Notes

- **Release ordering:** this plan changes `rust/gitsheets-core` (rollups,
  engine hardening, transaction / merge / sync) — a `core-napi-v*` release
  must ship before the next JS (`v*`) release (CLAUDE.md "Releases").
- **Prefix-aware pass (review round 1, closes #360).** The first cut ran the
  pass in "the scopes the transaction opened", which missed prefixed data in
  merge and sync (a multi-tenant merge committed a rollup full of conflict
  markers). Now, for each rollup sheet in the root `.gitsheets/`, every
  changed path under the source root maps to `(prefix, partition)`: a record
  file's prefix is the leading segments beyond the source template's fixed
  segment count (a recursive template has no prefixes); any other file maps
  through the record whose attachment directory holds it. Changed paths come
  from a tree diff that only descends into differing subtree ids. Merge and
  each sync replay also heal every rollup path that differs from either
  parent — regenerated from its partition, or deleted — so no unresolved
  rollup blob survives; a transaction's pass does not (forged stamps via raw
  writes are caught by `--check` / `materialize`, by spec).
- **`configTree` stamp.** Rollup records carry the `.gitsheets/` tree id
  beside `sourceTree`; fresh = both match, so any config change (even by
  plain git, even from another tenant's scope) recomputes on read, and a
  gitsheets commit that changes `.gitsheets/` regenerates every `(prefix,
  partition)` (prefixes enumerated from the source and rollup roots). The
  cost: editing an unrelated sheet's config also regenerates every rollup in
  that commit.
- **Lazy resolution.** A rollup sheet is resolved only when the pass has
  work for it (source or rollup subtree changed, or `.gitsheets/` changed),
  from a cheap two-config parse; an invalid rollup config fails only those
  commits.
- **Disjointness** (narrowed at review): a rollup's root may not overlap
  any rollup's source or any other rollup in the directory; ordinary sheets
  may overlap as before. A source rooted at `.` cannot have a rollup
  (`config_invalid`, asking for a root).
- **#354 closed here.** The `reduce` / `finalize` realm denies
  `Math.random`, `Date.now`, and the argument-less `Date`; boa's host hooks
  pin the local offset to UTC and the clock to the epoch (boa's default
  local-offset hook reads the process time zone only when single-threaded —
  a real Node/Python divergence). The path-template / comparator engines are
  untouched (#362).
- **Performance.** Decoded source records are memoized by blob id
  (immutable; cleared at 200k entries) and compiled rollup sheets per thread
  by `(config path, open root, prefix, config blobs)` (cap 256; not cached
  when the sheet declares contracts). The fold itself is always the plain
  fold.
- **Reads.** Node standing reads open a core sheet per call (`rollupQuery` /
  `rollupGet` / `rollupStatus` / `rollupAggregate`); `sheet.aggregate` on a
  rollup sheet folds the read-through. Equality on a local-date field
  accepts an ISO date string or a midnight-UTC datetime, in the core and in
  Node's host-side re-check. Python reads stay batch functions:
  `record_query(..., sheet=, stale=)`; without `sheet=` a rollup root reads
  stored bytes (spec'd).
- **Rebases.** Onto #346 (default-branch binding: fixtures name branches
  with `parent`) and #347 (submodule mode: conflicts in api/cli.md and the
  axi TOP_HELP, both sides kept).

## Follow-ups

- Issue [#362](https://github.com/JarvusInnovations/gitsheets/issues/362) — harden the path-template and comparator engines (no clock, randomness, or host time zone) the way the aggregate realm was.
