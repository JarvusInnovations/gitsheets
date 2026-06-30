---
status: planned
depends: [sheet-store-core]
specs:
  - specs/rust-core.md
  - specs/behaviors/normalization.md
issues: [127]
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

- [ ] `sort = true` over a fixture set incl. **non-ASCII / mixed-case** strings
      matches V8 `localeCompare` (the `node:vm` reference) exactly — the cases the
      boa path diverged on.
- [ ] No declarative locale sort routes through the boa engine anymore (grep/test).
- [ ] The collator + data version is pinned and recorded as a behavior-contract
      input.
- [ ] `cargo build/test` + clippy clean; napi boundary suite passes; the main JS
      suite stays green and independent.

## Risks / unknowns

- **V8 `localeCompare` fidelity** — V8's default collation has specific
  sensitivity/case semantics; the Rust collator must be configured to match.
  Budget a real parity pass over tricky inputs (accents, case, digits, symbols).
- **ICU data size** — the `icu` crate can pull sizable CLDR data; prefer a compact
  configuration (default locale, the collation features actually used) to keep the
  prebuilt binaries lean.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
