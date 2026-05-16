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
  validator?: StandardSchema, // optional Standard Schema validator
});
```

Throws `ConfigError` if `.gitsheets/<name>.toml` doesn't exist under the resolved root.

### `repo.openSheets(opts?)`

Returns `{ [sheetName]: Sheet }` covering every sheet declared in `.gitsheets/`.

```typescript
const sheets = await repo.openSheets({ root?: string });
```

`openSheets` returns un-validated sheets keyed by name. To attach per-sheet validators, use [`openStore`](store.md) instead — `openSheets` does not accept a `validators` map.

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
| `RefError` | `ref_not_found` | `parent` ref doesn't exist |
| `TransactionError` | `transaction_in_progress` | Another transaction is open on this repo |
| `TransactionError` | `commit_failed` | The underlying `git commit-tree` or `update-ref` failed |
| `TransactionError` | `parent_moved` | Optimistic concurrency: parent ref moved between transaction start and commit |
| `ConfigError` | `config_missing` | `.gitsheets/<name>.toml` not found in `openSheet` |
| `ConfigError` | `config_invalid` | Sheet config TOML is malformed |

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
- [behaviors/push-sync.md](../behaviors/push-sync.md)
