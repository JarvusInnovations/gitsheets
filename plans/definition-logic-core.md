---
status: planned
depends: [gitsheets-core-foundation]
specs:
  - specs/rust-core.md
  - specs/behaviors/path-templates.md
  - specs/behaviors/validation.md
issues: [127]
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

- [ ] Path rendering (incl. a partition-derivation case) is identical to the JS
      implementation across the corpus.
- [ ] Rust JSON-Schema validation matches `ajv` on a parity fixture set (valid +
      invalid records, formats, edge cases).
- [ ] An embedded-JS sort/derivation snippet produces the same result as today's
      `node:vm` path; the compiled context persists across operations (compiled
      once per open, not per call).
- [ ] Engine version is pinned and recorded as a behavior-contract input.

## Risks / unknowns

- **`ajv` parity** is the biggest unknown — format validators and coercion
  semantics differ between validators. Budget a real parity pass.
- **Engine choice trade-off.** QuickJS (mature, small C) vs Boa (pure-Rust, easier
  prebuilds, less complete). Tie the decision to the cross-platform prebuild story.
- **Thread model.** `!Send` JS context + the napi/pyo3 threading model — confine
  deliberately (same lesson as holo-tree's thread-local cache).

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
