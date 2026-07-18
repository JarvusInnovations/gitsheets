# API: Repository

The entry point. A `Repository` represents a git repository that contains gitsheets data.

## Summary

`Repository` opens a git directory, exposes per-sheet handles, and orchestrates transactions. It's the primary object every consumer holds.

## Construction

```typescript
import { openRepo } from 'gitsheets';

const repo = await openRepo({
  gitDir?: string,           // path to a .git directory; default: discovered from cwd
  workTree?: string | null,  // optional working-tree path; default: null (bare-style operation)
});
```

Backed by hologit's repo discovery. If `gitDir` is omitted, the library probes `cwd` upward for a `.git`.

A fresh-but-initialized repository (no commits yet) is supported — see [#19](https://github.com/JarvusInnovations/gitsheets/issues/19).

## Methods

### `repo.openSheet(name, opts?)`

Returns a `Sheet` handle bound to this repository's current state.

```typescript
const users = await repo.openSheet('users', {
  root?: string,              // default: '.'
  prefix?: string,            // optional sub-prefix under the sheet's configured root
  validator?: StandardSchema, // optional Standard Schema validator
  contract?: {                // consumer-side contract verification — behaviors/contracts.md
    schema: object | string,  // the contract document the consumer holds (parsed data, or JSON/TOML text)
    mode?: 'verify' | 'declared' | 'structural',   // default: 'verify'
    onDrift?: (report: ConformanceReport) => void, // advisory drift signal (structural-verified sheets only)
  },
});
```

`opts.prefix` scopes record reads/writes to `<configRoot>/<prefix>/<rendered-path>.<ext>`. Useful for multi-tenant sub-tree partitioning. The sheet's `.gitsheets/<name>.toml` config file is unaffected — only the record data tree is scoped. Mirrors the CLI `--prefix` global flag (env `GITSHEETS_PREFIX`). See [api/cli.md](cli.md#global-flags) for the CLI surface.

Throws `ConfigError` if `.gitsheets/<name>.toml` doesn't exist under the resolved root.

**`opts.contract`** verifies the sheet against a contract document the consumer holds, per the two-rung ladder in [behaviors/contracts.md](../behaviors/contracts.md#consumer-verification). The document is canonicalized and hashed by the core regardless of input form. Modes:

- `'verify'` (default) — rung 1 (declared identity), falling back to rung 2 (structural validation of all records). Failure of both: `ContractError('contract_unsatisfied')` carrying the conformance report.
- `'declared'` — rung 1 only; never reads records. Miss: `ContractError('contract_unsatisfied')`.
- `'structural'` — rung 2 only (duck typing; ignores any declaration).

`sheet.contractVerification` on the returned handle reports `{ name, rung: 'declared' | 'structural', tree }` — which guarantee you actually got, and the tree hash it's pinned to. For structural-verified sheets, a rebind to a changed tree ([behaviors/freshness.md](../behaviors/freshness.md)) triggers an advisory re-verification: `onDrift` is invoked with the report if conformance regressed. Reads are never blocked by drift — refusal belongs at wiring time only.

### `repo.openSheets(opts?)`

Returns `{ [sheetName]: Sheet }` covering every sheet declared in `.gitsheets/`.

```typescript
const sheets = await repo.openSheets({
  root?: string,
  prefix?: string,            // applied to every discovered sheet
});
```

`openSheets` returns un-validated sheets keyed by name. To attach per-sheet validators, use [`openStore`](store.md) instead — `openSheets` does not accept a `validators` map. `opts.prefix` is applied uniformly to every sheet returned; for per-sheet differing prefixes, call `openSheet` directly with each name.

Used by `openStore` (see [api/store.md](store.md)).

### `repo.transact(opts, handler)`

Run a handler inside a transaction. Returns `Promise<TransactionResult<T>>` where `T` is the handler's return type.

```typescript
const result = await repo.transact(
  {
    parent?: string,                 // ref or commit hash; default: current HEAD
    author?: { name: string, email: string }, // default: git config
    committer?: { name: string, email: string }, // default: author
    message: string,                 // commit subject + body
    trailers?: Record<string, string>, // appended per `git interpret-trailers` rules
    branch?: string,                  // ref to update on success; default: the parent ref if it was a branch
  },
  async (tx: Transaction) => {
    // mutations via tx.sheet(name).upsert / delete / patch
    return someValue;
  }
);
// result: { value, commitHash, treeHash, ref, parentCommitHash }
```

See [behaviors/transactions.md](../behaviors/transactions.md) for semantics (mutex, commit-on-success, trailer formatting).

**Auto-refresh on commit.** When the transaction produces a commit, `repo.transact` rebinds every live `Sheet` this repository has issued to the current `HEAD` tree before resolving — reads through standing sheets (including `store.<sheet>`) immediately reflect the committed state. A no-op or discarded transaction rebinds nothing. See [behaviors/freshness.md](../behaviors/freshness.md).

### `repo.refresh()`

Rebind every live `Sheet` this `Repository` has issued (via `openSheet`, `openSheets`, `openStore`, or `Sheet.clone()`) to the repository's current `HEAD` tree. Returns `Promise<void>`.

```typescript
// after an out-of-band ref movement (external process commit, fetch+reset):
await repo.refresh();
```

Cheap: one ref resolution, then a lazy rebind per sheet — records, attachments, config, and indexes re-derive on their next read. Consumers do **not** need to call this after their own `repo.transact` — a successful commit auto-refreshes (see below). See [behaviors/freshness.md](../behaviors/freshness.md).

### `repo.readBlobStream(ref, path)`

Stream a blob's bytes by `<ref>:<path>`, resolved **at call time** — independent of any sheet's read snapshot. Returns `Promise<Readable>` (a Node stream); bytes are piped from the object store without materializing the whole blob in memory.

```typescript
const stream = await repo.readBlobStream('HEAD', 'people/janedoe/avatar.jpg');
stream.pipe(httpResponse);
```

- `ref` — any tree-ish: ref name, commit hash, or tree hash.
- `path` — tree path under the ref (e.g. an attachment's key: `<sheetRoot>/<recordPath>/<name>`).
- Throws `RefError` (`ref_not_found`) when `ref` doesn't resolve to a tree-ish.
- Throws `NotFoundError` (`record_not_found`) when `path` is absent under the ref's tree, or names a non-blob (a directory).

The typical consumer is an HTTP handler serving attachment bytes by key (see [behaviors/attachments.md](../behaviors/attachments.md#streaming-reads-by-keypath)); `Sheet.getAttachmentStream` is the sheet-scoped sibling.

### `repo.withLock(fn)`

Run `fn` while holding the repository's **write lock** — the same in-process mutex that serializes `repo.transact`. For consumers coordinating non-transact git operations against the same repo (an external fetch + ref reset, a hot-reload that re-opens the store, raw plumbing reads that must not interleave with a commit), so they don't have to maintain a parallel lock that shadows gitsheets' own.

```typescript
const result = await repo.withLock(async () => {
  // no gitsheets transaction can start or commit while this runs
  await execFile('git', ['fetch', 'origin'], { cwd: repo.gitDir });
  await execFile('git', ['update-ref', 'refs/heads/main', 'origin/main'], { cwd: repo.gitDir });
  return 'synced';
});
```

- Returns `Promise<T>` where `T` is `fn`'s return type. `fn` may be sync or async.
- **Queueing**: contends FIFO with `repo.transact` calls (and permissive-mode auto-transactions) from other async contexts — whoever holds the lock runs alone; the lock is released when `fn` settles (resolve or throw). A throw from `fn` propagates after release.
- **Not reentrant — deliberately.** The lock has no hold-count. Calling `repo.withLock` inside a `withLock` callback, calling `repo.withLock` inside a `repo.transact` handler (the transaction already holds the lock), or calling `repo.transact` (or any permissive-mode mutation, which auto-opens a transaction) inside a `withLock` callback would self-deadlock — each is detected via async-context tracking and throws `TransactionError` (`lock_held`) instead of hanging.
- The lock is **in-process, per-`Repository`-instance** — the same scope as the transaction mutex ([behaviors/transactions.md](../behaviors/transactions.md#single-writer-model)). It does not coordinate across processes or across two `Repository` instances opened on the same git dir.

### `repo.requireExplicitTransactions()`

Opt into strict mode. After this is called on a `Repository`, calling `Sheet.upsert` / `delete` / `patch` outside a transaction throws `TransactionError` with `code: 'transaction_required'`.

Default mode is permissive (mutations outside a transaction auto-open one).

### `repo.startPushDaemon(opts)`

Returns a `PushDaemon` handle. Configures async background push-to-remote with retry/backoff. See [behaviors/push-sync.md](../behaviors/push-sync.md).

```typescript
const daemon = await repo.startPushDaemon({
  remote: 'origin',
  branch?: string,           // default: HEAD's branch
  backoff?: 'exponential' | { base: number, cap: number, multiplier: number },
  maxRetries?: number,       // default: Infinity
});

daemon.on('push', ({ commit, durationMs }) => {});
daemon.on('error', ({ commit, err, attempt }) => {});
daemon.on('retry', ({ commit, attempt, nextDelayMs }) => {});

daemon.status();             // { lastPushAt, lastError, pendingCommits, currentBackoffMs }
await daemon.stop();         // graceful drain
```

### `repo.resolveRef(ref)`

Returns the commit hash a ref points to, or `null` if the ref doesn't exist.

```typescript
const hash = await repo.resolveRef('main');         // → '01ab...'
const missing = await repo.resolveRef('nope');      // → null
```

## TransactionResult

```typescript
interface TransactionResult<T> {
  value: T;                  // whatever the handler returned
  commitHash: string;        // the new commit
  treeHash: string;          // the tree that commit points at
  ref: string | null;        // the ref that was updated, if any
  parentCommitHash: string | null;
}
```

When the handler stages no mutations, the transaction does **not** commit — `commitHash`, `treeHash`, and `ref` are `null`, and the parent ref is unchanged. This applies to both `repo.transact` and permissive-mode auto-transactions. See [behaviors/transactions.md](../behaviors/transactions.md#commit-on-success-only).

## Errors

| Class | Code | When |
| --- | --- | --- |
| `RefError` | `ref_not_found` | `parent` ref doesn't exist; `readBlobStream` ref doesn't resolve |
| `NotFoundError` | `record_not_found` | `readBlobStream` path absent under the ref, or not a blob |
| `TransactionError` | `transaction_in_progress` | Another transaction is open on this repo |
| `TransactionError` | `lock_held` | `withLock` / `transact` attempted while the caller's own async context already holds the write lock (not reentrant) |
| `TransactionError` | `commit_failed` | The underlying `git commit-tree` or `update-ref` failed |
| `TransactionError` | `parent_moved` | Optimistic concurrency: parent ref moved between transaction start and commit |
| `ConfigError` | `config_missing` | `.gitsheets/<name>.toml` not found in `openSheet` |
| `ConfigError` | `config_invalid` | Sheet config TOML is malformed |
| `ContractError` | `contract_missing` | `implements` names a contract with no vendored document in the committed tree |
| `ContractError` | `contract_invalid` | Vendored contract violates document requirements (compile, `$id`/path, canonical form, openness, self-containment) |
| `ContractError` | `contract_unsatisfied` | `openSheet` with `opts.contract` failed verification (carries conformance report) |

## Examples

### Open + transact

```typescript
const repo = await openRepo({ gitDir: '/path/to/repo' });

await repo.transact(
  { message: 'janedoe: POST /api/users', author: { name: 'Jane', email: 'jane@x.org' } },
  async (tx) => {
    await tx.sheet('users').upsert({ slug: 'janedoe', email: 'jane@x.org' });
  }
);
```

### Push daemon

```typescript
const daemon = repo.startPushDaemon({ remote: 'origin' });
// ... mutations happen, daemon pushes async ...
await daemon.stop();
```

## Coordinates with

- [api/sheet.md](sheet.md)
- [api/transaction.md](transaction.md)
- [api/store.md](store.md)
- [api/errors.md](errors.md)
- [behaviors/transactions.md](../behaviors/transactions.md)
- [behaviors/freshness.md](../behaviors/freshness.md)
- [behaviors/push-sync.md](../behaviors/push-sync.md)
