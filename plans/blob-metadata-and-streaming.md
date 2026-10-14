---
status: done
depends: []
specs:
  - specs/behaviors/attachments.md
  - specs/api/repository.md
  - specs/api/sheet.md
issues: [306]
pr: 315
---

# Plan: blob metadata with streaming reads

## Scope

- `BlobHandle` gains `size` (bytes) and `stream()`; it is the one handle
  type (`AttachmentBlobHandle` becomes an alias). `getAttachment`,
  `getAttachments`, `attachments()`, `upsert`, and `diffFrom({ blobs })`
  all hand it out.
- `repo.readBlob(ref, path): Promise<BlobHandle>`; `readBlobStream` is its
  `.stream()`. The `cat-file -t` / `rev-parse` spawns go away: the ref and
  path resolve in the core, with `RefError` / `NotFoundError` preserved.
- `stream()` buffers a bounded amount: ≤ 1 MiB from one in-core read,
  otherwise piped from `git cat-file blob <hash>`.
- Core/bindings: `blob_header(git_dir, hash) → { kind, size }` from the
  object header (no inflate); Node `blobHeader`, Python `blob_header`.

Out of scope: a chunked in-core streaming read (gix inflates whole
objects; the spawn path covers the large case).

## Implements

- `specs/behaviors/attachments.md` — "Blob metadata and bounded buffering",
  `readBlob`.
- `specs/api/repository.md` — `repo.readBlob`, `readBlobStream`.
- `specs/api/sheet.md` — attachment handle shape.

## Approach

1. Core `record::blob_header(repo, hash) -> Option<(ObjectKind, u64)>` via
   `Repository::find_header`. napi `blobHeader(gitDir, hash)`; pyo3
   `blob_header`.
2. Host `makeBlobHandle(gitDir, hash, mode, knownBytes?)`: `size` eager
   (from `knownBytes.length` or one header read); `stream()` per the
   threshold. `makeAttachmentBlobHandle` folds into it.
3. `Repository.readBlob` via `addon.treeEntryHash` (RefError propagates;
   `null` → NotFoundError) + header; `readBlobStream` delegates.
4. Tests: handle `size` on `getAttachment` / iterator / `upsert` result;
   `readBlob` metadata and errors; a > 1 MiB attachment streams
   byte-identical through the spawn path; napi + pytest `blob_header`.
5. Docs: `docs/api.md`, skill `references/api.md`.

## Validation

- [x] `cargo test`: `blob_header` kind/size, `None` for a missing id.
- [x] napi + pytest: `blobHeader` / `blob_header` parity.
- [x] vitest: the host cases above; existing attachment, iterator, diff and
      blob-stream suites pass.
- [x] clippy / type-check clean.

## Risks / unknowns

- `size` is eager on every handle; it is one header read (microseconds),
  including for `diffFrom({ blobs: true })` over many changes.

## Notes

- `size` is eager on every handle (one `try_find_header` read); the blob is
  never inflated for it.
- `stream()` serves ≤ `STREAM_INLINE_LIMIT` (1 MiB) from one in-core read and
  pipes `git cat-file blob <hash>` above that — the only spawn left on the
  read side, kept because gix inflates whole objects.
- `readBlobStream` lost its `cat-file -t` / `rev-parse` spawns: the core's
  `treeEntryHash` resolves the ref (RefError) and the path (null →
  NotFoundError).
- `AttachmentBlobHandle` is a type alias of `BlobHandle` now.

## Follow-ups

- None.
