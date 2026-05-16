# API: Sheet

A typed handle to a single sheet within a repository. The most-touched object in consumer code.

## Summary

A `Sheet<T>` represents one declared sheet in `.gitsheets/<name>.toml`. It owns the path template, the JSON Schema, the canonical-normalization rules, and the secondary in-memory indices. All record-level mutations and queries go through it.

## Type parameter

`T` is the record shape inferred from the sheet's JSON Schema, optionally narrowed by a consumer-supplied Standard Schema validator. Without a validator, `T = Record<string, unknown>`.

## Reading

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

### `sheet.queryFirst(filter?, opts?)`

Returns `Promise<T | undefined>`. The first match, or `undefined`. Honors the same `opts.signal` as `query`.

### `sheet.queryAll(filter?, opts?)`

Returns `Promise<T[]>`. All matches collected into an array. Convenience over `for await ... push`. Honors the same `opts.signal` as `query`.

### `sheet.pathForRecord(record)`

Returns `Promise<string>` — the path the sheet's template would render this record to. Does not write.

### `sheet.normalizeRecord(record)`

Returns `Promise<T>` — the record with canonical normalization applied (sorted keys deep, array-field sorts per [behaviors/normalization.md](../behaviors/normalization.md)). Does not write, does not validate.

## Writing

All write methods stage to the current transaction's tree (or, in permissive mode, auto-open and commit a single-mutation transaction). See [behaviors/transactions.md](../behaviors/transactions.md).

### `sheet.upsert(record)`

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
- Writes the TOML blob to the tree
- Returns the staged blob + its path

Throws `ValidationError` on invalid input. Throws `PathTemplateError` if the template can't render against the record.

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

Removes every record from the sheet's tree. Used during full-replace imports.

### `sheet.clone()`

Returns a deep clone of the `Sheet` instance with a cloned data tree. Used to stage a tentative state for diffing / proposing without mutating the original.

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
await sheet.setAttachment(record, 'avatar.jpg', blob);
await sheet.setAttachments(record, { 'avatar.jpg': blob1, 'avatar-128.jpg': blob2 });

const attachments = await sheet.getAttachments(record); // current low-level surface
const avatar = await sheet.getAttachment(record, 'avatar.jpg');
```

The iterator API (`for await (const { name, mimeType, blob } of sheet.attachments(record))`) is deferred to a post-1.0 release. See [#140](https://github.com/JarvusInnovations/gitsheets/issues/140).

## Diff

### `sheet.diffFrom(srcCommitHash?, opts?)`

> **Deferred — not in the v1.0 surface.** Tracked at [#152](https://github.com/JarvusInnovations/gitsheets/issues/152); see [`deferred.md`](../deferred.md).

Async iterator of changes between `srcCommitHash` and the current tree, scoped to this sheet's root.

```typescript
for await (const change of sheet.diffFrom('HEAD~1', { records: true, patches: true })) {
  // change.status: 'added' | 'modified' | 'deleted' | 'renamed'
  // change.path
  // change.src / change.dst  (when records: true)
  // change.patch             (when patches: true)
}
```

- `srcCommitHash` defaults to the empty tree (all current records are "added").
- `opts.blobs?: boolean` — include raw blob handles
- `opts.records?: boolean` — include parsed src/dst records
- `opts.patches?: boolean` — include RFC 6902 (JSON Patch) patches between src and dst

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
- [behaviors/indexing.md](../behaviors/indexing.md)
- [behaviors/patch-semantics.md](../behaviors/patch-semantics.md)
- [behaviors/attachments.md](../behaviors/attachments.md)
