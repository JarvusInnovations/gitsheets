# Secondary indices

The path template is gitsheets's primary index — it determines the dominant access path. Secondary indices give you cheap lookups in *other* directions ("find user by email," "all memberships for this person") without restructuring the tree.

Indices are **in-memory only**. They build lazily on first lookup and invalidate on writes. No persistence, no extra files in your repo.

## When to use one

You have a sheet with `path = '${{ slug }}'`. The primary index makes `findBySlug` cheap. But your code also needs to find users by their `email` — a field the path template doesn't use. Without an index, that's an `O(records)` walk every time.

```typescript
// without an index — fast for primary key, walks for everything else
const jane = await users.queryFirst({ slug: 'jane' });        // O(1) path
const byEmail = await users.queryFirst({ email: 'jane@x.org' }); // O(n) walk
```

With an index:

```typescript
users.defineIndex('byEmail', { unique: true }, (r) => r.email.toLowerCase());

const byEmail = await users.findByIndex('byEmail', 'jane@x.org'); // O(1) after build
```

The build itself is `O(n)` (one walk) but only on first access, and it's amortized across every subsequent lookup.

## Define + look up

```typescript
import { openRepo } from 'gitsheets';

const repo = await openRepo();
const users = await repo.openSheet('users');

users.defineIndex('byEmail', { unique: true }, (record) =>
  (record.email as string).toLowerCase(),
);

const jane = await users.findByIndex('byEmail', 'jane@x.org');
// → record | undefined  (unique index)
```

The `keyFn` is the heart of the index — it takes a record and returns the string key it should be indexed under. Returning `undefined` or `null` excludes the record from the index entirely (useful for sparse indices).

## Unique vs non-unique

**Unique** — `findByIndex` returns a single record (or `undefined`). On the first lookup, if the index detects duplicate keys, it throws `IndexError('index_unique_conflict')` with the conflicting paths.

```typescript
users.defineIndex('byEmail', { unique: true }, (r) => r.email.toLowerCase());
```

**Non-unique** — `findByIndex` returns an array. Multiple records can share a key.

```typescript
users.defineIndex('byTeam', (r) => r.team);   // no { unique: true }

const eng = await users.findByIndex('byTeam', 'engineering');
// → record[]
```

## Composite keys

`keyFn` returns a string — composition is the consumer's responsibility. The standard approach: concatenate field values with a separator that won't appear in the data.

```typescript
projects.defineIndex(
  'byOrgAndStatus',
  (r) => `${r.orgSlug}\x00${r.status}`,
);

const active = await projects.findByIndex(
  'byOrgAndStatus',
  `acme\x00active`,
);
```

`\x00` (null byte) is a good separator because it can't appear in a meaningful slug. Otherwise pick something your data definitely doesn't contain.

## Eager vs lazy

By default, indices build **lazily** — on first `findByIndex` call. The build cost is paid by whoever hits the index first.

For predictable startup latency, opt into **eager** building. `defineIndex({ eager: true }, ...)` returns a `Promise<void>` that resolves when the build completes:

```typescript
await users.defineIndex(
  'byLegacyId',
  { unique: true, eager: true },
  (r) => (r.legacyId !== undefined ? String(r.legacyId) : undefined),
);
// Index is now built — any subsequent findByIndex hits memory
```

Eager builds surface unique conflicts at definition time rather than first access.

## Sparse indices

Return `undefined` from `keyFn` to exclude a record:

```typescript
// Index only records that have a legacyId
users.defineIndex(
  'byLegacyId',
  { unique: true },
  (r) => (r.legacyId !== undefined ? String(r.legacyId) : undefined),
);
```

This is the right pattern for fields that only some records have (legacy IDs, external identifiers, optional handles).

## Invalidation

Indices invalidate on:

- `sheet.upsert(...)` / `sheet.delete(...)` against the same `Sheet` instance — synchronously, before the next lookup
- The data tree's hash changing (someone else committed to the ref) — detected on next access, triggers a rebuild

The first case is fine and cheap — gitsheets just clears the index's `built` flag; next `findByIndex` rebuilds.

The second case is also fine but more expensive — a full re-walk of the sheet. If your process makes many mutations and you don't want the rebuild churn, prefer a single long-lived `Sheet` instance (vs. opening a fresh one per request).

## Multiple indices per sheet

Define as many as you want:

```typescript
users.defineIndex('byEmail',  { unique: true }, (r) => r.email.toLowerCase());
users.defineIndex('byTeam',                      (r) => r.team);
users.defineIndex('byAccountLevel',              (r) => r.accountLevel);
```

Each is independent — all rebuild together on a tree change, but a write to the same Sheet instance invalidates each cheaply.

## Don't index on the body field

For the upcoming markdown-format sheets ([#158](https://github.com/JarvusInnovations/gitsheets/issues/158)), indices key on metadata (frontmatter fields). Indexing on the body field is not a supported use case — bodies are content, not keys. The lazy-loading path-spec for content sheets makes body access opt-in, and indices use body-less reads.

## Cost model

- **Memory:** ~1 entry per record per index. For a sheet of 10,000 records, three indices ≈ 30k Map entries. Trivial.
- **Build:** one walk of the sheet — same cost as `queryAll`. Pays once per ref-change.
- **Lookup:** `Map.get` — constant time.

For sheets with > ~100k records, consider whether to keep all records in a single sheet vs splitting by path template segment. Indices stay efficient at that scale, but `queryAll` (the build trigger) doesn't.

## Errors

```typescript
import { IndexError } from 'gitsheets';

try {
  await users.findByIndex('byEmail', 'jane@x.org');
} catch (err) {
  if (err instanceof IndexError && err.code === 'index_unique_conflict') {
    console.error('Duplicate emails:', err.conflictingPaths);
    // → ['users/alice.toml', 'users/alice2.toml']
  }
  if (err instanceof IndexError && err.code === 'index_not_defined') {
    // typo'd the index name
  }
}
```

## Upsert-time uniqueness check

Beyond the build-time conflict detection, the library checks unique constraints **before writing** during `Sheet.upsert`. If a write would violate a built unique index, it throws `IndexError('index_unique_conflict')` *before* any tree mutation:

```typescript
users.defineIndex('byEmail', { unique: true }, (r) => r.email.toLowerCase());
await users.findByIndex('byEmail', 'jane@x.org');  // build the index

// Later — this attempt is rejected without touching the tree
try {
  await users.upsert({ slug: 'imposter', email: 'jane@x.org' });
} catch (err) {
  if (err instanceof IndexError) {
    console.error('Would violate byEmail:', err.conflictingPaths);
  }
}
```

So an index isn't just a read accelerator — it's also an enforced uniqueness constraint at write time.

## See also

- [Concepts: Index](../concepts.md#index)
- [`specs/behaviors/indexing.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/indexing.md) — invalidation rules, conflict semantics
- [`specs/api/sheet.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/sheet.md) — full Sheet API
