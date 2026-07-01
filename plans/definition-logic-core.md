---
status: done
depends: [gitsheets-core-foundation]
specs:
  - specs/rust-core.md
  - specs/behaviors/path-templates.md
  - specs/behaviors/validation.md
issues: [127]
pr: https://github.com/JarvusInnovations/gitsheets/pull/207
---

# Plan: definition-logic core — path templates, validation, embedded engine

## Scope

Move the behavior that's **derived from a sheet definition** into the core, so it
produces identical results under every binding. **In:** path-template rendering
(incl. partition derivations), persisted-shape (JSON Schema) validation, and the
**embedded JS engine** for the escape-hatch cases (declarative-first). **Out:**
the consumer-supplied runtime validator (Zod/Pydantic) — that legitimately stays
in the binding — and record CRUD/query (downstream).

## Implements

- [`specs/rust-core.md`](../specs/rust-core.md) — "Embedded code execution"
  (declarative-first; JS escape-hatch in an embedded engine *in the core*;
  engine-as-contract; thread-confinement) and the consumer-validator-vs-
  definition-embedded distinction.
- [`specs/behaviors/path-templates.md`](../specs/behaviors/path-templates.md) and
  [`specs/behaviors/validation.md`](../specs/behaviors/validation.md) — re-implemented
  in Rust, behavior-preserving.

## Approach

- **Path templates (native).** `${{ field }}` substitution + built-in partition
  derivations (date-parts, hashing, bucketing) evaluated natively over the core
  `Value`.
- **Shape validation (native).** JSON Schema via a Rust validator (e.g.
  `jsonschema`). **Parity pass vs `ajv`** — formats, coercion, error shapes —
  because this changes observable validation behavior.
- **Embedded engine (escape-hatch).** Embed a small JS engine (`rquickjs` for
  maturity, or `boa_engine` pure-Rust for clean cross-compile — decide here).
  Compile each definition's snippets **once on sheet-open** into persistent
  function handles held on the `Sheet`/`Store`; reuse across operations. Pin the
  engine version (it's part of the canonical-behavior contract). Confine the
  context to the owning thread.
- **Parity vs `node:vm`.** The current raw-JS sort rules run via `node:vm`; the
  embedded engine must produce identical results for the same snippets.

## Validation

- [x] Path rendering (incl. a partition-derivation case) is identical to the JS
      implementation across the corpus. — `renderPathsBatch` vs a faithful
      node:vm reference renderer, 11-case corpus incl. `getUTCFullYear`/
      `getUTCMonth` date-parts (`test/path-template.mjs`).
- [x] Rust JSON-Schema validation matches `ajv` on a parity fixture set (valid +
      invalid records, formats, edge cases). — 15 records: exact validity parity
      AND identical `(location, keyword)` sets, zero divergences
      (`test/validation-parity.mjs`).
- [x] An embedded-JS sort/derivation snippet produces the same result as today's
      `node:vm` path; the compiled context persists across operations (compiled
      once per open, not per call). — 21 comparator pairs exact; `CompiledDefinition`
      200 ops with constant `snippetCount` (`test/engine-parity.mjs`).
- [x] Engine version is pinned and recorded as a behavior-contract input. —
      `boa_engine = "=0.21.1"` in `rust/gitsheets-core/Cargo.toml`.

## Risks / unknowns

- **`ajv` parity** is the biggest unknown — format validators and coercion
  semantics differ between validators. Budget a real parity pass.
- **Engine choice trade-off.** QuickJS (mature, small C) vs Boa (pure-Rust, easier
  prebuilds, less complete). Tie the decision to the cross-platform prebuild story.
- **Thread model.** `!Send` JS context + the napi/pyo3 threading model — confine
  deliberately (same lesson as holo-tree's thread-local cache).

## Notes

**What was built.** Three modules added to `gitsheets-core`, all batch-first and
exposed across the napi boundary for JS-side parity:

- `path_template.rs` — a behavior-preserving port of the JS renderer
  (`packages/gitsheets/src/path-template/index.ts`). Literal/field components
  render natively over `Value`; **expression** components compile once into the
  embedded engine. Ports `stringifyValue`, multi-variable segments (#105),
  recursive `field/**`, invalid-char rejection, and the
  `path_render_failed`/`path_invalid_chars` typed errors.
- `validation.rs` — native JSON-Schema via the `jsonschema` crate, compiled once
  per schema (`CompiledSchema`), mapping failures to `ValidationIssue`.
- `engine.rs` — a persistent `boa_engine` `Context` with compile-once snippet
  handles; core `Value` ⇄ boa marshalling (incl. real JS `Date` for datetime
  fields, via a dependency-free `days_from_civil`); `!Send` / thread-confined.

napi surface: `renderPathsBatch`, `validateBatch`, `runComparator`, and a
stateful `CompiledDefinition` class (compile-once / reuse demonstrator).

**Pinned engine version.** `boa_engine = "=0.21.1"` — exact pin, recorded as a
canonical-behavior-contract input per `specs/rust-core.md`. `jsonschema 0.46.7`
(default-features off — no remote-ref resolver).

**ajv-parity result.** Over 15 valid+invalid records the Rust validator matched
`ajv` (Draft 7, `should_validate_formats`, all-errors) with **exact validity
parity AND identical `(instanceLocation, keyword)` sets** — pattern, format
(email/uri), minLength, minimum, type, enum, maxItems, additionalProperties,
required, and multi-error `allErrors` cases. **Zero `(location, keyword)`
divergences.** Issue *message text* is excluded from the assertion (library-
specific prose). Enumerated structural divergences vs ajv, by design:

  1. **Strict-mode unknown keywords.** ajv `strict:true` rejects a typo'd/unknown
     keyword at *compile* (`config_invalid`); the `jsonschema` crate silently
     ignores unknown keywords, so such a schema compiles here. (Follow-up below.)
  2. **Datetime as JSON.** A `Value::Datetime` marshals to a JSON *string* for
     validation, whereas ajv validates the host record with a JS `Date`
     *object*. Datetime-typed schema fields are uncommon; the parity fixtures
     stay JSON-representable. Resolved properly when the binding marshals records
     for validation in the record engine.

**node:vm-parity result.** All 21 realistic raw-JS sort-comparator `(rule, input)`
pairs (subtraction, relational, length, `Math.sign`, multi-key object directive)
match `node:vm` exactly. `CompiledDefinition` ran 200 render/compare operations
with `snippetCount` constant at 2 — proof snippets compile once on open, never
per call. A **`localeCompare` Intl-boundary probe diverged 1/4** (`["B","a"]`:
node:vm collates `1`, boa code-unit-compares `-1`) — this is the documented boa
trade-off (boa default-features exclude `intl`). It is **non-gating**: gitsheets'
locale-aware sort is the declarative `sort = true` path, evaluated *natively in
the binding*, not an embedded raw-JS snippet. The snippets gitsheets actually
runs through the engine all pass.

**Independence.** Changes touch only `rust/` + `.github/workflows/rust-core.yml`.
The main JS package imports no `.node` addon; the rust-core workflow stays
separate from `ci.yml`.

## Follow-ups

- **Strict-mode unknown-keyword rejection (Issue).** To fully match ajv's
  `strict:true`, the core could walk a `[gitsheet.schema]` for unrecognized
  keywords at compile and raise `config_invalid`. Deferred — track as a hardening
  issue; current behavior is *more* lenient, not unsafe.
- **Datetime validation marshalling (Deferred to plan: `record-engine-core`).**
  How a datetime-typed field is presented to shape-validation (string vs Date)
  is settled when the record engine owns the write path; revisit there.
- **Query-tree traversal/pruning (Deferred to plan: `record-engine-core`).** This
  plan ported parse + render only; the path template's *query pruning* half is a
  record-engine concern.
- **`getFieldNames` for query auto-derivation (Deferred to plan:
  `record-engine-core`).** Not needed for rendering parity; lands with query.
- **boa engine upgrades (Tracked as: contract discipline).** The `=0.21.1` pin is
  upgraded deliberately, re-running the node:vm parity gate — same discipline as
  a normalization change.
