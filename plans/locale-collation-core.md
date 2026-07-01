---
status: done
depends: [sheet-store-core]
specs:
  - specs/rust-core.md
  - specs/behaviors/normalization.md
issues: [127]
pr: https://github.com/JarvusInnovations/gitsheets/pull/213
---

# Plan: native ICU locale collation for `sort = true`

## Scope

Move declarative locale-sensitive array sorting (`sort = true`) off the embedded
boa engine and onto a **native Rust ICU collator** that matches V8's
`localeCompare`. **In:** the collator, its wiring into the `Sheet` array-sort path,
a `node:vm`/`localeCompare` parity gate, and the version pin. **Out:** the
arbitrary raw-JS comparator escape hatch (that stays in boa, correctly).

> **Why this exists.** `sheet-store-core` routed `sort = true` through boa for code
> reuse with the escape-hatch comparators. But boa is built without `Intl`, so its
> `localeCompare` falls back to code-unit comparison and **diverges from node:vm's
> ICU-backed collation** for non-ASCII / case-sensitive input. It also violates
> the spec's declarative-first principle: `sort = true` is a declarative directive
> and must be native, not engine-routed ([`rust-core.md`](../specs/rust-core.md)
> "Embedded code execution", point 1). This realigns it.

## Implements

- [`specs/rust-core.md`](../specs/rust-core.md) — declarative `sort = true` is
  native ICU collation, not the engine; pinned as part of the canonical-behavior
  contract.
- [`specs/behaviors/normalization.md`](../specs/behaviors/normalization.md) — the
  locale-aware array-sort rule, now native and byte-stable across bindings.

## Approach

- **Collator.** Add a Rust collation crate (`icu_collator` / the `icu` meta-crate,
  or `feruca` — decide on fidelity to V8's default `localeCompare`). Configure it
  to match V8's default collation (sensitivity, case ordering) as the existing JS
  `localeCompare` call does.
- **Wire it in.** Replace the boa-comparator path for `sort = true` (and any
  declarative `{field:dir}` string ordering that used `localeCompare`) with the
  native collator in the `Sheet` array-sort path. Leave the raw-JS escape-hatch
  comparators in boa untouched.
- **Pin.** Pin the collation crate version (and, if applicable, the ICU/CLDR data
  version) — it determines sort order, hence canonical bytes for sorted arrays, so
  it is contract-pinned like the serializer and the engine.

## Validation

- [x] `sort = true` over a fixture set incl. **non-ASCII / mixed-case** strings
      matches V8 `localeCompare` (the `node:vm` reference) exactly — the cases the
      boa path diverged on. (20,449 all-pairs over 143 strings, zero divergence,
      during development; shipped as `test/collator-parity.mjs` — boa-divergent
      cases + curated fixture + 50 randomized arrays, all exact on node 20 + 22.)
- [x] No declarative locale sort routes through the boa engine anymore. `sort =
      true` → `SortKind::Locale` → `crate::collator`; `comparator_source` returns
      `None` for it, so no `localeCompare` snippet is compiled into boa (grep:
      zero `localeCompare` *code* in the rust sources, only doc comments).
- [x] The collator + data version is pinned and recorded as a behavior-contract
      input. `icu_collator = "=2.0.0"` with `compiled_data` (baked CLDR), documented
      in `Cargo.toml` as a canonical-behavior contract input.
- [x] `cargo build/test` + clippy clean; napi boundary suite passes; the main JS
      suite stays green and independent. (core 143 pass; clippy `-D warnings`
      clean; napi `npm test` 92 pass; root `npm test` 287+66 pass + type-check;
      main build has zero `.node` references.)

## Risks / unknowns

- **V8 `localeCompare` fidelity** — V8's default collation has specific
  sensitivity/case semantics; the Rust collator must be configured to match.
  Budget a real parity pass over tricky inputs (accents, case, digits, symbols).
- **ICU data size** — the `icu` crate can pull sizable CLDR data; prefer a compact
  configuration (default locale, the collation features actually used) to keep the
  prebuilt binaries lean.

## Notes

- **Crate chosen: `icu_collator` (ICU4X), pinned `=2.0.0`.** ICU4X is the same
  ICU/CLDR lineage V8 uses, and its docs spell out the exact ECMA-402 `sensitivity`
  → `Strength` mapping, so configuring it to V8's `localeCompare` was direct rather
  than guesswork. `feruca` (the other candidate) was not needed once ICU4X matched
  exactly. Held to **2.0.x** not the latest 2.2.x: `boa_engine` 0.21.1 pins
  `icu_normalizer ~2.0`, and `icu_collator` 2.2.x wants `~2.2` — irreconcilable on
  that shared transitive dep. 2.0.0 reuses boa's existing `icu_normalizer 2.0.1`;
  only 4 net-new locked packages (`icu_collator{,_data}`, `icu_locale{,_data}`).
- **Exact V8-matching config** (in `src/collator.rs`), matching
  `localeCompare(b, undefined, { sensitivity: 'base', ignorePunctuation: true,
  numeric: true })`:
  - `sensitivity: 'base'` → `Strength::Primary` (case + accents fold)
  - `ignorePunctuation: true` → `AlternateHandling::Shifted`
  - `numeric: true` → `CollationNumericOrdering::True` (a BCP47 `kn` *preference*,
    set on `CollatorPreferences`, not `CollatorOptions`)
  - locale `undefined` (en-US in Node) → **root** collator (default prefs). CLDR
    `en` carries no tailoring over root, so root is byte-identical to en-US here
    *and* deterministic across hosts (no dependence on a runtime's resolved default
    locale) — which the canonical-bytes contract needs.
- **Parity result.** Byte-exact vs node's `localeCompare`: an all-pairs sign
  comparison of **20,449 pairs over 143 strings** (accents, mixed case, ligatures
  `ﬁ`/`ﬀ`, fullwidth `２`/`５`, CJK `北京`, Cyrillic/Greek, punctuation, whitespace,
  emoji, numeric `file2`/`file10`) diverged on **zero** pairs. The headline boa
  divergences now match: `["B","a"]` → `["a","B"]` (boa gave `["B","a"]`), `["é",
  "e","z"]` stable-folds, `["10","2","1"]` → `["1","2","10"]`, `co-op`/`coop`/`co
  op` collate equal.
- **Stability.** `Array.prototype.sort` is stable; `collator::sort_array` uses
  `slice::sort_by` (stable) over a coerced-key/value pairing, so base-equal
  elements keep input order — matching V8.
- **Pinned version.** `icu_collator = "=2.0.0"` (+ `compiled_data` baked CLDR), a
  canonical-behavior contract input alongside the serializer and the engine.
- **Engine split.** Only `sort = true` moved. Raw-JS comparators and relational
  `{field: dir}` / `[field]` directives stay in boa: the directives use JS `<`/`>`
  (code-unit, deterministic across boa and V8), not locale collation, so they do
  not have the boa-vs-V8 divergence locale sort had.

## Follow-ups

- **Non-string `sort = true` coercion.** `collator::sort_array` coerces non-string
  elements to a JS-`String()`-equivalent before collating (the prior boa path did
  `String(a)`). Faithful for scalars (int/bool/float-integral); composite values
  (array/table) and exotic floats fall back to JS's degenerate forms. The spec
  scopes `sort = true` to string arrays, so this only matters for misconfigured
  data — but if non-string locale sort ever becomes load-bearing, give it its own
  parity fixtures.
- **Per-sheet/per-field locale.** v1.0 uses one fixed root collator. If a future
  sheet wants a tailored locale (`de` phonebook, `sv`, …), thread a locale through
  `SortRule` and build a per-sheet collator — and re-pin/pin-document the data.
- **boa's shared `icu_normalizer` ceiling.** The `=2.0.0` pin is coupled to
  boa_engine 0.21.1's `icu_normalizer ~2.0`. A boa upgrade that moves that floor is
  the moment to revisit the collator version (and re-run the parity gate, since the
  baked CLDR data version is part of the contract).
