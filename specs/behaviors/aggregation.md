# Behavior: Aggregation

## Rule

A sheet can answer **aggregate questions** — a count, a sum, the extremes, an
average, the distinct values of a field, or an arbitrary fold — over the
records matching a query filter, through one declarative grammar evaluated
**in the core** so every binding gets the same answer to the bit. The same
grammar is what persisted rollups (`behaviors/rollups.md`, a separate
feature) are declared in; this spec defines the grammar and its evaluation,
and the ad-hoc, query-time surface: `sheet.aggregate(filter, aggregates)`,
`git sheet aggregate`, and the `gitsheets-axi` twins
([#223](https://github.com/JarvusInnovations/gitsheets/issues/223)).

## Applies To

- [api/sheet.md](../api/sheet.md) — `sheet.aggregate`
- [api/cli.md](../api/cli.md) — `git sheet aggregate`
- [api/errors.md](../api/errors.md) — `AggregationError`
- [rust-core.md](../rust-core.md) — aggregation lives in the core; `reduce`
  is embedded code

## Details

### Aggregate forms

Declarative forms are evaluated natively in the core; `reduce` is the
embedded-code escape hatch ([rust-core.md](../rust-core.md#embedded-code-execution)).
An **aggregates table** maps a result name to one form each:

| Form | Contributing values | Result |
| --- | --- | --- |
| `{ count = true }` | every record | integer |
| `{ sum = 'f' }` | records whose `f` is an integer or float | integer when every contributing value is an integer, else float |
| `{ avg = 'f' }` | as `sum` | float (`sum / count` over contributing records) |
| `{ min = 'f' }` / `{ max = 'f' }` | records whose `f` is a number, string, or datetime | the extreme, by the kind's ordering ([api/sheet.md § ranges](../api/sheet.md#sheetqueryfilter-opts)); mixed kinds is `AggregationError` |
| `{ distinct = 'f' }` | records whose `f` is a scalar | sorted array of the distinct values (numbers numerically, strings by byte order, datetimes chronologically); mixed kinds is `AggregationError` |
| `{ reduce = '<body>', initial = <value>, finalize = '<body>' }` | every record | whatever `finalize` (or the fold) returns — must be a TOML-representable value |

Modifiers, allowed on every form:

- **`where = { … }`** — an equality filter in the `query` filter grammar
  (values and ranges; no functions), applied before aggregating. Records that
  do not match do not contribute.
- **`groupBy = 'g'`** — the result is a table keyed by the string form of each
  record's `g` (string, integer, or boolean; records lacking a scalar `g` do
  not contribute), each value the aggregate over that group. Empty groups do
  not appear.

Edge rules the table above leaves implicit:

- **Fields** (`'f'`, `'g'`) name a top-level record field.
- **`sum`** of integers is exact; an integer total outside the signed 64-bit
  range is `AggregationError`. Once any contributing value is a float, the
  result is the float fold `acc + v` from `0.0` over every contributing value
  (integers converted), in canonical path order. **`avg`** is that `sum`, as a
  float, divided by the contributing count.
- **`min` / `max`** keep the first of several equal extremes in canonical path
  order. Integers and floats are one kind (numbers). Two datetimes the ordering
  cannot compare (a local time against a date or datetime) count as mixed
  kinds.
- **`distinct`** treats values that compare equal as one value (`1` and `1.0`;
  one instant written at two offsets) and keeps the first in canonical path
  order. Booleans are a kind of their own and sort `false` before `true`.
- **A grouped aggregate** is always a table, `{}` when no group has a
  contributing record. A group appears only when at least one of its records
  contributes to the form, so a grouped `sum` leaves out a group whose records
  carry no number in `f`.
- **A `reduce` result** crosses back from the engine the way a host value
  crosses the binding boundary: a JS number that is an exact integer within
  ±(2^53 − 1) is a TOML integer, any other number a float; a `Date` is an
  offset datetime at UTC; arrays and plain objects become arrays and tables,
  with `null`/`undefined`-valued keys dropped. `null`/`undefined` itself, a
  `null`/`undefined` array element, a function, a symbol, or any other object
  is not TOML-representable. Between calls `acc` stays a live engine value, so
  a body may mutate and return it; each group starts from its own copy of
  `initial`.

`reduce` is the body of `(acc, record) => { … }`, called once per
contributing record in canonical path order with `acc` starting at `initial`
(required; any TOML value). `finalize`, optional, is the body of
`(acc) => { … }` run once at the end. The snippet must be pure: no clock, no
randomness, no I/O. It runs in the core's embedded engine, so a Python caller
and a Node caller get identical results — required because aggregate results
can be committed (as persisted rollups) and must be byte-identical across
bindings, which is why this escape hatch cannot run in the host runtime the
way sort comparators still do on the Node binding today. A throw, or a result
that is not TOML-representable, is `AggregationError`.

The grammar is spelled in TOML in a sheet config and in the binding's idiom
at a call site (`{ sum: 'f', where: { … }, groupBy: 'g' }`); the two are the
same `Value` table.

### Canonical computation

An aggregate result is a pure function of the contributing record set:

1. The records are read body-less (an aggregate — its field, `groupBy`, or a
   `where` key — and an ad-hoc call's filter may not reference a content-typed
   sheet's body field — `TypeError` at the call site, `ConfigError` in a
   config), **in canonical path order** — the byte order
   of the full record path, i.e. the order a tree walk yields. Attachments
   and non-record files are not records.
2. Each aggregate folds over those records in that order. The order is part
   of the contract because floating-point folds are order-dependent.
3. The result is a `Value` table with one entry per aggregate name. An
   aggregate with no contributing records is **omitted** (TOML has no null)
   except `count` (`0`) and `sum` (`0`).

An engine **may** compute a result incrementally or by composing partial
results, but **only where the outcome is bit-identical** to the fold above —
count, integer `sum`, `min`, `max`, `distinct`. Float `sum`/`avg` and
`reduce` always fold over the records. Consumers who need totals to compose
exactly across groupings store integers (cents).

### Ad-hoc aggregation (query time)

```typescript
const r = await sheet.aggregate(
  { postedAt: { $gte: '2026-01-01' } },          // the query filter; pruned like `query`
  {
    count: { count: true },
    total: { sum: 'amountCents' },
    byStatus: { count: true, groupBy: 'status' },
  },
);
// → { count: 1402, total: 98231100, byStatus: { posted: 1390, pending: 12 } }
```

- Every form and modifier above is accepted, including `reduce` / `initial`
  / `finalize`.
- The contributing set is the records matching `filter`, pruned by the path
  template exactly as `query` is; evaluation follows "Canonical computation".
  On the Node binding the filter may carry function predicates as on `query`:
  they run host-side to decide which records match, and the core folds over
  exactly those records (re-read in the core, so the fold sees the core's
  values, not the host's projection of them).
- Nothing is persisted. `opts.signal` cancels as on `query`: it is checked
  before the call starts and before the result is returned (the fold itself
  is one synchronous core call).
- The CLI form is `git sheet aggregate <sheet> [--filter …] --agg <name>=<form>[:<field>] … [--group-by <field>]`
  ([api/cli.md](../api/cli.md#git-sheet-aggregate-sheet)); `gitsheets-axi`
  mirrors it and gains `query --group-by`.

## Coordinates with

- [api/sheet.md](../api/sheet.md)
- [api/cli.md](../api/cli.md)
- [api/errors.md](../api/errors.md)
- [behaviors/path-templates.md](path-templates.md) — pruning of the
  contributing set
- [rust-core.md](../rust-core.md)
