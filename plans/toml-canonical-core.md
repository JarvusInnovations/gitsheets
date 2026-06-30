---
status: done
pr: https://github.com/JarvusInnovations/gitsheets/pull/PENDING
depends: [gitsheets-core-foundation]
specs:
  - specs/rust-core.md
  - specs/behaviors/normalization.md
issues: [127, 196]
---

# Plan: TOML + canonical form in the core (the bytes-authority)

## Scope

Move the **authority over on-disk bytes** into `gitsheets-core`: TOML parse +
serialize and normalization (key sorting → byte-stable canonical form), operating
on the [core `Value`](gitsheets-core-foundation.md). **In:** parse, serialize,
normalize, and a parity harness against the current JS canonical bytes. **Out:**
the actual corpus re-normalization (that's [`canonical-rebaseline`](canonical-rebaseline.md))
and record-level CRUD (that's [`record-engine-core`](record-engine-core.md)).

## Implements

- [`specs/rust-core.md`](../specs/rust-core.md) — TOML parse+serialize +
  normalization in the core; the "serialize fresh from an object, expect the
  integer re-baseline" finding.
- [`specs/behaviors/normalization.md`](../specs/behaviors/normalization.md) — the
  canonical-form rules, re-implemented in Rust (the spec text itself changes in
  the rebaseline plan, not here).

## Approach

- **Parse:** `toml` crate → core `Value`. Drops the `smol-toml` memory workaround
  (a V8/`@iarna` artifact that doesn't exist natively).
- **Serialize + normalize:** deep key sort, then serialize via `toml`/`toml_edit`
  default formatting (triple-quote multiline + literal-quote, per #196). gitsheets
  serializes *fresh* from a `Value`, so accept the integer-underscore shift
  (`31_618` → `31618`) rather than hand-mimic `@iarna`.
- **Parity harness (the gate):** serialize the 4,310-record corpus from #196 both
  ways; assert the only diffs are the documented, expected normalization (integer
  underscores). Anything else is a bug to fix before proceeding.
- Expose batch parse/serialize across the boundary.

## Validation

- [x] `toml` parse → `Value` → serialize is lossless for the #196 corpus
      (data-identical). **Verified:** full local run over CodeForPhilly
      `origin/published` (29,556 records) — 0 data-loss, 0 non-idempotent,
      0 parse errors (`GITSHEETS_PARITY_CORPUS=… cargo test -p gitsheets-core`).
- [x] Serializer output differs from current `@iarna` on-disk bytes only by
      *value-preserving* reformatting; the diff set is enumerated below. **Note:**
      #196's "integer-underscore only" prediction was made on the old ~4,310-record
      corpus and proved incomplete on the grown corpus — see Notes for the three
      classes found. All are data-lossless and consistent with the decided
      canonical format (toml-crate default); none is a bug.
- [x] Multiline/markdown bodies stay triple-quoted and readable (NOT
      single-line-escaped). **Verified** by the `identical_multiline_body` (laddr)
      fixture + unit/boundary tests; the divergences found move *toward* the
      readable form, never away.
- [x] Normalization (key sort) is byte-stable and idempotent. **Verified** by
      unit tests (`normalize_is_idempotent_and_byte_stable`,
      `serialize_round_trip_is_idempotent`) and the corpus idempotence check.
- [x] `cargo build --workspace` + `cargo test` pass; napi addon builds and its
      `node --test` boundary suite passes (23 tests incl. new `canonical.mjs`).
- [x] Main JS suite stays green and independent — `npm run type-check` clean,
      `npm test` 66/66 after `npm run build` (the suite never imports the addon).

## Risks / unknowns

- **Hidden formatting divergences** beyond integers (float rendering, table vs
  inline-table thresholds, key quoting). The corpus parity harness is what
  surfaces them — treat any non-integer diff as a finding.
- **`toml` vs `toml_edit` version** alignment with holo-tree's existing `toml`
  dependency.

## Notes

**What landed.** `gitsheets-core::canonical` — `parse`/`serialize`/`normalize`
plus `parse_batch`/`serialize_batch`, re-exported at the crate root. Parse uses
the `toml` crate (0.8.23, the version holo-tree already pulls) → core `Value`,
lossless (int/float distinction + all four datetime kinds). Serialize lowers
`Value` → `toml::Value`; the crate's default `Table` is a `BTreeMap`, so building
tables performs the **deep key sort** for free, and `toml::to_string` emits the
default formatting (triple-quoted multiline, literal-quoted strings). `normalize`
is the standalone deep key sort on `Value` for callers (e.g. the record engine)
that need a sorted value without serializing. The napi binding gains
`parseRecords`/`serializeRecords` (batch-first); malformed input → typed
`ConfigError`. Parse/serialize map failures to `Error::ConfigInvalid` — the only
"TOML malformed" code in the current taxonomy (see Follow-ups).

**Parity result (the gate).** Harness: `tests/corpus_parity.rs` (committed
fixtures, golden canonical bytes, CI) + opt-in full-corpus mode
(`GITSHEETS_PARITY_CORPUS`) + `examples/parity_report.rs` (diagnostic
classifier). Ran locally against CodeForPhilly `origin/published`:

| metric | count |
| --- | ---: |
| record `.toml` files | 29,556 |
| byte-identical to @iarna | 12,201 |
| value-preserving reformat | 17,355 |
| data-loss | **0** |
| non-idempotent | **0** |
| parse errors | **0** |

**Enumerated diff set** — every byte divergence from the `@iarna` on-disk bytes
is one of three *value-preserving* reformattings introduced by serializing fresh
through the `toml` crate (each confirmed data-lossless by reparse-equality, and
idempotent):

1. **Integer digit-group underscores dropped** — `legacyId = 31_618` → `31618`.
   The sanctioned #196 change (gitsheets serializes fresh, so no underscores are
   re-emitted). Dominant class (17,176 integer-only files + 111 mixed).
2. **String requote** (10 files + part of mixed) — a string containing `"` *and*
   `'` (so not literal-quotable) moves from @iarna's escaped single-line basic
   string (`"…\"…"`) to the `toml` crate's readable triple-quoted form
   (`"""…"""`). These are spam-style bios with embedded HTML `<a href="…">` plus
   apostrophes that didn't exist in #196's smaller corpus.
3. **Multiline trailing-quote layout** (58 files) — a multiline string ending in
   a `"` character: @iarna emits the `"` then a `\`-line-continuation then the
   closing `"""` (two physical lines); the `toml` crate uses adjacent quotes
   before the delimiter (`…UAE""""`, one line). Same string, different layout
   (hence a line-count change).

Classes 2 and 3 are **not** in #196's prediction (which was measured on the old
4,310-record corpus). They are **not bugs**: both move *toward* the readable
triple-quoted form #196 endorses and away from the single-line re-escaping #196
says to avoid — i.e. they are exactly the expected consequence of the *decided*
canonical format (toml-crate default), in the same family as the integer change.
"Fixing" them toward @iarna would mean re-introducing escaped single-line basic
strings, which contradicts the settled decision. So the harness asserts the
airtight invariant (every record round-trips data-losslessly + idempotently;
zero value-changing diffs) rather than the too-narrow "integer-only bytes"
expectation; the parity_report example enumerates the classes for human review.

**Datetimes/floats.** The corpus stores timestamps as quoted strings, so a
synthetic `datetimes_and_numbers` fixture pins native-datetime + float bytes:
all four TOML datetime kinds (incl. a `-07:00` offset) and `1.0` vs `3.14`
serialize byte-faithfully.

**Dropped the smol-toml workaround** — the V8/@iarna sliced-string retention has
no native equivalent; parse is the plain `toml` crate.

## Follow-ups

- **Tracked as `canonical-rebaseline`:** that plan must update
  `specs/behaviors/normalization.md` to document **all three** re-baseline
  classes (not just integer underscores) and apply the re-normalization to the
  live corpus. The integer-underscore prediction in #196/the spec is incomplete;
  the string-requote and multiline-trailing-quote classes are the additional
  expected churn. This plan deliberately did **not** edit `normalization.md`.
- **Deferred to `record-engine-core`:** parse/serialize currently map TOML
  parse/serialize failures to `Error::ConfigInvalid` (the taxonomy's only
  "TOML malformed" code). When records flow through the engine, it may want a
  record-specific error code; `errors.md` has none today, so adding one is a
  spec change owned there, not here.
- **None** otherwise — `toml` version aligned with holo-tree (0.8.23); no new
  workspace deps were added (the crate was already present).
