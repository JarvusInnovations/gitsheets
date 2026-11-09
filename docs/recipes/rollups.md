# Rollups (stored aggregates)

A ledger sheet answers "what did we spend in March?" with an aggregate:
[`sheet.aggregate`](../api.md#aggregation) walks March's records and folds
them. That is fine for one question. When a dashboard asks it on every page
load, or you want the monthly totals to show up in `git diff` next to the
transactions that moved them, store them: declare a **rollup sheet**.

A rollup sheet holds one record per **partition** of a source sheet (a year,
a month, a domain, or the whole sheet). gitsheets writes those records in the
same commit as the record changes that affect them, and stamps each with the
git tree id of the partition it summarizes, so a stale one is a single hash
comparison away.

## The source

```toml
# .gitsheets/transactions.toml
[gitsheet]
root = 'transactions'
path = '${{ postedAt: YYYY/MM }}/${{ id }}'
```

Records land at `transactions/2026/03/t-1042.toml`. The month directory is the
partition the rollup rides on.

## The rollup

```toml
# .gitsheets/transactions-monthly.toml
[gitsheet]
root = 'transactions-monthly'
path = '${{ postedAt: YYYY/MM }}'           # a proper prefix of the source's path

[gitsheet.rollup]
from = 'transactions'

[gitsheet.rollup.aggregates]
count      = { count = true }
total      = { sum = 'amountCents' }
largest    = { max = 'amountCents' }
posted     = { sum = 'amountCents', where = { status = 'posted' } }
byCategory = { sum = 'amountCents', groupBy = 'category' }
```

Commit both configs, then write transactions as usual:

```typescript
import { openRepo } from 'gitsheets';

const repo = await openRepo();
await repo.transact({ message: 'import March statement' }, async (tx) => {
  const ledger = tx.sheet('transactions');
  await ledger.upsert({ id: 't-1042', postedAt: new Date('2026-03-05T09:00:00Z'), amountCents: 1200, status: 'posted', category: 'groceries' });
  await ledger.upsert({ id: 't-1043', postedAt: new Date('2026-03-20T09:00:00Z'), amountCents: 240000, status: 'posted', category: 'rent' });
});
```

That one commit carries the two transactions **and**:

```toml
# transactions-monthly/2026/03.toml
count = 2
largest = 240000
posted = 241200
postedAt = 2026-03-01
sourceTree = "9f8e1c…"
total = 241200

[byCategory]
groceries = 1200
rent = 240000
```

- `postedAt` is the **key field**: the first day of the period, as a TOML
  local date. A plain-field partition (`${{ domain }}`) carries the field's
  value instead.
- `sourceTree` is the stamp — `git rev-parse HEAD:transactions/2026/03`.
- An aggregate with nothing to fold is left out, except `count` and `sum`
  (`0`).

Only the partitions a commit touches are regenerated. A transaction that adds
one February record rewrites `transactions-monthly/2026/02.toml` and nothing
else; deleting a month's last record deletes its rollup in the same commit.

## Reading

A rollup sheet reads like any sheet, and pruning works on the key field:

```typescript
const monthly = await repo.openSheet('transactions-monthly');

const q1 = await monthly.queryAll({ postedAt: { $gte: '2026-01-01', $lt: '2026-04-01' } });
const march = await monthly.get('2026/03');
```

Reads are always correct. For each partition, gitsheets compares the stored
record's `sourceTree` with the partition's current tree id: a match is served
as stored (one small blob read); a mismatch is recomputed from the
transactions on the fly, without writing. Pass `{ stale: 'serve' }` to see
exactly what the commit stored instead.

## Keeping them fresh after outside writes

Every commit gitsheets makes keeps the rollups fresh: transactions, permissive
writes, `repo.merge` / `git sheet merge`, and every commit `repo.sync`
replays. A plain `git merge`, a hand edit, or an import by another tool leaves
stale stamps. Reads still self-heal; to persist the fix:

```bash
git sheet rollup transactions-monthly --check   # CI gate: lists stale / missing / orphaned, exit 1 if any
git sheet rollup transactions-monthly           # recompute + delete orphans, one commit
```

or `await monthly.materialize()` from code. The same command backfills a
rollup added to a sheet with history (a gitsheets transaction that adds the
config backfills in that commit too).

## Partitions you can declare

- **A shorter date bucket** — `${{ postedAt: YYYY }}` over a `YYYY/MM/DD`
  source rolls up by year. A `YYYY/WW` (ISO week) bucket can only be rolled up
  whole.
- **A plain field** — `${{ domain }}` over `${{ domain }}/${{ slug }}`.
- **The whole sheet** — a literal path, `path = 'all'`, yields one record.
  Every transaction that touches the source rescans it, so prefer integer
  aggregates (`count`, integer `sum`, `min`, `max`) there.

Expression components, recursive `**` components, and anything that is not a
prefix of the source's path are rejected when the sheet is opened.

## Things to know

- **Rollup sheets are read-only.** `upsert`, `delete`, `patch`, `clear`, and
  the attachment writers throw `TransactionError` (`sheet_derived`).
- **A failing aggregate aborts the commit.** Mixed kinds under `max`, an
  overflowing integer `sum`, or a throwing `reduce` raise `AggregationError`
  naming the rollup sheet, the aggregate, and the partition — and nothing is
  committed.
- **`reduce` is allowed and deterministic.** It runs in the core's embedded
  engine with no clock or randomness (`Date.now()`, `Math.random()`, and an
  argument-less `new Date()` throw), so Node and Python commit identical bytes.
- **Floats don't compose.** A yearly float total is not promised to equal the
  sum of its monthly float totals. Store money in integer cents.
- **Add a schema to catch typos.** A `[gitsheet.schema]` on the rollup sheet
  validates every generated record, so a misnamed aggregate fails loudly.

→ [`specs/behaviors/rollups.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/rollups.md)
