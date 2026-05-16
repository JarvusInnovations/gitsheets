# API: Store

A top-level typed wrapper that auto-discovers sheets in a repository and binds them to consumer validators.

## Summary

`openStore(repo, opts)` is the recommended entry point for TypeScript consumers. It:

1. Discovers every sheet declared in `.gitsheets/*.toml`
2. Optionally binds each to a consumer-supplied [Standard Schema](https://standardschema.dev) validator
3. Returns a typed object whose properties are the sheets, with full TS inference

## Construction

```typescript
import { openStore, openRepo } from 'gitsheets';
import { z } from 'zod';

const UserSchema = z.object({
  slug: z.string(),
  email: z.string().email(),
  fullName: z.string(),
});

const ProjectSchema = z.object({
  slug: z.string(),
  title: z.string(),
  stage: z.enum(['idea', 'active', 'maintaining', 'dormant']),
});

const repo = await openRepo();
const store = await openStore(repo, {
  validators: {
    users: UserSchema,
    projects: ProjectSchema,
    // sheets without entries here still work, typed as Sheet<Record<string, unknown>>
  },
});

// fully typed against UserSchema
const jane = await store.users.queryFirst({ slug: 'janedoe' });
// jane is z.infer<typeof UserSchema> | undefined

// store.transact bundles writes across sheets atomically
await store.transact({ message: '...' }, async (tx) => {
  await tx.users.upsert({ slug: 'jane', email: 'jane@x.org', fullName: 'Jane' });
  await tx.projects.upsert({ slug: 'p1', title: 'P1', stage: 'idea' });
});
```

## Type inference

When a sheet has an entry in `validators`, its type flows through:

- `store.<sheet>` is `Sheet<z.infer<typeof SchemaForThatSheet>>`
- `tx.<sheet>` inside `store.transact` is the same Sheet type, scoped to the transaction's tree

When a sheet does not have an entry in `validators`:

- `store.<sheet>` is `Sheet<Record<string, unknown>>`
- The JSON Schema in `.gitsheets/<sheet>.toml` still runs on every write — only the *TS-level* shape is `unknown`

## Sheet discovery

Sheets are discovered by enumerating `.gitsheets/*.toml`. The discovery happens once at `openStore` time. Sheets added after `openStore` are not auto-detected — call `openStore` again or use `repo.openSheet(name)` for one-offs.

A sheet present in `validators` but missing from `.gitsheets/` throws `ConfigError` (`config_missing`) at `openStore` time.

A sheet present in `.gitsheets/` but missing from `validators` is included as `Sheet<Record<string, unknown>>` — not an error.

## Transactions

`store.transact(opts, handler)` is a thin wrapper over `repo.transact` that passes a `tx` object exposing `tx.<sheet>` aliases:

```typescript
await store.transact({ message: '...' }, async (tx) => {
  // tx.users: Sheet<User>      (transaction-scoped)
  // tx.projects: Sheet<Project> (transaction-scoped)
  // ... one tx.<sheet> per declared sheet
});
```

The transaction's commit message, trailers, author, parent, etc. follow the same options as `repo.transact` (see [api/transaction.md](transaction.md)).

## Why `Store` and not just `Repository`?

`Repository.openSheets()` returns `{ [name]: Sheet<unknown> }` — a flat dictionary with no type-level connection between sheet names and shapes. `Store` adds:

- Generic type inference from the `validators` map
- Validator wiring (consumer's Zod/Valibot/etc. is automatically attached to each Sheet)
- `transact` shorthand with `tx.<sheet>` aliases

Both APIs are public. Use `Repository` for one-off scripts and dynamic discovery; use `Store` for typed applications.

## Errors

| Class | Code | When |
|---|---|---|
| `ConfigError` | `config_missing` | A sheet in `validators` doesn't have a `.gitsheets/<name>.toml` |
| `ConfigError` | `config_invalid` | A sheet's config TOML is malformed |
| (errors from `Sheet`) | (various) | Per-sheet operations propagate normally |

## Coordinates with

- [api/repository.md](repository.md)
- [api/sheet.md](sheet.md)
- [api/transaction.md](transaction.md)
- [behaviors/validation.md](../behaviors/validation.md)
