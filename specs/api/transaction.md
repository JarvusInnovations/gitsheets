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

## Read isolation

Reads through `tx.sheet(name)` see the transaction's in-flight mutations. Reads outside the transaction (e.g., a concurrent `repo.openSheet(name).queryFirst(...)`) see the *committed* state — the pre-transaction tree — until the transaction commits.

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

One open transaction per `Repository` at a time. A concurrent `repo.transact(...)` call while another is open throws `TransactionError` (`transaction_in_progress`).

Mutations made *outside* any open transaction (permissive mode) implicitly open and commit a single-mutation transaction; they too contend for the mutex.

In **strict mode** (`repo.requireExplicitTransactions()`), mutations outside `repo.transact(...)` throw `TransactionError` (`transaction_required`).

## Parent ref handling

- If `opts.parent` is a branch name (e.g., `main`), the transaction's parent commit is `main`'s tip at transaction open; on commit, `main` advances to the new commit.
- If `opts.parent` is a commit hash, the transaction commits onto that hash; if `opts.branch` is also set, that branch is updated.
- If neither is set, defaults to `HEAD`'s ref.

If the parent ref moves between transaction open and commit (a separate process committed), the transaction throws `TransactionError` (`parent_moved`). The handler's tree changes are discarded.

## Permissive mode

Standalone mutations (mutations called without an enclosing `repo.transact`) auto-open a transaction with a generated message:

```text
<sheet> upsert <path>
```

or `<sheet> delete <path>`, etc. The author defaults to git config. The branch defaults to `HEAD`'s ref.

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
| `TransactionError` | `transaction_in_progress` | Concurrent `repo.transact` attempt |
| `TransactionError` | `transaction_required` | Mutation outside a transaction in strict mode |
| `TransactionError` | `parent_moved` | Optimistic-concurrency conflict at commit |
| `TransactionError` | `commit_failed` | `git commit-tree` or `update-ref` returned non-zero |
| `RefError` | `ref_not_found` | `opts.parent` is a branch name that doesn't exist |
| (any) | (any) | Errors thrown by the handler propagate out after tree discard |

## Coordinates with

- [api/repository.md](repository.md)
- [api/sheet.md](sheet.md)
- [api/store.md](store.md)
- [api/errors.md](errors.md)
- [behaviors/transactions.md](../behaviors/transactions.md)
