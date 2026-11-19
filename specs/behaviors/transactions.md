# Behavior: Transactions

## Rule

A **transaction** scopes a set of mutations to one commit. The mutations stage into a private tree built from a parent ref. On success the tree is finalized into a commit and the configured branch advances. On failure (handler throws) the tree is discarded — no commit, no ref movement.

## Applies To

- [api/transaction.md](../api/transaction.md) — the `Transaction` class itself
- [api/repository.md](../api/repository.md) — `repo.transact(opts, handler)`
- [api/store.md](../api/store.md) — `store.transact(opts, handler)`
- [api/sheet.md](../api/sheet.md) — `Sheet.upsert` / `delete` / `patch` (in permissive mode, auto-opens a transaction)

## Single-writer model

One open transaction per `Repository` at a time, serialized by an in-process mutex. (The Rust core exposes a *throwing* per-repo single-writer slot; the host binding wraps it with the fair queue below — queueing is a host concern.)

| Scenario | Behavior |
| --- | --- |
| Two concurrent `repo.transact` calls from independent async contexts | Second waits on the mutex; runs after the first commits or releases. |
| **Nested** `repo.transact` — opening one inside another's handler (same async context) | Throws `TransactionError` (`transaction_in_progress`) immediately; it does not queue. Use `tx.sheet(name)` inside the handler instead. |
| Concurrent `repo.transact` *and* a permissive-mode `Sheet.upsert` outside a transaction | The permissive `upsert` opens its own transaction, contends for the same mutex. |
| Same-process concurrent reads | Reads don't take the mutex. They see the *committed* state (pre-transaction tree). After a successful commit, standing sheets rebind to the new tree — see [freshness.md](freshness.md). |
| `repo.withLock(fn)` from an independent async context | Contends FIFO for the same mutex as transactions; `fn` runs alone. See [api/repository.md](../api/repository.md#repowithlockfn). |
| `repo.withLock` inside a transaction handler, `repo.transact` (or a permissive-mode mutation) inside a `withLock` callback, or `withLock` inside `withLock` | Throws `TransactionError` (`lock_held`) immediately — the lock is not reentrant, and queueing would self-deadlock. |

**The write lock is exposed.** `repo.withLock(fn)` runs consumer code under the same mutex, so out-of-band git operations (external fetch + ref reset, hot-reload re-opens, raw plumbing) serialize against transactions without a parallel consumer-maintained lock ([#236](https://github.com/JarvusInnovations/gitsheets/issues/236)).

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

handler resolves successfully, nothing changed, but `allowEmpty: true`
  → finalize anyway: an empty commit carrying the message, trailers, and parents
  → resolve { value, commitHash, treeHash, ref, parentCommitHash }

handler throws
  → tree discarded, no commit, no ref movement
  → throw propagates out of `repo.transact`
  → mutex released
```

This differs from the [pre-v1.0 PR #38 prototype](https://github.com/JarvusInnovations/gitsheets/pull/38), which committed unconditionally when `save()` was called. The commit-on-success-only rule is a hard requirement for production use — a half-applied mutation in the log is worse than no log entry.

**Two short-circuit paths, same return shape.** The library tracks an `anyMutation` flag as a cheap heuristic (set by `upsert`/`delete`/`clear`/etc.), but that flag is an over-approximation. The authoritative no-op signal is tree-hash equality with the parent: after `workspace.root.write()` produces the resulting tree hash, it's compared to `parentCommitHash^{tree}`. A match means semantically nothing changed, and the same `{ commitHash: null, ... }` return path fires. See [api/transaction.md#no-op-detection](../api/transaction.md#no-op-detection) for examples (re-upsert of byte-identical record; `clear()` + re-upsert of unchanged snapshot data; etc.). On a fresh repo (no parent), no tree-hash comparison is possible — an initial commit IS produced even when the tree is empty.

Both short-circuits are skipped when the caller opts in with `allowEmpty: true` ([Empty commits](#empty-commits)). In [replace mode](#replacing-the-tip) the `anyMutation` short-circuit is skipped as well, because its premise (the starting tree is the parent's tree) does not hold there.

### Rollup pass

Before a transaction's tree is committed, gitsheets regenerates the rollup records ([rollups.md](rollups.md)) of every partition the transaction changed in any rollup's source sheet, staging them into the same tree. The records and their aggregates land in one commit; a `AggregationError` aborts it like a `ValidationError` would. A transaction that touches no rollup source stages nothing extra.

"Changed" is always measured against the new commit's **first parent**. [Lineage parents](#lineage-parents) never feed the pass. In [replace mode](#replacing-the-tip) the pass also regenerates every partition the replaced commit changed relative to that same first parent, so a replacement that reverts part of the replaced commit's work does not inherit a rollup computed from records that are no longer there.

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

A trailer whose key isn't HTTP-header style, or whose value isn't a single-line string, is rejected up front (at option-normalization time, before any tree work) with `TransactionError` (`trailer_invalid`). See [api/transaction.md#errors](../api/transaction.md#errors).

Until this release a malformed trailer was `commit_failed`. It moves to its own code because `commit_failed` tells a caller "nothing landed, a retry may work", and a retry of a malformed trailer never works ([api/errors.md](../api/errors.md#malformed-trailers-were-commit_failed)).

The key `Gitsheets-Lineage` is **reserved**: gitsheets writes it to mark [lineage parents](#lineage-parents), and a caller-supplied trailer with that key is `trailer_invalid`. Every other key stays the caller's.

### Trailers from the command line

Both CLIs take trailers as a repeatable `--trailer` flag on every committing command ([api/cli.md](../api/cli.md), [api/axi.md](../api/axi.md)). The flag value is `Key: value` or `Key=value`, split at the first `:` or `=` (a valid key contains neither, so the split is unambiguous); in the `:` form, whitespace after the colon is dropped, as `git interpret-trailers` does. The same key and value rules apply as for the library option. Trailers are a per-call option ([principles.md](../principles.md#behave-like-a-first-party-git-extension)): a command flag only, with no `GITSHEETS_*` variable and no git config.

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

- `opts.parent`: ref name, short hash, full commit hash, or **`null`** for an orphan root commit (empty starting tree, no parents, always commits). Default: the repository's default branch ([default-branch.md](default-branch.md); `HEAD`'s branch unless bound otherwise).
- `opts.branch`: ref to update on commit. Default:
  - If `opts.parent` is a branch (e.g., `main`): that same branch
  - If `opts.parent` is a commit hash or `null`: `null` (no ref updated — the commit is "detached")
  - A `branch` that does not exist yet is **created** at commit. An orphan refuses an existing `branch` (`commit_failed` at open).

To "commit onto a feature branch": `opts.parent: 'feature-x'`. To "commit onto a specific commit but not advance any branch": `opts.parent: '01ab2c...'`. To "fork a new branch from main in one commit": `opts.parent: 'main', opts.branch: 'new-branch'`. To "start a fresh history": `opts.parent: null, opts.branch: 'snapshot'`. See [api/transaction.md](../api/transaction.md#parent-ref-handling).

## Optimistic concurrency

At transaction open: capture `parentCommitHash = resolveRef(opts.parent)`.

At commit time: re-resolve `opts.parent`. If it has moved:

- The transaction is closed
- `TransactionError` (`parent_moved`) is thrown with both hashes (`expected`, `actual`)
- Tree is discarded
- Consumer can retry by re-opening a transaction (it'll pick up the new parent)

This catches concurrent commits from outside the API instance — direct git commits, separate gitsheets processes, etc. — at minimal cost.

In [replace mode](#replacing-the-tip) `parent_moved` is never thrown. The branch is checked against the commit the caller said it expected to replace, and any difference, at open or at commit, is `tip_mismatch`. The two codes ask for different recoveries: after `parent_moved` a caller re-opens and writes on top of whatever is there now; after `tip_mismatch` it must not, because it would be replacing a commit it has not seen.

## Lineage parents

A transaction may name **additional parents** for its commit with `alsoParents: string[]`: each entry is a commit-ish (hash or ref) that must resolve to a commit already in the repository, and the commit is written with parents `[first parent, ...alsoParents]` in that order, recorded as full hashes.

**A lineage parent records provenance, not a merge.** It says "this state was built on top of that one": a log commit that names the data snapshot it was computed from, a resumed run that names the run it resumed. The commit's tree is still the first parent's tree plus the transaction's changes; nothing from a lineage parent's tree is merged in, and gitsheets never merges, replays, or diffs against a lineage parent on its own initiative.

Git itself cannot tell a lineage parent from a merge parent: both are just a later entry in the commit's parent list. So gitsheets marks them. For each lineage parent it appends a trailer `Gitsheets-Lineage: <full hash>` after the caller's trailers. A parent at position two or later is a **lineage parent** when its hash appears in a `Gitsheets-Lineage` trailer of that commit, and a **merge parent** otherwise. Commits gitsheets did not create (a plain `git merge`, another tool's multi-parent commit) carry no marker, so they keep their merge semantics, and no existing history reads differently.

Rules:

- **Validation at open.** An entry that does not resolve, or resolves to something other than a commit, is `RefError` (`parent_not_found`). An entry equal to the first parent, or given twice, is `TransactionError` (`commit_failed`) at open. `alsoParents` with `parent: null` (an orphan) is `commit_failed` at open: an orphan has no first parent to add lineage to.
- **No effect on the tree, the no-op check, or the rollup pass.** All three use the first parent only. A transaction that changes nothing still commits nothing unless `allowEmpty` is set; a lineage parent rides on a commit, it does not cause one.
- **`parent_moved`** keeps its meaning: it concerns the first parent (the ref being advanced), never a lineage parent.
- **History walks skip lineage edges.** Wherever gitsheets walks history to decide what to move, it follows first parents and merge parents and does not follow an edge to a lineage parent:
  - `repo.sync` ([push-sync.md](push-sync.md#lineage-parents-in-sync)): the merge base, the `ahead` / `behind` counts, and the set of local commits to replay are computed over that graph. A replayed commit keeps its lineage parents (and its message, which carries the markers) as parents two and later.
  - `repo.merge` ([merge.md](merge.md#lineage-parents)): the up-to-date and fast-forward checks and the merge base are computed over that graph.
  - Without this rule, a lineage parent that points into another branch's history would make `sync` replay that entire history onto the remote tip, and would make `merge` treat everything behind the lineage parent as already merged.
- **Plain reachability is unchanged.** `repo.isAncestor(a, b)` keeps git's meaning (any parent edge counts): it answers "is this commit in my object graph", and a lineage parent's history is in it. The [replace-mode](#replacing-the-tip) "already pushed" check uses plain reachability too, which errs toward refusing.
- **Pushing sends lineage history.** `git push` (the push daemon, `gitsheets-axi push`) transfers every object reachable from the branch, so a lineage parent and its whole history go to the remote with the branch. A caller that names a parent from a private history publishes it. That is git's behavior; gitsheets does not filter it.

## Replacing the tip

A transaction may **replace** its branch's current tip instead of committing on top of it, with `replace: '<expected tip>'`: the commit-ish the caller believes is the tip right now. This is `git commit --amend` with a compare-and-swap guard.

- **The ref.** Replace mode moves the parent ref: the default branch, or `opts.parent` when that names a branch. `replace` with `parent: null`, with `parent` set to a commit hash, or with an `opts.branch` other than the parent ref is `commit_failed` at open. In submodule mode on a detached `HEAD` ([default-branch.md](default-branch.md#submodule-mode)), the ref is `HEAD`.
- **The guard.** At open, `replace` is resolved and compared with the ref's current tip. If they differ, or the value does not resolve, or the branch is unborn, the transaction fails with `TransactionError` (`tip_mismatch`, carrying `expected` and `actual`) before the handler runs, and nothing changes. At commit the ref is moved by compare-and-swap from the expected tip; if it moved in between, that too is `tip_mismatch` and the tree is discarded.
- **Already pushed is refused.** If the tip is reachable from any remote-tracking ref (`refs/remotes/**`), the transaction fails with `TransactionError` (`tip_published`) at open, and the check repeats at commit. Replacing a commit a remote already has makes the branch non-fast-forward there, and gitsheets never force-pushes ([push-sync.md](push-sync.md#push-command)). Refusing up front is the safer of the two options: a failure at push time would arrive after the replacement had landed locally, in the push daemon, possibly after further commits were built on it. There is no override. A caller that really means to rewrite published history uses git directly.
- **The starting tree** is the replaced tip's tree. The handler's mutations apply on top of it, so a replacement that changes nothing about the records keeps the tip's data.
- **The parents.** The first parent is the replaced tip's first parent. The tip's other parents (lineage and merge, with their roles) are kept unless `alsoParents` is given, in which case `alsoParents` replaces them and every entry is a lineage parent. `alsoParents: []` drops them. Replacing a root commit (no parents) produces a root commit.
- **The message and trailers** are the caller's. Nothing is inherited from the replaced commit except the lineage markers of the lineage parents it keeps.
- **No-op.** The resulting tree is compared with the **new first parent's** tree, not the replaced tip's. If they are equal and `allowEmpty` is not set, nothing is committed and the ref stays on the old tip (`commitHash: null`). A replacement that rewrites only the message of a tip that changed records therefore commits, because the tip's tree differs from its parent's. The `anyMutation` short-circuit does not apply in this mode.
- **Rollups and derived data.** The rollup pass covers the partitions changed between the new first parent and the result, plus those the replaced commit changed relative to the same parent ([Rollup pass](#rollup-pass)). Rollup records are stamped with partition tree hashes, not commit hashes, so nothing else in a gitsheets tree refers to the replaced commit. Live sheets rebind after the ref moves, as after any commit ([freshness.md](freshness.md)); index caches follow the rebind.
- **The replaced commit** is not deleted. It stays in the object database, unreferenced, until git's garbage collection removes it, and the result names it (`replacedCommitHash`).
- **Push daemon.** The replacement is handed to a running daemon like any commit. The `tip_published` check depends on how fresh the remote-tracking refs are: gitsheets' own successful pushes update them, so a single writer that pushes only through gitsheets is covered. If another tool pushed the tip without updating the tracking ref, or a daemon push of the old tip was already in flight when the replacement landed, the next push is rejected as non-fast-forward, which the daemon reports as a terminal `non-fast-forward` error and never retries or forces ([push-sync.md](push-sync.md#push-command)).

## Empty commits

`allowEmpty: true` makes a transaction commit even when the resulting tree equals its first parent's tree: the commit carries only its message, trailers, and parents. It applies on top of the tip and in replace mode. The default stays `false`, and without it every no-op rule above stands.

- Both short-circuits are skipped: no `anyMutation` check, no tree-equality check.
- The rollup pass runs as usual and, with nothing changed, stages nothing.
- An orphan already always commits; `allowEmpty` changes nothing there.
- The CLIs expose this through a `commit` command, because an empty commit has no record to write ([api/cli.md](../api/cli.md), [api/axi.md](../api/axi.md)).

## Reading a commit back

`repo.readCommit(rev?)` returns one commit as data, so a caller can resume from what it wrote ([api/repository.md](../api/repository.md#reporeadcommitrev)): its hash, tree, parents (each with a role: `first`, `lineage`, or `merge`, per [Lineage parents](#lineage-parents)), author and committer with dates, subject, body, and trailers as an ordered list of `{ key, value }` pairs. With no `rev` it reads the default branch's tip and returns `null` when the branch is unborn.

Trailers are read back from the **last paragraph** of the message (the text after the last blank line) when every line of that paragraph has the form `Key: value` with a key of letters, digits, and hyphens. Otherwise the commit has no trailers and the whole message after the subject is the body. That is exactly the shape gitsheets writes, so a round trip is lossless: the subject and body come back as given (trailing whitespace trimmed), and the trailers come back in order, `Gitsheets-Lineage` markers included.

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

## Principles

**Inherited:**

- [Behave like a first-party git extension](../principles.md#behave-like-a-first-party-git-extension) —
  trailers, lineage parents, `replace`, and `allowEmpty` shape one commit, so they are
  per-call options: library options and command flags, never an environment variable or
  git config. A `GITSHEETS_REPLACE` that silently amended every write in a shell would be
  the two-tools-two-answers trap that principle exists to prevent.

**Local:**

- **A ref move that could lose work needs the caller's proof.** Advancing a branch on
  top of its tip loses nothing, so the parent check is optimistic and retryable
  (`parent_moved`). Replacing the tip discards a commit, so the caller must name the
  commit it is discarding, a mismatch is never retried for it (`tip_mismatch`), and a
  commit a remote already has is never discarded at all (`tip_published`). When a new
  ref-moving option is added, it sits on the side of this line its worst case puts it.
- **gitsheets acts only on history it can classify.** A parent gitsheets marked as
  lineage is provenance and is never merged or replayed; an unmarked parent keeps git's
  merge meaning. gitsheets does not guess a parent's role from its shape, because a
  wrong guess either replays someone else's history or drops a real merge.

## Coordinates with

- [api/transaction.md](../api/transaction.md)
- [api/repository.md](../api/repository.md)
- [api/store.md](../api/store.md)
- [api/errors.md](../api/errors.md)
- [api/cli.md](../api/cli.md), [api/axi.md](../api/axi.md) — `--trailer`, `--also-parent`, `--replace`, `commit`, `head`
- [push-sync.md](push-sync.md), [merge.md](merge.md) — how sync and merge treat lineage parents
- [rollups.md](rollups.md) — the rollup pass in replace mode
- [GitHub #129](https://github.com/JarvusInnovations/gitsheets/issues/129) — implementation issue
- [GitHub PR #38](https://github.com/JarvusInnovations/gitsheets/pull/38) — historical prototype
