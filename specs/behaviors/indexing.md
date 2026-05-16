# Behavior: Secondary Indexing

## Rule

A `Sheet` may declare one or more **secondary indices** for fast lookup by a derived key — typically a field that isn't in the path template. Indices are built and kept in process memory; they are not persisted to the data repo.

Indices supplement the path template (the *primary* index, which determines record locations on disk). The path template handles the dominant access pattern; secondary indices handle the others.

## Applies To

- [api/sheet.md](../api/sheet.md) — `defineIndex`, `findByIndex`
- [api/repository.md](../api/repository.md) — Sheet instances obtained via `repo.openSheet` and `repo.openSheets`
- [api/store.md](../api/store.md) — Store-wrapped sheets get indices defined the same way

## Declaration

```typescript
sheet.defineIndex(
  name: string,
  opts?: { unique?: boolean; eager?: boolean },
  keyFn: (record: T) => string | undefined,
): void;
```

- `name` — identifier used by `findByIndex`. Unique within the sheet.
- `opts.unique` — default `false`. If `true`, each key maps to at most one record.
- `opts.eager` — default `false`. If `true`, the index is built at sheet-open time.
- `keyFn` — called per record. Returns the index key (string) or `undefined` to exclude the record from the index.

Composite keys: concatenate inside `keyFn` (`record.projectId + ':' + record.status`).

```typescript
sheet.defineIndex('byEmail', { unique: true }, (r) => r.email.toLowerCase());
sheet.defineIndex('byProjectAndStatus', (r) => `${r.projectId}:${r.status}`);
```

## Lookup

```typescript
sheet.findByIndex(name: string, key: string): Promise<T | undefined>;       // unique
sheet.findByIndex(name: string, key: string): Promise<T[]>;                  // non-unique
```

The return type depends on whether the index was declared unique. TS overloads disambiguate.

Throws `IndexError` (`index_not_defined`) if `name` isn't declared on this sheet.

## Build timing

### Lazy (default)

The index is empty until the first `findByIndex(name, ...)` call for that name. On first call:

1. Iterate every record in the sheet
2. Call `keyFn(record)` for each
3. Populate the in-memory index
4. Serve the lookup
5. Subsequent lookups hit the populated index

### Eager (`opts.eager: true`)

The index is built at `sheet.defineIndex` time (synchronously enough — see below).

```typescript
sheet.defineIndex('byLegacyId', { unique: true, eager: true }, (r) => r.legacyId);
// → returns after the iteration completes; index ready
```

`defineIndex` with `eager: true` returns a `Promise<void>` that resolves when the build completes. The lazy variant returns `void` synchronously.

## Invalidation

### On `Sheet.upsert(record)` / `Sheet.delete(record)` (same instance)

Indices update synchronously after the mutation succeeds. The record's old keys (computed from the *previous* on-disk state, when available) are removed from each index; the new keys are added.

Without a pre-mutation read (e.g., a brand-new upsert), there's no old key to remove — straightforward addition.

For updates where the record changed identity-fields (the key from `keyFn` differs from before), the old key is removed and the new key is added in one synchronous step.

### On out-of-band ref movement

If the sheet's underlying ref moves due to a change made outside this `Sheet` instance — another process committed, the data repo was re-clone, etc. — every index on the sheet is marked dirty.

Next `findByIndex(name, ...)` call:

1. Detects the dirty state (by comparing the current ref's commit hash against the hash captured at last build)
2. Discards the existing index for that name
3. Re-runs the build pipeline
4. Serves the lookup

Other indices on the same sheet don't rebuild until accessed.

### Across multiple `Sheet` instances

Two `Sheet` instances opened against the same repo (e.g., a `Sheet` from `repo.openSheet('users')` and another from `store.users`) maintain *independent* indices. Mutations against one don't update the other.

This is a deliberate simplification — coordinating indices across instances would require an event bus the library otherwise doesn't need. Consumers building applications typically hold one `Sheet` (or one `Store`) per repo per process; the multi-instance scenario is unusual.

## Unique conflicts

When `opts.unique: true`:

- **Lazy build:** the conflict throws on first `findByIndex` call (or any `upsert`/`delete` that triggers a build). `IndexError` (`index_unique_conflict`) names both conflicting paths.
- **Eager build:** the conflict throws from the `defineIndex` Promise.
- **Mutation that would create a conflict:** `Sheet.upsert(record)` throws `IndexError` (`index_unique_conflict`) before writing to the tree. The mutation is aborted; the tree is unchanged. (This is the *only* index-related validation that affects writes — non-unique indices never block a write.)

## Memory + performance

- Each index entry costs roughly `key.length + 24` bytes plus a reference to the record (which is held by the sheet's in-memory record cache, not duplicated).
- A 10,000-record sheet with a single unique index on a 32-char key: ~600 KB.
- Build time for 10,000 records on commodity hardware: well under a second.

Memory limits are the consumer's concern. The library doesn't bound index size; consumers running on memory-constrained hosts should be deliberate about which indices to declare.

## Persisted indices?

Out of scope for v1.0. The reasoning:

- Most use cases at gitsheets' "civic scale" target rebuild in <1s
- Persistence requires choosing an on-disk format, deciding when to rebuild on schema change, and handling crash-during-write — substantial design + test surface
- If a consumer's corpus grows past the threshold, that's the time to design persisted indices with real requirements in hand

See [deferred.md](../deferred.md#persisted-indexes).

## Lookups vs. queries

`findByIndex` is an in-memory hash lookup — O(1). `Sheet.query` is a tree walk + filter — O(records) in the worst case (path template helps when applicable). They're complementary:

- Use `findByIndex` when you have a derived key and need fast point lookups
- Use `query` when you need to enumerate or filter on path-template fields

There's no `findManyByIndex` for non-unique indices because `findByIndex` already returns an array when the index is non-unique.

## Coordinates with

- [api/sheet.md](../api/sheet.md)
- [api/errors.md](../api/errors.md)
- [behaviors/path-templates.md](path-templates.md)
- [GitHub #134](https://github.com/JarvusInnovations/gitsheets/issues/134) — implementation issue
