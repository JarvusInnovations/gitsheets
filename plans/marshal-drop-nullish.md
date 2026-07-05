---
status: done
depends: []
specs:
  - specs/behaviors/normalization.md
  - specs/rust-core.md
issues: [232, 233]
pr: 241
---

# Plan: drop null/undefined-valued keys at the marshal boundary

## Scope

Restore the 1.x `@iarna/toml` semantics the Rust-core cutover silently broke
([#232](https://github.com/JarvusInnovations/gitsheets/issues/232)): a
`null`/`undefined`-valued key in a record must be **dropped** on write, not
rejected with `cannot marshal JS value of type Null/Undefined`. The drop is
recursive (nested tables, and tables inside arrays) and applies identically in
every binding. A null **array element** stays an error — but with a targeted,
actionable message (see Approach for the rationale).

Riding along ([#233](https://github.com/JarvusInnovations/gitsheets/issues/233)):
the missing 1.x → 2.x breaking-changes section in `docs/migration-guide.md`
(hologit drop, null handling, canonical byte re-baseline).

Out of scope:

- Merge-patch marshalling (`applyMergePatch` / `MergePatch`), where `null` is
  the RFC 7396 delete sentinel — a separate, already-correct code path.
- Any `Value::Null` variant in the core value type. The core stays
  TOML-faithful; nulls are a host-language concept resolved at the marshal
  boundary (see Approach).
- Null-aware query-filter semantics (e.g. `{ field: null }` matching absent
  fields) — a filter leaf of `null` keeps erroring, as it does today.

## Implements

- `specs/behaviors/normalization.md` — the (already-specced, newly-explicit)
  rule that null values are omitted from output: "Null / undefined handling"
  subsection under TOML serialization details.
- `specs/rust-core.md` — the new "Nulls" type-fidelity rule for the marshal
  boundary every binding implements.

## Approach

1. **Spec first**: make the existing one-liner ("Null values are *omitted* from
   the output") explicit and complete in `specs/behaviors/normalization.md` —
   recursive drop for table keys, error for array elements, the absent-key ==
   cleared-optional equivalence — and add the matching "Nulls" bullet to
   `specs/rust-core.md`'s type-fidelity rules.
2. **Where the fix lives**: the host→core marshal in the two Rust binding
   crates — `JsValue::from_napi_value` in `rust/gitsheets-napi/src/lib.rs` and
   `py_to_value` in `rust/gitsheets-py/src/lib.rs`. The core `Value` enum is
   deliberately TOML-faithful (no null variant), so the core never sees a null
   by construction; the marshal recursion is the single place each binding can
   see one. The rule itself is core-owned: `gitsheets-core` exports the shared
   error-message helper so the rejection reads identically from Node and
   Python, and the spec is the cross-binding contract, enforced by the existing
   cross-binding byte-parity CI job.
3. **Table entries**: a `null`/`undefined` (JS) or `None` (Python) property
   value drops the key, recursively — the record serializes as if the key were
   never set, matching 1.x bytes exactly.
4. **Array elements**: reject with a dedicated error naming the index. TOML
   arrays cannot contain nulls, and silently *dropping an element* — unlike
   dropping a key — shifts sibling indices and changes data. This is a
   **deliberate divergence from 1.x**: `@iarna/toml@2.2.5` silently dropped
   null array elements (`[1, null, 2]` → `[1, 2]`), which is exactly the kind
   of silent data mutation the bytes-authority refuses. Spec + migration guide
   call the divergence out explicitly.
5. **Top-level / scalar-position nulls** (a whole record, a filter leaf): keep
   erroring, with the clarified message.
6. **Tests at every layer**: core unit test for the shared message helper; napi
   boundary tests (roundtrip drop, byte-equality with the pre-stripped record,
   array-element error, upsert-through-`record_write`); Python mirror tests
   plus a cross-binding byte-parity case with nullish keys; package-layer
   vitest covering the real consumer pattern (Standard Schema validator
   normalizing cleared optionals to `null` → upsert succeeds → serialized
   record has no such keys).
7. **Migration guide (#233)**: new "v1.x → v2.0 (Rust core)" section — hologit
   dependency drop (`BlobObject.write`/`hologitRepo` → `repo.writeBlob` +
   `setAttachments` before/after), null handling (initially threw, fixed in
   this release; array-element edge case), canonical byte re-baseline per #196
   with the one-time re-serialize commit recipe.

## Validation

- [x] `cargo test` green across the workspace (core + bindings build, clippy
  `-D warnings` clean)
- [x] napi suite (`npm test` in `rust/gitsheets-napi`) green, including new
  cases: null/undefined table keys dropped recursively (nested tables, tables
  inside arrays), serialized bytes identical to the pre-stripped record, null
  array element rejected with an error naming the index, top-level null still
  rejected
- [x] Python suite (`pytest` in `rust/gitsheets-py`) green, including the
  mirrored `None` cases and a cross-binding byte-parity case for a record
  with nullish keys
- [x] Package vitest suite (`npm test`) green, including the end-to-end
  consumer pattern: `.nullable().optional()`-style Standard Schema validator
  emitting `null` for cleared optionals → `upsert` succeeds → read-back has no
  such keys → on-disk TOML bytes contain no trace of them
- [x] `docs/migration-guide.md` gains the 1.x → 2.x section enumerating the
  three breaks from #233 with before/after for each

## Risks / unknowns

- **Blanket drop in the generic record marshal** also affects `roundtrip`,
  `serializeRecords`, comparator args, `createPatch` src/dst, and
  `recordQueryCandidates` partial records. This is intended: all of those
  surfaces were plain JS in 1.x where a null-valued key was either dropped at
  serialize time or behaved as absent. Filter leaves are unaffected (filters
  recurse host-side and only marshal scalar/array leaves).
- **Merge-patch adjacency** — the null-drop must not leak into
  `MergePatch` marshalling where null means delete. Covered by existing
  `apply_merge_patch` tests in both bindings.

## Notes

- 1.x array-element behavior verified against `@iarna/toml@2.2.5`:
  `stringify({ a: [1, null, 2] })` silently emits `a = [ 1, 2 ]` — a silent
  element drop that shifts indices. 2.x deliberately rejects instead; only the
  key-drop is restored as 1.x-compatible.
- JS sparse-array holes (`[1, , 2]`) read back as `undefined` and hit the same
  array-element rejection — deliberate, since dropping them would also shift
  indices.
- The shared rejection-message helpers live in `gitsheets-core::value`
  (`null_array_element_msg` / `null_scalar_msg`) so both bindings and any
  future one emit identical diagnostics; the drop recursion itself is
  ~6 lines per binding inside each marshal.
- Considered and rejected a `Value::Null` core variant: it would break the
  value type's "mirrors TOML's type set exactly" invariant and force a Null
  arm on every exhaustive match across ~12 core modules, for no gain — the
  marshal recursion is the only place a host null is visible, and the
  cross-binding byte-parity suite pins the contract.
- Verified totals at closeout: core 169, clippy `-D warnings` clean, napi 108,
  pytest 31 (incl. the new `nullish` cross-binding parity fixture), vitest 298
  (gitsheets) + 118 (gitsheets-axi), type-check clean.

## Follow-ups

None.
