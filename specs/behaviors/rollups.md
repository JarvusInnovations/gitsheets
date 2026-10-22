# Behavior: Rollups (partition aggregates)

## Rule

A sheet may have **rollup sheets**: derived, read-only sheets whose records
are aggregates over a **source** sheet's records — one rollup record per
**partition**, where a partition is a prefix of the source sheet's path
template (a year, a year/month, a domain, the whole sheet). Rollup records are
ordinary canonical records committed in the data tree, so every existing read
surface (`query` with range pruning, `get`, the CLI, `gitsheets-axi`, a future
SQL facade) reads them with no new vocabulary.

gitsheets maintains them: every commit it produces (a transaction, a
sheet-aware merge, a `sync` replay) carries fresh rollups for the partitions
that commit touched, in the same commit as the record changes. Each rollup
record is **stamped with the git tree hash of the partition it summarizes**,
so staleness is an O(1) hash comparison with no record read — and a read of a
rollup sheet always returns correct values, recomputing transiently when the
stamp does not match, whatever got the records there.

## Applies To

- [concepts.md](../concepts.md#rollup-sheet)
- [behaviors/aggregation.md](aggregation.md) — the aggregate grammar and
  its canonical evaluation
- [api/sheet.md](../api/sheet.md) — reads on a rollup sheet, refused writes,
  `materialize()`
- [api/transaction.md](../api/transaction.md) /
  [behaviors/transactions.md](transactions.md) — the commit-time rollup pass
- [behaviors/path-templates.md](path-templates.md) — partition prefixes and
  pruning
- [behaviors/merge.md](merge.md), [behaviors/push-sync.md](push-sync.md) —
  rollups in gitsheets-produced merge and replay commits
- [api/cli.md](../api/cli.md) — `git sheet rollup`
- [api/errors.md](../api/errors.md) — `sheet_derived`, `aggregation_failed`
- [rust-core.md](../rust-core.md) — aggregation is bytes-determining and
  lives in the core; `reduce` is embedded code

## Details

### Declaration

A rollup sheet is a sheet config with a `[gitsheet.rollup]` table:

```toml
# .gitsheets/transactions-monthly.toml
[gitsheet]
root = 'transactions-monthly'
path = '${{ postedAt: YYYY/MM }}'           # a prefix of the source's path

[gitsheet.rollup]
from = 'transactions'                       # the source sheet

[gitsheet.rollup.aggregates]
count     = { count = true }
total     = { sum = 'amountCents' }
largest   = { max = 'amountCents' }
posted    = { sum = 'amountCents', where = { status = 'posted' } }
byCategory = { sum = 'amountCents', groupBy = 'category' }
```

with the source declared as usual:

```toml
# .gitsheets/transactions.toml
[gitsheet]
root = 'transactions'
path = '${{ postedAt: YYYY/MM }}/${{ id }}'
```

- **`from`** names a sheet in the same `.gitsheets/` directory (resolved from
  the same tree the rollup config was read from). It must not itself be a
  rollup sheet — no chains.
- **`path` is the partition.** It must be a **prefix of the source's path
  template**: the same leading components, in order, where the last may be a
  date bucket cut at a shorter format (`YYYY` or `YYYY/MM` of a `YYYY/MM/DD`
  source). The rollup for the **whole sheet** is declared with a single
  literal component (`path = 'all'`), which yields exactly one record.
- Only **literal**, **plain field** (`${{ field }}`), and **date-bucket**
  components may appear in a partition: the rollup record has to carry the
  partition's key fields, and these are the component kinds whose key value is
  recoverable. Expression, multi-reference, prefixed/suffixed, and recursive
  components are `ConfigError` (`config_invalid`). A `YYYY/WW` bucket may only
  be partitioned at `YYYY/WW` itself (its `YYYY` is the ISO week-year, which
  the rollup's own `YYYY` bucket would render differently).
- `root`, `[gitsheet.schema]`, `implements`, `[gitsheet.fields.*]`, and
  `[gitsheet.format]` (TOML only — a content-typed rollup is `config_invalid`)
  behave as for any sheet. A schema is optional; when present, generated
  records are validated against it like any write, so a typo'd aggregate name
  surfaces as `ValidationError`. The template-fields-must-be-required check
  applies to a declared schema as usual.
- Aggregate names may not collide with the key fields or `sourceTree`
  (`config_invalid`). An aggregate may not reference a content-typed source's
  body field (`config_invalid`); rollups read records body-less.

Every config problem above is reported at sheet open, in every binding, like
the existing template checks.

### The rollup record

```toml
# transactions-monthly/2026/03.toml
postedAt = 2026-03-01
sourceTree = "9f8e1c…"
count = 142
total = 1023455
largest = 240000
posted = 998100

[byCategory]
groceries = 120000
rent = 240000
```

- **Key fields** — one per non-literal partition component. A plain-field
  component carries the field with the value the partition's records hold
  (they render identically by construction; the first record in canonical
  path order is authoritative). A date-bucket component carries the bucket
  field as a TOML **local-date, the first day of the period** (`2026-03-01`
  for `2026/03`; the Monday of the ISO week for `YYYY/WW`). A range filter on
  that field prunes a rollup query exactly as it prunes the source.
- **`sourceTree`** — the hex id of the partition's tree object in the source
  (for the whole-sheet rollup, the source root's tree; under a `prefix`, the
  prefix-scoped root). This is the stamp.
- **One field per aggregate.** An aggregate with no contributing records is
  **omitted** (TOML has no null) except `count` (`0`) and `sum` (`0`).
- Canonical normalization applies; the file is byte-identical across bindings
  for the same partition contents.

### Aggregates

Each entry of `[gitsheet.rollup.aggregates]` is one form of the aggregate
grammar in [behaviors/aggregation.md](aggregation.md#aggregate-forms) —
`count`, `sum`, `min`, `max`, `avg`, `distinct`, or `reduce` / `initial` /
`finalize`, each with optional `where` and `groupBy` — spelled in TOML. The
`reduce` escape hatch produces committed bytes here, which is why the grammar
runs in the core's embedded engine. A data-dependent failure is
`AggregationError` with `partition` set.

### Canonical computation

A rollup record is a pure function of the partition's record contents:

1. The partition's records are the record blobs (the source format's
   extension) under the partition subtree, read body-less, **in canonical
   path order** — the byte order of the full record path, i.e. the order a
   tree walk yields. Attachments and non-record files are not records.
2. Each aggregate folds over those records in that order. The order is part
   of the contract because floating-point folds are order-dependent.
3. The result is normalized and serialized like any record.

An engine **may** compute a rollup differentially (old rollup + the changed
records) or compose it from finer rollups, but **only where the result is
bit-identical** to the fold above — count, integer `sum`, `min`, `max`,
`distinct`. Float `sum`/`avg` and `reduce` always fold over the records. The
spec does not promise that a yearly float total equals the sum of its monthly
totals; consumers who need that store integers (cents).

An empty partition has no rollup record. A partition that becomes empty has
its rollup record deleted in the same commit.

### Maintenance at commit

Before any gitsheets-produced commit is finalized — an explicit `transact`, a
permissive-mode auto-transaction, `repo.merge`'s merge commit, each commit
`repo.sync` replays — gitsheets runs a **rollup pass**:

1. For each rollup sheet in the tree being committed, diff the source root
   (prefix-scoped) between the parent tree(s) and the new tree. Every changed
   path under it counts — record adds, modifies, deletes, renames, and raw
   `tx.writeFile` / `tx.deleteFile` writes alike.
2. Map each changed path to its partition (the leading components at the
   rollup's depth; the whole-sheet rollup is touched by any change).
3. Recompute each touched partition's rollup record from the new tree and
   stage it (or its deletion) into the same tree.

One commit carries the records and their rollups, and `git diff` shows the
total move alongside the transactions that moved it. Untouched partitions are
untouched: their stamps still match. The cost of a transaction grows with the
records in the partitions it touches, not with the sheet — except that a
whole-sheet rollup over a non-integer-exact aggregate rescans the source on
every transaction that touches it; the config author accepts that by
declaring it.

A `AggregationError` in the pass aborts the commit, exactly as a `ValidationError`
would; nothing moves.

Rollup sheets are **read-only to consumers**. `upsert`, `delete`, `patch`,
`clear`, and the attachment writers throw `TransactionError` (`sheet_derived`)
on a standing or transaction-bound rollup sheet, naming the sheet and its
source. A raw `tx.writeFile` under a rollup root is not refused (raw writes
are unvalidated by design) but the next recompute of that partition overwrites
it.

### Reads: always correct, stamps as the cache

A read of a rollup sheet (`query`, `queryFirst`, `queryAll`, `get`, `count`,
an index build) reads **through the source**:

1. Walk the source sheet's tree at the partition depth, pruned by the filter
   exactly as a source query would be — the templates share their prefix, so
   equality and range pruning on the key fields apply unchanged.
2. For each partition: if a rollup record exists and its `sourceTree` equals
   the partition's current tree id, yield it. Otherwise (stale, or missing)
   compute the rollup from the partition's records and yield that, with
   `sourceTree` set to the current id, **without writing**.
3. A rollup record whose partition no longer exists in the source is not
   yielded.

A transaction-bound rollup sheet reads through the transaction's tree, so a
handler that upserts into March and then queries March's rollup sees the new
total before commit; the commit-time pass persists it.

Consequences: a rollup sheet is correct after a plain `git merge`, an external
writer, a hand-edited file, a rollup config added over existing data, or a
crash between any two steps — the committed rollup records are a **cache that
gitsheets keeps hot on its own write path**, never a second source of truth.
The freshness check costs one tree lookup per partition; fresh partitions read
one small blob, which is the whole point. `opts.stale: 'serve'` on a read
yields stored records as committed even when stale (for auditing what a
commit claimed); the default is `'recompute'`.

### Materializing explicitly

`rollupSheet.materialize()` recomputes every stale or missing rollup record
and deletes orphaned ones, in one transaction (or into the current one on a
transaction-bound sheet), returning `{ recomputed: string[], deleted: string[] }`
of partition paths. A no-op when everything is fresh (no commit). This is the
repair after a plain `git merge` or an external import, and the backfill
after adding a rollup config to a sheet with history.

`git sheet rollup <sheet>` is the CLI form; `--check` writes nothing, lists
each stale / missing / orphaned partition, and exits 1 if there are any — the
CI gate for data branches other tools write to.

### Merge and sync

- **`repo.merge` / `git sheet merge`** — rollup records never enter the record
  pass and never conflict: whatever the tree merge produced for a rollup path
  is discarded and the rollup pass regenerates every partition changed on
  either side since the base, into the merge tree.
- **Merge driver** (plain `git merge`) — a file-at-a-time driver cannot
  regenerate; rollup files merged by git carry stale stamps that reads
  self-heal and `git sheet rollup` repairs.
- **`repo.sync` replay** — each replayed commit gets the rollup pass against
  its new parent, so a local March commit replayed over a remote March commit
  carries a rollup over both sets of records.

### Why the stamp lives in the record

The stamp is provenance of a derived artifact — the identity of the input the
value was computed from — not a copy of something git already tracks about the
rollup file. Git has no slot for "which tree was this blob derived from"; the
alternatives were weighed and rejected:

- **Infer from history** (the rollup is fresh if no commit since the one
  that last wrote it touched the partition). Needs a *commit* context, and
  gitsheets routinely holds only a *tree*: a transaction's private tree
  before commit, a tree-hash-pinned sheet, a `merge({ commit: false })`
  dry-run tree, a `sync` replay in progress. It is a revision walk per
  partition, unbounded on long histories, where the stamp is one tree
  lookup. And it is wrong after exactly the events the check exists for: a
  merge commit "touches" both sides, a rebase rewrites which commit wrote
  what, and a plain `git merge` that took a stale rollup file looks like a
  fresh write. The stamp compares against the partition's *current* tree id
  regardless of how the tree got there.
- **Git notes on the rollup blob** (`refs/notes/gitsheets`: blob id → source
  tree id). Git-native and out of the content, but notes do not clone, fetch,
  or push by default, so a second clone or a CI runner sees every rollup as
  stale (reads still self-heal, the cache is just cold); the notes ref is a
  second ref to update per commit (non-atomically) and to merge between
  writers; and a human reading the file on GitHub cannot tell what the
  number was computed over.
- **A commit trailer** per partition. Per commit, not per partition — finding
  the stamp for one rollup is the history walk again — and lost from any
  commit git itself produces.

The record stamp travels with the data, is atomic with it (same tree, same
commit), is verifiable by anyone with `git rev-parse <commit>:<source>/<partition>`,
and makes a rollup *self-describing*: the file says what it is a function of.
That is the same reason a lockfile records integrity hashes rather than
trusting the registry's history.

### Not in this spec

- **Multi-level composition guarantees** (year == Σ months for floats). See
  "Canonical computation".
- **Rollups over rollups.** Chains are refused.
- **Cross-sheet rollups** (a join). A rollup has one source.

## Principles

**Local:**

- **Rollups are a cache, not a source.** The records are the truth; a rollup
  record is a committed, stamped memo of a pure function of them. Anything
  that can read the records can regenerate it, so a stale or missing rollup is
  never an error on read — it is recomputed — and a rollup is never merged,
  edited, or validated as user data, only regenerated. When a design choice is
  between protecting the committed rollup bytes and recomputing them, recompute.
- **Partitioning is the unit of incrementality.** The path template already
  decides which subtree a write touches; rollups ride that decision rather
  than adding a second one. A rollup that cannot be scoped to a partition
  (the whole-sheet total) is allowed but costs a scan, and the spec says so
  instead of hiding it.

**Inherited:**

- [Records carry their own path](../principles.md#records-carry-their-own-path) —
  a rollup record carries its key fields like any record; its path is a pure
  function of the record, which is why only recoverable component kinds may
  be partitions.

## Coordinates with

- [concepts.md](../concepts.md)
- [api/sheet.md](../api/sheet.md)
- [api/transaction.md](../api/transaction.md)
- [api/cli.md](../api/cli.md)
- [api/errors.md](../api/errors.md)
- [behaviors/aggregation.md](aggregation.md)
- [behaviors/path-templates.md](path-templates.md)
- [behaviors/transactions.md](transactions.md)
- [behaviors/merge.md](merge.md)
- [behaviors/push-sync.md](push-sync.md)
- [behaviors/indexing.md](indexing.md) — in-memory indexes are the other
  derived structure; they are neither persisted nor stamped
- [rust-core.md](../rust-core.md)
- [deferred.md](../deferred.md#persisted-indexes) — persisted indexes remain
  deferred; rollups are not a substitute for them
