---
status: planned
depends: [rollup-sheets]
specs:
  - specs/behaviors/rollups.md
  - specs/api/python-binding.md
issues: [342, 240]
---

# Plan: rollup and aggregate surface on the Python binding

## Scope

Expose on `rust/gitsheets-py` what the core now does: `record_aggregate`
(ad-hoc), reads of rollup sheets going through the stamped read-through
(`record_query` on a rollup sheet, `stale=` keyword), `materialize_rollups`,
and the write-refusal error mapping (`sheet_derived`, `RollupError`). The
commit-time pass already runs inside `transact` because it lives in the core;
this plan is the explicit Python API plus parity tests and README.

Out of scope: an object-oriented Python API (the binding stays batch-first
per `specs/api/python-binding.md`).

## Implements

- `specs/behaviors/rollups.md` — every surface, Python idiom.
- `specs/api/python-binding.md` — the new module-level functions.

## Approach

1. pyo3 wrappers over `aggregate::fold` entry points and `rollup::materialize`;
   `stale` as a keyword on `record_query`.
2. Error classes: `RollupError` with `sheet` / `partition` / `aggregate`
   attributes; `TransactionError` code `sheet_derived`.
3. Parity tests in `rust-core.yml`: the fixture repo written from Python and
   from Node yields identical rollup blobs and identical `aggregate`
   results.
4. README section with the `transactions-monthly` example.

## Validation

- [ ] `maturin develop` + pytest cover aggregate, rollup read-through
  (fresh and stale), materialize, and refused writes.
- [ ] Parity job green.
- [ ] `specs/api/python-binding.md` lists the functions; README updated.

## Risks / unknowns

- **pyo3 marshalling of aggregate specs** (nested dicts with `where`
  filters) must reuse the existing `Value` conversion so range filters and
  datetimes behave as in `record_query`.

## Notes

## Follow-ups
