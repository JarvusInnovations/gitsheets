---
status: done
depends: [toml-canonical-core, definition-logic-core]
specs:
  - specs/rust-core.md
  - specs/behaviors/patch-semantics.md
issues: [127]
pr: https://github.com/JarvusInnovations/gitsheets/pull/208
---

# Plan: record engine in the core — CRUD + diff/patch (the substrate seam)

## Scope

The record read/write layer in `gitsheets-core`, composed from the bytes-authority
(`canonical`) + definition-logic (`path_template`, `validation`) layers below it,
and the first consumer to **wire holo-tree into `gitsheets-core`**. **In:** record
read/write/delete/list over holo-tree blobs and the core `Value`, plus diff + patch
(RFC 7396 / 6902) semantics. **Out:** query traversal/filtering + secondary
indexing (split into [`record-query-index`](record-query-index.md) per this plan's
original scope-creep note), the `Sheet`/`Transaction`/`Store` orchestration
([`sheet-store-core`](sheet-store-core.md)), and the bindings.

> **Split note.** This plan originally bundled query + index too; per its own
> "split before starting" risk, those moved to `record-query-index` (depends on
> this). This plan lands the substrate seam (CRUD over holo-tree) and diff/patch
> cleanly first; query/index build on it.

## Implements

- [`specs/rust-core.md`](../specs/rust-core.md) — record CRUD and "diff + patch" in
  the core, over the holo-tree substrate.
- [`specs/behaviors/patch-semantics.md`](../specs/behaviors/patch-semantics.md) —
  re-implemented behavior-preserving in Rust.

## Approach

- **Wire holo-tree.** Add the holo-tree Cargo git dependency to `gitsheets-core`
  (the form decided in `gitsheets-core-foundation`: a git dep on the hologit repo).
  This is the first plan that needs tree ops — confine the engine's thread model as
  holo-tree's thread-local cache requires.
- **Record CRUD.** read (tree blob → parse), write (render path + normalize +
  serialize + tree write), delete, list — over holo-tree blobs and the core
  `Value`. Batch-first signatures.
- **Diff / patch.** record-level diff (gix diff, replacing `git.diffTree`) and the
  RFC 7396 / 6902 patch semantics in Rust.

## Validation

- [x] CRUD round-trips records byte-identically to the (re-baselined) on-disk form.
      Rust integration test asserts holo-tree writes the *expected git blob hash*
      (computed independently via sha1) of the canonical bytes, and read-back
      returns the identical `Value`; the napi `record-crud.mjs` round-trips through
      a real `git init` repo.
- [x] Diff + patch outputs match the JS `Sheet.diffFrom` / patch behavior on a
      fixture corpus. `createPatch` matches the `rfc6902` package **op-for-op**
      across 17 fixtures; `applyMergePatch` matches `patch.ts`'s `mergePatch`
      across the `patch-semantics.md` examples. Two divergences enumerated below.
- [x] holo-tree is wired and exercised (a write produces the expected tree/blob).
- [x] `cargo build/test` + clippy clean (`cargo clippy --workspace --all-targets
      -- -D warnings`); napi boundary suite passes (43 tests, node 20/22 via
      explicit file paths); the main JS suite stays green (`npm test`: 287 + 66)
      and independent (`npm run type-check` clean; the main build never imports
      the `.node` addon).

## Risks / unknowns

- **gix diff fidelity** vs `git diffTree` for record-level diffs — parity-check.
- **The read-heavy perf headroom** (hologit#464: per-call `to_thread_local`,
  object cache, per-read clone) first surfaces here — measure and feed back
  upstream (the bulk benchmark itself is in `record-query-index`).

## Inbound deferrals to absorb

- From [`toml-canonical-core`](toml-canonical-core.md): parse/serialize currently
  map TOML failures to `Error::ConfigInvalid`. Now that records flow through the
  engine, decide whether a **record-specific parse error code** is warranted; if
  so it's a spec change to [`errors.md`](../specs/api/errors.md) owned here.
- From [`definition-logic-core`](definition-logic-core.md): **datetime-for-validation
  marshalling** — how a datetime-typed field is presented to shape-validation
  (string vs `Date`) is settled now that the engine owns the write path.

## Notes

**What was built.** A `record` module (CRUD over holo-tree, batch-first) and a
`diff` module (RFC 6902 `create_patch` + RFC 7396 `apply_merge_patch`) in
`gitsheets-core`, plus a thin napi surface (`recordRead/Write/Delete/List`,
`diffRecords`, `createPatch`, `applyMergePatch`). The binding never touches a
`gix::Repository` or holo-tree node — core `*_at_ref` wrappers open the repo and
resolve a ref/hash to a tree internally.

**holo-tree dep pin.** `holo-tree = { git = "https://github.com/JarvusInnovations/hologit", branch = "develop" }`,
pinned in the committed `Cargo.lock` to commit `e3750660`. **Deviation from the
plan's `master` suggestion, deliberate and required:** `master` (`bcef9b59`) lacks
the merged spike fixes this layer relies on — `delete_child_deep`'s
dirty-propagation (hologit#473) is on `develop` and not yet on `master`. The
mission's "verify the resolved holo-tree includes the merged spike fixes"
overrides the `master` default. `gix` is pinned to the same 0.83 holo-tree uses so
the `Repository` handle unifies.

**Diff/patch parity result.** `createPatch` matches the `rfc6902` package
op-for-op (verified live in `record-crud.mjs` over 17 fixtures, and against
captured golden outputs in Rust units) — the array diff is a faithful port of
rfc6902's memoized Levenshtein incl. its cost/stable-tie-break and `/-` padding.
`applyMergePatch` matches `patch.ts`'s `mergePatch` verbatim-copied into the test.
**Two enumerated divergences, both theoretical (parity fixtures stay
JSON-representable):** (1) a changed *datetime* field emits a `replace` here vs
nothing in `rfc6902` (which sees a `Date` object with no own keys — a latent JS
quirk); (2) no `-M` rename detection — a moved record is a delete + add, not a
`renamed`. `1` vs `1.0` is a no-op in both (numerically equal, as in JS).

**Representational note.** The core `Value` has no null, but both algorithms need
one (RFC 6902's top-level deleted-record `replace "" null`; RFC 7396's per-key
delete marker). Modeled out-of-band: `create_patch` takes `Option<&Value>` and a
`PatchValue::{Absent,Null,Value}`; the merge patch is a `MergePatch` tree whose
`Delete` is the null marker, marshalled from JS by a dedicated `JsMergePatch`.

**Inbound deferrals — resolved.**

- *(a) record-specific parse error code* — **No new code.** Resolved as "keep
  `config_invalid`." The existing JS `Sheet.#readRecordFromBlob` already throws
  `ConfigError('config_invalid')` for an unparseable record blob, and the
  canonical layer maps TOML failures the same way. Matching it preserves the
  no-consumer-visible-change non-negotiable; introducing a `record_invalid` code
  would be a behavior change. **No `errors.md` spec change.** (See Follow-ups for
  a possible post-1.0 cleanup.)
- *(b) datetime-for-validation marshalling* — **Settled: string form.** Already
  decided in `validation.rs` (`value_to_json` lowers `Value::Datetime` to its
  canonical TOML string, divergence enumerated there). Confirmed it holds for the
  engine-owned write path: shape-validation runs over the `Value` with datetimes
  presented as strings (so a `type: string, format: date-time` field validates),
  before `serialize`. No change needed; recorded here as the resolution.

## Follow-ups

- **`record-query-index`** (Deferred to plan): query traversal/filtering +
  secondary indexing build on this layer's CRUD + list primitives. The
  read-heavy perf headroom (hologit#464: per-call `to_thread_local`, object
  cache, per-read clone) first surfaces here; the bulk benchmark that measures it
  lives in that plan.
- **`sheet-store-core`** (Deferred to plan): the `Sheet`/`Transaction`/`Store`
  orchestration that composes these primitives (path-template-driven record→path
  rendering on writes, the markdown/frontmatter format, `Sheet.diffFrom`'s
  scoping + `BlobHandle`s, rename detection if wanted). This plan kept the write
  primitive path-explicit (caller supplies the rendered path + extension); the
  full render-and-write pipeline is that plan's.
- **`record_invalid` error code** (Issue, post-1.0): a dedicated code for an
  unparseable *record* (vs config) blob would be semantically cleaner than reusing
  `config_invalid` (500). Deferred because adding it now is a consumer-visible
  behavior change; revisit after 1.0 as a deliberate `errors.md` addition.
- **holo-tree `master` lag** (Tracked as): the spike fixes (incl. hologit#473)
  are on hologit `develop` but not `master`. When they merge to `master`, the dep
  can move to `branch = "master"`; until then `develop` is required. No action
  needed beyond the pinned `Cargo.lock`.
