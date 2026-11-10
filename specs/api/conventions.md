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
  ContractError, AggregationError,

  // utilities
  mergePatch, validateRecord, canonicalContractHash,

  // helper exports (see "Public helper exports" below)
  parseToml, parseConfigToml, stringifyRecord,
  registerFormat, getFormat, hasFormat, resolveFormatConfig,

  // record annotation symbols (`record[RECORD_PATH_KEY]`, etc.)
  RECORD_SHEET_KEY, RECORD_PATH_KEY,
} from 'gitsheets';
```

Type-only exports (interfaces, type aliases) flow alongside the value exports
above. `packages/gitsheets/src/index.ts` is the authoritative list; by area:

- **Repository** — `OpenRepoOptions`, `OpenSheetOptions`, `OpenSheetsOptions`,
  `SyncOptions`, `SyncResult`, `FetchOptions`, `FetchResult`, `MergeOptions`,
  `MergeResult`, `MergeConflict`, `TreeEntry`.
- **Transaction** — `TransactionOptions`, `TransactionResult`,
  `TransactionHandler`, `Author`.
- **Sheet** — `SheetConfig`, `SheetFieldConfig`, `SortRule`, `UpsertResult`,
  `UpsertOptions`, `WillChangeResult`, `SheetConstructorOptions`, `IndexKeyFn`,
  `DefineIndexOptions`, `QueryFilter`, `RangeFilter`, `QueryOptions`,
  `DiffStatus`, `DiffOptions`, `DiffChange`, `AttachmentBlobHandle`,
  `AttachmentContent`, `AttachmentEntry`, `BlobHandle`.
- **Aggregation and rollups** — `AggregateSpec`, `AggregatesSpec`,
  `AggregateModifiers`, `AggregateOptions`, `RollupConfig`,
  `MaterializeResult`, `RollupStatusEntry`.
- **Formats** — `Format`, `FormatConfig`.
- **Store** — `OpenStoreOptions`, `Store`, `StoreTx`, `StoreTransactFn`,
  `ValidatorMap`, `InferRecord`.
- **Push daemon** — `PushDaemonOptions`, `PushDaemonStatus`,
  `PushFailureReason`, `BackoffConfig`.
- **Contracts** — `CanonicalContractHashOptions`, `ConformanceReport`,
  `ContractDocumentFormat`, `ContractVerificationMode`,
  `OpenSheetContractOptions`.
- **Validation** — `JSONSchema`, `StandardSchemaV1`, `StandardSchemaProps`,
  `StandardSchemaTypes`, `StandardSchemaIssue`, `StandardSchemaResult`,
  `StandardSchemaFailure`, `StandardSchemaSuccess`,
  `StandardSchemaPathSegment`, `ValidationIssue`.
- **Errors** — `GitsheetsErrorCode` and the per-class code unions
  (`ConfigErrorCode`, `TransactionErrorCode`, …).
- **Path templates** — `RecordLike`, `PathTemplateBlob`, `PathTemplateTree`,
  `PathTemplateQueryResult`.

No deep imports (`gitsheets/lib/Sheet`) — the implementation can rearrange `packages/gitsheets/src/` freely.

## Public helper exports

Lower-level helpers exported from the package root alongside the primary
classes. They are stable API like everything else re-exported here.

| Export | Contract |
| --- | --- |
| `parseToml(text)` | Parse a TOML document into a record through the core's parser (datetimes as `Date`, integer/float kept distinct — [behaviors/normalization.md](../behaviors/normalization.md)). Throws on malformed input |
| `parseConfigToml(text, sourcePath)` | `parseToml`, but a parse failure is `ConfigError` (`config_invalid`) naming `sourcePath` — for sheet-config text |
| `stringifyRecord(record)` | Serialize a record to canonical TOML (deep-sorted keys) through the core. Array fields are **not** sorted; sheet-level sort rules apply only via a `Sheet` ([behaviors/normalization.md](../behaviors/normalization.md)) |
| `getFormat(type)` | The registered `Format` for `'toml'`, `'markdown'`, or `'mdx'` (or a name registered with `registerFormat`); throws for an unknown name ([behaviors/content-types.md](../behaviors/content-types.md)) |
| `hasFormat(type)` | Whether a format is registered under `type` |
| `registerFormat(name, format)` | Register a host-side `Format` for `getFormat` lookups. The core validates sheet configs and accepts only `toml` / `markdown` / `mdx`, so registering a new name does not make it a valid `[gitsheet.format].type`; overriding a built-in is unsupported and never changes the bytes a sheet writes |
| `resolveFormatConfig(raw)` | Normalize a raw `[gitsheet.format]` table into a `FormatConfig` (`{ type: 'toml' }` when absent); `TypeError` when it is not a table |
| `Format` | The format interface: `extension` (with the leading dot), `serialize(record, config)`, `parse(text, config)`, `parseHeaderOnly(text, config)` (frontmatter only — [behaviors/content-types.md § Lazy body loading](../behaviors/content-types.md#lazy-body-loading)) |
| `FormatConfig` | The `[gitsheet.format]` shape: `type`, plus `body`, `title`, `normalize` for markdown formats ([behaviors/content-types.md](../behaviors/content-types.md)) |
| `WillChangeResult` | `sheet.willChange`'s result: `{ changed, path, currentBlobHash?, nextText }` ([api/sheet.md](sheet.md#sheetwillchangerecord-opts)) |
| `AttachmentContent` | What `setAttachment(s)` accepts: `string` (UTF-8), `Buffer`, `Uint8Array`, or `BlobHandle` ([behaviors/attachments.md](../behaviors/attachments.md)) |
| `GitsheetsErrorCode` | The union of every stable `err.code` string ([api/errors.md](errors.md#code-table)) |
| `RollupConfig` | `SheetConfig.rollup` on a rollup sheet: `{ from }`, the source sheet's name ([behaviors/rollups.md](../behaviors/rollups.md)) |
| `MaterializeResult` | `sheet.materialize()`'s result: `{ recomputed, deleted }` partition paths ([api/sheet.md](sheet.md#sheetmaterialize)) |
| `AggregateOptions` | `sheet.aggregate`'s options: `{ signal? }` ([behaviors/aggregation.md](../behaviors/aggregation.md)) |
| `RollupStatusEntry` | One element of `sheet.rollupStatus()`: `{ path, status: 'stale' \| 'missing' \| 'orphaned' }` ([api/sheet.md](sheet.md#sheetrollupstatus)) |

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

- Read operations default to the repository's **default branch** (`HEAD`'s branch unless bound elsewhere — [behaviors/default-branch.md](../behaviors/default-branch.md)).
- Write operations (transactions) default `parent` to the default branch's tip.
- The CLI honors `GITSHEETS_REF` for an override.

## Default paths

When a root isn't specified:

- `Repository.openSheet(name)` defaults `root` to `/` (repo root) — `.gitsheets/<name>.toml` is read from there.
- The CLI honors `GITSHEETS_ROOT` and `GITSHEETS_PREFIX` for overrides (matching the pre-v1.0 behavior).

### Prefix scoping

`prefix` is an optional runtime parameter — both `Repository.openSheet({ prefix })` / `openSheets({ prefix })` / `Transaction.sheet(name, { prefix })` accept it, and the CLI exposes it as `--prefix` (env `GITSHEETS_PREFIX`). When set, records are read and written under `<configRoot>/<prefix>/<rendered-path>.<ext>` instead of `<configRoot>/<rendered-path>.<ext>`. The `.gitsheets/<name>.toml` config file location is unaffected by `prefix` — only the record data tree is scoped. Default: empty string (no prefix). Useful for multi-tenant sub-tree partitioning where one git repo holds many tenants under `<root>/<tenant>/...`.

`prefix` is not threaded through `openStore` — for prefix-scoped typed access, open prefix-scoped sheets via `repo.openSheet` directly and assemble a typed wrapper manually.

## I/O

- All file paths inside the data repo are POSIX-style (`/` separators) regardless of host OS.
- TOML reads and writes happen in the Rust `gitsheets-core` engine (the bytes-authority — see [architecture.md](../architecture.md)); the Node binding surfaces datetimes as `instanceof Date`.
- Writes serialize to the byte-stable canonical form (deep-sorted keys) in the core, identical across every binding.
