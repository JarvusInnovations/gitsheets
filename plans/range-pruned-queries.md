---
status: done
depends: [date-bucket-path-keys]
specs:
  - specs/api/sheet.md
  - specs/behaviors/path-templates.md
  - specs/api/cli.md
  - specs/deferred.md
issues: [291]
pr: 292
---

# Plan: range-pruned queries on date-bucket path keys

## Scope

Implement the follow-up that `date-bucket-path-keys` deferred
([#291](https://github.com/JarvusInnovations/gitsheets/issues/291)): a
declarative **range** filter entry on `Sheet.query`, and a query walk that
turns a range on a **date-bucket** path field into a bounded trie scan over
the partition tree instead of walking every partition.

```typescript
await posts.queryAll({ publishedAt: { $gte: '2026-01-01', $lt: '2026-04-01' } });
// template '${{ publishedAt: YYYY/MM/DD }}/${{ slug }}' → reads 2026/01, 2026/02, 2026/03 only
```

In scope:

- `FilterPred::Range` in the core: `$gt` / `$gte` / `$lt` / `$lte`, evaluated
  natively (numbers numerically incl. int↔float, strings lexicographically,
  datetimes chronologically; an accepted-ISO string bound compares
  chronologically against a datetime field).
- Planner + walk: a bounded `QueryComponentPlan` for bucket components with
  per-prefix lower/upper constraints; inclusive-at-date-level (superset) rule.
- Bindings: napi + pyo3 recognize the `$`-keyed range object (before the
  nested-table fallback) in both `recordQuery` and `recordQueryCandidates`.
- Host: `QueryFilter` type gains the range object; host-side `queryMatches`
  (markdown + tx paths) applies ranges identically; range objects survive
  `stripFilterFunctions`.
- `git sheet query --filter` ordered-operator forms.
- `gitsheets-axi query` pushes its existing ordered clauses on bucket fields
  down to the core filter so the walk prunes (host post-filter stays
  authoritative).
- Docs: `docs/path-templates.md`, `docs/cli.md`, `docs/axi.md`, `docs/api.md`.

Out of scope:

- `$in` / `$or` — still deferred (`specs/deferred.md`).
- Pruning on non-bucket components (plain field / expression) — spec'd as
  widening; could be a later plan for zero-padded integer keys if a consumer
  needs it.
- Range pruning on a bucket field referenced through a nested table
  (`${{ meta.date: YYYY }}`) — widens, matching the existing nested-equality
  behavior.
- Changing the host `Template.queryTree` public export (equality-only, not on
  the production read path since the cutover).

## Implements

- `specs/api/sheet.md` — "Range filter entries" bullets under
  `sheet.query(filter?, opts?)`.
- `specs/behaviors/path-templates.md` — "Range-pruned traversal", the bounded
  case in "Query traversal § Algorithm", and "Range filter entries".
- `specs/api/cli.md` — `--filter` comparison forms.
- `specs/deferred.md` — "Richer query operators" narrowed to `$in` / `$or`.

## Approach

1. **Core filter** (`rust/gitsheets-core/src/query.rs`): add
   `FilterPred::Range(Range)` with `lower: Option<Bound>` /
   `upper: Option<Bound>` (value + inclusive flag). `matches` compares
   via a `compare_values(field, bound) -> Option<Ordering>`: Integer/Float
   numeric, String/String lexicographic, Datetime/Datetime chronological
   (both reduced to a UTC `NaiveDateTime`; local-date → midnight; local-time
   → incomparable), Datetime field / String bound via the bucket ISO parse.
   `prune_record` emits a range entry as a `$`-keyed `Value::Table` under the
   field — the single wire form shared with `query_candidate_paths`' `query`
   argument.
2. **Planner** (`path_template.rs`): `QueryComponentPlan` grows a
   `bounds: Option<Bounds { lo: Option<String>, hi: Option<String>, token: usize }>`
   alongside `rendered`. In `plan_query`, a component that is exactly one
   `Part::Bucket` whose field maps to a `$`-keyed table renders each bound's
   date (via the existing bucket date reduction) with `render_bucket_unit`.
   `token` is the bucket token's index (assigned at parse) so the walk can
   reset its boundary tracking between distinct bucket tokens.
3. **Walk** (`walk_query`): carry a `BoundTrack { token, on_lo, on_hi }`. At
   a bounded intermediate: list subtrees; skip `name < lo` while `on_lo`,
   skip `name > hi` while `on_hi`; recurse with `on_lo && name == lo`,
   `on_hi && name == hi`. At a bounded leaf: the same test over the bare
   record names. Exact / wildcard components pass the tracking through
   unchanged; a component from a different token resets it.
4. **Bindings**: `parse_filter_pred` in both napi and pyo3 checks for any
   `$`-prefixed key first — `$pred` → predicate (unchanged), range keys →
   `Range`, anything else / a mix → `ConfigInvalid` surfaced as `TypeError`
   host-side. `JsValue`/`py_to_value` already marshal the nested object for
   the candidates path.
5. **Host**: `QueryFilter<T>` value union gains `RangeFilter<T[K]>`;
   `queryMatches` evaluates range objects with the same kind rules (Date vs
   ISO string via a regex-based UTC parse, never `Date.parse` on offset-less
   input); `stripFilterFunctions` passes range objects through verbatim.
   Reject malformed `$` objects at query start with `TypeError`.
6. **CLI**: `--filter` coerce parses `>=`, `<=`, `>`, `<`, `=` longest-first;
   comparison clauses accumulate into one range object per field.
7. **axi**: in `query` / `count` / `distinct`, derive the bucket fields from
   `config.path` (the `${{ field: YYYY… }}` grammar), translate ordered
   `--filter` clauses on those fields into a core range filter passed to
   `queryAll`, keep `buildPredicate` as the authoritative post-filter.
8. **Docs** as listed in Scope.

## Validation

- [x] `cargo test` (core): range `matches` across kinds (int/float, string,
      datetime/datetime, datetime/ISO-string, mismatched → no match); planner
      renders lo/hi segments for every bucket format incl. ISO-week bounds;
      candidate walk on a year-spanning range visits exactly the in-range
      partitions; one-sided ranges; superset rule (`$lt` midnight still visits
      that day's partition, record filter excludes it); wrong-typed bound
      widens to wildcard; non-bucket range does not prune.
- [x] `cargo clippy -D warnings` clean (whole workspace).
- [x] napi `node --test`: `recordQueryCandidates` with a range object returns
      the pinned bounded set; `recordQuery` end-to-end applies the exact
      cutoff; malformed `$` object rejected.
- [x] pytest: same cases through the Python binding (dict form), byte-identical
      results to the napi run (cross-binding parity suite green).
- [x] vitest (`gitsheets`): end-to-end range query on a bucketed sheet (TOML
      and markdown) returns the right records; `count` honors a range; range
      on a tx-bound sheet applies host-side; `QueryFilter` type accepts the
      range object; malformed `$` object throws `TypeError`.
- [x] vitest (`gitsheets`, CLI): `git sheet query --filter 'f>=v'` builds a
      range entry.
- [x] vitest (`gitsheets-axi`): ordered clauses on a bucket field reach the
      core filter; results identical to the post-filter-only path.
- [x] `npm run type-check` clean.
- [x] Docs updated (`path-templates.md`, `cli.md`, `axi.md`, `api.md`).

## Risks / unknowns

- **Boundary tracking across templates with multiple bucket tokens** — the
  `token` reset exists for this; covered by a two-bucket test.
- **ISO-week bounds** — a range's lower bound in calendar terms maps to an
  ISO week-year/week pair that can precede the calendar year (2027-01-01 →
  `2026/53`); rendering both bounds through `iso_week()` keeps the scan
  consistent with how records were written.
- **axi semantic drift** — the core's range comparison must never drop a
  record the axi host predicate would keep (the core result feeds the
  post-filter). Mitigated by pushing only clauses on bucket fields (always
  date-valued) and by the ISO-string-vs-datetime rule.
- **Core change ⇒ release ordering** — needs a `core-napi-v*` release before
  the next `gitsheets` npm release (CLAUDE.md "Releases").

## Notes

- **Offset-less datetime bounds are not pushed down by axi.** `Date.parse`
  reads `2026-01-01T10:00:00` in the host timezone while the core reads it
  as UTC, so a pushed `<` bound could cut records the host predicate keeps.
  Date-only and offset/`Z`-qualified bounds agree on both sides and are the
  only ones pushed (`PUSHDOWN_BOUND_RE` in `packages/gitsheets-axi/src/util/filter.ts`).
- **Schema-less sheets store ISO strings, not datetimes.** A JSON upsert of
  `"2025-11-20T00:00:00Z"` into a sheet with no schema lands as a TOML
  string, so a range on it compares lexicographically on both the core and
  axi sides (`"…T00:00:00Z" > "2025-11-20"`). Consistent, but a reader
  expecting instant semantics should give the field a date-time schema.
  Bucket *pruning* is unaffected (buckets accept ISO strings).
- **`$gt`/`$gte` on one side (or `$lt`/`$lte`) is rejected**, not merged —
  one bound per side keeps the wire form unambiguous across bindings.
- The host `Template.queryTree` export stays equality-only; the napi parity
  suite pins range expectations directly against the core instead of the JS
  reference transcription (`_ref-query.mjs` is unchanged).
- **axi tests on devbox**: four pre-existing export tests fail there because
  `/tmp/gitsheets-axi` is owned by another user (EACCES); green with
  `TMPDIR` overridden. Environmental, not a code issue.
- Workspace vitest for `gitsheets-axi` resolves `gitsheets` through
  `packages/gitsheets/dist`, so `npm run build` is required after library
  changes before the axi suite sees them.

## Follow-ups

- Tracked as: range pruning on zero-padded non-bucket path keys (e.g. a
  `${{ year }}` field holding a four-digit string) — spec'd as widening for
  now; worth its own plan if a consumer shows a partitioned sheet keyed that
  way. Noted in `specs/behaviors/path-templates.md` "Range filter entries".
