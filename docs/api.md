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
  IndexError, RefError, PathTemplateError, NotFoundError, ContractError,

  // utilities
  mergePatch, validateRecord, canonicalContractHash,
  parseToml, parseConfigToml, stringifyRecord,
  getFormat, hasFormat, registerFormat, resolveFormatConfig,

  // record annotation symbols
  RECORD_SHEET_KEY, RECORD_PATH_KEY,
} from 'gitsheets';
```

Type-only exports (selected highlights):

```typescript
import type {
  OpenRepoOptions, OpenSheetOptions, OpenSheetsOptions,
  TransactionOptions, TransactionResult, TransactionHandler, Author,
  SheetConfig, SheetFieldConfig, SortRule, UpsertResult, UpsertOptions, WillChangeResult,
  SheetConstructorOptions, IndexKeyFn, DefineIndexOptions, QueryFilter, QueryOptions,
  DiffStatus, DiffOptions, DiffChange,
  AttachmentBlobHandle, AttachmentEntry,
  Format, FormatConfig,
  OpenStoreOptions, Store, StoreTx, StoreTransactFn, ValidatorMap, InferRecord,
  PushDaemonOptions, PushDaemonStatus, PushFailureReason, BackoffConfig,
  JSONSchema, StandardSchemaV1, ValidationIssue, StandardSchemaResult,
  RecordLike, PathTemplateBlob, PathTemplateTree, PathTemplateQueryResult,
  OpenSheetContractOptions, ContractVerificationMode, ConformanceReport,
  ContractDocumentFormat, CanonicalContractHashOptions,
} from 'gitsheets';
```

No deep imports (`gitsheets/lib/Sheet`) — the implementation can rearrange `packages/gitsheets/src/` freely without notice. The package-root surface is the only stable API.

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
| `repo.openSheet<T>(name, opts?)` | Sheet handle; `opts.validator` (Standard Schema), `opts.root`, `opts.prefix`, `opts.contract` (verify against a [contract](contracts.md) before returning — result on `sheet.contractVerification`) |
| `repo.openSheets(opts?)` | All sheets keyed by name; `opts.root`, `opts.prefix` |
| `repo.transact(opts, handler)` | Run a handler in a single-commit transaction |
| `repo.withLock(fn)` | Run `fn` holding the write lock transact uses — coordinate non-transact git ops. Not reentrant (`lock_held`) |
| `repo.requireExplicitTransactions()` | Switch to strict mode (one-way) |
| `repo.startPushDaemon(opts)` | Start async push to a configured remote |
| `repo.resolveRef(ref)` | Resolve a ref or commit hash; returns `string \| null` |
| `repo.refresh()` | Rebind every live Sheet to the current HEAD tree — for out-of-band ref movement (a successful `transact` auto-refreshes) |
| `repo.readBlobStream(ref, path)` | `Promise<Readable>` — stream a blob's bytes at `<ref>:<path>`, resolved at call time. Throws `RefError` / `NotFoundError` |

`opts.prefix` scopes records to a sub-tree under each sheet's configured root — useful for multi-tenant deployments where one git repo holds many tenants under `<root>/<tenant>/...`. Mirrors the CLI `--prefix` flag (env `GITSHEETS_PREFIX`). The sheet's `.gitsheets/<name>.toml` config file is unaffected — only the record data tree is scoped.

→ [`specs/api/repository.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/repository.md)

## Sheet

`Sheet<T extends RecordLike = RecordLike>` — generic on the record type. With a validator (via `openSheet({ validator })` or `openStore`), `T` flows through every method signature.

### Reading

| Method | Returns |
| --- | --- |
| `sheet.query(filter?, opts?)` | `AsyncGenerator<T>` — iterator; `opts.signal` for AbortSignal cancellation; `opts.withBody` for content-typed body loading |
| `sheet.queryFirst(filter?, opts?)` | `Promise<T \| undefined>` — honors `opts.signal`, `opts.withBody` |
| `sheet.queryAll(filter?, opts?)` | `Promise<T[]>` — honors `opts.signal`, `opts.withBody` |
| `sheet.loadBody(record)` | `Promise<T>` — hydrate a body-less record (content-typed sheets) |
| `sheet.refresh()` | Rebind this sheet's read snapshot to the current HEAD tree (out-of-band movement; own commits auto-refresh) |
| `sheet.pathForRecord(record)` | `Promise<string>` — rendered path, no write |
| `sheet.normalizeRecord(record)` | `Promise<T>` — canonical form, no write |

### Writing

| Method | Purpose |
| --- | --- |
| `sheet.upsert(record, opts?)` | Insert or replace; returns `{ blob, path }`. `opts.allowMissingBody` for content-typed sheets |
| `sheet.delete(recordOrPath)` | Remove a record + cascade attachments |
| `sheet.patch(query, partial)` | RFC 7396 merge patch over an existing record. For content-typed sheets with `[gitsheet.format].title` configured (v1.3): a title-only patch rewrites the body's H1; a body-only patch re-derives the title |
| `sheet.willChange(record, opts?)` | Pre-flight idempotency check — returns `{ changed, path, currentBlobHash?, nextText }` without mutating the tree (v1.3) |
| `sheet.clear()` | Remove every record from the sheet's tree |
| `sheet.clone()` | Clone the Sheet for staging tentative state |

All write methods route through a transaction — permissive mode auto-opens one; strict mode requires `repo.transact`.

`willChange` runs upsert's full validation + normalization + serialization pipeline and compares the resulting bytes to the existing blob at the rendered path. Useful for consumers that want commit-skipping idempotency semantics — "only commit if something actually changed." Throws the same errors upsert would on the same input (`ValidationError`, `IndexError`, `PathTemplateError`).

### Attachments

| Method | Purpose |
| --- | --- |
| `sheet.getAttachment(record, name)` | One attachment's `AttachmentBlobHandle` or null |
| `sheet.getAttachments(record)` | Map of name → `AttachmentBlobHandle` |
| `sheet.getAttachmentStream(recordOrPath, name)` | `Promise<Readable \| null>` — stream an attachment's bytes without materializing the record |
| `sheet.setAttachment(record, name, content)` | Add or replace — `content` may be raw bytes (`Buffer`/`Uint8Array`), a UTF-8 `string`, or a `BlobHandle` |
| `sheet.setAttachments(record, map)` | Bulk variant; values accept the same types, mixed freely |
| `sheet.deleteAttachment(record, name)` | Remove a single attachment; throws `NotFoundError` if missing |
| `sheet.deleteAttachments(record)` | Remove all attachments; idempotent no-op when no attachment dir |
| `sheet.attachments(record)` | `AsyncGenerator<AttachmentEntry>` yielding `{name, mimeType, blob}` with `.read()` / `.stream()` |

### Diff

| Method | Returns |
| --- | --- |
| `sheet.diffFrom(srcCommitHash?, opts?)` | `AsyncGenerator<DiffChange<T>>` — per-record changes since `srcCommitHash` (defaults to the empty tree). `opts.blobs` / `opts.records` / `opts.patches` attach hologit blob handles, parsed src/dst records, and RFC 6902 JSON Patches respectively. Throws `RefError` if `srcCommitHash` doesn't resolve. |

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
| `tx.sheet<T>(name, opts?)` | Sheet bound to the tx's tree; `opts.validator`, `opts.prefix` |
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
  readonly refresh: () => Promise<void>;
};
```

`store.<sheet>` for each sheet declared in `validators`. `store.transact(opts, async tx => ...)` mirrors `repo.transact` with `tx.<sheet>` aliases that thread validators through. `store.refresh()` rebinds every sheet to the current HEAD tree (delegates to `repo.refresh()`).

Reads through `store.<sheet>` follow the freshness model: a successful `store.transact` / `repo.transact` auto-refreshes, so post-commit reads reflect the committed state — see [`specs/behaviors/freshness.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/freshness.md).

Sheets not in `validators` are accessible via `repo.openSheet(name)` for one-off un-typed access.

→ [`specs/api/store.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/store.md)

## PushDaemon

Returned from `repo.startPushDaemon(opts)`. EventEmitter with:

| Event | Payload |
| --- | --- |
| `push` | `{ commit, durationMs }` |
| `retry` | `{ commit, attempt, nextDelayMs, reason }` |
| `error` | `{ commit, err, attempt, reason }` — `reason: 'non-fast-forward' \| 'unknown'`. NFF is terminal (no retry). |
| `stopped` | (none) |

| Method | Purpose |
| --- | --- |
| `daemon.status()` | Snapshot: running, lastPushAt, lastError (with `reason`), pendingCommits, currentBackoffMs, currentAttempt |
| `daemon.stop({ timeoutMs })` | Drain in-flight retries (graceful) |

On `startPushDaemon` the daemon also runs a one-shot startup-backlog check (fetch + `rev-list --count <remote>/<branch>..<branch>`) and queues any commits ahead of the remote; this is how a restarted daemon catches up.

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
| `TransactionError` | `transaction_in_progress`, `transaction_required`, `parent_moved`, `commit_failed`, `push_daemon_running`, `transaction_closed`, `lock_held` |
| `IndexError` | `index_unique_conflict`, `index_not_defined` (carries `conflictingPaths`) |
| `RefError` | `ref_not_found`, `not_an_ancestor` |
| `PathTemplateError` | `path_render_failed`, `path_invalid_chars` |
| `NotFoundError` | `record_not_found` |
| `ContractError` | `contract_missing`, `contract_invalid`, `contract_unsatisfied` (carries `contract` and, on `contract_unsatisfied`, the conformance report in `issues`) |

Consumers switch on `instanceof` or `err.code` — never on `err.message`.

→ [`specs/api/errors.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/errors.md) — full code table

## Path Template

`Template.fromString(s)` — parse + cache. Most consumers don't construct `Template` directly; it's exposed for advanced use cases (path template diagnostics, custom queryTree integrations).

→ [path templates doc](path-templates.md) · [`specs/behaviors/path-templates.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/path-templates.md)

## Utility

### `mergePatch(target, patch)`

RFC 7396 JSON Merge Patch as a pure function. Useful when you want the patch semantic without going through `Sheet.patch`. See [`specs/behaviors/patch-semantics.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/patch-semantics.md).

### `validateRecord({ record, schema, validator? })`

Run the same validation pipeline `Sheet.upsert` uses without going through a Sheet. Useful for pre-flight (UI form submission, CSV ingest, audit passes against legacy records). Returns the possibly-transformed record on success, throws `ValidationError` on failure. See [`specs/behaviors/validation.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/validation.md).

### `canonicalContractHash(input, options?)`

The [contract](contracts.md) identity primitive: canonicalize a contract document — parsed data, or JSON/TOML text with `{ format }` — through the canonical TOML encoder and return the SHA-256 hex of the resulting bytes. Two parties holding the same logical document compute the same hash regardless of serialization.

### TOML round-tripping

| Symbol | Use |
| --- | --- |
| `parseToml(text)` | Parse TOML to a plain object; preserves `@iarna/toml` date types |
| `parseConfigToml(text, sourcePath)` | Same parse with config-aware error messages — for `.gitsheets/<sheet>.toml` |
| `stringifyRecord(record)` | Serialize an object to canonical TOML (deep-sorted keys) |

Used by the AXI tool's config-scaffolding commands; available to consumers that need raw config-text round-tripping.

### Format dispatch

| Symbol | Use |
| --- | --- |
| `getFormat(type)` | Resolve a format implementation by name (`'toml'`, `'markdown'`, `'mdx'`) |
| `hasFormat(type)` | Probe whether a format is registered |
| `registerFormat(type, impl)` | Register a custom format implementation |
| `resolveFormatConfig(raw)` | Validate and normalize a `[gitsheet.format]` block |

Available for consumers who want to render records through a sheet's configured format without going through a `Sheet` instance.

## Conventions

Read [`specs/api/conventions.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/conventions.md) for the cross-cutting rules: TypeScript posture, async patterns, options-object pattern, default refs/paths.

## Stability

Everything documented in [`specs/`](https://github.com/JarvusInnovations/gitsheets/tree/develop/specs) (and re-exported from `gitsheets`) is stable from v1.0 onward. Additions in minor versions are additive (new methods, new options). Internal modules under `dist/` that aren't re-exported are implementation details and may change in minor releases.
