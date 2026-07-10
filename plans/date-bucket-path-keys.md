---
status: in-progress
depends: []
specs:
  - specs/behaviors/path-templates.md
issues: [252]
---

# Plan: declarative date-bucket path keys

## Scope

Implement the date-bucket path-template reference specced in
`specs/behaviors/path-templates.md` § "Date-bucket references"
([#252](https://github.com/JarvusInnovations/gitsheets/issues/252)):

```toml
path = '${{ publishedAt: YYYY/MM/DD }}/${{ slug }}'
```

- Closed format enum (`YYYY`, `YYYY/MM`, `YYYY/MM/DD`, `YYYY/WW`); anything
  else in the format position → `ConfigError('config_invalid')` at sheet-open.
- UTC-always rendering; `YYYY/WW` = ISO-8601 week + ISO week-based year;
  two-digit zero-padding for `MM`/`DD`/`WW`.
- One token → multiple real path segments, composing with the existing
  query-tree pruning walk (present field prunes; absent field wildcards).
- Implemented in the Rust core (native chrono rendering, no boa involvement)
  **and** the host TS `Template` (public export, used by `pathForRecord` and
  `getFieldNames`), byte-identical.

Out of scope:

- **Range-pruned queries** (date-range filters mapped onto bounded subtree
  walks) — the follow-up the declarative form enables; noted in the spec and
  tracked on [#252](https://github.com/JarvusInnovations/gitsheets/issues/252).
- Any change to bare `${{ dateField }}` rendering (the host-side `.toString()`
  wart stands for non-bucket references, per the spec's rejected-alternative
  note).
- New format-enum members (`HH` time buckets, quarter buckets, …) — the enum
  is deliberately closed; fancier needs use the expression form.

## Implements

- `specs/behaviors/path-templates.md` — "Date-bucket references" (grammar,
  rendering semantics, query-traversal semantics, backward compatibility) and
  the date-bucket line item in "Query traversal § Algorithm".

## Approach

1. **Rust core** (`rust/gitsheets-core/src/path_template.rs`): recognize the
   bucket form during template parse, **before** the expression fallback —
   content matching `ident(.ident)*: <format>` is a bucket attempt; a valid
   format expands into one `Part::Bucket { field, unit }` component per
   format part (`CalendarYear`/`Month`/`Day` | `IsoWeekYear`/`IsoWeek`); an
   invalid format is `Error::ConfigInvalid` (surfaces at `Sheet::open`, which
   compiles the template). A bucket must stand alone in its segment.
   Rendering is native via `chrono` (no boa): TOML datetimes normalize
   offset → UTC before date-part extraction; ISO 8601 strings parse via
   chrono; `iso_week()` for `YYYY/WW`. Wrong-typed values →
   `PathRenderFailed` at render; missing field → un-renderable. In
   `plan_query`, a wrong-typed/unparseable query value degrades to
   un-renderable (wildcard walk) instead of erroring, matching how opaque
   filter values widen the walk today.
2. **Query pruning** (`rust/gitsheets-core/src/query.rs`): include
   `Value::Datetime` in `prune_record`'s scalar set so a datetime-valued
   equality filter reaches the bucket components and prunes the walk.
3. **Host TS renderer** (`packages/gitsheets/src/path-template/index.ts`):
   mirror the parser rule and add a `bucket` part kind; render from JS `Date`
   (UTC accessors) and ISO strings — offset-less strings are read literally
   (never `new Date(...)`, which would consult the host timezone); ISO week
   via the standard nearest-Thursday algorithm, matching chrono exactly.
   Invalid format → `ConfigError('config_invalid')`; `getFieldNames`
   contributes the bucket's (base) field name.
4. **napi reference renderer** (`rust/gitsheets-napi/test/_ref-path-template.mjs`):
   extend in lockstep (it is the parity oracle), plus bucket corpus cases and
   error cases in `test/path-template.mjs`, and a bucket-pruning walk case in
   `test/record-query.mjs`.
5. **Python cross-binding parity**: bucket render cases over the same core via
   `render_paths_batch` in `rust/gitsheets-py` tests if the harness builds
   cheaply in this environment.
6. **Package tests**: vitest cases in `path-template/index.test.ts` (each
   format, padding, ISO week-year boundaries, string vs Date inputs,
   rejections, config-time enum validation) plus an end-to-end sheet
   write/query with a bucketed config.
7. **Docs**: extend `docs/path-templates.md` with the bucket form and
   day/week/month examples.

## Validation

- [ ] `cargo test` green across the workspace, including new core cases: each
  format; zero-padding; ISO week-year boundaries (2027-01-01 → `2026/53`,
  2024-12-30 → `2025/01`); offset-datetime UTC conversion; string vs datetime
  inputs; wrong-type and unparseable-string rejection; invalid-format
  `config_invalid` at compile; bucket-must-stand-alone rejection; bucket
  pruning + wildcard walk in `query.rs`
- [ ] napi suite green (`node --test`), including bucket parity vs the
  reference renderer and the error-path cases
- [ ] Package vitest suite green, including TS `Template` bucket cases and an
  end-to-end bucketed sheet upsert/query through the core
- [ ] `npm run type-check` clean
- [ ] `docs/path-templates.md` documents the bucket forms with day/month/week
  examples

## Risks / unknowns

- **Multi-segment expansion vs the walk** — the walk machinery is strictly
  one-component-per-tree-level, so expansion must happen at parse time (one
  bucket token → N components), not at render time. Mitigated by expanding in
  the parser; `component_count` and the walk see ordinary components.
- **ISO-week parity between chrono and the TS implementation** — hand-rolled
  TS week math could diverge from `iso_week()` on boundary dates. Mitigated
  with boundary-date tests on both sides and napi parity cases.
- **`prune_record` widening** — admitting datetimes into the prune record
  also exposes them to expression components at plan time (previously they
  were stripped, so expressions were un-renderable and the walk widened).
  Rendered plans stay consistent with write-time renders (same engine, same
  marshal), so results are identical and pruning only improves; the
  divergence note in `query.rs` is updated.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
