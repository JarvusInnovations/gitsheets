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
handler resolves successfully + tree has at least one staged change
  → finalize: validate the staged tree, commit, update ref
  → resolve { value, commitHash, treeHash, ref, parentCommitHash }

handler resolves successfully but no mutations occurred
  → permissive mode: no commit, resolves with { value, commitHash: null, ... }
  → explicit `repo.transact`: same — empty transactions don't commit

handler throws
  → tree discarded, no commit, no ref movement
  → throw propagates out of `repo.transact`
  → mutex released
```

This differs from the [pre-v1.0 PR #38 prototype](https://github.com/JarvusInnovations/gitsheets/pull/38), which committed unconditionally when `save()` was called. The commit-on-success-only rule is a hard requirement for production use — a half-applied mutation in the log is worse than no log entry.

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

`Sheet.upsert(record)` called outside any explicit `repo.transact`:

1. Opens a transaction with auto-generated `message`: `"<sheet> upsert <renderedPath>"`
2. Renders the record via the template, stages the write
3. Commits with the auto-generated message and git-config author
4. Returns the `{ blob, path }` shape that `upsert` documents

Equivalent for `delete` (`"<sheet> delete <path>"`) and `patch` (`"<sheet> patch <path>"`).

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
