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

- It is **not part of the typed surface** — the `Store` type includes only sheets named in `validators`, so property access on a non-validator sheet is a compile-time error and there's no autocomplete for it.
- Use `repo.openSheet(name)` for one-off un-typed access — it returns `Sheet<Record<string, unknown>>` and the persisted JSON Schema still runs on every write.

Rationale: a mapped-type-plus-index-signature shape (`{ [K in keyof V]: Sheet<…> } & Record<string, Sheet<unknown>>`) doesn't compose cleanly in TypeScript without losing the typo-protection that the typed `Store` surface exists for. Confining the typed surface to declared validators is the cleaner tradeoff.

> **Type-level vs runtime.** This confinement is a *type-level* guarantee, not a runtime filter. `openStore` discovers **every** sheet in `.gitsheets/` and, for implementation simplicity, attaches all of them (validator-bound or not) as runtime properties on both the `store` object and the `tx` object inside `store.transact` — the non-validator ones just aren't visible to the type checker. Consumers should treat the typed surface as the contract; reaching a non-validator sheet by dynamic string key happens to work at runtime (typed `Sheet<Record<string, unknown>>`) but is outside the typed API. The persisted JSON Schema still runs on those sheets.

## Sheet discovery

Sheets are discovered by enumerating `.gitsheets/*.toml`. The discovery happens once at `openStore` time. Sheets added after `openStore` are not auto-detected — call `openStore` again or use `repo.openSheet(name)` for one-offs.

A sheet present in `validators` but missing from `.gitsheets/` throws `ConfigError` (`config_missing`) at `openStore` time.

A sheet present in `.gitsheets/` but missing from `validators` is not exposed on the typed `Store` surface (see "Type inference" above); use `repo.openSheet(name)` for those.

### `prefix` is not threaded through `openStore`

`openStore` calls `repo.openSheets()` internally without a `prefix` parameter, so the typed `Store` surface always opens sheets without sub-tree scoping. For prefix-scoped typed access, open each prefix-scoped sheet via `repo.openSheet(name, { prefix, validator })` and assemble a wrapper manually. This is a deliberate scope cut — multi-tenant deployments typically open one `Store` per tenant, not one `Store` that spans tenants.

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

## Freshness

`store.<sheet>` reads follow the standard freshness model ([behaviors/freshness.md](../behaviors/freshness.md)): a successful `store.transact` / `repo.transact` auto-refreshes every sheet, so post-commit reads through `store.<sheet>` reflect the committed state.

### `store.refresh()`

Rebind every sheet to the repository's current `HEAD` tree — delegates to `repo.refresh()` (a Store's sheets are Repository-issued sheets; partial-store freshness is not a meaningful state). Returns `Promise<void>`. Use after out-of-band ref movement.

```typescript
await store.refresh();
const fresh = await store.users.queryAll();
```

Like `transact`, `refresh` is a reserved property name on the `Store` surface — a sheet named `refresh` or `transact` is shadowed by the method and must be reached via `repo.openSheet(name)`.

## Why `Store` and not just `Repository`?

`Repository.openSheets()` returns `{ [name]: Sheet<unknown> }` — a flat dictionary with no type-level connection between sheet names and shapes. `Store` adds:

- Generic type inference from the `validators` map
- Validator wiring (consumer's Zod/Valibot/etc. is automatically attached to each Sheet)
- `transact` shorthand with `tx.<sheet>` aliases

Both APIs are public. Use `Repository` for one-off scripts and dynamic discovery; use `Store` for typed applications.

## Errors

| Class | Code | When |
| --- | --- | --- |
| `ConfigError` | `config_missing` | A sheet in `validators` doesn't have a `.gitsheets/<name>.toml` |
| `ConfigError` | `config_invalid` | A sheet's config TOML is malformed |
| (errors from `Sheet`) | (various) | Per-sheet operations propagate normally |

## Coordinates with

- [api/repository.md](repository.md)
- [api/sheet.md](sheet.md)
- [api/transaction.md](transaction.md)
- [behaviors/validation.md](../behaviors/validation.md)
- [behaviors/freshness.md](../behaviors/freshness.md)
