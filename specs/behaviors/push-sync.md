# Behavior: Push Sync

## Rule

A `Repository` can run an optional **push daemon** that asynchronously pushes new commits to a configured git remote, with retry and exponential backoff. Push-only — the daemon never pulls.

## Applies To

- [api/repository.md](../api/repository.md) — `repo.startPushDaemon(opts)`
- [api/transaction.md](../api/transaction.md) — commits produced by `repo.transact` are what the daemon pushes

## Why push-only

A consumer process that writes to gitsheets is the *single writer* (see [behaviors/transactions.md](transactions.md)). Pulling from the remote at runtime would risk overwriting in-memory state and unstaged tree changes — neither is recoverable cleanly.

If a consumer needs to incorporate changes from elsewhere (a manual edit, a separate process), the canonical path is: stop the consumer, pull, restart. The library does not automate this.

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

If the remote rejects the push (non-fast-forward, "remote contains work that you do not have"), the daemon does not retry — it emits an `error` event and surfaces a hard error in `daemon.status()`. The consumer needs to intervene; a never-force-push policy is non-negotiable.

The daemon does *not* attempt to merge or rebase. The local commit history is the source of truth.

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
daemon.on('retry', ({ commit, attempt, nextDelayMs }) => { ... });
daemon.on('error', ({ commit, err, attempt }) => { ... });
daemon.on('stopped', () => { ... });
```

- `push` — successful push. `durationMs` is wall-clock for the push attempt.
- `retry` — a failed attempt has been scheduled for retry. Fires *before* the delay.
- `error` — a failure occurred. May or may not be retried; if retried, a `retry` event follows.
- `stopped` — emitted after `daemon.stop()` completes draining.

Consumers building observability surfaces typically attach to `push`, `retry`, `error` for Prometheus / structured-logging fan-out.

## Status

```typescript
daemon.status();
// → {
//   running: boolean,
//   lastPushAt: ISO 8601 | null,
//   lastError: { message: string, at: ISO 8601, attempt: number } | null,
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

## Push frequency

The daemon pushes once per commit by default. For high-frequency commit workloads, this can be wasteful — a `debounceMs` option may be added later to coalesce multiple commits into a single push (still all individual commits, just a single network round-trip). Out of scope for v1.0.

## Multiple daemons

A `Repository` can host at most one push daemon at a time. `repo.startPushDaemon(...)` while one is already running throws `TransactionError` (`push_daemon_running`). Stop the existing one first.

A daemon is bound to a single `(remote, branch)` pair. To push the same commits to two remotes, run two daemons in two `Repository` instances (or feature-request a multi-remote daemon if a consumer needs it).

## Coordinates with

- [api/repository.md](../api/repository.md)
- [api/transaction.md](../api/transaction.md)
- [GitHub #132](https://github.com/JarvusInnovations/gitsheets/issues/132) — implementation issue
