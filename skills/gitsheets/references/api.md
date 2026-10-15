# gitsheets TypeScript API reference

ESM-only. `import { … } from 'gitsheets'`. Targets Node ≥ 20 / Bun ≥ 1, `strict: true`.

## Table of contents

- [Module surface](#module-surface)
- [openRepo](#openrepo) — open a Repository
- [Repository](#repository) — methods on the repo handle
- [Sheet](#sheet) — per-sheet operations
  - [Reading](#reading) — query / queryFirst / queryAll / count / get / loadBody / pathForRecord / normalizeRecord
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
  QueryFilter, RangeFilter, QueryOptions, DiffStatus, DiffOptions, DiffChange,
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
| `repo.openSheet<T>(name, opts?)` | Sheet handle; `opts.validator` (Standard Schema), `opts.root`, `opts.prefix`, `opts.ref` (v2.8+: pin reads to a branch/tag/commit — read-only, never auto-refreshed; `sheet.refresh()` re-resolves the ref; writes throw `TransactionError(transaction_required)` — write via `repo.transact({ parent: ref })`) |
| `repo.openSheets(opts?)` | `Record<string, Sheet>` of every sheet declared under `.gitsheets/`; `opts.ref` pins them all |
| `repo.transact(opts, handler)` | Single-commit transaction; see below |
| `repo.requireExplicitTransactions()` | One-way strict-mode switch — standalone Sheet writes throw |
| `repo.startPushDaemon(opts)` | Start async push to a remote (returns `PushDaemon`) |
| `repo.resolveRef(ref)` | `Promise<string \| null>` — resolve a ref or commit hash |
| `repo.readBlob(ref, path)` | `Promise<BlobHandle>` (v2.8+) — the blob at `<ref>:<path>` resolved now: `hash`, `size`, `read()`, `stream()`; `RefError` / `NotFoundError` |
| `repo.readBlobStream(ref, path)` | `Promise<Readable>` — `readBlob(…).stream()` |
| `repo.sync(opts?)` | `Promise<SyncResult>` (v2.8+) — fetch + fast-forward / replay / preserve-on-conflict under the write lock; see PushDaemon section |
| `repo.isAncestor(a, b)` | `Promise<boolean>` (v2.8+) — is commit `a` reachable from `b` |
| `repo.merge({ theirs, ours?, prefer?, commit?, message? })` | `Promise<MergeResult>` (v2.8+) — sheet-aware merge: records changed on both sides are field-merged and written canonically; `prefer: 'fail'` (default) reports conflicts in `result.conflicts` with nothing written, `'ours'` / `'theirs'` resolves field, delete/modify and blob conflicts; `commit: false` = dry run. Outcomes `up-to-date` · `fast-forward` · `merged` · `conflict` · `dry-run` |

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
| `sheet.get(path, opts?)` | `Promise<T \| undefined>` | One record by its rendered path — one blob read, no scan; `opts.withBody`; tx-bound reads the private tree. The primitive behind "read one record" |
| `sheet.loadBody(record)` | `Promise<T>` | Hydrate a body-less record (markdown sheets); no-op on TOML sheets |
| `sheet.pathForRecord(record)` | `Promise<string>` | Render the path template; doesn't write |
| `sheet.normalizeRecord(record)` | `Promise<T>` | Canonical form (deep-sort keys, array sort rules); doesn't write/validate |

**Filters.** A filter is a plain object; every entry must hold (AND). Per field, the value is one of:

| Entry | Meaning |
| --- | --- |
| literal (`'staff'`, `42`, `true`, a `Date`) | strict equality (`Date`s compare by instant) |
| `(value, record) => boolean` | predicate — opaque to pruning |
| plain object | nested-table filter, descends recursively |
| `{ $gt?, $gte?, $lt?, $lte? }` | **range** — see below (v2.7+) |

Filters that reference path-template fields prune the tree walk (see `sheet-config.md` → "How queries use the template"); predicates and most other entries filter record-level after the walk.

**Range filters** (`RangeFilter<V>`): any combination of the four bounds, at least one. Comparison is by kind — numbers numerically (int and float interchangeably), strings lexicographically, `Date`s as instants — and a `Date` field also accepts an **ISO 8601 string bound** (`'2026-01-01'`, `'2026-01-01T00:00:00Z'`), so you rarely need to construct a `Date`. Mismatched kinds (a string bound against a number field, an absent field) never match. A `$`-keyed object outside this vocabulary, or mixing `$gte` with ordinary keys, or giving both `$gt` and `$gte`, throws `TypeError` at query start. `$in` / `$or` don't exist — use a predicate or filter in consumer code.

```typescript
// template '${{ publishedAt: YYYY/MM/DD }}/${{ slug }}' — walks only the 2025/11/20 … 2026/02/03 partitions
const q1 = await posts.queryAll({ publishedAt: { $gte: '2025-11-20', $lt: '2026-02-03' } });
const recent = await posts.queryAll({ publishedAt: { $gt: new Date('2026-01-01T00:00:00Z') } });  // one-sided
const adults = await users.queryAll({ age: { $gte: 18, $lt: 65 } });                               // numeric, record-level
const n = await posts.count({ publishedAt: { $gte: '2026-01-01' } });                              // count honors it too
```

On a **date-bucket** path field (`${{ field: YYYY/MM/DD }}` etc.) a range prunes the walk to the bounded span of partitions — pruning is inclusive at the day/month/year level and the record-level comparison applies the exact `$gt` / `$lt` cutoff, so results equal a full scan, just far cheaper. On any other field a range is record-level only. Typed sheets: `RangeFilter<Date>` admits string bounds, `RangeFilter<number>` doesn't.

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
| `sheet.upsert(record, opts?)` | Insert or replace; returns `{ blob, path }`. `opts.allowMissingBody` for markdown sheets — only for an absent/`undefined` body; an explicit `null` body is accepted as-is and written empty (v2.8+). |
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
const map = await sheet.getAttachments(record);          // Map of name → BlobHandle { hash, size, read(), stream() } (size + stream() v2.8+)

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
tx.parentCommitHash             // may be null on fresh repos and orphan commits
tx.parentRef                    // ref the tx is reading from
tx.branchRef                    // ref the tx will advance on commit
tx.writeFile(path, content)     // raw file (string → UTF-8, or Buffer/Uint8Array) at a repo-root-relative path → BlobHandle (v2.8+)
tx.deleteFile(path)             // → boolean: did a blob exist there (v2.8+)
```

Writes inside the handler are atomic; throws from the handler discard the staged tree. Nested `repo.transact` throws `TransactionError(transaction_in_progress)`.

`writeFile` / `deleteFile` are for non-record files that belong in the same commit — a `.gitsheets/<sheet>.toml`, a vendored contract, a fixture, a README. Nothing is validated or normalized; use `tx.sheet(name)` for records.

**Orphan commits and new branches (v2.8+).** `repo.transact({ parent: null, branch: 'snapshot' }, …)` starts from the empty tree and commits with no parents (always, even if the handler stages nothing); the branch is created and must not already exist (`TransactionError(commit_failed)` at open). Without `branch` the result is a detached root (`ref: null`). Separately, `branch` may name a branch that does not exist yet: `transact({ parent: 'main', branch: 'review/x' }, …)` forks it from `main` in one call.

## openStore + Store

Typed wrapper over `Repository.openSheets()` that binds per-sheet Standard Schema validators.

```typescript
import { openStore } from 'gitsheets';
import { z } from 'zod';

const UserSchema   = z.object({ slug: z.string(), email: z.string().email() });
const ProjectSchema = z.object({ id: z.string(), name: z.string() });

const store = await openStore(repo, {
  validators: { users: UserSchema, projects: ProjectSchema },
  // ref: 'published',  // v2.8+: read-only store pinned at a ref; store.refresh() re-resolves it
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

**Push-only.** Never pulls. The consumer process is the single writer — the reverse direction is `repo.sync()`:

```typescript
const r = await repo.sync({ remote: 'origin', branch: 'main', onConflict: 'preserve-branch' }); // v2.8+
// r.outcome: 'in-sync' | 'fast-forwarded' | 'ahead' | 'rebased' | 'conflict' | 'conflict-escaped' | 'fetch-failed'
// r.oldCommit, r.newCommit, r.ahead, r.behind, r.conflictBranch?, r.conflictCommit?, r.fetchError?
```

Fetch happens outside the write lock; classification and ref movement happen under it (no transaction can interleave); live sheets are rebound when HEAD's branch moved; `ahead` / `rebased` tips are handed to a running push daemon. `onConflict: 'fail'` (default) leaves everything in place and names the commit that would not replay; `'preserve-branch'` keeps the local history on `conflicts/<UTC>` (pushed best-effort) and adopts the remote. `repo.isAncestor(a, b)` is the "do I already have this commit?" short-circuit.

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

These annotations let `Sheet.upsert` detect renames: if the rendered path differs from `RECORD_PATH_KEY`, the old file is deleted **and the record's attachment directory moves to the new path** (v2.8+). Symbols are stripped before writing to disk.

So the rename idiom is "load, change the key, upsert the same object" — `await sheet.upsert({ ...person, slug: 'new' })` (spread keeps symbol keys). Do **not** `delete` then `upsert`: `delete` cascades to the attachment directory first, so the attachments are lost. A validator that drops symbol keys (Zod `.parse`) needs the annotation re-applied — `parsed[RECORD_PATH_KEY] = person[RECORD_PATH_KEY]` — or pass the validator via `openSheet({ validator })` so the sheet carries it across itself.
