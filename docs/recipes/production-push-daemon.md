# Production push daemon

Pattern: a long-running consumer process (web service, worker) holds an open `Repository` and runs a background push daemon that ships commits to a remote with retry/backoff. Push-only — the daemon never pulls.

## Why push-only

A consumer that writes to gitsheets is the **single writer** for the repo. Pulling from a remote at runtime would risk overwriting in-memory state and unstaged mutations — there's no good recovery. The daemon's contract is: take commits the consumer produces, get them to the remote, retry on transient failures, surface hard failures for human intervention.

If a consumer needs to incorporate external changes (a manual edit, a separate process), the canonical path is: stop the consumer, pull, restart.

## Start it

```typescript
import { openRepo } from 'gitsheets';

const repo = await openRepo();
const daemon = await repo.startPushDaemon({
  remote: 'origin',
  branch: 'main',                  // default: HEAD's branch
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

The right intervention: stop the consumer, investigate the remote (something else committed to your branch), reconcile (rebase or merge), restart.

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
