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
- **`path` is the partition.** It must be a **proper prefix of the source's
  path template**: the same leading components, in order, where the last may
  be a date bucket cut at a shorter format (`YYYY` or `YYYY/MM` of a
  `YYYY/MM/DD` source), and at least one source component left below it — a
  partition is a subtree, so a `path` as long as the source's whole template
  is `config_invalid`. The rollup for the **whole sheet** is declared with
  literal components only (typically one, `path = 'all'`), which yields
  exactly one record; its literals need not match the source's.
- Only **literal**, **plain field** (`${{ field }}`), and **date-bucket**
  components may appear in a partition: the rollup record has to carry the
  partition's key fields, and these are the component kinds whose key value is
  recoverable. Expression, dotted-field (`${{ meta.cat }}` — only top-level
  fields can be keys), multi-reference, prefixed/suffixed, and recursive
  components are `ConfigError` (`config_invalid`). A `YYYY/WW` bucket may only
  be partitioned at `YYYY/WW` itself (its `YYYY` is the ISO week-year, which
  the rollup's own `YYYY` bucket would render differently).
- A rollup's data subtree must be disjoint from **every other sheet's** in
  the same `.gitsheets/` directory, its source included: a rollup `root`
  equal to, inside, or containing another sheet's `root` is `config_invalid`
  (a rollup record under a source root would change the very partition some
  rollup summarizes, so that stamp could never match; under any other sheet it
  would be read as that sheet's data).
- `root`, `[gitsheet.schema]`, `implements`, `[gitsheet.fields.*]`, and
  `[gitsheet.format]` (TOML only — a content-typed rollup is `config_invalid`)
  behave as for any sheet. A schema is optional; when present, generated
  records are validated against it like any write, so a typo'd aggregate name
  surfaces as `ValidationError`. The template-fields-must-be-required check
  applies to a declared schema as usual.
- Aggregate names may not collide with the key fields, `sourceTree`, or
  `configTree` (`config_invalid`). An aggregate may not reference a content-typed source's
  body field (`config_invalid`); rollups read records body-less.

Every config problem above is reported at sheet open, in every binding, like
the existing template checks.

### The rollup record

```toml
# transactions-monthly/2026/03.toml
configTree = "41d07a…"
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
  path order that carries the field is authoritative — `AggregationError` when
  none does). A date-bucket component carries the bucket
  field as a TOML **local-date, the first day of the period** (`2026-03-01`
  for `2026/03`; the Monday of the ISO week for `YYYY/WW`). A range filter on
  that field prunes a rollup query exactly as it prunes the source, and an
  equality filter matches it given the local date, an ISO date string
  (`'2026-03-01'`), or a datetime at midnight UTC (a JS `Date` of that day) —
  see [api/sheet.md § query](../api/sheet.md#sheetqueryfilter-opts). A dotted
  bucket reference (`${{ meta.postedAt: YYYY }}`) carries the key at that
  nested path.
- **`sourceTree`** — the hex id of the partition's tree object in the source
  (for the whole-sheet rollup, the source root's tree; under a `prefix`, the
  prefix-scoped root).
- **`configTree`** — the hex id of the `.gitsheets/` directory's tree the
  record was computed under (`git rev-parse <commit>:<root>/.gitsheets`, with
  `<root>` the `openSheet({ root })` scoping). Together with `sourceTree` this
  is **the stamp**: a record is fresh only when both match the tree it is read
  from, so a rollup is recomputed after any change to the rollup's own config,
  its source's, or anything else in that directory.
- **One field per aggregate.** An aggregate with no contributing records is
  **omitted** (TOML has no null) except `count` (`0`) and `sum` (`0`).
- Canonical normalization applies; the file is byte-identical across bindings
  for the same partition contents.

A **partition** is a subtree of the source root at the partition depth whose
names the partition components could have rendered — a literal component's
exact name, a bucket segment that reads as its unit (`2026`, `03`, `W`-less
`09` for a week) — and whose rollup record renders back, through the rollup's
own `path`, to that same partition path. Anything else at that depth (a stray
directory) is not a partition: it is never read, rolled up, or reported.

**Prefixes.** A source record's path under the source root is its tenant
`prefix` (zero or more leading segments — the `openSheet({ prefix })`
sub-tree) followed by exactly the segments the source template renders. The
template's segment count is fixed (a template with a recursive `**` component
has none, and its records carry no prefix), so the prefix of any record file
is the leading segments beyond that count. A record's partition is the
partition-depth segments after its prefix; the rollup record for a
`(prefix, partition)` lives at `<rollup root>/<prefix>/<partition path>`.
 A partition is identified everywhere (the
`AggregationError`'s `partition`, `materialize()`'s lists, `git sheet rollup`'s
output) by its **rollup record path** — the partition's path under the source
root, or the rollup's literal `path` for a whole-sheet rollup.

### Aggregates

Each entry of `[gitsheet.rollup.aggregates]` is one form of the aggregate
grammar in [behaviors/aggregation.md](aggregation.md#aggregate-forms) —
`count`, `sum`, `min`, `max`, `avg`, `distinct`, or `reduce` / `initial` /
`finalize`, each with optional `where` and `groupBy` — spelled in TOML. The
`reduce` escape hatch produces committed bytes here, which is why the grammar
runs in the core's embedded engine. A data-dependent failure is
`AggregationError` naming the rollup sheet (`sheet`), the aggregate, and the
`partition`.

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

1. For each rollup sheet declared in the `.gitsheets/` directory at the
   root being committed (the repository root, or `repo.merge`'s `root`),
   diff its source's data root between the parent tree(s) and the new tree.
   Every changed path under it counts — record adds, modifies, deletes,
   renames, attachments, and raw `tx.writeFile` / `tx.deleteFile` writes
   alike — whatever prefix it lies under.
2. Map each changed path to its `(prefix, partition)` (see "Prefixes"; an
   attachment or other non-record file maps through the record whose
   attachment directory holds it; a whole-sheet rollup's partition is the
   prefix-scoped root).
3. Recompute each touched `(prefix, partition)`'s rollup record from the new
   tree and stage it (or its deletion, when the partition is gone or empty)
   at `<rollup root>/<prefix>/…` in the same tree.

When the `.gitsheets/` directory's tree differs between the parent and the
new tree (a config added, edited, or removed — including a rollup config
added over existing data), and for an orphan commit, which has no parent,
every `(prefix, partition)` of every rollup sheet is touched: the pass
enumerates the prefixes by walking the source root (and the rollup root, so
orphaned records are deleted) and regenerates everything, since every
record's `configTree` changes.

A rollup sheet is resolved (its config checked against its source) only when
the pass has something to do for it — its source changed, or the
`.gitsheets/` directory did. An invalid rollup config therefore fails exactly
the commits that touch its source or the configs, with the `ConfigError` the
sheet open would raise; unrelated commits are unaffected.

Removing a rollup config leaves its committed records in place: nothing reads
them as a rollup any more (they are plain files under the old root), so delete
that directory explicitly in the same commit if they should go.

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
are unvalidated by design), and a transaction's pass does not inspect it: a
record written that way with forged stamps is served as fresh until
`git sheet rollup --check` / `materialize()` (which compare bytes) flag and
replace it, or until its partition changes. The next recompute of that partition overwrites
it.

### Reads: always correct, stamps as the cache

A read of a rollup sheet (`query`, `queryFirst`, `queryAll`, `get`, `count`,
`aggregate`, an index build) reads **through the source** — `aggregate` folds
over the read-through records:

1. Walk the source sheet's tree at the partition depth, pruned by the filter
   exactly as a source query would be — the templates share their prefix, so
   equality and range pruning on the key fields apply unchanged.
2. For each partition: if a rollup record exists and its `sourceTree` equals
   the partition's current tree id **and** its `configTree` equals the
   current `.gitsheets/` tree id, yield it. Otherwise (stale, or missing)
   compute the rollup from the partition's records and yield that, with both
   stamps set to the current ids, **without writing**.
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
commit claimed) — exactly what a plain sheet read of the rollup root would
return, orphans included; the default is `'recompute'`. Because the stamp
covers the `.gitsheets/` directory too, a config edit is caught on read
whatever committed it: a gitsheets commit regenerates everything (above); one
committed by plain git leaves `configTree` mismatched, so reads recompute
until `materialize()` / `git sheet rollup` persists the result.

### Materializing explicitly

`rollupSheet.materialize()` recomputes every stale or missing rollup record
and deletes orphaned ones, in one transaction (or into the current one on a
transaction-bound sheet), returning `{ recomputed: string[], deleted: string[] }`
of partition paths. A no-op when everything is fresh (no commit). Here
**stale** means the stored bytes differ from the recomputed record — a stamp
mismatch, or an edited config or hand-edited value under a matching stamp —
so materializing recomputes every partition (it is the explicit repair, not
the hot path). **Orphaned** is a stored rollup record with no partition, or
whose partition holds no records. This is the
repair after a plain `git merge` or an external import, and the backfill
after adding a rollup config to a sheet with history.

`git sheet rollup <sheet>` is the CLI form; `--check` writes nothing, prints
one `<status> <partition>` line (`stale` / `missing` / `orphaned`) per
partition that is not fresh, and exits 1 if there are any — the CI gate for
data branches other tools write to.

### Merge and sync

- **`repo.merge` / `git sheet merge`** — rollup records never enter the record
  pass and never conflict. The rollup pass runs on the merged tree touching
  every `(prefix, partition)` whose source changed on either side since the
  base, **and** every rollup path the tree merge produced that differs from
  either parent (a both-sides edit, a conflict the merge could not resolve, a
  hand-edited file): each is regenerated from its partition, or deleted when
  the partition is gone. No unresolved rollup blob reaches a merge tree — dry
  runs included.
- **Merge driver** (plain `git merge`) — a file-at-a-time driver cannot
  regenerate; rollup files merged by git carry stale stamps that reads
  self-heal and `git sheet rollup` repairs.
- **`repo.sync` replay** — each replayed commit gets the pass against its new
  parent with the same rule: the `(prefix, partition)`s the replayed commit
  touched and every rollup path of the replayed tree that differs from the
  new parent's or from the original commit's are regenerated. A rollup file
  both sides changed is therefore not a replay conflict, so a local March
  commit replayed over a remote March commit carries a rollup over both sets
  of records — under any prefix.

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
