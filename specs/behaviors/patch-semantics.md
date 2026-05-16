# Behavior: Patch Semantics (RFC 7396)

## Rule

`Sheet.patch(query, partial)` and the CLI's `--patch` flag use **[RFC 7396 JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396)** to combine the partial document with the existing record.

A standards-based merge with predictable rules — replacing the pre-v1.0 `deepmerge` behavior, which had multiple non-obvious edge cases.

## Applies To

- [api/sheet.md](../api/sheet.md) — `patch(query, partial)`
- [api/cli.md](../api/cli.md) — `git sheet upsert --patch`

## RFC 7396 in one paragraph

Apply each key of the patch to the target:

- If the patch value is `null`, **delete** that key from the target
- If the patch value is an object, **recursively merge** with the target's value at that key (which must also be an object or absent)
- If the patch value is anything else (scalar, array), **replace** the target's value at that key

That's the entire spec. Arrays replace as atomic values — element-level merging is *not* part of RFC 7396 and is intentionally not supported.

## Pipeline

When `sheet.patch(query, partial)` is called:

1. `queryFirst(query)` → existing record. If no match, throw `NotFoundError` (`record_not_found`).
2. Apply RFC 7396 to combine `partial` with the existing record → new record.
3. Validate the new record (JSON Schema + optional Standard Schema, per [validation.md](validation.md)). On failure, throw `ValidationError`.
4. Apply canonical normalization (per [normalization.md](normalization.md)).
5. Render path, write to tree (within the current transaction).

Returns `Promise<{ blob, path }>` — the same shape as `upsert`.

## Worked examples

### Update a field

```javascript
existing = { slug: 'jane', email: 'jane@old.org', fullName: 'Jane' }
patch    = { email: 'jane@new.org' }
result   = { slug: 'jane', email: 'jane@new.org', fullName: 'Jane' }
```

### Delete a field

```javascript
existing = { slug: 'jane', email: 'jane@x.org', bio: 'Hello!' }
patch    = { bio: null }
result   = { slug: 'jane', email: 'jane@x.org' }       // bio removed
```

### Replace an array

```javascript
existing = { slug: 'jane', tags: ['foo', 'bar'] }
patch    = { tags: ['baz'] }
result   = { slug: 'jane', tags: ['baz'] }              // replaced, not concatenated
```

This is the surprising case for consumers expecting deep-merge behavior. The CLI help text and `docs/` explicitly call it out.

### Merge nested objects

```javascript
existing = { slug: 'jane', address: { city: 'Philly', zip: '19103' } }
patch    = { address: { zip: '19104' } }
result   = { slug: 'jane', address: { city: 'Philly', zip: '19104' } }    // recursive merge
```

### Delete a nested field

```javascript
existing = { slug: 'jane', address: { city: 'Philly', zip: '19103' } }
patch    = { address: { zip: null } }
result   = { slug: 'jane', address: { city: 'Philly' } }
```

### Replace a nested object wholesale

```javascript
existing = { slug: 'jane', address: { city: 'Philly', zip: '19103' } }
patch    = { address: { city: 'Pittsburgh' } }
result   = { slug: 'jane', address: { city: 'Pittsburgh' } }   // zip is deleted? NO!
```

Wait — actually:

```javascript
result   = { slug: 'jane', address: { city: 'Pittsburgh', zip: '19103' } }
```

Because the patch value `{ city: 'Pittsburgh' }` is an object, RFC 7396 recursively merges. To *replace* the address object wholesale, the patch would need to first delete all of address's keys, or set `address: null` and then `upsert` (not patch) the new shape.

In practice, "replace this whole subtree" is `upsert`, not `patch`. If a consumer wants atomic replace-then-set behavior, they use `upsert` with the full record.

## Vs. `upsert`

| | `upsert(newRecord)` | `patch(query, partial)` |
| --- | --- | --- |
| Read existing first | No (write only) | Yes (`queryFirst(query)`) |
| Required input | full record | partial — only changed fields |
| Missing-record behavior | Creates a new one | `NotFoundError` |
| Replace whole field | Pass new value | Pass new value (non-object) |
| Delete field | Omit from record (creates a full replacement that doesn't have the field) | Pass `null` |

Use `upsert` when you have the whole record. Use `patch` when you have just the changes.

## Vs. pre-v1.0 `deepmerge` behavior

The pre-v1.0 `commands/upsert.js` `--patch-existing` flag used the `deepmerge` package, which has different rules:

| Operation | deepmerge | RFC 7396 |
| --- | --- | --- |
| Arrays | **Concat** by default (configurable) | **Replace** |
| `null` values | Treat as a value (set to `null`) | **Delete** the key |
| Nested objects | Merge recursively | Merge recursively (same) |
| Scalars | Replace | Replace (same) |

The shift to RFC 7396 is a **breaking change** for any consumer relying on the pre-v1.0 array-concat behavior. The CLI's `--patch` flag uses RFC 7396; there is no compatibility mode.

Consumers who *do* want array-concat semantics can do it themselves:

```typescript
// before patch
const existing = await sheet.queryFirst({ slug: 'jane' });
const merged = { ...existing, tags: [...existing.tags, ...newTags] };
await sheet.upsert(merged);
```

## Implementation note

The library uses an inline RFC 7396 implementation in `src/patch.ts` — about 40 lines, no external dependency. Inline-ness is deliberate: @iarna/toml's custom Date subclasses and other class instances need to flow through the merge as opaque values rather than being recursively merged, and an off-the-shelf merge package's `isPlainObject` heuristic isn't tailored to that. The `deepmerge` package is removed from `package.json` during the [#128 purge](https://github.com/JarvusInnovations/gitsheets/issues/128).

## Conformance

The RFC 7396 specification provides an [appendix of test cases](https://www.rfc-editor.org/rfc/rfc7396#appendix-A). All of them are part of the v1.0 test suite.

## Coordinates with

- [api/sheet.md](../api/sheet.md)
- [api/cli.md](../api/cli.md)
- [behaviors/validation.md](validation.md)
- [behaviors/normalization.md](normalization.md)
- [behaviors/transactions.md](transactions.md)
- [GitHub #133](https://github.com/JarvusInnovations/gitsheets/issues/133) — implementation issue
