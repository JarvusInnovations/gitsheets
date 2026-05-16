# API reference

The authoritative API contract lives in [`specs/`](https://github.com/JarvusInnovations/gitsheets/tree/develop/specs). This page lists the public surface with one-line descriptions and pointers into the per-symbol spec for the details. For end-to-end usage walkthroughs, see the [recipes](README.md#recipes).

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
  mergePatch,

  // record annotation symbols
  RECORD_SHEET_KEY, RECORD_PATH_KEY,
} from 'gitsheets';
```

Type-only exports (selected highlights):

```typescript
import type {
  OpenRepoOptions, OpenSheetOptions, OpenSheetsOptions,
  TransactionOptions, TransactionResult, TransactionHandler, Author,
  SheetConfig, SheetFieldConfig, SortRule, UpsertResult,
  SheetConstructorOptions, IndexKeyFn, DefineIndexOptions, QueryFilter,
  OpenStoreOptions, Store, StoreTx, StoreTransactFn, ValidatorMap, InferRecord,
  PushDaemonOptions, PushDaemonStatus, BackoffConfig,
  JSONSchema, StandardSchemaV1, ValidationIssue, StandardSchemaResult,
  RecordLike, PathTemplateBlob, PathTemplateTree, PathTemplateQueryResult,
} from 'gitsheets';
```

No deep imports (`gitsheets/lib/Sheet`) — the implementation can rearrange `src/` freely without notice. The package-root surface is the only stable API.

## Factories

### `openRepo(opts?)` → `Promise<Repository>`

Open a `Repository` against a git directory. Discovers from cwd upward when `gitDir` is omitted. Fresh-but-initialized repositories (no commits yet) are supported.

```typescript
const repo = await openRepo();                         // discovered
const repo = await openRepo({ gitDir: '/.git' });      // explicit
```

→ [`specs/api/repository.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/repository.md)

### `openStore(repo, opts?)` → `Promise<Store<V>>`

Typed wrapper over `Repository.openSheets()` that binds per-sheet Standard Schema validators. `store.<sheet>` is `Sheet<InferRecord<V[sheet]>>` for every sheet in `opts.validators`.

```typescript
const store = await openStore(repo, {
  validators: { users: UserSchema, projects: ProjectSchema },
});
```

→ [`specs/api/store.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/store.md) · [recipe](recipes/typed-sheet-with-zod.md)

## Repository

| Method | Purpose |
| --- | --- |
| `repo.openSheet<T>(name, opts?)` | Sheet handle, optionally with a Standard Schema validator |
| `repo.openSheets(opts?)` | All sheets keyed by name |
| `repo.transact(opts, handler)` | Run a handler in a single-commit transaction |
| `repo.requireExplicitTransactions()` | Switch to strict mode (one-way) |
| `repo.startPushDaemon(opts)` | Start async push to a configured remote |
| `repo.resolveRef(ref)` | Resolve a ref or commit hash; returns `string \| null` |

→ [`specs/api/repository.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/repository.md)

## Sheet

`Sheet<T extends RecordLike = RecordLike>` — generic on the record type. With a validator (via `openSheet({ validator })` or `openStore`), `T` flows through every method signature.

### Reading

| Method | Returns |
| --- | --- |
| `sheet.query(filter?)` | `AsyncGenerator<T>` — iterator |
| `sheet.queryFirst(filter?)` | `Promise<T \| undefined>` |
| `sheet.queryAll(filter?)` | `Promise<T[]>` |
| `sheet.pathForRecord(record)` | `Promise<string>` — rendered path, no write |
| `sheet.normalizeRecord(record)` | `Promise<T>` — canonical form, no write |

### Writing

| Method | Purpose |
| --- | --- |
| `sheet.upsert(record)` | Insert or replace; returns `{ blob, path }` |
| `sheet.delete(recordOrPath)` | Remove a record + cascade attachments |
| `sheet.patch(query, partial)` | RFC 7396 merge patch over an existing record |
| `sheet.clear()` | Remove every record from the sheet's tree |
| `sheet.clone()` | Clone the Sheet for staging tentative state |

All write methods route through a transaction — permissive mode auto-opens one; strict mode requires `repo.transact`.

### Attachments

| Method | Purpose |
| --- | --- |
| `sheet.getAttachment(record, name)` | One attachment's BlobObject or null |
| `sheet.getAttachments(record)` | Map of name → BlobObject |
| `sheet.setAttachment(record, name, blob)` | Add or replace |
| `sheet.setAttachments(record, map)` | Bulk variant |

### Indexing

| Method | Purpose |
| --- | --- |
| `sheet.defineIndex(name, keyFn)` | Lazy index (build on first lookup) |
| `sheet.defineIndex(name, { unique, eager }, keyFn)` | With opts; `eager: true` returns `Promise<void>` |
| `sheet.findByIndex(name, key)` | `Promise<T \| T[] \| undefined>` |

→ [`specs/api/sheet.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/sheet.md) · [indexing recipe](recipes/secondary-indices.md)

## Transaction

| Member | Purpose |
| --- | --- |
| `tx.sheet<T>(name, opts?)` | Sheet bound to the tx's tree |
| `tx.parentCommitHash` | Commit hash the tx parents on (may be `null` for fresh repos) |
| `tx.parentRef` / `tx.branchRef` | Refs being read from / advanced |

Consumers don't construct `Transaction` directly — it comes from `repo.transact`'s handler. `tx.sheet(name)` may be called any number of times; writes are atomic within the handler.

→ [`specs/api/transaction.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/transaction.md) · [`specs/behaviors/transactions.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/transactions.md) · [request-bound recipe](recipes/request-bound-transactions.md)

## TransactionResult

```typescript
interface TransactionResult<T> {
  readonly value: T;                  // handler return value
  readonly commitHash: string | null; // null when no mutations occurred
  readonly treeHash: string | null;
  readonly ref: string | null;
  readonly parentCommitHash: string | null;
}
```

## Store

```typescript
type Store<V extends ValidatorMap> = {
  readonly [K in keyof V]: Sheet<InferRecord<V[K]>>;
} & {
  readonly transact: StoreTransactFn<V>;
};
```

`store.<sheet>` for each sheet declared in `validators`. `store.transact(opts, async tx => ...)` mirrors `repo.transact` with `tx.<sheet>` aliases that thread validators through.

Sheets not in `validators` are accessible via `repo.openSheet(name)` for one-off un-typed access.

→ [`specs/api/store.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/store.md)

## PushDaemon

Returned from `repo.startPushDaemon(opts)`. EventEmitter with:

| Event | Payload |
| --- | --- |
| `push` | `{ commit, durationMs }` |
| `retry` | `{ commit, attempt, nextDelayMs }` |
| `error` | `{ commit, err, attempt }` |
| `stopped` | (none) |

| Method | Purpose |
| --- | --- |
| `daemon.status()` | Snapshot: running, lastPushAt, lastError, pendingCommits, currentBackoffMs, currentAttempt |
| `daemon.stop({ timeoutMs })` | Drain in-flight retries (graceful) |

→ [`specs/behaviors/push-sync.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/push-sync.md) · [production recipe](recipes/production-push-daemon.md)

## Errors

All gitsheets exceptions extend `GitsheetsError`:

```typescript
class GitsheetsError extends Error {
  readonly code: string;     // stable identifier
  readonly status: number;   // HTTP-style hint
  override readonly cause?: unknown;
}
```

Subclasses:

| Class | Common codes |
| --- | --- |
| `ConfigError` | `config_missing`, `config_invalid` |
| `ValidationError` | `validation_failed` (carries `issues: ValidationIssue[]`) |
| `TransactionError` | `transaction_in_progress`, `transaction_required`, `parent_moved`, `commit_failed`, `push_daemon_running`, `transaction_closed` |
| `IndexError` | `index_unique_conflict`, `index_not_defined` (carries `conflictingPaths`) |
| `RefError` | `ref_not_found`, `not_an_ancestor` |
| `PathTemplateError` | `path_render_failed`, `path_invalid_chars` |
| `NotFoundError` | `record_not_found` |

Consumers switch on `instanceof` or `err.code` — never on `err.message`.

→ [`specs/api/errors.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/errors.md) — full code table

## Path Template

`Template.fromString(s)` — parse + cache. Most consumers don't construct `Template` directly; it's exposed for advanced use cases (path template diagnostics, custom queryTree integrations).

→ [path templates doc](path-templates.md) · [`specs/behaviors/path-templates.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/path-templates.md)

## Utility

### `mergePatch(target, patch)`

RFC 7396 JSON Merge Patch as a pure function. Useful when you want the patch semantic without going through `Sheet.patch`. See [`specs/behaviors/patch-semantics.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/patch-semantics.md).

## Conventions

Read [`specs/api/conventions.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/conventions.md) for the cross-cutting rules: TypeScript posture, async patterns, options-object pattern, default refs/paths.

## Stability

Everything documented in [`specs/`](https://github.com/JarvusInnovations/gitsheets/tree/develop/specs) (and re-exported from `gitsheets`) is stable from v1.0 forward. Internal modules under `dist/` that aren't re-exported are implementation details and may change in minor releases.
