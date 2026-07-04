# Behavior: Attachments

## Rule

A record may have any number of **attachments** — binary blobs colocated with the record in the data tree. Attachments are first-class: they participate in commits, diffs, and merges the same way records do.

## Applies To

- [api/sheet.md](../api/sheet.md) — `getAttachment`, `getAttachments`, `getAttachmentStream`, `setAttachment`, `setAttachments`, `deleteAttachment`, `deleteAttachments`, `attachments` (iterator)
- [api/repository.md](../api/repository.md) — `readBlobStream`
- [behaviors/path-templates.md](path-templates.md) — query traversal skips attachment subtrees

## Storage layout

For a record at `<sheetRoot>/<recordPath>.toml`, attachments live in a sibling directory at `<sheetRoot>/<recordPath>/`:

```text
users/janedoe.toml              # the record
users/janedoe/avatar.jpg        # attachment 1
users/janedoe/avatar-128.jpg    # attachment 2
users/janedoe/cover.png         # attachment 3
```

The record's own file (`<recordPath>.toml`) and the attachment directory (`<recordPath>/`) coexist as siblings in the tree. Git handles this without conflict.

## Naming

Attachment names are simple filenames — no slashes. Nested subdirectories under an attachment directory are reserved for future use; v1.0 attachments are flat per record.

The attachment name typically encodes the type via extension (`.jpg`, `.pdf`, `.zip`). The library does not enforce extension correctness or content-type validation — that's the consumer's responsibility.

## API

### `sheet.setAttachment(record, name, content)`

Stage a single attachment.

```typescript
// one call from raw bytes — no repo.writeBlob pre-step:
await sheet.setAttachment(record, 'avatar.jpg', uploadedBuffer);

// or from an already-written blob handle:
const blob = await repo.writeBlob(bytes);
await sheet.setAttachment(record, 'avatar.jpg', blob);
```

`content` accepts any of:

| Value type | Interpretation |
| --- | --- |
| `Buffer` / `Uint8Array` | Raw bytes — written to the object store as part of staging ([#234](https://github.com/JarvusInnovations/gitsheets/issues/234)) |
| `string` | UTF-8 text — encoded and written as bytes |
| `BlobHandle` | An already-written object-store blob (from `repo.writeBlob` or a diff) — reused by hash, no re-write |

### `sheet.setAttachments(record, map)`

Stage multiple attachments at once. Values accept the same types as `setAttachment` — mixing is fine:

```typescript
await sheet.setAttachments(record, {
  'avatar.jpg': avatarBuffer,        // raw bytes
  'avatar-128.jpg': thumbnailBlob,   // BlobHandle
});
```

### `sheet.getAttachments(record)`

Returns a blob map keyed by attachment name. Used for browsing.

```typescript
const attachments = await sheet.getAttachments(record);
// → { 'avatar.jpg': BlobObject, 'avatar-128.jpg': BlobObject }
```

Returns `null` if the record has no attachment directory.

### `sheet.getAttachment(record, name)`

Returns the named attachment's blob, or `null` if absent.

```typescript
const blob = await sheet.getAttachment(record, 'avatar.jpg');
if (blob) {
  const buf = await blob.read();   // Buffer
}
```

### `sheet.deleteAttachment(record, name)`

Remove a single named attachment. Sibling attachments are left intact.

```typescript
await sheet.deleteAttachment(record, 'avatar.jpg');
```

Throws `NotFoundError` (`record_not_found`) if the named attachment doesn't exist — single-target deletion is strict so callers can't silently miss bugs.

### `sheet.deleteAttachments(record)`

Remove all attachments for a record (drops the entire attachment directory).

```typescript
await sheet.deleteAttachments(record);
```

**No-op** when the record has no attachment directory — idempotent, mirroring the cascade behavior on `Sheet.delete(record)`. The transaction is not marked mutated in the no-op case (so a transaction that does nothing else still completes without a commit).

## Streaming reads by key/path

Two surfaces stream an attachment's bytes **without materializing its record** — for HTTP handlers serving blobs (avatars, uploads) where "load the record, then get the attachment" is pure overhead:

### `sheet.getAttachmentStream(recordOrPath, name)`

```typescript
const stream = await sheet.getAttachmentStream('janedoe', 'avatar.jpg');
if (stream === null) reply.code(404);
else stream.pipe(reply.raw);
```

Accepts a record object or a rendered record path (like `getAttachment`); returns `Promise<Readable | null>` — `null` when the attachment is absent, mirroring `getAttachment`. Resolves through the sheet's read snapshot ([freshness.md](freshness.md)), so it reflects this repository's commits without re-opening the sheet.

### `repo.readBlobStream(ref, path)`

The repository-level primitive for consumers whose attachment key **is** the tree path (`<sheetRoot>/<recordPath>/<name>`): resolves `<ref>:<path>` at call time — no sheet, no snapshot — and returns `Promise<Readable>`. Throws `RefError` (`ref_not_found`) / `NotFoundError` (`record_not_found`) rather than returning `null`, since the caller named an explicit ref. See [api/repository.md](../api/repository.md#reporeadblobstreamref-path).

Both are backed by a streamed `git cat-file blob` read — bytes are piped, never fully buffered by gitsheets.

## Iterator API

A higher-level iterator surface — sugar over `getAttachments`:

```typescript
for await (const { name, mimeType, blob } of sheet.attachments(record)) {
  const buf = await blob.read();      // Buffer
  // or stream:
  blob.stream().pipe(someWritable);
}
```

- `name` — the attachment filename (relative to the record's attachment dir)
- `mimeType` — inferred from extension; `application/octet-stream` for unknown extensions
- `blob` — handle with `.hash`, `.read()` (Buffer), and `.stream()` (Readable backed by `git cat-file blob <hash>`)

The lower-level `getAttachments` / `getAttachment` methods remain for callers that want the raw blob-hash map.

## Atomicity

Attachment changes are part of the transaction's tree. They stage and commit atomically with record changes:

```typescript
await repo.transact({ message: 'Update avatar' }, async (tx) => {
  await tx.sheet('users').upsert(updatedUser);                // record change
  await tx.sheet('users').setAttachment(updatedUser, 'avatar.jpg', blob);  // attachment change
  // Both land in the same commit
});
```

If the handler throws, both changes are discarded.

## Cascade on record delete

When a record is deleted via `Sheet.delete(record)`, **its attachment directory is also deleted in the same operation.** The pre-v1.0 behavior left attachments orphaned in the tree; v1.0 fixes this.

For "preserve attachments across record deletion" use cases (rare), the consumer can move the attachment subtree to a different location before deleting the record.

## Query interaction

The `query` traversal recognizes that a directory named `<recordName>/` next to a file `<recordName>.toml` is an attachment container, not a nested record. It descends into the directory only for `getAttachments` calls — never for query iteration. See [behaviors/path-templates.md](path-templates.md).

This means a sheet with `path = "${{ slug }}"` and records at `users/janedoe.toml` + attachments at `users/janedoe/avatar.jpg` works correctly — `query({})` yields only `janedoe`, not also the avatar.

## Binary diffs

Git handles binary blob diffs by recording before/after blob hashes. Gitsheets' `Sheet.diffFrom` includes attachment changes when scanning the record's path — but parses them as blob-diff records (no `records: true` payload, since attachments aren't TOML).

For diffing the attachment content itself (image diffs, PDF text extraction), consumers run their own tools against the blob hashes.

## Size limits

Gitsheets imposes no inherent size limit. Practical limits come from git itself:

- Single blob: git happily stores multi-GB blobs but performance degrades
- Repo total: git LFS is the conventional answer for large binary repos
- For attachments larger than ~10 MB, consider whether the data belongs in the gitsheets repo at all or in object storage referenced by URL from the record

The library does not invoke git LFS automatically. Consumers wanting LFS configure it via `.gitattributes` in the data repo themselves.

## Coordinates with

- [api/sheet.md](../api/sheet.md)
- [behaviors/path-templates.md](path-templates.md)
- [behaviors/transactions.md](transactions.md)
- [GitHub #140](https://github.com/JarvusInnovations/gitsheets/issues/140) — iterator API (shipped v1.1)
