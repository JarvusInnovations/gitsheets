# Production push daemon

Pattern: a long-running consumer process (web service, worker) holds an open `Repository` and runs a background push daemon that ships commits to a remote with retry/backoff. Push-only — the daemon never pulls. Taking in commits from elsewhere is a separate, explicit call: [`repo.sync()`](#taking-in-other-writers-commits-reposync) below.

## Why the daemon is push-only

A consumer that writes to gitsheets is the **single writer** for the repo. A daemon that pulled on its own schedule would move the branch underneath open transactions and standing sheets — there's no good recovery. The daemon's contract is: take commits the consumer produces, get them to the remote, retry on transient failures, surface hard failures for human intervention.

Incorporating external changes (an importer, a person pushing to the data repo, a separate process) is the consumer's decision about *when*: at boot, from a webhook, on a timer. That is `repo.sync()`, and it runs under the same write lock as `transact`, so nothing commits or reads a half-moved ref while it works.

## Start it

```typescript
import { openRepo } from 'gitsheets';

const repo = await openRepo();
const daemon = await repo.startPushDaemon({
  remote: 'origin',
  branch: 'main',                  // default: the repo's default branch
  backoff: 'exponential',          // default: 1s base, ×2 each retry, cap 1h
  maxRetries: Infinity,            // default: never give up unless stopped
});
```

After this, every commit produced by `repo.transact` triggers a push attempt asynchronously. Your transact calls return as soon as the local commit lands; the push happens in the background.

## Configure backoff

The default exponential backoff (1s → 2s → 4s → … → 1h cap) is reasonable. To tune:

```typescript
const daemon = await repo.startPushDaemon({
  remote: 'origin',
  backoff: {
    base: 5_000,         // 5s initial delay
    multiplier: 1.5,     // 1.5× per retry
    cap: 1_800_000,      // 30min cap
  },
  maxRetries: 100,
});
```

`maxRetries: Infinity` keeps the daemon retrying forever (with backoff). For systems that should surface hard failures to humans, set a finite number.

## Observe what's happening

The daemon is an `EventEmitter`:

```typescript
daemon.on('push', ({ commit, durationMs }) => {
  log.info({ commit, durationMs }, 'pushed');
});

daemon.on('retry', ({ commit, attempt, nextDelayMs, reason }) => {
  log.info({ commit, attempt, nextDelayMs, reason }, 'push retry scheduled');
});

daemon.on('error', ({ commit, err, attempt, reason }) => {
  // `reason: 'non-fast-forward'` means the remote has work this daemon
  // doesn't — page someone. The daemon will *not* retry it; pushing the same
  // commit again would just re-fail. Future commits still trigger fresh
  // attempts (each producing its own classified error).
  log.warn({ commit, err: String(err), attempt, reason }, 'push failed');
});

daemon.on('stopped', () => {
  log.info('push daemon stopped');
});
```

For metrics / dashboards:

```typescript
const status = daemon.status();
// {
//   running: boolean,
//   lastPushAt: ISO 8601 | null,
//   lastError: { message, at, attempt, reason: 'non-fast-forward' | 'unknown' } | null,
//   pendingCommits: number,
//   currentBackoffMs: number | null,
//   currentAttempt: number | null,
// }
```

Poll `status()` from a `/healthz` or `/metrics` endpoint. It's cheap (no I/O).

A Prometheus-style integration:

```typescript
import { Gauge, Counter } from 'prom-client';

const pendingGauge = new Gauge({
  name: 'gitsheets_push_pending',
  help: 'commits waiting to push',
});
const pushedCounter = new Counter({
  name: 'gitsheets_push_total',
  help: 'commits successfully pushed',
});
const errorCounter = new Counter({
  name: 'gitsheets_push_errors_total',
  help: 'push errors',
});

daemon.on('push', () => pushedCounter.inc());
daemon.on('error', () => errorCounter.inc());

setInterval(() => {
  pendingGauge.set(daemon.status().pendingCommits);
}, 5_000);
```

## Authentication

**Out of scope for the daemon.** It runs `git push` and inherits whatever auth the surrounding environment provides. Pick one of:

### SSH (recommended for servers)

Mount a deploy key, set `GIT_SSH_COMMAND`:

```bash
export GIT_SSH_COMMAND='ssh -i /run/secrets/deploy-key -o StrictHostKeyChecking=accept-new'
```

The remote URL must be SSH-form: `git@github.com:org/repo.git`. The daemon doesn't care — `git push` handles it.

### HTTPS with a PAT

Embed the token in the remote URL (set during `git remote add origin` or in `.git/config`):

```text
[remote "origin"]
    url = https://x-access-token:ghp_xxxx@github.com/org/repo.git
```

Or use a credential helper. **Don't log the URL** — it contains the secret.

### GitHub App with short-lived tokens

An init container or sidecar refreshes the token periodically and writes it to a credential helper file. The daemon picks up the new token on its next push.

## Stop gracefully at shutdown

Always call `daemon.stop()` before the process exits. `process.exit()` mid-push leaves commits unpushed (they stay in the local repo, but the remote misses them until the next daemon start).

```typescript
import process from 'node:process';

async function shutdown() {
  log.info('shutting down...');
  try {
    await daemon.stop({ timeoutMs: 30_000 });
  } catch (err) {
    log.error({ err }, 'daemon.stop failed');
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

`stop()`:

1. Stops accepting new commits to the queue
2. Waits for the in-flight push to complete or fail
3. Drains the retry queue up to `timeoutMs` (default 30s)
4. After the timeout, abandons remaining queued commits — they stay in the local repo and are picked up on the next daemon start via the startup-backlog check
5. Resolves once the daemon is fully idle

For Kubernetes / Docker, set `terminationGracePeriodSeconds` to at least `timeoutMs` + a safety margin so the orchestrator doesn't SIGKILL mid-drain.

## Non-fast-forward rejections

When the remote contains work the daemon doesn't (a fast-forward isn't possible), the push fails and the daemon classifies it as terminal:

- Exactly one `error` event fires with `reason: 'non-fast-forward'`.
- **No `retry` event follows.** The daemon never force-pushes; pushing the same commit again would just re-fail.
- `daemon.status().lastError.reason` carries `'non-fast-forward'` so health checks / alerting can branch on it.
- Subsequent `repo.transact` commits still trigger fresh push attempts. Each will also fail with `non-fast-forward` (and emit its own event) until the remote state is reconciled.

The right intervention is a `repo.sync()` (below): it fetches, replays your local commits onto the remote tip, and hands the new tip back to the daemon — or, if the replay conflicts, preserves your local history on a `conflicts/<timestamp>` branch for an operator and adopts the remote. Stop-pull-restart still works, but it is no longer the only option.

```typescript
daemon.on('error', ({ reason, err }) => {
  if (reason === 'non-fast-forward') {
    // page on-call; do not auto-restart
    alerts.send({ severity: 'critical', message: 'push rejected — remote diverged' });
  } else {
    log.warn({ err: String(err) }, 'transient push failure');
  }
});
```

## Taking in other writers' commits: `repo.sync()`

When something else also pushes to your branch — an importer, a person committing to the data repo, a second service — bring the local branch up to date with an explicit sync (v2.8+):

```typescript
const result = await repo.sync({
  remote: 'origin',               // default
  branch: 'main',                 // default: HEAD's branch
  onConflict: 'preserve-branch',  // default 'fail'
});

switch (result.outcome) {
  case 'in-sync':          // nothing to do
  case 'fast-forwarded':   // remote had new commits; the branch moved, live sheets rebound
  case 'ahead':            // only local commits; the running daemon was handed the tip
  case 'rebased':          // both sides had commits; yours were replayed on top (author/message kept)
  case 'conflict':         // onConflict: 'fail' — nothing moved; result.conflictCommit names the culprit
  case 'conflict-escaped': // onConflict: 'preserve-branch' — local history kept on result.conflictBranch
                           // (pushed best-effort), branch reset to the remote tip
  case 'fetch-failed':     // network/auth; nothing moved; result.fetchError
}
```

- The fetch runs **outside** the write lock (a slow network never blocks writes); classification and ref movement run **inside** it, in the core, with no working tree and nothing to abort. A conflict stops the replay before any ref moves.
- When the synced branch is the one `HEAD` points at, every live sheet is rebound before `sync` resolves — the same auto-refresh a commit does.
- `ahead` / `rebased` tips are handed to a running daemon via its normal path; `sync` never pushes the branch itself and never force-pushes anything.
- Call it at boot before the daemon starts (so a `non-fast-forward` at startup is reconciled rather than alerted on), from a hot-reload webhook, or on a timer. `repo.isAncestor(remoteTip, localTip)` is the cheap "do I already have this?" check before a webhook-triggered sync.
- `sync` inside a `transact` handler or a `withLock` callback throws `TransactionError('lock_held')`. For a hot reload that must rebuild in-memory state with no transaction in between, pass `afterMove` — it runs under the lock after the move and the rebind:

  ```typescript
  await repo.sync({
    onConflict: 'preserve-branch',
    afterMove: async (result) => {
      await rebuildInMemoryState(); // no transaction can commit until this returns
    },
  });
  ```

- `repo.fetch()` runs just the fetch step (outside any lock, failure as a value); follow it with `repo.sync({ fetch: false })`.

For a full record-level merge of two branches (an import branch into the served branch, with canonical output and a conflict policy), see `repo.merge` in the [API reference](../api.md#repository) and `git sheet merge` in the [CLI reference](../cli.md#gitsheets-merge-theirs); `gitsheets merge --install-driver` makes plain `git merge` do the same.

## Multi-remote replication (still external)

A `Repository` can host one push daemon at a time, and post-commit notifications fire only on the `Repository` instance that ran the `transact` — so a second `Repository` opened against the same `gitDir` wouldn't see live commits via the in-process hook. The startup-backlog check runs *once* per daemon (at start), so a long-lived second daemon won't catch up on commits made after it started.

In-process multi-remote replication isn't the right pattern. For a backup remote, drive it externally: an external scheduler triggering `git push backup main`, or a server-side hook on the primary that mirrors to the backup.

What the startup-backlog *does* unlock: if your process restarts (intentional deploy, crash, OOM kill) with commits ahead of the remote, the new daemon pushes them on startup without needing an explicit `repo.transact` to nudge it.

## A complete production setup

```typescript
// src/store.ts
import { openRepo, openStore, type PushDaemon } from 'gitsheets';
import { z } from 'zod';
import { log } from './log.js';

const UserSchema = z.object({ slug: z.string(), email: z.string().email() });

export const repo = await openRepo();
export const store = await openStore(repo, {
  validators: { users: UserSchema },
});

export let pushDaemon: PushDaemon | null = null;

if (process.env.PUSH_REMOTE) {
  pushDaemon = await repo.startPushDaemon({
    remote: process.env.PUSH_REMOTE,
    backoff: 'exponential',
    maxRetries: Infinity,
  });
  pushDaemon.on('push',  ({ commit, durationMs }) => log.info({ commit, durationMs }, 'pushed'));
  pushDaemon.on('error', ({ err, attempt, reason }) => {
    log.warn({ err: String(err), attempt, reason }, 'push failed');
    if (reason === 'non-fast-forward') alerts.page({ message: 'gitsheets remote diverged' });
  });
  pushDaemon.on('retry', ({ attempt, nextDelayMs, reason }) => log.info({ attempt, nextDelayMs, reason }, 'push retry'));
  log.info({ remote: process.env.PUSH_REMOTE }, 'push daemon started');
}

// graceful shutdown
async function shutdown(signal: string) {
  log.info({ signal }, 'shutdown requested');
  if (pushDaemon) {
    try {
      await pushDaemon.stop({ timeoutMs: 30_000 });
    } catch (err) {
      log.error({ err }, 'pushDaemon.stop failed');
    }
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

## See also

- [Concepts: Push daemon](../concepts.md#push-daemon)
- [`specs/behaviors/push-sync.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/push-sync.md) — full contract
- [Issue #156](https://github.com/JarvusInnovations/gitsheets/issues/156) — non-FF detection (v1.x)
- [Issue #157](https://github.com/JarvusInnovations/gitsheets/issues/157) — startup-diff (v1.x)
