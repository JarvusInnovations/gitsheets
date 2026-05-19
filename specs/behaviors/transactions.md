# Behavior: Transactions

## Rule

A **transaction** scopes a set of mutations to one commit. The mutations stage into a private tree built from a parent ref. On success the tree is finalized into a commit and the configured branch advances. On failure (handler throws) the tree is discarded — no commit, no ref movement.

## Applies To

- [api/transaction.md](../api/transaction.md) — the `Transaction` class itself
- [api/repository.md](../api/repository.md) — `repo.transact(opts, handler)`
- [api/store.md](../api/store.md) — `store.transact(opts, handler)`
- [api/sheet.md](../api/sheet.md) — `Sheet.upsert` / `delete` / `patch` (in permissive mode, auto-opens a transaction)

## Single-writer model

One open transaction per `Repository` at a time, serialized by an in-process mutex.

| Scenario | Behavior |
| --- | --- |
| Two concurrent `repo.transact` calls | Second waits on the mutex; runs after the first commits or releases. |
| Concurrent `repo.transact` *and* a permissive-mode `Sheet.upsert` outside a transaction | The permissive `upsert` opens its own transaction, contends for the same mutex. |
| Same-process concurrent reads | Reads don't take the mutex. They see the *committed* state (pre-transaction tree). |

Multi-process / multi-host writers are explicitly out of scope. If another process commits to the same ref while a transaction is open, the transaction throws `TransactionError` (`parent_moved`) when it tries to commit. Detection is via comparing the parent ref's commit hash at transaction open vs. at commit.

## Commit-on-success-only

```text
handler resolves successfully + resulting tree differs from parent's tree
  → finalize: write tree, commit, update ref
  → resolve { value, commitHash, treeHash, ref, parentCommitHash }

handler resolves successfully but resulting tree matches parent's tree
  → no commit produced (tree-hash equality check)
  → resolve { value, commitHash: null, treeHash: null, ref: null, parentCommitHash }

handler resolves successfully but no mutating methods were called
  → no commit produced (anyMutation flag short-circuit)
  → resolve { value, commitHash: null, treeHash: null, ref: null, parentCommitHash }

handler throws
  → tree discarded, no commit, no ref movement
  → throw propagates out of `repo.transact`
  → mutex released
```

This differs from the [pre-v1.0 PR #38 prototype](https://github.com/JarvusInnovations/gitsheets/pull/38), which committed unconditionally when `save()` was called. The commit-on-success-only rule is a hard requirement for production use — a half-applied mutation in the log is worse than no log entry.

**Two short-circuit paths, same return shape.** The library tracks an `anyMutation` flag as a cheap heuristic (set by `upsert`/`delete`/`clear`/etc.), but that flag is an over-approximation. The authoritative no-op signal is tree-hash equality with the parent: after `workspace.root.write()` produces the resulting tree hash, it's compared to `parentCommitHash^{tree}`. A match means semantically nothing changed, and the same `{ commitHash: null, ... }` return path fires. See [api/transaction.md#no-op-detection](../api/transaction.md#no-op-detection) for examples (re-upsert of byte-identical record; `clear()` + re-upsert of unchanged snapshot data; etc.). On a fresh repo (no parent), no tree-hash comparison is possible — an initial commit IS produced even when the tree is empty.

## Commit message format

```text
<subject line>

<optional body, separated by blank line>

<trailers, separated by blank line>
```

- **Subject** = first line of the `message` option. ≤ 72 chars is convention but not enforced.
- **Body** = anything after the first blank line of `message`, up to the trailers.
- **Trailers** = key/value lines appended per `git interpret-trailers`. Format and conventions below.

## Trailer convention

Trailers are appended at the end of the commit message, parseable by `git interpret-trailers --parse`.

### Format

```text
Subject-Type: project
Subject-Id: 01ab-...
Subject-Slug: squadquest
Action: project.soft-delete
Actor-Slug: chris
Reason: spam policy violation
```

### Naming

HTTP-header style:

- First letter capitalized
- Multi-word keys hyphenated
- Rest lowercase

Examples: `Subject-Type`, `User-Agent`, `Response-Code`. Single-word keys: `Action`, `Reason`, `Host`.

### Semantic vs. request trailers

Trailers serve two purposes — the API doesn't distinguish, but consumers typically use both:

**Semantic** (describes the action):

- `Action` — dotted action name (`project.soft-delete`, `tag.merge`, `account-level.change`)
- `Subject-Type` — entity type affected
- `Subject-Id` — UUID
- `Subject-Slug` — slug
- `Actor-Slug` — actor's slug
- `Actor-Account-Level` — actor's role
- `Reason` — free-form rationale

**Request context** (describes the HTTP request that triggered the commit):

- `Host`
- `Content-Type`
- `User-Agent`
- `User-Ip`
- `Response-Code`

Consumers building request-bound commit lifecycles (one commit per HTTP request) populate both sets. Programmatic / batch consumers typically populate only semantic trailers.

## Author and committer

```typescript
{
  author?: { name: string, email: string },
  committer?: { name: string, email: string }
}
```

Resolution:

1. `opts.author` if provided
2. `opts.committer` falls back to `opts.author` if not provided separately
3. If `opts.author` is omitted, falls back to git config (`user.name`, `user.email`)
4. If git config is also missing, falls back to `Anonymous <anonymous@gitsheets.local>` and logs a warning

## Parent ref handling

- `opts.parent`: ref name, short hash, or full commit hash. Default: current `HEAD`.
- `opts.branch`: ref to update on commit. Default:
  - If `opts.parent` is a branch (e.g., `main`): that same branch
  - If `opts.parent` is a commit hash: `null` (no ref updated — the commit is "detached")

To "commit onto a feature branch": `opts.parent: 'feature-x'`. To "commit onto a specific commit but not advance any branch": `opts.parent: '01ab2c...'`.

## Optimistic concurrency

At transaction open: capture `parentCommitHash = resolveRef(opts.parent)`.

At commit time: re-resolve `opts.parent`. If it has moved:

- The transaction is closed
- `TransactionError` (`parent_moved`) is thrown with both hashes (`expected`, `actual`)
- Tree is discarded
- Consumer can retry by re-opening a transaction (it'll pick up the new parent)

This catches concurrent commits from outside the API instance — direct git commits, separate gitsheets processes, etc. — at minimal cost.

## Permissive mode (default)

A standalone `Sheet` mutation called outside any explicit `repo.transact` opens an auto-transaction, stages the write, and commits with an auto-generated message.

Auto-message format by method:

| Method | Auto-message |
| --- | --- |
| `Sheet.upsert(record)` | `<sheet> upsert` |
| `Sheet.delete(target)` | `<sheet> delete <path>` |
| `Sheet.patch(query, partial)` | `<sheet> patch <path>` |
| `Sheet.clear()` | `<sheet> clear` |
| `Sheet.setAttachment(s)(...)` | `<sheet> attachments` |

The exact rendered path is included where it's available *before* the transaction opens (`delete` and `patch` both resolve the target path first). For `upsert` the rendered path is only known *after* validation + normalization + template rendering inside the staged tree, so the auto-message omits it — the rendered path is recoverable from the commit's tree diff. Consumers who want the path in the subject line should pass an explicit `repo.transact({ message })`.

This makes simple scripts ergonomic. For production request-bound flows, consumers should call `repo.transact` explicitly to control author/message/trailers — see [architecture.md](../architecture.md) recommendations.

## Strict mode

After `repo.requireExplicitTransactions()`:

- Standalone `Sheet.upsert` / `delete` / `patch` throws `TransactionError` (`transaction_required`)
- All writes must be inside an explicit `repo.transact` block

Strict mode is per-`Repository` and one-way (no `releaseStrictMode`) — set once at boot.

## Hooks

None in v1.0. Pre-commit and post-commit hook points are deliberately not exposed. The internal commit pipeline is structured so hooks can be added in a future minor release without breaking existing callers — but the *contract* doesn't include them.

If a consumer needs hook-like behavior in v1.0:

- Pre-commit equivalent: run any side-effects in the handler before the last `tx.sheet(...)` call
- Post-commit equivalent: chain `await repo.transact(...).then(...)` — the resolved `TransactionResult` includes the commit hash for downstream effects

## Historical note: PR #38

The transaction concept has existed in design form since 2020 — see [PR #38 (Feature/transactions)](https://github.com/JarvusInnovations/gitsheets/pull/38), a draft prototype that added `gitSheets.createTransaction(parentRef)` to the legacy `GitSheets` class. The prototype:

- Returned `{ upsert(data), save(branch?) }`
- Staged writes into an in-memory `TreeObject`
- Committed unconditionally on `save()`
- Had no message/author/trailers/mutex/commit-on-success

The v1.0 design (this spec + [#129](https://github.com/JarvusInnovations/gitsheets/issues/129)) preserves the kernel idea (tree-builder + commit) and adds the production-grade pieces. PR #38 should be closed as superseded.

## Coordinates with

- [api/transaction.md](../api/transaction.md)
- [api/repository.md](../api/repository.md)
- [api/store.md](../api/store.md)
- [api/errors.md](../api/errors.md)
- [GitHub #129](https://github.com/JarvusInnovations/gitsheets/issues/129) — implementation issue
- [GitHub PR #38](https://github.com/JarvusInnovations/gitsheets/pull/38) — historical prototype
