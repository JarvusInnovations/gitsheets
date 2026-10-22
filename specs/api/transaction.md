# API: Transaction

A scope bundling one or more sheet mutations into a single commit.

## Summary

A `Transaction` is the unit of atomicity. Inside a transaction, mutations stage to a private tree built from the parent ref; on success the tree commits and the configured branch advances. On throw, the tree is discarded — no commit, no ref movement.

Transactions are created by `Repository.transact(opts, handler)` and (in typed Store usage) by `Store.transact(opts, handler)`. They are not directly constructible by consumers.

## Lifecycle

```text
1. parent ref resolves      → parentCommitHash
2. private tree built       → copy of parent's tree
3. handler runs             → mutations stage to the private tree
4. handler resolves         → finalize: validate, write tree, commit, update ref
   handler throws           → discard tree, no commit, no ref movement
5. transaction closed       → mutex released
```

## Inside the handler

The handler receives a `tx` object. The Sheet handles obtained from `tx.sheet(name)` are scoped to the transaction's tree — their writes do not become visible to other readers until the transaction commits.

```typescript
await repo.transact({ message: '...' }, async (tx) => {
  const users = tx.sheet('users');
  await users.upsert({ slug: 'jane', email: 'jane@x.org' });

  const audit = tx.sheet('audits');
  await audit.upsert({ action: 'user.create', subject: 'jane' });

  return { created: 'jane' };
});
```

`tx.sheet(name, opts?)` returns a `Sheet` with the same API as the outer `Repository.openSheet(name)` — except all writes route through the transaction's private tree. `opts` accepts `validator?: StandardSchema` (used by [`Store.transact`](store.md) to thread per-sheet validators through to tx scope) and `prefix?: string` (sub-prefix under the sheet's configured root — same shape as `Repository.openSheet({ prefix })`; useful when a multi-tenant request handler opens a transaction and needs every sheet within it scoped to one tenant).

### Raw files: `tx.writeFile(path, content)` / `tx.deleteFile(path)`

A transaction can also stage files that are not records — a sheet config, a vendored contract, a fixture, a README beside the data — so they land in the **same commit** as the record changes they belong with:

```typescript
await repo.transact({ message: 'add the events sheet + seed' }, async (tx) => {
  tx.writeFile('.gitsheets/events.toml', eventsConfigToml);        // string → UTF-8
  tx.writeFile('fixtures/banner.png', pngBytes);                   // Buffer / Uint8Array → raw bytes
  await tx.sheet('events').upsert({ slug: 'launch', title: 'Launch' });
  tx.deleteFile('fixtures/old.csv');                               // true if something was there
});
```

- `path` is **repo-root-relative** (`a/b/c.txt`), never absolute and never `..`; intermediate directories are created. It is independent of `openSheet({ root })` and of any sheet's `root`.
- `content` is a `string` (written as UTF-8) or raw bytes (`Buffer` / `Uint8Array`). `writeFile` returns a `BlobHandle` (`hash`, `read()`) for the written blob and marks the transaction mutated.
- `deleteFile` returns whether a blob existed at `path`; a miss is a no-op that does not mark the transaction mutated.
- **Raw means raw.** Nothing is validated, normalized, or rendered: writing into a sheet's data tree bypasses the sheet entirely. Use `tx.sheet(name)` for records; use these for everything else. The CLI's `init` / `infer` / `migrate-config` / `contracts adopt` / `contracts prune` are built on them.

Both are synchronous: they stage into the private tree and return. The Python binding exposes the same pair (`tx.write_file(path, content: str | bytes) -> str` (the blob hash), `tx.delete_file(path) -> bool`).

## Read isolation

Reads through `tx.sheet(name)` see the transaction's in-flight mutations. Reads outside the transaction (e.g., a concurrent `repo.openSheet(name).queryFirst(...)`) see the *committed* state — the pre-transaction tree — until the transaction commits.

That includes the sheet's **config**: `tx.sheet(name)` loads `.gitsheets/<name>.toml` (and any vendored contracts it declares) from the transaction's private tree, so a config staged earlier in the same transaction with `tx.writeFile` governs that sheet's writes — in an orphan `transact({ parent: null })`, which starts from the empty tree, that is the only place a config can come from. Config is read once, when the transaction first uses the sheet; staging a different config for a sheet the transaction has already used does not reload it.

A transaction-bound query is **pruned by the path template exactly like a committed-ref query** ([behaviors/path-templates.md § Query traversal](../behaviors/path-templates.md#query-traversal)): a filter that supplies path fields reads only the matching subtrees of the private tree, and `withBody: false` skips bodies. It never degrades to listing the whole sheet — a bulk loop of `tx.sheet(name).patch(query, …)` costs one pruned lookup per row, not one full-sheet read per row.

## Commit message + trailers

The commit's message is structured:

```text
<subject>

<optional body>

Trailer-Key: trailer-value
Another-Trailer: another-value
```

- **Subject** = the `message` option (first line).
- **Body** = anything after the first line of `message`.
- **Trailers** = appended per `git interpret-trailers` rules. See [behaviors/transactions.md](../behaviors/transactions.md) for the format.

Trailer keys use HTTP-header style: first letter capitalized, multi-word hyphenated, rest lowercase (`Subject-Id`, `User-Agent`, `Action`).

## Author and committer

- **Author** = `opts.author` or git config `user.name` / `user.email`.
- **Committer** = `opts.committer` or `opts.author`.
- Both can be omitted entirely if git config is set.

## Concurrency

One open transaction per `Repository` at a time, enforced two ways:

- **Nested** `repo.transact(...)` — calling `repo.transact` from *within* an open transaction's handler (same async context, detected via `AsyncLocalStorage`) throws `TransactionError` (`transaction_in_progress`) immediately. Use `tx.sheet(name)` inside the handler instead of re-opening a transaction.
- **Concurrent-but-independent** `repo.transact(...)` — a call from a *separate* async context while another transaction is open does **not** throw; it **queues** on an in-process mutex and runs after the open one commits or releases. (The Rust core exposes a *throwing* per-repo single-writer slot; the host binding wraps it with this fair queue, so well-behaved concurrent callers serialize rather than fail.) See [behaviors/transactions.md](../behaviors/transactions.md#single-writer-model).

Mutations made *outside* any open transaction (permissive mode) implicitly open and commit a single-mutation transaction; they too contend for the mutex.

In **strict mode** (`repo.requireExplicitTransactions()`), mutations outside `repo.transact(...)` throw `TransactionError` (`transaction_required`).

## Parent ref handling

- If `opts.parent` is a branch name (e.g., `main`), the transaction's parent commit is `main`'s tip at transaction open; on commit, `main` advances to the new commit.
- If `opts.parent` is a commit hash, the transaction commits onto that hash; if `opts.branch` is also set, that branch is updated.
- If neither is set, defaults to the repository's default branch ([behaviors/default-branch.md](../behaviors/default-branch.md)).
- If `opts.parent` is **`null`**, the transaction is an **orphan**: it starts from the empty tree, `parentCommitHash` is `null`, and the commit has no parents — a fresh root for a snapshot, a scrubbed export, or a seed branch. An orphan always commits (there is no parent tree to compare against), even when the handler leaves the tree empty. With `opts.branch`, the branch is **created** pointing at the new root; an orphan refuses to land on a branch that already exists (`TransactionError` `commit_failed` at open — delete the ref or pick another name), because there is no parent to make the move safe. Without `opts.branch`, the result is a detached root commit (`ref: null`) the consumer tags or pushes by hash.

### `opts.branch` may name a branch that does not exist yet

`opts.branch` is the ref to advance on success. When it names a branch other than the parent ref, its tip is captured at open; at commit it must still be there (compare-and-swap, else `TransactionError` `commit_failed`) — or **absent**, in which case the branch is created. So `transact({ parent: 'main', branch: 'review/batch-7' }, …)` forks a new branch from `main` in one call, with `main` left where it was. A branch that is also the parent ref keeps the `parent_moved` check described below.

If the parent ref moves between transaction open and commit (a separate process committed), the transaction throws `TransactionError` (`parent_moved`). The handler's tree changes are discarded.

## No-op detection

`finalize` skips the commit entirely when the resulting tree-hash matches the parent commit's tree-hash:

```text
new_tree_hash := await workspace.root.write()
if parentCommitHash !== null and (parentCommitHash^{tree}) === new_tree_hash:
    return { value, commitHash: null, treeHash: null, ref: null, parentCommitHash }
```

Two conditions must both hold to detect the no-op:

1. **A parent commit exists.** On a fresh repo (`parentCommitHash === null`), an initial commit IS produced even if the tree is empty — there's no parent tree to compare against. This is intentional: an initial commit is a meaningful event the consumer asked for.
2. **The resulting tree hash equals the parent's tree hash.** This is the canonical git-native "did anything actually change?" check, computed in O(tree-depth) by `git rev-parse <commit>^{tree}`.

When both conditions hold, the return shape matches the existing `!anyMutation` short-circuit (`commitHash: null`, `treeHash: null`, `ref: null`). Consumers detect a no-op via `result.commitHash === null`.

**This means the following all produce no commit:**

- `upsert(record)` where the record's canonical bytes match the existing blob
- `clear()` + re-`upsert` from a snapshot whose data is unchanged from the parent's
- `delete(path)` + `upsert` of an identical record at the same path
- An explicit `tx.markMutated()` call that isn't accompanied by an actual tree mutation

The last bullet is a behavior change from v1.3.0, where `markMutated()` alone forced a commit. Real consumers of `markMutated` (internal callers like `upsert`/`delete`/`setAttachments`) always pair it with an actual mutation, so this isn't expected to break anyone. Consumers who genuinely want empty commits should use `git commit --allow-empty` outside the library.

## Permissive mode

Standalone mutations (mutations called without an enclosing `repo.transact`) auto-open a transaction with a generated message:

```text
<sheet> upsert <path>
```

or `<sheet> delete <path>`, etc. The author defaults to git config. The branch defaults to the repository's default branch ([behaviors/default-branch.md](../behaviors/default-branch.md)).

This makes simple scripts ergonomic. For request-bound workflows, consumers should call `repo.transact` explicitly to control the message/author/trailers.

## Hooks

None in v1.0. Pre-commit and post-commit hook points are deliberately not exposed — the API can grow them later without breaking existing callers.

## Examples

### Single-sheet write

```typescript
const { value, commitHash } = await repo.transact(
  {
    parent: 'main',
    author: { name: 'Jane Doe', email: 'jane@x.org' },
    message: 'janedoe: POST /api/users\n\nCreated by sign-up flow',
    trailers: { Action: 'user.create', 'Subject-Slug': 'janedoe' },
  },
  async (tx) => {
    return tx.sheet('users').upsert({ slug: 'janedoe', email: 'jane@x.org' });
  }
);
```

### Multi-sheet atomic write

```typescript
await repo.transact(
  { message: 'admin: project.delete squadquest' },
  async (tx) => {
    await tx.sheet('projects').delete({ slug: 'squadquest' });
    for await (const m of tx.sheet('memberships').query({ projectSlug: 'squadquest' })) {
      await tx.sheet('memberships').delete(m);
    }
  }
);
```

### Strict mode

```typescript
repo.requireExplicitTransactions();

await sheet.upsert({ ... });          // throws TransactionError: transaction_required

await repo.transact({ message: '...' }, async (tx) => {
  await tx.sheet('users').upsert({ ... });  // ok
});
```

## Errors

| Class | Code | When |
| --- | --- | --- |
| `TransactionError` | `transaction_in_progress` | Nested `repo.transact` inside an open transaction's handler (independent-context calls queue instead — see [Concurrency](#concurrency)) |
| `TransactionError` | `transaction_required` | Mutation outside a transaction in strict mode |
| `TransactionError` | `parent_moved` | Optimistic-concurrency conflict at commit |
| `TransactionError` | `commit_failed` | `git commit-tree` / `update-ref` returned non-zero, **or** a malformed trailer key/value was rejected at option-normalization time (HTTP-header-style key, string value with no newlines) |
| `RefError` | `ref_not_found` | `opts.parent` is a branch name that doesn't exist |
| `TransactionError` | `commit_failed` | `opts.parent: null` with an `opts.branch` that already exists (an orphan only creates a branch); or `opts.branch` (≠ parent ref) moved between open and commit |
| (any) | (any) | Errors thrown by the handler propagate out after tree discard |

## Coordinates with

- [api/repository.md](repository.md)
- [api/sheet.md](sheet.md)
- [api/store.md](store.md)
- [api/errors.md](errors.md)
- [behaviors/transactions.md](../behaviors/transactions.md)
