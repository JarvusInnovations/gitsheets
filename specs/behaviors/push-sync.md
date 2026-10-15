# Behavior: Push Sync

## Rule

A `Repository` can run an optional **push daemon** that asynchronously pushes new commits to a configured git remote, with retry and exponential backoff. Push-only — the daemon never pulls.

## Applies To

- [api/repository.md](../api/repository.md) — `repo.startPushDaemon(opts)`, `repo.sync(opts)`, `repo.isAncestor(a, b)`
- [api/transaction.md](../api/transaction.md) — commits produced by `repo.transact` are what the daemon pushes
- [behaviors/freshness.md](freshness.md) — a sync that moves `HEAD`'s branch rebinds live sheets

## Why the daemon is push-only

A consumer process that writes to gitsheets is the *single writer* (see [behaviors/transactions.md](transactions.md)). A daemon that pulled on its own schedule would move the branch underneath open transactions and standing sheets — neither is recoverable cleanly. So the daemon never pulls.

Incorporating changes from elsewhere (an importer, a person pushing to the data repo, a separate process) is a separate, **explicit, consumer-invoked** operation that runs under the write lock: [`repo.sync()`](#sync-opt-in-explicit) below. Without it the fallback is still: stop the consumer, pull, restart.

## Sync (opt-in, explicit)

`repo.sync(opts)` brings a local branch up to date with a remote that other writers also push to. It is the single-writer model's one sanctioned reverse path: the consumer decides *when* (at boot, from a webhook, on a timer), and the library guarantees that nothing else commits or reads a half-moved ref while it runs.

```typescript
const result = await repo.sync({
  remote: 'origin',               // default 'origin'
  branch: 'published',            // default: the branch HEAD points at
  onConflict: 'preserve-branch',  // default 'fail'
});
// { outcome, oldCommit, newCommit, ahead, behind, conflictBranch?, conflictCommit?, fetchError? }
```

### Steps

1. **Fetch, outside the lock.** `git fetch --prune <remote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>` — an explicit refspec, so a single-branch clone can still sync a branch it was not cloned with. A failed fetch (network, auth) is **not an error**: the outcome is `fetch-failed`, nothing moves, and `fetchError` carries the message. `fetch: false` skips the step when the caller already fetched.
2. **Classify and move, inside the lock** — the same mutex `repo.transact` and `repo.withLock` take, so a transaction cannot open, commit, or observe a partially moved ref during the sync (and `sync` inside a transaction handler or a `withLock` callback is `lock_held`). With `L` the local tip, `R` the remote-tracking tip, `B` their merge base:

   | Relation | Outcome | Ref movement |
   | --- | --- | --- |
   | `L == R` | `in-sync` | none |
   | `L == B` (behind) | `fast-forwarded` | branch → `R` (compare-and-swap from `L`) |
   | `R == B` (ahead) | `ahead` | none; the local commits are handed to the push daemon if one is running |
   | diverged, replay clean | `rebased` | each local commit `B..L`, oldest first, is replayed onto `R` as a 3-way tree merge (parent tree, tip, commit tree); author, date and message preserved, committer set to `opts.committer` or the repository's identity; branch → new tip (compare-and-swap from `L`); the new tip is handed to the push daemon |
   | diverged, replay conflicts, `onConflict: 'fail'` | `conflict` | none; `conflictCommit` names the local commit that could not be replayed |
   | diverged, replay conflicts, `onConflict: 'preserve-branch'` | `conflict-escaped` | the local tip is preserved on a new branch `<conflictBranchPrefix><UTC timestamp>` (default prefix `conflicts/`, timestamp `YYYY-MM-DDTHH-MM-SSZ`), the branch is reset to `R`, and the conflict branch is pushed to the remote best-effort (`conflictBranchPushed`) so an operator can see it |
   | `L` and `R` share no history | throws `RefError` (`not_an_ancestor`) | none |

   `ahead` / `behind` are the commit counts `B..L` / `B..R`.

3. **Refresh.** When the branch moved and it is the branch `HEAD` points at, every live sheet is rebound to the new tree before `sync` resolves — exactly as a committing transaction does ([freshness.md](freshness.md)). Ref-pinned sheets are untouched.
4. **`afterMove(result)`, still under the lock.** When the branch moved (`fast-forwarded`, `rebased`, `conflict-escaped`) and the caller passed `afterMove`, `sync` awaits it **before releasing the write lock**, after the rebind. This is the consumer's critical section: a hot reload rebuilds its in-memory state there, and no transaction can commit between the ref move and the rebuild (a write validated against pre-reload state would otherwise land on top of what the reload brought in). Inside `afterMove`, `transact` and `withLock` are `lock_held` as everywhere under the lock; reads, `refresh()` and `store.refresh()` work. A throw from `afterMove` propagates out of `sync` after the lock is released — the ref has already moved and stays moved. The push-daemon hand-off and the conflict-branch push happen after `afterMove` returns.

The fetch step is also available on its own as **`repo.fetch({ remote?, branch? })`**: the same explicit-refspec fetch, run without the lock, returning `{ ok: true, remoteRef, remoteCommit }` or `{ ok: false, remoteRef, error }` (never throwing for a network or auth failure). A consumer that wants the round-trip outside any lock it holds calls `repo.fetch()` first and then `repo.sync({ fetch: false })`.

The replay is pure object-database work (no working tree, no index, nothing to abort), done in the core; only the fetch and the conflict-branch push spawn git, because the network layer stays with git's own auth and transport. `sync` never force-pushes and never rewrites the remote: the only remote writes are the push daemon's fast-forward pushes and the conflict branch.

### `repo.isAncestor(a, b)`

`true` when commit `a` is reachable from commit `b` (or `a == b`). The short-circuit consumers use before a sync or a hot reload ("do I already have this commit?"). `RefError` (`ref_not_found`) if either does not resolve to a commit.

This was [#301](https://github.com/JarvusInnovations/gitsheets/issues/301): a consumer with a push daemon *and* an external writer hand-rolled all of the above in ~500 lines of plumbing; the outcome vocabulary is that module's, kept so its logs and alerts carry over.

## Lifecycle

```text
1. Consumer calls repo.startPushDaemon(opts) → PushDaemon handle
2. Daemon registers a listener for ref-update events (or polls; impl detail)
3. On each new commit produced by `repo.transact`:
     - Add to push queue
     - Attempt push immediately
     - On success: emit 'push' event
     - On failure: schedule retry with backoff; emit 'error' / 'retry' events
4. Consumer optionally inspects daemon.status() at any time
5. Consumer calls daemon.stop() at shutdown:
     - Stop accepting new commits to the queue
     - Drain in-flight retries (with a configurable timeout)
     - Resolve daemon.stop()'s Promise
```

## Push command

The underlying operation is `git push <remote> <branch>` with no `--force`. **Regular fast-forward only.**

If the remote rejects the push (non-fast-forward, "remote contains work that you do not have"), the daemon does not retry — it emits an `error` event with `reason: 'non-fast-forward'` and surfaces a hard error in `daemon.status()` (also with `lastError.reason === 'non-fast-forward'`). The consumer needs to intervene; a never-force-push policy is non-negotiable.

The daemon does *not* attempt to merge or rebase. The local commit history is the source of truth.

Subsequent `repo.transact` commits will trigger fresh push attempts. If the remote is still ahead, those attempts also fail and emit their own `non-fast-forward` errors — each commit gets one classified error, never a retry storm.

## Backoff

Default: exponential, base 1 second, multiplier 2, cap 1 hour.

| Attempt | Delay |
| --- | --- |
| 1 | 1s |
| 2 | 2s |
| 3 | 4s |
| 4 | 8s |
| 5 | 16s |
| ... | ... |
| Stable max | 3600s |

Configurable:

```typescript
repo.startPushDaemon({
  remote: 'origin',
  backoff: { base: 5000, multiplier: 1.5, cap: 1800_000 },  // 5s base, 30min cap
  maxRetries: 100,
});
```

Or accept the default with `backoff: 'exponential'`.

`maxRetries` defaults to `Infinity` — the daemon keeps retrying until success, or until `daemon.stop()` is called.

## Events

```typescript
daemon.on('push',  ({ commit, durationMs }) => { ... });
daemon.on('retry', ({ commit, attempt, nextDelayMs, reason }) => { ... });
daemon.on('error', ({ commit, err, attempt, reason }) => { ... });
daemon.on('stopped', () => { ... });
```

- `push` — successful push. `durationMs` is wall-clock for the push attempt.
- `retry` — a failed attempt has been scheduled for retry. Fires *before* the delay. `reason` mirrors the upstream `error`'s classification.
- `error` — a failure occurred. `reason` is one of:
  - `'non-fast-forward'` — terminal. No `retry` event follows. Status' `lastError.reason` carries the same value.
  - `'unknown'` — anything else (network, auth, transient git errors). Retried per the configured backoff unless `maxRetries` is exhausted.
- `stopped` — emitted after `daemon.stop()` completes draining.

For startup-backlog errors (see "Startup backlog" below) the `commit` field is `null` and `attempt` is `0`; the failure surfaces through the same `error` event channel.

Consumers building observability surfaces typically attach to `push`, `retry`, `error` for Prometheus / structured-logging fan-out.

## Status

```typescript
daemon.status();
// → {
//   running: boolean,
//   lastPushAt: ISO 8601 | null,
//   lastError: {
//     message: string,
//     at: ISO 8601,
//     attempt: number,
//     reason: 'non-fast-forward' | 'unknown',
//   } | null,
//   pendingCommits: number,
//   currentBackoffMs: number | null,        // current delay, if a retry is scheduled
//   currentAttempt: number | null,           // which attempt we're on for the next commit
// }
```

Cheap to call — no I/O, just in-memory snapshot.

## Stopping

```typescript
await daemon.stop({ timeoutMs?: 30_000 });
```

- Stops accepting new commits
- Waits for the currently-in-flight push (if any) to complete or fail
- Drains the retry queue up to `timeoutMs` (default 30s)
- After the timeout, abandons remaining queued commits — they remain in the local repo and can be retried by restarting the daemon
- Resolves once the daemon is fully idle

`daemon.stop()` is the only correct way to end the daemon. Letting the process exit while the daemon is running may leave commits unpushed.

## Authentication

**Out of scope for the daemon.** The daemon runs `git push` and inherits the process's git auth configuration:

- SSH: `GIT_SSH_COMMAND`, ssh-agent, `~/.ssh/config`
- HTTPS: git credential helper, env-injected token in the remote URL
- GitHub App: token via credential helper (`gh auth setup-git` or equivalent)

The library doesn't know what credentials are in play. If a `git push` fails authentication, the daemon emits an `error` event with the underlying git stderr — the consumer decides whether that's recoverable.

For container deployments, common patterns:

- **Deploy key (SSH):** mount the private key, configure `GIT_SSH_COMMAND='ssh -i /run/secrets/deploy-key -o StrictHostKeyChecking=accept-new'`
- **GitHub App:** an init container or sidecar refreshes a short-lived token and writes a `.git-credentials` file
- **HTTPS PAT:** simplest; embed in the remote URL (avoid logging) or use a credential helper

## Idempotency

Pushing a commit that's already on the remote is a no-op (`Everything up-to-date`). Push attempts are safe to retry.

If the daemon restarts and finds commits in the local repo that aren't on the remote, it pushes them. The daemon doesn't track a "pending" state across restarts — it diffs local vs. remote on startup and queues anything ahead.

## Startup backlog

`repo.startPushDaemon` returns the handle synchronously to the caller, then performs the startup-backlog check on the next event-loop tick (so consumers can attach `error` / `push` listeners first):

1. `git fetch <remote> <branch>` — best-effort, populates `refs/remotes/<remote>/<branch>`. If this fails (unreachable remote, auth) the daemon emits an `error` event with `commit: null`, `attempt: 0`, classified `reason`. The check continues — a previously-cached remote-tracking ref may still be usable.
2. `git rev-list --count <remote>/<branch>..<branch>` — counts local commits the remote doesn't have. If the remote-tracking ref doesn't exist after the fetch (e.g., the branch was never on the remote), the check exits silently; the daemon stays alive for future `notifyCommit` events.
3. If the count is non-zero, the daemon primes its pending counter and immediately drains — the queued commits flow through the same push pipeline as live ones.

The startup check **never throws**. The consumer's `await repo.startPushDaemon(opts)` resolves with the handle even when the remote is unreachable; observability comes through `error` events and `daemon.status()`.

## Push frequency

The daemon pushes once per commit by default. For high-frequency commit workloads, this can be wasteful — a `debounceMs` option may be added later to coalesce multiple commits into a single push (still all individual commits, just a single network round-trip). Out of scope for v1.0.

## Multiple daemons

A `Repository` can host at most one push daemon at a time. `repo.startPushDaemon(...)` while one is already running throws `TransactionError` (`push_daemon_running`). Stop the existing one first.

A daemon is bound to a single `(remote, branch)` pair. To push the same commits to two remotes, run two daemons in two `Repository` instances (or feature-request a multi-remote daemon if a consumer needs it).

## Coordinates with

- [api/repository.md](../api/repository.md)
- [api/transaction.md](../api/transaction.md)
- [GitHub #132](https://github.com/JarvusInnovations/gitsheets/issues/132) — implementation issue
