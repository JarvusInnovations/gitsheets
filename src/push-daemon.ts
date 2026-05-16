// Push daemon — async push-to-remote with retry/backoff.
// See specs/behaviors/push-sync.md and specs/api/repository.md.

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface BackoffConfig {
  /** Initial delay in ms; default 1000. */
  readonly base: number;
  /** Multiplier each attempt; default 2. */
  readonly multiplier: number;
  /** Max delay in ms; default 3_600_000 (1 hour). */
  readonly cap: number;
}

export interface PushDaemonOptions {
  /** Git remote name (e.g., 'origin'). Required. */
  readonly remote: string;
  /** Branch to push; default the repo's current HEAD branch. */
  readonly branch?: string;
  /** Retry backoff configuration; default exponential. */
  readonly backoff?: 'exponential' | BackoffConfig;
  /** Max retry attempts per commit batch; default Infinity. */
  readonly maxRetries?: number;
}

/**
 * Reason a push attempt failed.
 * - `non-fast-forward`: remote has work the local doesn't — terminal, never
 *   retried (no-force-push policy; consumer must intervene).
 * - `unknown`: everything else (network, auth, transient git errors) — retried
 *   per the configured backoff.
 */
export type PushFailureReason = 'non-fast-forward' | 'unknown';

export interface PushDaemonStatus {
  readonly running: boolean;
  readonly lastPushAt: string | null;
  readonly lastError: {
    message: string;
    at: string;
    attempt: number;
    reason: PushFailureReason;
  } | null;
  readonly pendingCommits: number;
  readonly currentBackoffMs: number | null;
  readonly currentAttempt: number | null;
}

/**
 * Inspect a thrown `git push` (or `git fetch`) error and decide whether it's a
 * terminal non-fast-forward rejection. Looks at stderr; the markers
 * (`! [rejected]` plus `non-fast-forward` or `fetch first`) are stable across
 * modern git versions.
 */
function classifyPushFailure(err: unknown): PushFailureReason {
  let stderr = '';
  if (err && typeof err === 'object') {
    const obj = err as { stderr?: unknown; message?: unknown };
    if (typeof obj.stderr === 'string') stderr = obj.stderr;
    else if (typeof obj.message === 'string') stderr = obj.message;
  } else if (typeof err === 'string') {
    stderr = err;
  }
  if (/!\s*\[rejected\]/.test(stderr) && /(non-fast-forward|fetch first)/i.test(stderr)) {
    return 'non-fast-forward';
  }
  return 'unknown';
}

export class PushDaemon extends EventEmitter {
  readonly #gitDir: string;
  readonly #remote: string;
  readonly #branch: string;
  readonly #backoff: BackoffConfig;
  readonly #maxRetries: number;

  #running = true;
  #stopResolve: (() => void) | null = null;
  #pendingCounter = 0;
  #lastPushedCounter = 0;
  #lastCommit: string | null = null;
  #lastPushAt: string | null = null;
  #lastError: {
    message: string;
    at: string;
    attempt: number;
    reason: PushFailureReason;
  } | null = null;
  #currentAttempt: number | null = null;
  #currentBackoffMs: number | null = null;
  #inFlight = false;
  #pendingTimer: NodeJS.Timeout | null = null;

  constructor(opts: {
    gitDir: string;
    remote: string;
    branch: string;
    backoff: BackoffConfig;
    maxRetries: number;
  }) {
    super();
    this.#gitDir = opts.gitDir;
    this.#remote = opts.remote;
    this.#branch = opts.branch;
    this.#backoff = opts.backoff;
    this.#maxRetries = opts.maxRetries;
  }

  /** Repository invokes this after each successful transact commit. */
  notifyCommit(commitHash: string): void {
    if (!this.#running) return;
    this.#pendingCounter++;
    this.#lastCommit = commitHash;
    void this.#drain();
  }

  /**
   * @internal — Called by Repository.startPushDaemon shortly after the daemon
   * is handed back to the consumer (deferred via setImmediate so listeners can
   * attach first).
   *
   * Fetches the configured remote/branch, counts local commits ahead of the
   * remote-tracking ref, and primes the pending queue if any exist. Failures
   * surface as a standard `error` event but never throw — startup must not be
   * able to crash the consumer process.
   *
   * See specs/behaviors/push-sync.md#startup-backlog.
   */
  async checkStartupBacklog(): Promise<void> {
    if (!this.#running) return;
    try {
      // Best-effort fetch to populate refs/remotes/<remote>/<branch>. If it
      // fails (unreachable remote, auth, etc.) we emit an error event but
      // continue — rev-list may still resolve against a previously-cached
      // remote-tracking ref.
      try {
        await exec('git', ['fetch', this.#remote, this.#branch], { cwd: this.#gitDir });
      } catch (err) {
        const reason = classifyPushFailure(err);
        const message = err instanceof Error ? err.message : String(err);
        this.#lastError = { message, at: new Date().toISOString(), attempt: 0, reason };
        this.emit('error', { commit: null, err, attempt: 0, reason });
      }

      // Count commits on local <branch> not yet on <remote>/<branch>.
      let ahead = 0;
      try {
        const range = `${this.#remote}/${this.#branch}..${this.#branch}`;
        const { stdout } = await exec('git', ['rev-list', '--count', range], {
          cwd: this.#gitDir,
        });
        const parsed = parseInt(stdout.trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) ahead = parsed;
      } catch {
        // Remote-tracking ref missing (never fetched, no branch on remote, …).
        // Don't escalate — the daemon will pick up new commits via
        // notifyCommit and any push will sort out a divergent state.
        return;
      }

      if (ahead > 0) {
        let headCommit: string | null = null;
        try {
          const { stdout } = await exec('git', ['rev-parse', this.#branch], {
            cwd: this.#gitDir,
          });
          headCommit = stdout.trim() || null;
        } catch {
          /* keep null */
        }
        this.#pendingCounter += ahead;
        if (headCommit) this.#lastCommit = headCommit;
        void this.#drain();
      }
    } catch {
      // Defense-in-depth: never let startup crash.
    }
  }

  status(): PushDaemonStatus {
    return {
      running: this.#running,
      lastPushAt: this.#lastPushAt,
      lastError: this.#lastError,
      pendingCommits: Math.max(0, this.#pendingCounter - this.#lastPushedCounter),
      currentBackoffMs: this.#currentBackoffMs,
      currentAttempt: this.#currentAttempt,
    };
  }

  /**
   * Stop accepting new commits, drain in-flight retries up to `timeoutMs`,
   * resolve once idle. Idempotent.
   */
  async stop(opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    if (!this.#running) return;
    this.#running = false;
    if (this.#pendingTimer) {
      clearTimeout(this.#pendingTimer);
      this.#pendingTimer = null;
    }

    if (this.#inFlight) {
      await new Promise<void>((resolve) => {
        this.#stopResolve = resolve;
        const t = setTimeout(() => {
          this.#stopResolve = null;
          resolve();
        }, timeoutMs);
        // Ensure we don't keep the process alive
        t.unref?.();
      });
    }

    this.emit('stopped');
  }

  async #drain(): Promise<void> {
    if (this.#inFlight || !this.#running) return;
    if (this.#pendingCounter <= this.#lastPushedCounter) return;
    this.#inFlight = true;
    try {
      await this.#pushWithBackoff();
    } finally {
      this.#inFlight = false;
      this.#currentAttempt = null;
      this.#currentBackoffMs = null;
      const stopResolve = this.#stopResolve;
      if (stopResolve) {
        this.#stopResolve = null;
        stopResolve();
      } else if (this.#running && this.#pendingCounter > this.#lastPushedCounter) {
        // More commits arrived during the push; chain another drain.
        void this.#drain();
      }
    }
  }

  async #pushWithBackoff(): Promise<void> {
    let attempt = 0;
    let delay = this.#backoff.base;
    const counterAtStart = this.#pendingCounter;
    const commit = this.#lastCommit;

    while (this.#running) {
      attempt++;
      this.#currentAttempt = attempt;
      this.#currentBackoffMs = null;
      const started = Date.now();
      try {
        await exec('git', ['push', this.#remote, this.#branch], { cwd: this.#gitDir });
        this.#lastPushedCounter = counterAtStart;
        this.#lastPushAt = new Date().toISOString();
        this.emit('push', { commit, durationMs: Date.now() - started });
        return;
      } catch (err) {
        const reason = classifyPushFailure(err);
        const message = err instanceof Error ? err.message : String(err);
        this.#lastError = { message, at: new Date().toISOString(), attempt, reason };
        this.emit('error', { commit, err, attempt, reason });
        if (reason === 'non-fast-forward') {
          // Terminal: never retry NFF. Advance the counter so future commits
          // get a fresh push attempt (which may also fail, but each gets its
          // own classified error event). Consumer intervention is required —
          // the no-force-push policy is non-negotiable.
          this.#lastPushedCounter = counterAtStart;
          return;
        }
        if (attempt >= this.#maxRetries) {
          // Give up on this batch; drop the counter forward so we don't loop forever.
          this.#lastPushedCounter = counterAtStart;
          return;
        }
        const next = Math.min(delay, this.#backoff.cap);
        this.#currentBackoffMs = next;
        this.emit('retry', { commit, attempt, nextDelayMs: next, reason });
        await this.#sleep(next);
        delay = Math.min(delay * this.#backoff.multiplier, this.#backoff.cap);
      }
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.#pendingTimer = t;
      t.unref?.();
    });
  }
}

export function resolveBackoff(opt: PushDaemonOptions['backoff']): BackoffConfig {
  if (!opt || opt === 'exponential') {
    return { base: 1000, multiplier: 2, cap: 3_600_000 };
  }
  return opt;
}
