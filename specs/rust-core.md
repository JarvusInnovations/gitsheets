# Rust core & language bindings (v-next target architecture)

**Status: target / direction.** This spec records committed architectural
*decisions* for gitsheets' evolution into a Rust-core engine with thin
language bindings. It is forward-looking: most of it is **not yet implemented**,
and a spec-drift audit will (correctly) report it as unimplemented. The build-out
is tracked as a plan DAG in [`plans/`](../plans/) (see [Phasing](#phasing)). It
extends the substrate evolution begun by the holo-tree migration
([#127](https://github.com/JarvusInnovations/gitsheets/issues/127),
[`architecture.md`](architecture.md)).

## Goal

gitsheets should eventually be consumable from **more than one language** (Node.js
first, **Python** next, others later). The way to get there without
re-implementing — or worse, *diverging* — the engine per language is a single
**Rust core** that owns the engine, with **thin per-language bindings** that only
adapt it to each host's idioms.

## The load-bearing principle: the bytes-authority lives in the core

> **Anything that determines on-disk bytes, or must be identical across bindings,
> lives in the Rust core. Anything that is purely a host language's API ergonomics
> or the consumer's own types lives in the binding.**

The on-disk form is a **contract every binding must agree on byte-for-byte**. If
Node and Python each owned TOML serialization, normalization, path rendering, or
validation, the *same logical write from two bindings would produce different
commits* → divergence. That is unacceptable, and it is the principle that decides
every "core vs binding" question below.

This reverses the single-binding-era guidance (which kept serialization in JS):
under multi-binding, centralizing the bytes-authority is mandatory, not optional.

## Division of labor

### Rust core (`gitsheets-core`)

Owns everything bytes-determining or consistency-critical:

- Tree / blob / commit operations (via holo-tree; shipped as `@hologit/holo-tree`).
- **TOML parse + serialize** (`toml` / `toml_edit`).
- **Normalization** — key sorting, byte-stable canonical form.
- **Path-template rendering** (record → path), including partition derivations.
- **Persisted-shape validation** (JSON Schema).
- **Definition-embedded logic execution** — see [Embedded code](#embedded-code-execution).
- Query traversal + filtering; secondary indexing.
- Diff + patch semantics (RFC 7396 / RFC 6902).
- The `Sheet` / `Transaction` / `Store` state machine.

### Language binding (thin: `node`, `python`, …)

Owns only what is genuinely host-specific:

- Idiomatic API surface (naming, async conventions).
- **Marshalling** native objects ↔ the core value type, preserving type fidelity
  (TOML datetime → JS `Date` / Python `datetime`; integer vs float).
- The **consumer-supplied runtime validator** hook (Standard Schema / Zod in JS,
  Pydantic in Python). This runs on the *native* object and is *allowed* to be
  language-specific — it is the consumer's app concern, not the store's contract.
- Error-variant → idiomatic-exception mapping.

The one real subtlety is the write order: native object → **binding** runs the
consumer validator → marshal to core value → **core** does shape-validation +
normalize + serialize + write.

## The FFI boundary

- **Records cross as a typed core value, not JSON.** JSON flattens TOML datetimes
  to strings and blurs integer/float. The core value type preserves TOML's types;
  each binding maps it idiomatically (napi-rs / pyo3 both support custom
  conversions).
- **Batch at the boundary.** Bulk APIs (`upsertMany`, `queryAll`) cross the FFI
  *once* with an array; the whole batch is parsed/serialized and the tree built
  natively in Rust. This is where the core most rewards bulk-write workloads —
  versus per-record marshalling + per-record tree writes.

## Embedded code execution

Some behavior is **embedded in the sheet definition** itself — today, raw-JS sort
comparators (`Sheet.<field>.sort` string rules, run via `node:vm`); plausibly
later, partition-path derivations and custom validation expressions. Embedded
code is the one thing that does **not** portability-flatten the way TOML bytes do:
a definition-embedded snippet must produce identical results under every binding.

The resolution is two-part:

1. **Declarative-first, native in the core.** The common cases stay *data, not
   code* and are evaluated natively in Rust: `${{ field }}` path substitution,
   `{field: ASC}` sort directives, JSON-Schema validation, built-in partition
   derivations (date-parts, hashing, bucketing). This already mirrors how
   `Sheet`'s sorter treats `true`/`false`/array/`{field:dir}` declaratively and
   reserves raw JS only as an escape hatch.

2. **JS escape-hatch via an embedded engine *in the core*.** When a definition
   genuinely needs arbitrary logic, it runs in a JS engine **embedded in the Rust
   core** — *not* the host binding's JS runtime. Running it in the core is what
   keeps it portable: a Python consumer gets the *core's* engine, so Node and
   Python produce identical results. The engine + each definition's compiled
   snippets are held **persistently** on the `Sheet`/`Store` handle (compile once
   on open, reuse across every operation; no per-op re-parse).

**Engine choice** (decided when the plan is picked up): a small embeddable engine
— `rquickjs` (QuickJS) for maturity, or `boa_engine` (pure-Rust, no C toolchain →
trivial cross-platform prebuilds). Full V8 is overkill for snippet evaluation.

**Two constraints this creates:**

- **Thread-confinement.** Embedded JS contexts are single-threaded (`!Send`).
  The persistent context is pinned to the `Store`'s owning thread — the same
  thread-model discipline holo-tree's cache already needs.
- **The engine is part of the canonical-behavior contract.** Sort order and
  partition paths depend on its JS semantics, so the **engine version is pinned**
  and an upgrade is treated like a normalization change (same discipline as the
  TOML serializer and the validator).

## Canonical-form rebaseline

Moving TOML serialization to the Rust `toml`/`toml_edit` stack changes the
canonical bytes (at minimum integer-underscore: `31_618` → `31618`). gitsheets
always serializes *fresh* from an object, so `toml_edit`'s format-preserving "0%
churn" does not apply — expect the integer normalization. This is a **deliberate
one-time re-baseline**:

- **Decision: do it, and do it while gitsheets effectively has a single user.**
  The blast radius (re-normalizing existing repos) only grows with adoption.
- It is a documented change to [`behaviors/normalization.md`](behaviors/normalization.md)
  plus a single re-normalize commit per repo.
- Measurements behind this decision:
  [#196](https://github.com/JarvusInnovations/gitsheets/issues/196).

## Phasing

The DAG in [`plans/`](../plans/) realizes this in dependency order. The
load-bearing sequencing rule: **the bytes-authority must land before a second
binding exists**, or Node and Python will disagree on bytes.

1. **Tree ops in Rust** — `@hologit/holo-tree` binding; tree/blob/commit move off
   hologit JS, TOML stays JS, behind the unchanged public API.
   (`holo-tree-napi-spike` → `holo-tree-migration`.)
2. **Bytes-authority core** — establish `gitsheets-core`; move TOML +
   normalization, path templates, shape validation, and definition-embedded logic
   into it; execute the rebaseline. This is the gate for multi-binding.
3. **Engine + thin bindings** — record engine (CRUD/query/index/diff), the
   `Sheet`/`Transaction`/`Store` state machine, re-thin the Node binding, add the
   Python binding.

## Non-negotiables (carried from the existing specs)

- **No consumer-visible public-API change** for the Node surface across the
  migration (per [`architecture.md`](architecture.md) / #127). The bytes
  re-baseline is the one deliberate, documented exception, gated on the rebaseline
  decision above.
- Parity passes are required wherever a Rust component replaces a JS one with
  observable output: the TOML serializer (#196), the JSON-Schema validator vs
  `ajv`, and the embedded engine vs `node:vm`.
