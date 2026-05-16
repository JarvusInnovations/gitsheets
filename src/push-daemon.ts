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

export interface PushDaemonStatus {
  readonly running: boolean;
  readonly lastPushAt: string | null;
  readonly lastError: { message: string; at: string; attempt: number } | null;
  readonly pendingCommits: number;
  readonly currentBackoffMs: number | null;
  readonly currentAttempt: number | null;
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
  #lastError: { message: string; at: string; attempt: number } | null = null;
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
        const message = err instanceof Error ? err.message : String(err);
        this.#lastError = { message, at: new Date().toISOString(), attempt };
        this.emit('error', { commit, err, attempt });
        if (attempt >= this.#maxRetries) {
          // Give up on this batch; drop the counter forward so we don't loop forever.
          this.#lastPushedCounter = counterAtStart;
          return;
        }
        const next = Math.min(delay, this.#backoff.cap);
        this.#currentBackoffMs = next;
        this.emit('retry', { commit, attempt, nextDelayMs: next });
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
