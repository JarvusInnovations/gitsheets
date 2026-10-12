---
status: in-progress
depends: [core-native-record-reads]
specs:
  - specs/api/sheet.md
  - specs/api/cli.md
issues: [289, 290]
---

# Plan: by-path reads and a single-transaction bulk preflight

## Scope

The host-side half of #289 and #290, on top of `core-native-record-reads`
(which removed the per-record subprocess cost underneath):

- **`Sheet.get(path, opts?)`** — read one record by its rendered path with a
  single blob read (committed ref *or* a transaction's private tree). The
  library primitive behind every "read one record" surface.
- **`git sheet read` and `gitsheets-axi read`** use it instead of iterating
  `query()` until the path matches.
- **`gitsheets-axi query` / `count` / `distinct` read body-less** on
  content-typed sheets unless something needs bodies: a `--filter` clause on
  the body field, `--fields` naming it, or an export flag (`--json-out` /
  `--ndjson-out`, whose round-trip contract is the verbatim record). The TOON
  preview never shows bodies.
- **Bulk `gitsheets-axi patch` preflights inside the one real transaction**:
  per-row resolve + `willChange` on the tx-bound sheet (pruned lookups, no
  throwaway core transaction per row), then applies in the same handler. A
  dry run, an invalid row, or an abort-on-missing throws a sentinel the
  command catches, so nothing commits. Progress goes to stderr every 100 rows
  once a batch exceeds 200 rows.

Out of scope:

- A `--limit` short-circuit for `query` (#289 item 3). The core returns the
  pruned, body-less result set in one call; after this plan a 4,300-record
  listing is a sub-second parse, so an early exit would save nothing
  measurable. Recorded as superseded in Follow-ups.
- Python: `record_read` already reads by path; a `body_field` kwarg for
  content-typed reads is a one-line parity add if a consumer asks.

## Implements

- `specs/api/sheet.md` — `sheet.get(path, opts?)`.
- `specs/api/cli.md` — `git sheet read` reads by path (no behavior change
  visible to the user; the implementation note).

## Approach

1. **Core**: `Sheet::read_one(repo, tree, record_path, with_body)` (blob entry
   - codec). **napi**: `CoreTransaction.readRecord(name, path, withBody)`.
2. **Host `Sheet.get`**: committed ref → `readTreeBlobText` on
   `<base>/<path><ext>` + the existing record parser (path/sheet symbols
   annotated); tx-bound → `coreTx.readRecord`. `undefined` on absent.
3. **CLI `read`** (`git sheet read`, `gitsheets-axi read`): `sheet.get(target)`;
   drop the scan loops. The axi `read` already hydrates the body when
   missing — with `get` the body is present, so the hydrate is a no-op.
4. **axi body-less reads**: a `needsBodies(config, flags)` helper in
   `util/open-sheet.ts` (or `util/filter.ts`): true when the body field
   appears in any `--filter` clause, in `--fields`, or an export is
   requested. `query`, `count`, `distinct` pass `withBody: needsBodies(...)`.
5. **axi bulk patch**: restructure `batchPatch` so the preflight loop runs
   inside `repo.transact`'s handler against `tx.sheet(name)`; collect the same
   `changes` / `inserts` / `missing` / `invalid` sets; apply in the same
   handler; throw `class BatchHalt extends Error { kind: 'dry-run' | 'invalid' | 'missing' | 'no-op' }`
   to discard; the caller renders the same outputs as today. Progress:
   `process.stderr.write` every 100 rows when `records.length > 200`.
6. **Docs**: `docs/api.md` + skill `references/api.md` gain the `get` row;
   `docs/axi.md` + skill `references/axi.md` note body-less reads and the
   preflight.
7. **Benchmark** on the same 4,300-record markdown sheet: `read`, `query
   --limit 1`, `patch --dry-run` 100 rows, `patch` 100 rows.

## Validation

- [ ] `cargo test`: `Sheet::read_one` with/without body, absent path, subtree.
- [ ] napi `node --test`: `CoreTransaction.readRecord` sees a staged record.
- [ ] vitest (`gitsheets`): `sheet.get` on TOML and markdown sheets (withBody
      both ways), tx-bound `get` sees an uncommitted upsert, `undefined` on a
      missing path and on an attachment path; `git sheet read` still works.
- [ ] vitest (`gitsheets-axi`): `read` returns the full record incl. body;
      `query` on a markdown sheet omits bodies from the preview and includes
      them in `--ndjson-out`; a `--filter body~…` clause still matches;
      bulk `patch --dry-run` leaves no commit and reports the same counts;
      bulk `patch` commits once; the existing bulk-patch suite passes.
- [ ] Benchmark recorded in Notes; `patch --dry-run` 100 rows is faster than
      before `core-native-record-reads` (3.0 s), not slower.
- [ ] `npm run type-check` clean; `cargo clippy --workspace -D warnings` clean.

## Risks / unknowns

- **Holding the writer lock during preflight** — the bulk preflight now runs
  inside `repo.transact`, so the single-writer mutex is held for the whole
  batch instead of just the apply. Acceptable for the CLI (one writer by
  premise), and it removes a window where a concurrent writer could change
  the sheet between preflight and apply.
- **Dry-run via a throw** — `repo.transact` rethrows handler errors after
  discarding; the sentinel must be caught before `translateError` wraps it.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
