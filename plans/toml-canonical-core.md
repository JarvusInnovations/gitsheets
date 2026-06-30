---
status: planned
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

- [ ] `toml` parse → `Value` → serialize is lossless for the #196 corpus
      (data-identical).
- [ ] Serializer output differs from current `@iarna` on-disk bytes **only** by
      the documented normalization (integer underscores); the diff is enumerated
      and matches #196's prediction.
- [ ] Multiline/markdown bodies stay triple-quoted and readable (NOT
      single-line-escaped — the one outcome #196 says to avoid).
- [ ] Normalization (key sort) is byte-stable and idempotent.

## Risks / unknowns

- **Hidden formatting divergences** beyond integers (float rendering, table vs
  inline-table thresholds, key quoting). The corpus parity harness is what
  surfaces them — treat any non-integer diff as a finding.
- **`toml` vs `toml_edit` version** alignment with holo-tree's existing `toml`
  dependency.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
