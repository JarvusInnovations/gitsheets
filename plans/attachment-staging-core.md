---
status: done
depends: [sheet-store-core]
specs:
  - specs/behaviors/attachments.md
  - specs/rust-core.md
  - specs/api/sheet.md
issues: [127]
pr: https://github.com/JarvusInnovations/gitsheets/pull/215
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

- [x] A record + an attachment upserted in the same `CoreTransaction` land in **one
      commit** (atomic) — the tree contains both, one commit hash. Rust:
      `transaction.rs::record_and_attachment_land_in_one_commit_atomically`; napi:
      `sheet-attachments.mjs` (verified via `git ls-tree`/`rev-parse`); py:
      `test_smoke.py::test_record_and_attachment_commit_atomically`.
- [x] `setAttachment(s)` / `deleteAttachment(s)` / attachment reads match the JS
      behavior (overwrite, strict single-delete `record_not_found`, idempotent
      bulk-delete no-op, cascade-on-record-delete) on a fixture set — Rust
      `sheet.rs` tests + napi + py suites. (The `attachments()` iterator's
      `mimeType`/`.read()`/`.stream()` sugar is host-side and stays in the JS
      package; the core exposes the `name → hash` map it's built on.)
- [x] `writeBlob(bytes)` hashes binary content verbatim to the expected git blob
      hash (independently computed `sha1("blob <len>\0<bytes>")`) — Rust
      `write_blob_hashes_bytes_to_the_git_blob_hash`, napi + py parity tests.
- [x] The core diff emits `'renamed'` (with from/to) for a moved record, matching a
      **live `git diff-tree -M`** oracle on a fixture set (Rust + napi assert the
      real git output agrees); dissimilar records stay add + delete.
- [x] **Cross-binding:** an attachment staged via Python and via Node for the same
      input produces byte-identical blob + tree + commit hashes
      (`test_cross_binding.py::test_attachment_commit_bytes_identical_across_bindings`).
- [x] `cargo test` (159 core), clippy `-D warnings` clean; napi (`npm test`, 100) +
      py (`pytest`, 26) suites pass. `packages/gitsheets` untouched — the main JS
      suite stays independent until the cutover.

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

**Atomicity design (the crux).** `CoreTransaction` owns the live `MutableTree`
its records stage into (via `Transaction::split() -> (&repo, &mut tree)`). The new
`Sheet::set_attachments(record_path, [(name, blobHash)])` places each blob at
`<base>/<recordPath>/<name>` in **that same tree, before `finalize`** — so the
record file and its attachment blobs are children of the one tree
`Transaction::finalize` commits. Result: a record upsert + its attachments land in
a **single commit** (proven three ways: the Rust transaction test inspects the
committed tree + asserts a single parent; napi verifies via `git ls-tree`/
`rev-parse`; py via `git ls-tree`). The blob-write primitive
`record::write_blob(bytes) -> hash` writes the loose object to the ODB
(content-addressed), and `set_attachments` places it by hash — matching the JS
two-step `repo.writeBlob(bytes)` → `setAttachments(record, {name: blob})` flow.

**Rename-detection approach + git-parity result.** The core diff previously did a
pure blob-map add/modify/delete comparison (no renames). It now runs gix
`Repository::diff_tree_to_tree` over the sheet's **base subtrees** (scoping the
detection to the sheet, the way `Sheet.diffFrom`'s `-- <effectiveRoot>` pathspec
does) with an **explicit** `gix::diff::Rewrites::default()` = `percentage:
Some(0.5)`, `copies: None` — i.e. 50% similarity, renames only. This is exactly
`git diff-tree -M`'s default, and passing explicit options (rather than
`Options::from_configuration`) makes it **independent of the repo's `diff.renames`
config** so the classification is deterministic. gix's rewrite tracker did match a
live `git diff-tree -M` on the fixtures (a 4-field record moved with a one-field
change → `R`, ~75% similar; a wholly-different record → `A` + `D`), so no STOP was
needed. `gix`'s `blob-diff` feature is already on via its default features
(`basic`), so **no new dependency** — no `cargo add`. A `Renamed` change carries
`previous_path` (source) and `path` (destination); its src record is read from
`previous_path`, and its patch is the src→dst field delta. `RecordStatus::Renamed`

- `RecordChange.previous_path` are surfaced as `status: 'renamed'` / `previousPath`
on both bindings' `diffRecords`.

**Cross-binding attachment proof.** `_node_writer.mjs` gained a `commit-attachment`
op; `test_cross_binding.py::test_attachment_commit_bytes_identical_across_bindings`
stages a record + a fixed-bytes attachment in one transaction via Python and via
Node and asserts **byte-identical blob hash, tree hash, and commit hash**.

**holo-tree finding (upstream, not worked around).** holo-tree exposes no
place-a-blob-by-hash primitive on `MutableTree`. `set_attachments` therefore reads
the (already-written) blob by hash via `find_object` — which also validates it
exists and is a blob, matching the JS path's `content.read()` safety — then
re-places it with `write_child_bytes`, which re-hashes to the same content-
addressed id (byte-identical result). For large attachments this is one redundant
ODB read; a `MutableTree::write_child_hash(path, hash, mode)` upstream would avoid
it. Reported here as a hardening opportunity, not a blocker — the result is
correct and byte-identical.

## Follow-ups

- **holo-tree `write_child_hash` primitive — DONE (hologit#477 → gitsheets#221).**
  Place an existing blob by hash at a deep path without reading its bytes back
  (the efficiency note above). **Fixed upstream** in
  [hologit#477](https://github.com/JarvusInnovations/hologit/pull/479) (released
  as `holo-tree-v0.4.0`) and **consumed in gitsheets#221** — `set_attachments`
  now places by hash via `write_child_hash`, dropping the redundant ODB read.
- **`node-binding-thin` (the cutover)** rewires `packages/gitsheets` to route
  `Sheet.setAttachment(s)` / `deleteAttachment(s)` / `repo.writeBlob` and
  `Sheet.diffFrom` through this core surface (replacing the direct
  `@hologit/holo-tree` `writeBlob` and the `git diff-tree -M` shell-out). The
  iterator's `mimeType`/`.read()`/`.stream()` sugar stays host-side over the
  core's `name → hash` map.
- **Attachment-blob diffs in `diffFrom`** remain intentionally out of scope
  (specs/api/sheet.md: `*.toml` records only; consumers diff attachment blob
  hashes directly).
