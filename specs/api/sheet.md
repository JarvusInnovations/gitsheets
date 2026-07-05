# API: Sheet

A typed handle to a single sheet within a repository. The most-touched object in consumer code.

## Summary

A `Sheet<T>` represents one declared sheet in `.gitsheets/<name>.toml`. It owns the path template, the JSON Schema, the canonical-normalization rules, and the secondary in-memory indices. All record-level mutations and queries go through it.

## Type parameter

`T` is the record shape inferred from the sheet's JSON Schema, optionally narrowed by a consumer-supplied Standard Schema validator. Without a validator, `T = Record<string, unknown>`.

## Reading

Non-transaction reads resolve against the sheet's **read snapshot** — rebound automatically after each commit by the owning `Repository`, and explicitly via `refresh()`. See [behaviors/freshness.md](../behaviors/freshness.md).

### `sheet.refresh()`

Rebind this sheet's read snapshot to the repository's current `HEAD` tree. Returns `Promise<void>`.

```typescript
await sheet.refresh();       // pick up out-of-band ref movement
await sheet.queryAll();      // now reflects the current HEAD tree
```

- Rebinds **only this sheet** — the "did my row land?" primitive. For every open sheet at once, use `repo.refresh()` / `store.refresh()`.
- Not needed after this repository's own `repo.transact` — a successful commit auto-refreshes every live sheet.
- Lazily re-derives records, attachments, config, and index builds from the new tree ([behaviors/freshness.md](../behaviors/freshness.md#what-a-rebind-refreshes)).
- Throws `TypeError` on a transaction-bound sheet (`tx.sheet(name)`) — those read the transaction's private tree.

### `sheet.query(filter?, opts?)`

Async iterator yielding records matching `filter`.

```typescript
for await (const user of sheet.query({ accountLevel: 'staff' })) {
  // ...
}
```

- `filter` is a plain object. Each key on the filter is matched against the record's field by equality. Function-valued filter entries are called as `(recordValue, record) => boolean`. Nested objects descend recursively.
- If the filter includes fields from the path template, gitsheets prunes the tree traversal to only matching subtrees (see [behaviors/path-templates.md](../behaviors/path-templates.md)).
- Order of results: filesystem order within each tree level. Not guaranteed stable across implementation changes — sort in consumer code if order matters.
- `opts.signal?: AbortSignal` — cancel a streaming query. The query checks the signal before iteration starts and again before each yield. If aborted, the next iteration throws `signal.reason` (a `DOMException` with name `'AbortError'` by default, or whatever value the consumer passed to `controller.abort(reason)`). See [api/conventions.md](conventions.md#cancellation).
- `opts.withBody?: boolean` — for content-typed (markdown/mdx) sheets, whether to load the body field. Default `true`. Setting `false` reads only the frontmatter; the body field is `undefined` on yielded records. No effect on TOML sheets. Filters that reference the body field throw `TypeError` under `withBody: false`. See [behaviors/content-types.md](../behaviors/content-types.md#lazy-body-loading).

### `sheet.queryFirst(filter?, opts?)`

Returns `Promise<T | undefined>`. The first match, or `undefined`. Honors the same `opts.signal` and `opts.withBody` as `query`.

### `sheet.queryAll(filter?, opts?)`

Returns `Promise<T[]>`. All matches collected into an array. Convenience over `for await ... push`. Honors the same `opts.signal` and `opts.withBody` as `query`.

### `sheet.count(filter?)`

Returns `Promise<number>`, the number of matching records. With no filter (outside a transaction) it counts candidate paths from the tree walk without parsing any record, so it stays cheap on large sheets. A non-empty filter (value or function predicate) or a tx-bound sheet falls back to a body-less scan that honors the filter. Throws `TypeError` if passed a function.

### `sheet.loadBody(record)`

Hydrate a body-less record (returned by `query` / `queryFirst` / `queryAll` / `findByIndex` under `withBody: false`) with its full body. Re-reads the record blob and returns a fresh record with the body field populated. For TOML sheets (no body concept), returns the record unchanged. See [behaviors/content-types.md](../behaviors/content-types.md#lazy-body-loading).

Throws `NotFoundError` if the underlying blob is missing. Throws `TypeError` if the input lacks the `RECORD_PATH_KEY` annotation (i.e., the record didn't come from a Sheet read).

### `sheet.pathForRecord(record)`

Returns `Promise<string>` — the path the sheet's template would render this record to. Does not write.

### `sheet.normalizeRecord(record)`

Returns `Promise<T>` — the record with canonical normalization applied (sorted keys deep, array-field sorts per [behaviors/normalization.md](../behaviors/normalization.md)). Does not write, does not validate.

## Writing

All write methods stage to the current transaction's tree (or, in permissive mode, auto-open and commit a single-mutation transaction). See [behaviors/transactions.md](../behaviors/transactions.md).

### `sheet.upsert(record, opts?)`

```typescript
const { blob, path } = await sheet.upsert({
  slug: 'janedoe',
  email: 'jane@x.org',
  fullName: 'Jane Doe',
});
```

- Validates the record (JSON Schema + optional Standard Schema; see [behaviors/validation.md](../behaviors/validation.md))
- Applies canonical normalization
- Renders the record's path from the template
- If the record was loaded from disk (has the `Symbol.for('gitsheets-path')` annotation) and the new rendered path differs, the old path's file is deleted (rename semantics)
- Serializes through the configured sheet format (TOML by default, markdown/mdx for content-typed sheets — see [behaviors/content-types.md](../behaviors/content-types.md)) and writes the blob
- Returns the staged blob + its path

`opts.allowMissingBody?: boolean` — content-typed sheets only. Permits an upsert whose record omits the configured body field; without it, a missing body throws `TypeError` so a body-less upsert can't silently erase on-disk content. See [behaviors/content-types.md](../behaviors/content-types.md#upsert-with-a-body-less-record).

Throws `ValidationError` on invalid input. Throws `PathTemplateError` if the template can't render against the record.

### `sheet.willChange(record, opts?)`

Pre-flight idempotency check for `upsert`. Returns the canonical bytes the upsert would write and whether they differ from the current blob at the rendered path. Does NOT mutate the tree.

```typescript
const { changed, path, currentBlobHash, nextText } = await sheet.willChange({
  slug: 'janedoe',
  email: 'jane@x.org',
});
if (changed) {
  await sheet.upsert({ slug: 'janedoe', email: 'jane@x.org' });
}
```

- Runs the same pipeline as `upsert` (body-presence guard, JSON Schema + Standard Schema validation, canonical normalization, path rendering, unique-index conflict check, format serialization) — throws the same errors `upsert` would on the same input.
- Compares the serialized bytes to the existing blob at the rendered path.
- Returns `{ changed, path, currentBlobHash, nextText }`:
  - `changed: boolean` — `true` if the bytes differ, `false` for a logical no-op.
  - `path: string` — sheet-relative path the record renders to.
  - `currentBlobHash?: string` — hash of the existing blob, or `undefined` when the record doesn't exist on disk yet.
  - `nextText: string` — the UTF-8 serialized bytes that `upsert` would write.

`opts` matches `upsert` — `allowMissingBody` behaves the same way.

Intended for consumers that want commit-skipping idempotency semantics: "only commit when something actually changed." The agent-facing CLI (`gitsheets-axi`) uses this to make mutations idempotent — an `upsert` of unchanged content exits 0 with `(no-op)` rather than producing an empty commit.

### `sheet.delete(recordOrPath)`

```typescript
await sheet.delete({ slug: 'janedoe' });   // delete by record
await sheet.delete('users/janedoe');       // delete by path
```

If passed a record, renders its path via the template first. Returns void.

Throws `NotFoundError` if the path doesn't exist in the current tree.

### `sheet.patch(query, partial)`

Applies an RFC 7396 JSON Merge Patch to an existing record.

```typescript
await sheet.patch(
  { slug: 'janedoe' },
  { fullName: 'Jane O. Doe', bio: null }
);
```

Steps:

1. `queryFirst(query)` → existing record. Throws `NotFoundError` if no match.
2. Apply RFC 7396 semantics — see [behaviors/patch-semantics.md](../behaviors/patch-semantics.md). (`null` deletes, arrays replace, objects merge.)
3. Validate the merged record (same pipeline as `upsert`).
4. `upsert` the result.

Returns `Promise<{ blob, path }>` matching `upsert`.

### `sheet.clear()`

Removes every record from the sheet's tree. Used during full-replace imports (snapshot importers, full re-syncs).

**O(1)** regardless of record count — internally points the sheet's subtree at git's canonical empty-tree hash (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`) via hologit's `TreeObject.clearChildren()`. Invalidates the sheet's in-memory indexes. The resulting empty subtree is omitted from the committed tree (hologit's `write()` skips empty subtrees), so consumers querying the committed sheet root after a clear see no entries.

Pairs naturally with `Transaction#finalize`'s no-op detection (see [transaction.md](transaction.md)) — a `clear()` + re-upsert of byte-identical data produces no commit.

### `sheet.clone()`

Returns a deep clone of the `Sheet` instance with a cloned data tree. Used to stage a tentative state for diffing / proposing without mutating the original. A clone is a Repository-issued sheet like any other: it participates in the freshness model (auto-refresh on commit, `refresh()`), and is **not** a pinned snapshot — see [behaviors/freshness.md](../behaviors/freshness.md#pinned--historical-reads).

## Indexing

### `sheet.defineIndex(name, opts?, keyFn)`

Declare a secondary in-memory index.

```typescript
sheet.defineIndex(
  'byEmail',
  { unique: true, eager: false },
  (record) => record.email.toLowerCase()
);

sheet.defineIndex(
  'byProjectAndStatus',
  (record) => `${record.projectId}:${record.status}`
);
```

- `opts.unique?: boolean` — default `false`
- `opts.eager?: boolean` — default `false` (lazy)
- `keyFn(record): string | undefined` — return `undefined` to exclude a record from the index

See [behaviors/indexing.md](../behaviors/indexing.md) for build, invalidation, and conflict semantics.

### `sheet.findByIndex(name, key)`

- Unique index: returns `Promise<T | undefined>`
- Non-unique index: returns `Promise<T[]>`

Throws `IndexError` (`index_not_defined`) if `name` isn't declared on this sheet.
Throws `IndexError` (`index_unique_conflict`) during a lazy build if uniqueness is violated.

## Attachments

Binary blobs colocated with a record.

```typescript
await sheet.setAttachment(record, 'avatar.jpg', bufferOrBlob);
await sheet.setAttachments(record, { 'avatar.jpg': buffer1, 'avatar-128.jpg': blob2 });

const attachments = await sheet.getAttachments(record); // current low-level surface
const avatar = await sheet.getAttachment(record, 'avatar.jpg');

await sheet.deleteAttachment(record, 'avatar.jpg');     // throws NotFoundError if missing
await sheet.deleteAttachments(record);                  // no-op if record has no attachment dir
```

`setAttachment` / `setAttachments` values accept raw bytes (`Buffer` / `Uint8Array`), UTF-8 `string` content, or a `BlobHandle` from `repo.writeBlob` — the raw-bytes form makes the common "here are the bytes, attach them" case one call. See [behaviors/attachments.md](../behaviors/attachments.md#sheetsetattachmentrecord-name-content).

Streaming read without materializing the record:

```typescript
const stream = await sheet.getAttachmentStream('janedoe', 'avatar.jpg'); // Readable | null
stream?.pipe(httpResponse);
```

`getAttachmentStream(recordOrPath, name)` accepts a record object or a rendered record path (like `getAttachment`), returns a Node `Readable` over the attachment's bytes, or `null` when the attachment is absent — resolved through the sheet's read snapshot. See [behaviors/attachments.md](../behaviors/attachments.md#streaming-reads-by-keypath).

Iterator surface:

```typescript
for await (const { name, mimeType, blob } of sheet.attachments(record)) {
  const bytes = await blob.read();    // Buffer
  // or pipe blob.stream() to wherever
}
```

`mimeType` is inferred from the filename extension (with `application/octet-stream` for unknown extensions). `blob.read()` returns a `Buffer`; `blob.stream()` returns a `Readable` from `git cat-file blob <hash>` — useful for streaming large binary attachments without materializing the whole blob in memory.

## Diff

### `sheet.diffFrom(srcCommitHash?, opts?)`

Async iterator of changes between `srcCommitHash` and the current tree, scoped to this sheet's root. Useful for "what changed since the last review" surfaces, audit trails, change-feed consumers.

```typescript
for await (const change of sheet.diffFrom('HEAD~1', { records: true, patches: true })) {
  // change.path                            // record path (no .toml suffix, relative to sheet root)
  // change.status                          // 'added' | 'modified' | 'deleted' | 'renamed'
  // change.srcMode / change.dstMode        // git file modes (null on add/delete)
  // change.srcHash / change.dstHash        // blob hashes (null on add/delete)
  // change.src / change.dst                // parsed records (records: true)
  // change.patch                           // RFC 6902 JSON Patch ops (patches: true)
  // change.srcBlob / change.dstBlob        // hologit BlobObject handles (blobs: true)
}
```

- `srcCommitHash` accepts a commit hash, a tree hash, or a ref name (`'HEAD~1'`, `'main'`). Defaults to the empty tree — every current record yields `status: 'added'`.
- `opts.blobs?: boolean` — attach `srcBlob` / `dstBlob` (hologit `BlobObject`) handles.
- `opts.records?: boolean` — parse src/dst TOML into records.
- `opts.patches?: boolean` — produce an RFC 6902 JSON Patch (`Operation[]`) from src to dst. Add and delete entries get a single-op patch (`add` / `remove` on the root); modify entries get the full op sequence.

Scope: `*.toml` records only. Attachment-blob diffs (binary blobs under the record dir) are out of scope for v1.1 — consumers diff attachment blob hashes directly using the hashes the iterator surfaces.

Throws `RefError` (`ref_not_found`) when `srcCommitHash` doesn't resolve.

## Errors

See [api/errors.md](errors.md). Common: `ValidationError`, `NotFoundError`, `PathTemplateError`, `IndexError`.

## Coordinates with

- [api/conventions.md](conventions.md)
- [api/transaction.md](transaction.md)
- [api/errors.md](errors.md)
- [behaviors/path-templates.md](../behaviors/path-templates.md)
- [behaviors/validation.md](../behaviors/validation.md)
- [behaviors/normalization.md](../behaviors/normalization.md)
- [behaviors/transactions.md](../behaviors/transactions.md)
- [behaviors/freshness.md](../behaviors/freshness.md)
- [behaviors/indexing.md](../behaviors/indexing.md)
- [behaviors/patch-semantics.md](../behaviors/patch-semantics.md)
- [behaviors/attachments.md](../behaviors/attachments.md)
