# gitsheets TypeScript API reference

ESM-only. `import { … } from 'gitsheets'`. Targets Node ≥ 20 / Bun ≥ 1, `strict: true`.

## Table of contents

- [Module surface](#module-surface)
- [openRepo](#openrepo) — open a Repository
- [Repository](#repository) — methods on the repo handle
- [Sheet](#sheet) — per-sheet operations
  - [Reading](#reading) — query / queryFirst / queryAll / count / loadBody / pathForRecord / normalizeRecord
  - [Writing](#writing) — upsert / delete / patch / clear / clone
  - [Attachments](#attachments) — get / set / delete / iterator
  - [Indexing](#indexing) — defineIndex / findByIndex
  - [Diff](#diff) — diffFrom
- [Transaction](#transaction) — the handler arg of `repo.transact`
- [openStore + Store](#openstore--store) — typed multi-sheet wrapper
- [PushDaemon](#pushdaemon) — async push to remote
- [Errors](#errors) — `GitsheetsError` hierarchy
- [validateRecord](#validaterecord) — standalone validation
- [Template](#template) — path templates
- [Record annotations](#record-annotations) — RECORD_PATH_KEY / RECORD_SHEET_KEY

## Module surface

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

  // record annotation symbols
  RECORD_SHEET_KEY, RECORD_PATH_KEY,
} from 'gitsheets';

import type {
  OpenRepoOptions, OpenSheetOptions, OpenSheetsOptions,
  TransactionOptions, TransactionResult, TransactionHandler, Author,
  SheetConfig, SheetFieldConfig, SortRule, UpsertResult, UpsertOptions,
  IndexKeyFn, DefineIndexOptions,
  QueryFilter, QueryOptions, DiffStatus, DiffOptions, DiffChange,
  AttachmentBlobHandle, AttachmentEntry,
  Format, FormatConfig,
  OpenStoreOptions, Store, StoreTx, StoreTransactFn, ValidatorMap, InferRecord,
  PushDaemonOptions, PushDaemonStatus, PushFailureReason, BackoffConfig,
  JSONSchema, StandardSchemaV1, ValidationIssue,
  RecordLike,
} from 'gitsheets';
```

Don't deep-import (`gitsheets/lib/...`). The package-root surface is the only stable API.

## openRepo

```typescript
const repo = await openRepo();                          // discover from cwd
const repo = await openRepo({ gitDir: '/.git' });       // explicit
const repo = await openRepo({ gitDir, workTree });      // working-tree hint
```

Backed by the Rust core's git repository discovery (gix). Fresh-but-initialized repositories (no commits yet) are supported.

## Repository

| Method | Purpose |
| --- | --- |
| `repo.openSheet<T>(name, opts?)` | Sheet handle; `opts.validator` (Standard Schema), `opts.root`, `opts.prefix` |
| `repo.openSheets(opts?)` | `Record<string, Sheet>` of every sheet declared under `.gitsheets/` |
| `repo.transact(opts, handler)` | Single-commit transaction; see below |
| `repo.requireExplicitTransactions()` | One-way strict-mode switch — standalone Sheet writes throw |
| `repo.startPushDaemon(opts)` | Start async push to a remote (returns `PushDaemon`) |
| `repo.resolveRef(ref)` | `Promise<string \| null>` — resolve a ref or commit hash |

### `repo.transact`

```typescript
const result = await repo.transact(
  {
    parent: 'main',                  // ref or commit hash; default HEAD
    author: { name: 'Jane', email: 'jane@x.org' },
    committer: { name: 'Jane', email: 'jane@x.org' },  // default: author
    message: 'janedoe: POST /api/users',
    trailers: { 'X-Request-Id': 'req-123' },  // appended per git-interpret-trailers
    branch: 'refs/heads/main',       // ref to advance on success
  },
  async (tx: Transaction) => {
    await tx.sheet('users').upsert({ slug: 'janedoe', email: 'jane@x.org' });
    return { ok: true };
  }
);
// result: { value: { ok: true }, commitHash, treeHash, ref, parentCommitHash }
```

**Commit-on-success-only.** If the handler stages no mutations, the transaction does *not* commit — `commitHash`, `treeHash`, `ref` are `null` and the parent ref is unchanged. Throws from the handler discard the staged tree.

Trailer keys follow HTTP-style casing (`Some-Header`).

## Sheet

`Sheet<T extends RecordLike = RecordLike>`. With a validator (via `openSheet({ validator })` or `openStore`), `T` flows through every method signature.

### Reading

```typescript
for await (const user of sheet.query({ accountLevel: 'staff' })) { … }
const jane = await sheet.queryFirst({ slug: 'jane' });
const all = await sheet.queryAll();
```

| Method | Returns | Notes |
| --- | --- | --- |
| `sheet.query(filter?, opts?)` | `AsyncGenerator<T>` | `opts.signal` (AbortSignal), `opts.withBody` (content-typed sheets) |
| `sheet.queryFirst(filter?, opts?)` | `Promise<T \| undefined>` | Same opts |
| `sheet.queryAll(filter?, opts?)` | `Promise<T[]>` | Same opts |
| `sheet.count(filter?)` | `Promise<number>` | Cheap count (walks candidate paths, no parse) when unfiltered; a filter falls back to a body-less scan |
| `sheet.loadBody(record)` | `Promise<T>` | Hydrate a body-less record (markdown sheets); no-op on TOML sheets |
| `sheet.pathForRecord(record)` | `Promise<string>` | Render the path template; doesn't write |
| `sheet.normalizeRecord(record)` | `Promise<T>` | Canonical form (deep-sort keys, array sort rules); doesn't write/validate |

Filters: each key matches by equality; function values are predicates `(value, record) => boolean`; nested objects descend. Filters that reference path-template fields prune the tree walk.

AbortSignal: throws `signal.reason` on the next yield boundary. Filters that reference the body field under `withBody: false` throw `TypeError` at query start.

### Writing

```typescript
await sheet.upsert({ slug: 'jane', email: 'jane@x.org' });
await sheet.delete({ slug: 'jane' });             // by record
await sheet.delete('users/jane');                  // by path
await sheet.patch({ slug: 'jane' }, { email: 'new@x.org', bio: null });
await sheet.clear();                               // remove all records
const cloned = await sheet.clone();                // staging copy
```

| Method | Purpose |
| --- | --- |
| `sheet.upsert(record, opts?)` | Insert or replace; returns `{ blob, path }`. `opts.allowMissingBody` for markdown sheets. |
| `sheet.delete(recordOrPath)` | Remove a record + cascade attachment directory |
| `sheet.patch(query, partial)` | RFC 7396 merge: `null` deletes a field, arrays replace, objects merge |
| `sheet.clear()` | Wipe the sheet's tree |
| `sheet.clone()` | Deep-clone the Sheet handle (for staged comparisons) |

**Important:** `upsert` is a full-record replace. Use `patch` for partial updates.

All writes route through the current transaction (auto-opened in permissive mode; required-explicit in strict mode).

### Attachments

Binary blobs colocated with a record at `<recordPath>/<attachmentName>`.

```typescript
const blob = await repo.writeBlobFromFile('/path/to/avatar.jpg');
await sheet.setAttachment(record, 'avatar.jpg', blob);
await sheet.setAttachments(record, { 'avatar.jpg': blob, 'cover.png': otherBlob });

const blob = await sheet.getAttachment(record, 'avatar.jpg');
const map = await sheet.getAttachments(record);          // Map of name → BlobHandle

await sheet.deleteAttachment(record, 'avatar.jpg');      // throws if missing
await sheet.deleteAttachments(record);                   // no-op if no attachment dir

for await (const { name, mimeType, blob } of sheet.attachments(record)) {
  const buf = await blob.read();      // Buffer
  // or pipe blob.stream() — Readable backed by `git cat-file blob <hash>`
}
```

`AttachmentEntry.mimeType` is inferred from the extension; defaults to `application/octet-stream`.

Cascade-on-delete: `sheet.delete(record)` removes the record's attachment directory in the same operation.

### Indexing

In-memory secondary indices.

```typescript
sheet.defineIndex(
  'byEmail',
  { unique: true, eager: false },                       // opts: defaults shown
  (record) => record.email.toLowerCase()
);

sheet.defineIndex(
  'byProjectStatus',
  (record) => `${record.projectId}:${record.status}`,   // non-unique by default
);

await sheet.defineIndex('byTag', { eager: true }, fn);  // returns Promise<void>

const jane = await sheet.findByIndex('byEmail', 'jane@x.org');  // T | undefined (unique)
const open = await sheet.findByIndex('byProjectStatus', 'p1:open');  // T[] (non-unique)
```

- `keyFn` returns `undefined`/`null` → exclude from index
- `eager: true` builds at definition time (returns Promise); `false` (default) builds lazily on first `findByIndex`
- Indexes rebuild when the underlying tree hash changes
- **For markdown sheets**: index builds always use body-less reads. A `keyFn` referencing `record.body` sees `undefined`. Don't index on body content; index on frontmatter fields. `findByIndex` returns body-less records — `sheet.loadBody(record)` to hydrate.

### Diff

```typescript
for await (const change of sheet.diffFrom('HEAD~1', { records: true, patches: true })) {
  // change.path                        — relative to sheet root, no extension
  // change.status                      — 'added' | 'modified' | 'deleted' | 'renamed'
  // change.srcMode / dstMode           — git modes (null on add/delete)
  // change.srcHash / dstHash           — blob hashes (null on add/delete)
  // change.src / dst                   — parsed records (records: true)
  // change.patch                       — RFC 6902 ops (patches: true)
  // change.srcBlob / dstBlob           — gitsheets BlobHandle handles (blobs: true)
}
```

`srcCommitHash` accepts a commit hash, tree hash, or ref name. Omitted → defaults to the empty tree (every current record yields `status: 'added'`).

Scope: matches the sheet's storage format (`.toml` for TOML sheets, `.md` for markdown). Attachment-blob diffs are out of scope.

Throws `RefError(ref_not_found)` if `srcCommitHash` doesn't resolve.

## Transaction

The handler argument of `repo.transact`. Don't construct directly.

```typescript
tx.sheet<T>(name, opts?)        // sheet bound to the tx's tree (opts: validator, prefix)
tx.parentCommitHash             // may be null on fresh repos
tx.parentRef                    // ref the tx is reading from
tx.branchRef                    // ref the tx will advance on commit
```

Writes inside the handler are atomic; throws from the handler discard the staged tree. Nested `repo.transact` throws `TransactionError(transaction_in_progress)`.

## openStore + Store

Typed wrapper over `Repository.openSheets()` that binds per-sheet Standard Schema validators.

```typescript
import { openStore } from 'gitsheets';
import { z } from 'zod';

const UserSchema   = z.object({ slug: z.string(), email: z.string().email() });
const ProjectSchema = z.object({ id: z.string(), name: z.string() });

const store = await openStore(repo, {
  validators: { users: UserSchema, projects: ProjectSchema },
});

// Each named sheet is Sheet<InferRecord<schema>>:
const jane = await store.users.queryFirst({ slug: 'jane' });
// jane is typed as z.infer<typeof UserSchema> | undefined

// Single-commit multi-sheet writes:
await store.transact(
  { message: 'janedoe: register' },
  async (tx) => {
    const user = await tx.users.upsert({ slug: 'janedoe', email: 'jane@x.org' });
    await tx.projects.upsert({ id: 'p1', name: `${user.path}'s project` });
  }
);
```

Sheets not in `validators` aren't on the typed `Store` surface; access them via `repo.openSheet(name)` for one-off un-typed reads.

`Store<V>` is a mapped type — `store.<name>` is `Sheet<InferRecord<V[name]>>` for every named validator, plus a `store.transact` that mirrors `repo.transact` with typed `tx.<name>` aliases.

## PushDaemon

```typescript
const daemon = await repo.startPushDaemon({
  remote: 'origin',
  branch: 'main',                             // default: HEAD's branch
  backoff: 'exponential',                     // or { base, multiplier, cap }
  maxRetries: Infinity,                       // default
});

daemon.on('push',    ({ commit, durationMs }) => log.info({ commit, durationMs }));
daemon.on('retry',   ({ commit, attempt, nextDelayMs, reason }) => log.info({ … }));
daemon.on('error',   ({ commit, err, attempt, reason }) => {
  if (reason === 'non-fast-forward') alerts.page({ message: 'remote diverged' });
  else log.warn({ err: String(err), attempt }, 'push failed');
});
daemon.on('stopped', () => log.info('daemon stopped'));

daemon.status();                              // snapshot — see below
await daemon.stop({ timeoutMs: 30_000 });    // graceful drain
```

**Status snapshot:**

```typescript
{
  running: boolean,
  lastPushAt: ISO-8601 | null,
  lastError: { message, at, attempt, reason: 'non-fast-forward' | 'unknown' } | null,
  pendingCommits: number,
  currentBackoffMs: number | null,
  currentAttempt: number | null,
}
```

`reason: 'non-fast-forward'` is **terminal** — the daemon doesn't retry that batch. Page on-call.

On `startPushDaemon` the daemon runs a startup-backlog check (fetch + `rev-list --count <remote>/<branch>..<branch>`) and queues any commits ahead of the remote — useful for catching up after a restart.

**Push-only.** Never pulls. The consumer process is the single writer.

## Errors

All exceptions extend `GitsheetsError` and carry a stable `code` field.

```typescript
class GitsheetsError extends Error {
  readonly code: string;       // stable identifier
  readonly status: number;     // HTTP-style hint
  readonly cause?: unknown;
}
```

Subclasses + codes:

| Class | Codes |
| --- | --- |
| `ConfigError` | `config_missing`, `config_invalid` |
| `ValidationError` | `validation_failed` (carries `issues: ValidationIssue[]`) |
| `TransactionError` | `transaction_in_progress`, `transaction_required`, `parent_moved`, `commit_failed`, `push_daemon_running`, `transaction_closed` |
| `IndexError` | `index_unique_conflict`, `index_not_defined` (carries `conflictingPaths`) |
| `RefError` | `ref_not_found`, `not_an_ancestor` |
| `PathTemplateError` | `path_render_failed`, `path_invalid_chars` |
| `NotFoundError` | `record_not_found` |

Consumers switch on `instanceof` or `err.code` — never on `err.message`.

`ValidationError.issues[]` shape: `{ path: string[], message: string, source: 'json-schema' | 'standard-schema', schemaPath?, code? }`.

## validateRecord

The same validation pipeline `Sheet.upsert` uses, exposed for pre-flight checks (UI form submission, CSV ingest audits).

```typescript
import { validateRecord } from 'gitsheets';

const validated = await validateRecord({
  record,
  schema,                          // JSONSchema | null
  schemaSourcePath,                // for error messages
  validator,                       // optional Standard Schema
});
// returns the possibly-transformed record on success; throws ValidationError on failure
```

## Template

`Template.fromString(s)` — parse + cache. Most consumers don't construct `Template` directly; it's exposed for advanced use (path-template diagnostics, custom `queryTree` integrations).

```typescript
const tpl = Template.fromString('${{ domain }}/${{ username }}');
tpl.render({ domain: 'af.mil', username: 'jane' });  // → 'af.mil/jane'
tpl.getFieldNames();                                  // → ['domain', 'username']
```

## Record annotations

Records read from a Sheet carry two symbol-keyed annotations:

```typescript
import { RECORD_SHEET_KEY, RECORD_PATH_KEY } from 'gitsheets';

const jane = await sheet.queryFirst({ slug: 'jane' });
const sheetName = (jane as Record<symbol, unknown>)[RECORD_SHEET_KEY];  // 'users'
const recordPath = (jane as Record<symbol, unknown>)[RECORD_PATH_KEY]; // 'jane'
```

These annotations let `Sheet.upsert` detect renames (if the rendered path differs from `RECORD_PATH_KEY`, the old file is deleted). Symbols are stripped before writing to disk.
