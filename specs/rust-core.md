# Rust core & language bindings (current architecture)

**Status: implemented / current architecture.** This spec records the
architectural *decisions* behind gitsheets' Rust-core engine with thin language
bindings — and, as of the [#127](https://github.com/JarvusInnovations/gitsheets/issues/127)
cutover, the shipped reality: `gitsheets-core` owns the engine, the Node package
is a thin marshalling shell over `@gitsheets/core-napi`, and a Python binding
(`rust/gitsheets-py`) runs over the same core. A spec-drift audit should find this
implemented, not pending. The build-out landed via the (now-`done`) plan DAG in
[`plans/`](../plans/) (see [Phasing](#phasing)). It completed the substrate
evolution begun by the holo-tree migration
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

- Tree / blob / commit operations (via `holo-tree`/gitoxide, linked directly into
  the core — the Node package no longer depends on `@hologit/holo-tree`).
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

### Type-fidelity rules

The core value type is the lingua franca; these mappings are the round-trip
contract every binding implements and tests against. The rule of thumb: **the
core preserves whatever determines on-disk bytes** (bytes-authority), even when a
binding's host language can't represent the distinction natively — the binding
then picks the least-lossy idiomatic surface and the core retains the precise
kind for faithful re-serialization.

- **Integers — `i64` in the core; adaptive on the Node surface.** The core stores
  every integer as `i64` (TOML's full range). The Node binding marshals to a JS
  `number` when the value fits in ±(2^53−1) and to `BigInt` above that, so common
  small ids stay ergonomic numbers while large values never lose precision.
  Inbound it accepts both `number` and `bigint`. (A future Python binding maps to
  Python's arbitrary-precision `int` directly.)
- **Floats — `f64`.** Kept distinct from integers; `1` and `1.0` are different
  core values and serialize differently.
- **Datetimes — all four TOML kinds preserved distinctly.** Offset-datetime,
  local-datetime, local-date, and local-time serialize to *different bytes*, so
  the core keeps them as distinct value kinds. The Node binding surfaces them as
  JS `Date` to match the current `@iarna`-based v1.x behavior (no consumer-visible
  change), with the precise TOML kind retained core-side for byte-faithful
  re-serialization.
- **Strings, booleans, arrays, tables** map to their obvious idiomatic
  counterparts (table ↔ plain object / dict).

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
   reserves raw JS only as an escape hatch. **Declarative `sort = true`
   (locale-sensitive string-array sorting) is native — it does NOT go through the
   embedded engine.** It uses a Rust ICU collator that matches V8's
   `localeCompare`, so its order is byte-stable and identical across bindings.
   Because boa is built without `Intl`, routing locale sorting through the engine
   would diverge from `node:vm` for non-ASCII input; the engine is for *arbitrary*
   raw-JS comparators only. The ICU collator is part of the canonical-behavior
   contract — its **version is pinned** like the serializer and the engine.

2. **JS escape-hatch via an embedded engine *in the core*.** When a definition
   genuinely needs arbitrary logic, it runs in a JS engine **embedded in the Rust
   core** — *not* the host binding's JS runtime. Running it in the core is what
   keeps it portable: a Python consumer gets the *core's* engine, so Node and
   Python produce identical results. The engine + each definition's compiled
   snippets are held **persistently** on the `Sheet`/`Store` handle (compile once
   on open, reuse across every operation; no per-op re-parse).

**Engine choice: `boa_engine`** (pure-Rust). The escape-hatch snippet set is
simple and deterministic (sort comparators, partition derivations), so QuickJS's
spec-completeness edge buys little, while its C toolchain is permanent overhead
that multiplies per binding/target. Pure-Rust boa keeps the *whole* core C-free →
trivial cross-platform prebuilds across all six targets (incl. musl + windows),
clean Python wheels, and a plausible WASM binding later. Full V8 is overkill.
The accepted trade-off is boa's divergence risk vs the current `node:vm` baseline
(concentrated in `Intl`/locale + exotic built-ins our snippets don't use); the
**`node:vm` parity gate is a hard validation criterion** that catches any
real divergence on actual snippets before adoption. Flip to `rquickjs` only if
parity fails on real snippets or a use case needs `Intl`/advanced built-ins. As
boa evolves quickly, its **version is pinned** (per the contract constraint
below) and upgraded deliberately.

> **Shipped status (Node cutover).** The *declarative-first* half (point 1) is
> live in the core: `${{ field }}` substitution, `{field: dir}` directives,
> JSON-Schema validation, and locale-sensitive `sort = true` via the native ICU
> collator all run natively in `gitsheets-core`. The *JS escape-hatch* half
> (point 2) is **not yet routed through the core's boa engine on the Node
> binding**: raw-JS sort comparators (`Sheet.<field>.sort` string rules) still run
> host-side in `node:vm` via the retained `buildSorter`/exported `Template`
> path. This is a **deliberate deferral** — it is single-binding today (Node only,
> where `node:vm` is the parity baseline anyway) and moves to the in-core boa
> engine when the Python binding needs raw-JS comparators to stay byte-identical.
> Until then the core's boa engine is the specified target for this escape hatch,
> not the Node runtime path. Tracked in [`node-binding-thin`](../plans/node-binding-thin.md).

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

The DAG in [`plans/`](../plans/) realized this in dependency order — **all three
phases are now done**. The load-bearing sequencing rule held: **the bytes-authority
landed before a second binding existed**, so Node and Python agree on bytes.

1. **Tree ops in Rust** *(done — [#203](https://github.com/JarvusInnovations/gitsheets/pull/203))* —
   `@hologit/holo-tree` binding; tree/blob/commit moved off hologit JS, TOML stays
   JS, behind the unchanged public API.
   (`holo-tree-napi-spike` → `holo-tree-migration`.)
2. **Bytes-authority core** *(done)* — established `gitsheets-core`; moved TOML +
   normalization, path templates, shape validation, and definition-embedded logic
   into it and executed the rebaseline. This was the gate for multi-binding.
   (`toml-core`, `canonical-rebaseline`, `path-template-core`, `validation-core`,
   the codec/collation/normalize plans, etc.)
3. **Engine + thin bindings** *(done — Node cutover [#216](https://github.com/JarvusInnovations/gitsheets/pull/216))* —
   record engine (CRUD/query/index/diff) and the `Sheet`/`Transaction`/`Store`
   state machine in the core; the Node binding re-thinned to a marshalling shell
   over `@gitsheets/core-napi` (`node-binding-thin`) with the direct
   `@hologit/holo-tree` dependency dropped; the Python binding
   (`rust/gitsheets-py`, pyo3) added over the same core, proven byte-identical.

## Non-negotiables (carried from the existing specs)

- **No consumer-visible public-API change** for the Node surface across the
  migration (per [`architecture.md`](architecture.md) / #127). The bytes
  re-baseline is the one deliberate, documented exception, gated on the rebaseline
  decision above.
- Parity passes are required wherever a Rust component replaces a JS one with
  observable output: the TOML serializer (#196), the JSON-Schema validator vs
  `ajv`, and the embedded engine vs `node:vm`.
- **Markdown body normalization is native.** Content-typed (`markdown`/`mdx`)
  sheets normalize the body on write with the embedded `dprint-plugin-markdown`
  formatter rather than a host-side `markdownlint` pre-pass, so body bytes are
  identical across bindings. Its **version + config are pinned** as a
  canonical-behavior contract input (like the serializer, engine, validator, and
  collator); switching off the JS `markdownlint` pass is a one-time documented
  body re-baseline (see [`behaviors/content-types.md`](behaviors/content-types.md)).
