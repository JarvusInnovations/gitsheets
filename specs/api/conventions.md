# API: Conventions

Cross-cutting rules every API spec under this directory inherits.

## Module surface

All public symbols are imported from the package root:

```typescript
import {
  // factories
  openRepo, openStore,

  // primary classes
  Repository, Sheet, Transaction, PushDaemon, Template,

  // error classes
  GitsheetsError, ConfigError, ValidationError, TransactionError,
  IndexError, RefError, PathTemplateError, NotFoundError,

  // utilities
  mergePatch, validateRecord,

  // record annotation symbols (`record[RECORD_PATH_KEY]`, etc.)
  RECORD_SHEET_KEY, RECORD_PATH_KEY,
} from 'gitsheets';
```

Type-only exports (interfaces, type aliases) flow alongside the value exports
above. Notable ones: `TransactionResult`, `TransactionOptions`, `Author`,
`SheetConfig`, `UpsertResult`, `IndexKeyFn`, `DefineIndexOptions`,
`QueryFilter`, `QueryOptions`, `OpenStoreOptions`, `Store`, `StoreTx`, `InferRecord`,
`PushDaemonOptions`, `PushDaemonStatus`, `BackoffConfig`, `JSONSchema`,
`StandardSchemaV1`, `ValidationIssue`, `RecordLike`.

No deep imports (`gitsheets/lib/Sheet`) — the implementation can rearrange `src/` freely.

## TypeScript posture

- `strict: true` in shipped types.
- Public functions have explicit return types — no `Promise<any>`.
- Generics flow from sheet configs through to consumer call sites (`Sheet<T>`, `Store<Schemas>`).

## Async patterns

- Read-many results: `async function*` iterators. Consumers `for await` them.
- Read-one: `Promise<T | undefined>`.
- Writes: `Promise<{ blob, path }>` (single-record) or `Promise<TransactionResult>` (transaction commit).

## Options-object pattern

Functions with more than two parameters take an options object:

```typescript
// good
await sheet.defineIndex('byEmail', { unique: true, eager: false }, fn);

// not the convention
await sheet.defineIndex('byEmail', true, false, fn);
```

Optional fields have documented defaults. Missing `undefined` is treated as "use default."

## Errors

Every error thrown by gitsheets extends `GitsheetsError` and carries a stable `code` string. Consumers should switch on `instanceof` or on `err.code` — never on `err.message`. See [api/errors.md](errors.md).

## Cancellation

Long-running iterations (`Sheet.query`, `Sheet.queryFirst`, `Sheet.queryAll`) honor `AbortSignal` when one is passed in via the options. Without a signal, they run to completion.

```typescript
const controller = new AbortController();
for await (const record of sheet.query({}, { signal: controller.signal })) {
  // ...
  if (someCondition) controller.abort();  // optional reason arg → signal.reason
}
```

When the signal aborts, the next iteration (or the call itself, if aborted before invocation) throws `signal.reason` — which is whatever value was passed to `controller.abort(reason)`, or a `DOMException` with name `'AbortError'` if no reason was supplied. Callers can `try/catch` on the iteration and switch on the thrown value's shape.

Any iterator added later in the public surface should follow the same convention (`opts.signal`, check before iteration, check at each yield).

## Async iteration over trees

The library exposes async iterators throughout. They are **single-pass** — re-iterating requires calling the producing method again. Internal caching may make re-iteration fast, but the iterators are not stateless.

## Naming

- **Methods that don't commit:** `upsert`, `delete`, `patch`, `setAttachment` — they stage tree writes. Commits happen on transaction boundary.
- **Methods that do commit (implicit transaction):** none by name. Permissive mode commits at the end of any standalone mutation, but the *method* doesn't carry "commit" in its name.
- **Methods that always commit explicitly:** `Repository.transact` and `Store.transact`.

## Versioning

The public API is the API surface speced under `specs/api/`. Anything not speced there is implementation detail and may change without notice. Breaking changes to speced surface require a major version bump.

## Default branches and refs

When a ref isn't specified:

- Read operations default to the repository's `HEAD`.
- Write operations (transactions) default `parent` to `HEAD`.
- The CLI honors `GITSHEETS_REF` for an override.

## Default paths

When a root isn't specified:

- `Repository.openSheet(name)` defaults `root` to `/` (repo root) — `.gitsheets/<name>.toml` is read from there.
- The CLI honors `GITSHEETS_ROOT` and `GITSHEETS_PREFIX` for overrides (matching the pre-v1.0 behavior).

## I/O

- All file paths inside the data repo are POSIX-style (`/` separators) regardless of host OS.
- TOML reads use `@iarna/toml` to preserve Date types.
- TOML writes serialize sorted keys (deep) for byte-stable normalization.
