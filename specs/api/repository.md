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
  branch?: string,           // the default branch — reads, commits, refresh, sync all target it; default: `gitsheets.branch` git config, else HEAD's branch
});
```

Backed by hologit's repo discovery. If `gitDir` is omitted, the library probes `cwd` upward for a `.git`.

A fresh-but-initialized repository (no commits yet) is supported — see [#19](https://github.com/JarvusInnovations/gitsheets/issues/19).

**`opts.branch`** binds the repository to a **default branch** other than the one `HEAD` points at — the branch every live sheet reads, every transaction commits to by default, and `refresh` / `sync` / `fetch` / the push daemon / `merge` target when given no ref. The resolution order (`opts.branch` → `gitsheets.branch` git config → `HEAD`), the full list of what it governs, and the bootstrap path for a branch that does not exist yet are in .[behaviors/default-branch.md](../behaviors/default-branch.md).. `repo.branch` reports the resolved short name, or `null` on a detached `HEAD` with nothing configured.

## Methods

### `repo.openSheet(name, opts?)`

Returns a `Sheet` handle bound to this repository's current state.

```typescript
const users = await repo.openSheet('users', {
  root?: string,              // default: '.'
  prefix?: string,            // optional sub-prefix under the sheet's configured root
  ref?: string,               // pin reads to a ref / commit / tree (read-only sheet) — see "Ref-pinned sheets"
  validator?: StandardSchema, // optional Standard Schema validator
  contract?: {                // consumer-side contract verification — behaviors/contracts.md
    schema: object | string,  // the contract document the consumer holds (parsed data, or JSON/TOML text)
    format?: 'json' | 'toml', // required when `schema` is a string — no format auto-detection (matches canonicalContractHash)
    mode?: 'verify' | 'declared' | 'structural',   // default: 'verify'
    onDrift?: (report: ConformanceReport) => void, // advisory drift signal (structural-verified sheets only)
  },
});
```

`opts.prefix` scopes record reads/writes to `<configRoot>/<prefix>/<rendered-path>.<ext>`. Useful for multi-tenant sub-tree partitioning. The sheet's `.gitsheets/<name>.toml` config file is unaffected — only the record data tree is scoped. Mirrors the CLI `--prefix` global flag (env `GITSHEETS_PREFIX`). See [api/cli.md](cli.md#global-flags) for the CLI surface.

Throws `ConfigError` if `.gitsheets/<name>.toml` doesn't exist under the resolved root.

**`opts.ref`** opens a **ref-pinned, read-only** sheet: every read (records, config, attachments, indexes, contract verification) resolves against the tree `ref` pointed at when the sheet was opened — a branch, a tag, a commit hash, or a tree hash, anything `git rev-parse <ref>^{tree}` accepts. `RefError` (`ref_not_found`) if it does not resolve. Operator tooling reads another branch's records this way (a reviewer sampling a staging branch, an importer reading the previous snapshot to keep ids stable) without moving `HEAD`, opening a throwaway transaction, or hand-parsing `cat-file` output.

- **Pinned means pinned.** The sheet is excluded from the owning repository's auto-refresh and from `repo.refresh()` ([behaviors/freshness.md](../behaviors/freshness.md#ref-pinned-sheets)). Only an explicit `sheet.refresh()` re-resolves `ref` — so a branch-pinned sheet can be told to catch up with its branch; a commit-pinned sheet is immutable.
- **Read-only.** The permissive-mode write methods (`upsert`, `delete`, `patch`, `clear`, `setAttachment(s)`, `deleteAttachment(s)`) throw `TransactionError` (`transaction_required`) naming the ref. To write onto that history, open a transaction with `parent: ref`.
- `sheet.clone()` of a pinned sheet is pinned to the same ref. `tx.sheet(name)` inside a transaction is unaffected (it reads the transaction's tree as always).

**`opts.contract`** verifies the sheet against a contract document the consumer holds, per the two-rung ladder in [behaviors/contracts.md](../behaviors/contracts.md#consumer-verification). The document is canonicalized and hashed by the core regardless of input form. Modes:

- `'verify'` (default) — rung 1 (declared identity), falling back to rung 2 (structural validation of all records). Failure of both: `ContractError('contract_unsatisfied')` carrying the conformance report.
- `'declared'` — rung 1 only; never reads records. Miss: `ContractError('contract_unsatisfied')`.
- `'structural'` — rung 2 only (duck typing; ignores any declaration).

`sheet.contractVerification` on the returned handle reports `{ name, rung: 'declared' | 'structural', tree, conforming, issues }` — which guarantee you actually got, and the tree hash it's pinned to (`conforming`/`issues` are the same conformance-report shape `onDrift` receives; always `conforming: true` / `issues: []` on the handle you get back, since a failed verification throws rather than returning a non-conforming report). For structural-verified sheets, a rebind to a changed tree ([behaviors/freshness.md](../behaviors/freshness.md)) triggers an advisory re-verification: `onDrift` is invoked with the report if conformance regressed. Reads are never blocked by drift — refusal belongs at wiring time only.

### `repo.openSheets(opts?)`

Returns `{ [sheetName]: Sheet }` covering every sheet declared in `.gitsheets/`.

```typescript
const sheets = await repo.openSheets({
  root?: string,
  prefix?: string,            // applied to every discovered sheet
  ref?: string,               // discover and pin every sheet at this ref (read-only) — see openSheet
});
```

`openSheets` returns un-validated sheets keyed by name. To attach per-sheet validators, use [`openStore`](store.md) instead — `openSheets` does not accept a `validators` map. `opts.prefix` is applied uniformly to every sheet returned; for per-sheet differing prefixes, call `openSheet` directly with each name.

Used by `openStore` (see [api/store.md](store.md)).

### `repo.transact(opts, handler)`

Run a handler inside a transaction. Returns `Promise<TransactionResult<T>>` where `T` is the handler's return type.

```typescript
const result = await repo.transact(
  {
    parent?: string | null,          // ref or commit hash; default: the default branch (behaviors/default-branch.md); null = orphan root commit
    author?: { name: string, email: string }, // default: git config
    committer?: { name: string, email: string }, // default: author
    message: string,                 // commit subject + body
    trailers?: Record<string, string>, // appended per `git interpret-trailers` rules
    branch?: string,                  // ref to update on success (created if absent); default: the parent ref if it was a branch (so, the default branch when `parent` is omitted)
  },
  async (tx: Transaction) => {
    // mutations via tx.sheet(name).upsert / delete / patch
    return someValue;
  }
);
// result: { value, commitHash, treeHash, ref, parentCommitHash }
```

See [behaviors/transactions.md](../behaviors/transactions.md) for semantics (mutex, commit-on-success, trailer formatting).

**Auto-refresh on commit.** When the transaction produces a commit, `repo.transact` rebinds every live `Sheet` this repository has issued to the default branch's current tree before resolving (only when the commit advanced the default branch — [behaviors/default-branch.md](../behaviors/default-branch.md)) — reads through standing sheets (including `store.<sheet>`) immediately reflect the committed state. A no-op or discarded transaction rebinds nothing. See [behaviors/freshness.md](../behaviors/freshness.md).

### `repo.refresh()`

Rebind every live `Sheet` this `Repository` has issued (via `openSheet`, `openSheets`, `openStore`, or `Sheet.clone()`) to the repository's current `HEAD` tree. Returns `Promise<void>`.

```typescript
// after an out-of-band ref movement (external process commit, fetch+reset):
await repo.refresh();
```

Cheap: one ref resolution, then a lazy rebind per sheet — records, attachments, config, and indexes re-derive on their next read. Consumers do **not** need to call this after their own `repo.transact` — a successful commit auto-refreshes (see below). See [behaviors/freshness.md](../behaviors/freshness.md).

### `repo.readBlob(ref, path)`

The blob at `<ref>:<path>`, resolved **at call time** — independent of any sheet's read snapshot — as a `BlobHandle`: `hash`, `size` (bytes, from the object header, no inflate), `read()` (`Promise<Buffer>`), `stream()` (`Readable`). One native call for the metadata, no subprocess.

```typescript
const blob = await repo.readBlob('HEAD', 'people/janedoe/avatar.jpg');
reply.header('ETag', `"${blob.hash}"`).header('Content-Length', blob.size);
blob.stream().pipe(reply.raw);
```

### `repo.readBlobStream(ref, path)`

`(await repo.readBlob(ref, path)).stream()`: a `Promise<Readable>` over the blob's bytes with bounded buffering — up to 1 MiB is served from one in-core read; larger blobs are piped from `git cat-file blob` without being materialized by gitsheets ([behaviors/attachments.md](../behaviors/attachments.md#blob-metadata-and-bounded-buffering)).

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

### `repo.sync(opts?)`

Bring `opts.branch` (default: the repository's default branch — [behaviors/default-branch.md](../behaviors/default-branch.md)) up to date with `opts.remote` (default `origin`): fetch outside the write lock, then fast-forward / replay / escape under it, then refresh live sheets if the branch moved. Returns `Promise<SyncResult>`; the full state machine, option set, and outcome table are in [behaviors/push-sync.md](../behaviors/push-sync.md#sync-opt-in-explicit).

```typescript
interface SyncOptions {
  remote?: string;                            // default 'origin'
  branch?: string;                            // default: the default branch; RefError when that is a detached HEAD
  fetch?: boolean;                            // default true; false = the caller already fetched
  onConflict?: 'fail' | 'preserve-branch';    // default 'fail'
  conflictBranchPrefix?: string;              // default 'conflicts/'
  pushConflictBranch?: boolean;               // default true (best-effort)
  committer?: { name: string; email: string } // for replayed commits; default: the repo's identity
  afterMove?: (result: SyncResult) => void | Promise<void> // runs under the write lock after a move + rebind
}
interface SyncResult {
  outcome: 'in-sync' | 'fast-forwarded' | 'ahead' | 'rebased' | 'conflict' | 'conflict-escaped' | 'fetch-failed';
  oldCommit: string;      // the branch tip before
  newCommit: string;      // the branch tip after (== oldCommit when nothing moved)
  ahead: number;          // local commits the remote lacked
  behind: number;         // remote commits the local lacked
  conflictCommit?: string;        // 'conflict' / 'conflict-escaped': the local commit that would not replay
  conflictBranch?: string;        // 'conflict-escaped': where the local history was preserved
  conflictBranchPushed?: boolean; // 'conflict-escaped': whether that branch reached the remote
  fetchError?: string;            // 'fetch-failed'
}
```

- Throws `TransactionError` (`lock_held`) inside a transaction handler or a `withLock` callback; `RefError` (`ref_not_found`) when the branch or its remote-tracking ref does not exist after the fetch; `RefError` (`not_an_ancestor`) when the two histories are unrelated.
- A running push daemon is handed the new tip after `ahead` / `rebased` (it pushes; `sync` itself never pushes the branch).
- `afterMove` runs only when the branch moved, under the write lock and after live sheets were rebound, so no transaction can interleave between the move and the caller's rebuild; inside it `transact` / `withLock` are `lock_held`. Its throw propagates after the lock is released; the ref stays moved.

### `repo.fetch(opts?)`

`git fetch --prune <remote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>` on its own — `sync`'s first step, without the lock. `opts.remote` defaults to `origin`, `opts.branch` to the default branch (`RefError` when that is a detached `HEAD`). Returns `Promise<{ ok: true, remoteRef, remoteCommit } | { ok: false, remoteRef, error }>`; a network or auth failure is a value, not a throw. Pair with `sync({ fetch: false })`. See [behaviors/push-sync.md](../behaviors/push-sync.md#sync-opt-in-explicit).

### `repo.tag(name, target?, opts?)`

Point the lightweight tag `refs/tags/<name>` at `target` (any commit-ish; default `HEAD`), in the core with no subprocess. Returns `Promise<string>`, the object id tagged. An existing tag is refused with `TransactionError` (`commit_failed`) unless `opts.force` is `true`, in which case it is moved (the `git tag -f` equivalent). `RefError` (`ref_not_found`) when `target` does not resolve. Annotated tags are out of scope.

### `repo.listTree(ref, path?)`

The direct entries of the tree at `<ref>:<path>` (`path` defaults to the root), sorted by name: `Promise<Array<{ name, type: 'blob' | 'tree' | 'commit', mode, hash }> | null>` — `mode` as git's octal string (`100644`, `100755`, `120000`, `040000`, `160000`). `null` when nothing, or a blob, is at `path`. `RefError` (`ref_not_found`) when `ref` does not resolve. Not recursive: list a subdirectory by passing its path. Typical use: discovering `.gitsheets/` configs or vendored contracts at a ref.

### `repo.isAncestor(a, b)`

`Promise<boolean>` — whether commit `a` is reachable from commit `b` (or equal). `RefError` (`ref_not_found`) when either does not resolve to a commit.
### `repo.merge(opts)`

Sheet-aware merge of `opts.theirs` into `opts.ours` (default: the repository's default branch) per [behaviors/merge.md](../behaviors/merge.md): record files changed on both sides are field-merged and written canonically; conflicts follow `opts.prefer` or are reported. Returns `Promise<MergeResult>`; never throws on a conflict.

```typescript
interface MergeOptions {
  theirs: string;                         // branch, tag, or commit to merge in
  ours?: string;                          // branch to merge into; default: the default branch
  prefer?: 'fail' | 'ours' | 'theirs';    // default 'fail'
  commit?: boolean;                       // default true; false = write the tree, move nothing (dry-run)
  message?: string;                       // default `Merge <theirs> into <ours>`
  author?: { name: string; email: string };
  committer?: { name: string; email: string };
  root?: string;                          // openSheet({ root }) scoping; default '.'
}
interface MergeResult {
  outcome: 'up-to-date' | 'fast-forward' | 'merged' | 'conflict' | 'dry-run';
  oursCommit: string; theirsCommit: string; base: string | null;
  tree: string | null;        // the merged tree (merged / dry-run)
  commit: string | null;      // the merge commit (merged) or the tip adopted (fast-forward / up-to-date)
  mergedRecords: string[];    // record paths re-done at the record level
  conflicts: Array<{ path: string; kind: 'field' | 'delete-modify' | 'blob' | 'tree'; field?: string; ours?: string; theirs?: string }>;
}
```

- `ours` may be a commit hash, in which case no ref moves and `commit` is the detached merge commit.
- Throws `RefError` (`ref_not_found`) when a side does not resolve, `RefError` (`not_an_ancestor`) when the histories are unrelated, `TransactionError` (`lock_held`) inside a transaction or `withLock`. Runs under the write lock; a moved default branch rebinds live sheets.

### `repo.requireExplicitTransactions()`

Opt into strict mode. After this is called on a `Repository`, calling `Sheet.upsert` / `delete` / `patch` outside a transaction throws `TransactionError` with `code: 'transaction_required'`.

Default mode is permissive (mutations outside a transaction auto-open one).

### `repo.startPushDaemon(opts)`

Returns a `PushDaemon` handle. Configures async background push-to-remote with retry/backoff. See [behaviors/push-sync.md](../behaviors/push-sync.md).

```typescript
const daemon = await repo.startPushDaemon({
  remote: 'origin',
  branch?: string,           // default: the default branch
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
| `RefError` | `ref_not_found` | `parent` ref doesn't exist; `readBlob` / `readBlobStream` ref doesn't resolve; `openSheet` / `openSheets` / `openStore` `opts.ref` doesn't resolve to a tree |
| `TransactionError` | `transaction_required` | A permissive-mode write on a ref-pinned (read-only) sheet |
| `NotFoundError` | `record_not_found` | `readBlob` / `readBlobStream` path absent under the ref, or not a blob |
| `TransactionError` | `transaction_in_progress` | Another transaction is open on this repo |
| `TransactionError` | `lock_held` | `withLock` / `transact` / `sync` attempted while the caller's own async context already holds the write lock (not reentrant) |
| `RefError` | `not_an_ancestor` | `sync`: the local branch and the remote-tracking branch share no history |
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
- [behaviors/default-branch.md](../behaviors/default-branch.md)
