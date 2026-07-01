---
status: in-progress
depends: [sheet-store-core]
specs:
  - specs/behaviors/attachments.md
  - specs/rust-core.md
  - specs/api/sheet.md
issues: [127]
---

# Plan: attachment + blob staging in the core (+ diff rename detection)

## Scope

Close the core capability the cutover exposed as missing: **staging arbitrary
blobs (attachments) atomically inside a transaction**, plus the blob-write
primitive and the `diffFrom` **rename detection** the core diff lacks. **In:** a
blob-write primitive, attachment staging on `CoreTransaction`
(`setAttachment(s)` / `deleteAttachment(s)`) committed atomically with the record,
attachment reads (`getAttachment(s)` + the iterator), and gix similarity-based
rename detection (`-M`) in the core diff to restore the documented `'renamed'`
`DiffStatus`. **Out:** the Node re-thin that consumes these
([`node-binding-thin`](node-binding-thin.md)).

> **Why this exists.** Attachments are a shipping, tested, spec'd v1.0 feature
> (`sheet.setAttachment(s)` inside `repo.transact`, the CLI attach flow via
> `repo.writeBlob`, `specs/behaviors/attachments.md`) but **no core plan scoped
> them** — `CoreTransaction` commits its tree opaquely with no blob/attachment
> write primitive. The cutover (`node-binding-thin`) can't route records through
> `CoreTransaction` without regressing attachment atomicity. Per the bytes-authority
> principle, tree/blob/commit ops belong in the core (`rust-core.md`), so this is a
> conformance gap, not new scope — and it must land in the core so **Python gets
> attachments too, byte-identical to Node** (extend-the-core decision, with the user).

## Implements

- [`specs/behaviors/attachments.md`](../specs/behaviors/attachments.md) — attachment
  staging/reads, re-implemented behavior-preserving in the core.
- [`specs/rust-core.md`](../specs/rust-core.md) — "Tree / blob / commit operations
  … in the core"; this fills the blob/attachment slice of that.
- [`specs/api/sheet.md`](../specs/api/sheet.md) — `diffFrom`'s `'renamed'`
  `DiffStatus` (currently unemitted by the core diff) is restored.

## Approach

- **Blob-write primitive.** Expose `writeBlob(bytes) -> hash` on the core (it
  already depends on holo-tree, which hashes blobs into the ODB) + napi, replacing
  the JS package's direct `@hologit/holo-tree` `writeBlob` call so the ODB write
  goes through the core.
- **Attachment staging on `CoreTransaction`.** Add `setAttachments(recordPath,
  {name: blobHash})` / `setAttachment` / `deleteAttachment(s)` that place/remove
  blobs at `<recordPath>/<name>` **in the transaction's `MutableTree` before
  `finalize`**, so the record and its attachments land in **one commit** (the
  atomicity `cli-attachments.test.ts` asserts). Match the JS
  `Sheet.setAttachments`/`deleteAttachments` semantics (path scoping, overwrite,
  clear-on-record-delete already exists in `sheet.rs`).
- **Attachment reads.** `getAttachment(s)` + the attachment iterator over a
  record's `<recordPath>/` subtree, matching `sheet-attachments-iterator.test.ts`.
- **Diff rename detection.** Add gix similarity-based rename tracking (`gix-diff`
  `Rewrites`, the `-M` analogue) to the core diff so a moved record emits
  `status: 'renamed'` (with `from`/`to`), restoring the `diffFrom` contract. Match
  the JS default threshold (`git diff-tree -M`).
- Batch-first + thread-confinement consistent with the rest of the core.

## Validation

- [ ] A record + an attachment upserted in the same `CoreTransaction` land in **one
      commit** (atomic) — the tree contains both, one commit hash; matches the JS
      `sheet-attachments.test.ts` / `cli-attachments.test.ts` behavior.
- [ ] `setAttachment(s)` / `deleteAttachment(s)` / attachment reads + iterator match
      the JS behavior on a fixture set.
- [ ] `writeBlob(bytes)` hashes binary content verbatim to the expected git blob
      hash (independently computed).
- [ ] The core diff emits `'renamed'` (with from/to) for a moved record, matching
      `git diff-tree -M` / JS `Sheet.diffFrom` on a fixture set.
- [ ] **Cross-binding:** an attachment staged via Python and via Node for the same
      input produces byte-identical commits (extends the existing cross-binding
      proof to attachments).
- [ ] `cargo build/test` + clippy clean; napi + py boundary suites pass; the main JS
      suite stays green and independent (it still uses its own attachment path until
      the cutover — don't break it here).

## Risks / unknowns

- **Atomicity across the FFI.** Attachments must stage into the SAME `MutableTree`
  `CoreTransaction` commits — design the napi surface so blob placement happens on
  the live transaction tree, not a detached one.
- **gix rename-detection fidelity** vs `git diff-tree -M` — match the default
  similarity threshold; parity-check. If gix's rename semantics can't match git's
  default closely, STOP and report (vs shipping a divergent `'renamed'`).
- **holo-tree API sufficiency** — if placing/reading arbitrary blobs at deep paths
  needs a holo-tree primitive that's awkward or missing, note it as an upstream
  hardening finding (per the mandate) rather than working around it.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
