// Transaction — scopes a set of sheet mutations to a single commit.
// See specs/api/transaction.md + specs/behaviors/transactions.md.
//
// The transaction state machine (parent/branch resolution, the private tree,
// commit-on-success with no-op detection + optimistic `parent_moved` re-check +
// CAS ref movement, and commit-message/trailer formatting) all live in the Rust
// core, driven through the `CoreTransaction` napi class. This JS wrapper keeps
// the host-runtime concerns the core deliberately leaves out: the in-process
// single-writer mutex/queue, the `AsyncLocalStorage` nested-transaction guard,
// git-config author resolution, and post-commit hooks.

import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CoreTransaction, callCore } from './core.js';
import { RefError, TransactionError } from './errors.js';
import type { RecordLike } from './path-template/index.js';
import type { Sheet } from './sheet.js';
import type { StandardSchemaV1 } from './validation.js';

const exec = promisify(execFile);

export interface Author {
  readonly name: string;
  readonly email: string;
}

export interface TransactionOptions {
  /** Ref name or commit hash to parent the commit on; defaults to current HEAD. */
  readonly parent?: string;
  /** Ref name to update on commit; default: parent if it's a branch, null if a hash. */
  readonly branch?: string;
  /** Commit author; defaults to git config user.name/email. */
  readonly author?: Author;
  /** Commit committer; defaults to author. */
  readonly committer?: Author;
  /** Commit subject + body. First line is the subject. */
  readonly message: string;
  /** Git-style trailers appended per `git interpret-trailers`. */
  readonly trailers?: Readonly<Record<string, string>>;
}

export interface TransactionResult<T> {
  readonly value: T;
  readonly commitHash: string | null;
  readonly treeHash: string | null;
  readonly ref: string | null;
  readonly parentCommitHash: string | null;
}

export type TransactionHandler<T> = (tx: Transaction) => Promise<T>;

// Active transaction context — used to detect nested repo.transact attempts.
export const transactionContext = new AsyncLocalStorage<Transaction>();

const HTTP_HEADER_KEY_RE = /^[A-Z][a-z0-9]*(-[A-Z][a-z0-9]*)*$|^[A-Z][a-z]+$/;
const TRAILER_VALUE_RE = /[\r\n]/;

function validateTrailers(trailers: Readonly<Record<string, string>> | undefined): void {
  if (!trailers) return;
  for (const [key, value] of Object.entries(trailers)) {
    if (!HTTP_HEADER_KEY_RE.test(key)) {
      throw new TransactionError(
        'commit_failed',
        `trailer key ${JSON.stringify(key)} does not match HTTP-header style (e.g., "Subject-Id", "Action")`,
      );
    }
    if (typeof value !== 'string' || TRAILER_VALUE_RE.test(value)) {
      throw new TransactionError(
        'commit_failed',
        `trailer ${JSON.stringify(key)} has invalid value (must be string with no newlines): ${JSON.stringify(value)}`,
      );
    }
  }
}

/**
 * In-process mutex serializing transactions on a single Repository.
 * Concurrent callers from independent async contexts queue; nested
 * repo.transact attempts (same async context) throw before acquiring.
 *
 * The core exposes a *throwing* per-repo single-writer slot; this queue is the
 * host-runtime half that lets independent async callers wait rather than fail.
 */
export class Mutex {
  #locked = false;
  #queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.#locked) {
      this.#locked = true;
      return () => this.#release();
    }
    return new Promise<() => void>((resolve) => {
      this.#queue.push(() => resolve(() => this.#release()));
    });
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) {
      next();
    } else {
      this.#locked = false;
    }
  }
}

export class Transaction {
  readonly #coreTx: CoreTransaction;
  readonly #gitDir: string;
  readonly #parentCommitHash: string | null;
  /** Function the Repository injects so Transaction.sheet() can build Sheet instances. */
  readonly #sheetFactory: <T extends RecordLike = RecordLike>(
    name: string,
    tx: Transaction,
    validator?: StandardSchemaV1<unknown, T>,
    prefix?: string,
  ) => Sheet<T>;
  /** Sheet names already opened in the core transaction (open-once per name). */
  readonly #openedSheets = new Set<string>();
  #closed = false;

  /**
   * @internal — Transactions are created by Repository.transact (or
   * Store.transact). Consumers do not construct Transaction directly; the
   * constructor is exported only so the type is available for typing
   * handler parameters.
   */
  constructor(opts: {
    coreTx: CoreTransaction;
    gitDir: string;
    sheetFactory: <T extends RecordLike = RecordLike>(
      name: string,
      tx: Transaction,
      validator?: StandardSchemaV1<unknown, T>,
      prefix?: string,
    ) => Sheet<T>;
  }) {
    this.#coreTx = opts.coreTx;
    this.#gitDir = opts.gitDir;
    this.#sheetFactory = opts.sheetFactory;
    this.#parentCommitHash = callCore(() => this.#coreTx.parentCommitHash()) ?? null;
  }

  /** @internal — the underlying core transaction the tx-bound Sheet drives. */
  get coreTx(): CoreTransaction {
    return this.#coreTx;
  }

  get gitDir(): string {
    return this.#gitDir;
  }

  get parentCommitHash(): string | null {
    return this.#parentCommitHash;
  }

  /**
   * @internal — Ensure the named sheet is opened in the core transaction (config
   * read + template/schema/comparators compiled once). Opened once per name.
   */
  openCoreSheet(name: string, configPath: string, prefix: string): void {
    if (this.#openedSheets.has(name)) return;
    callCore(() => this.#coreTx.openSheet(name, configPath, '.', prefix));
    this.#openedSheets.add(name);
  }

  /**
   * Returns a Sheet whose writes route through this transaction's private tree.
   *
   * - `opts.validator` (optional) attaches a Standard Schema validator — used
   *   by Store.transact to thread per-sheet validators through to tx scope.
   * - `opts.prefix` (optional) scopes records to a sub-prefix under the
   *   sheet's `config.root`. Used by the CLI `--prefix` flag.
   */
  sheet<T extends RecordLike = RecordLike>(
    name: string,
    opts?: { validator?: StandardSchemaV1<unknown, T>; prefix?: string },
  ): Sheet<T> {
    if (this.#closed) {
      throw new TransactionError(
        'transaction_closed',
        'transaction is already closed — obtain a fresh Transaction via repo.transact',
      );
    }
    return this.#sheetFactory<T>(name, this, opts?.validator, opts?.prefix);
  }

  /**
   * @internal — Stage a raw text file at `path` (repo-root-relative) in this
   * transaction's tree. The generic file write the CLI uses to commit sheet
   * config edits atomically. Marks the transaction mutated.
   */
  writeFile(path: string, content: string): void {
    if (this.#closed) {
      throw new TransactionError(
        'transaction_closed',
        'transaction is already closed — obtain a fresh Transaction via repo.transact',
      );
    }
    callCore(() => this.#coreTx.writeFile(path, content));
  }

  /**
   * Finalize the transaction. Returns the commit hash + tree hash, or nulls if
   * no mutations occurred. Throws TransactionError(parent_moved) on optimistic
   * concurrency conflict. After finalize the transaction is closed.
   */
  async finalize<T>(value: T): Promise<TransactionResult<T>> {
    this.#closed = true;
    const r = callCore(() => this.#coreTx.finalize());
    return {
      value,
      commitHash: r.commitHash ?? null,
      treeHash: r.treeHash ?? null,
      ref: r.refName ?? null,
      parentCommitHash: r.parentCommitHash ?? this.#parentCommitHash,
    };
  }

  /** Called by Repository on handler throw. Discards the core tree + frees the slot. */
  discard(): void {
    if (this.#closed) return;
    this.#closed = true;
    callCore(() => this.#coreTx.discard());
  }

  static normalizeOptions(opts: TransactionOptions): {
    parent: string | undefined;
    branch: string | undefined;
    author: Author | undefined;
    committer: Author | undefined;
    message: string;
    trailers: Readonly<Record<string, string>>;
  } {
    validateTrailers(opts.trailers);
    return {
      parent: opts.parent,
      branch: opts.branch,
      author: opts.author,
      committer: opts.committer ?? opts.author,
      message: opts.message,
      trailers: opts.trailers ?? {},
    };
  }
}

/** Convert a JS trailer map to the core's ordered `{ key, value }` array form. */
export function toTrailerArray(
  trailers: Readonly<Record<string, string>>,
): Array<{ key: string; value: string }> {
  return Object.entries(trailers).map(([key, value]) => ({ key, value }));
}

// --- Author resolution from git config ---

let anonymousWarned = false;

export async function resolveAuthor(
  gitDir: string,
  explicit: Author | undefined,
): Promise<Author> {
  if (explicit) return explicit;
  try {
    const [name, email] = await Promise.all([
      exec('git', ['config', 'user.name'], { cwd: gitDir }).then((r) => r.stdout.trim()),
      exec('git', ['config', 'user.email'], { cwd: gitDir }).then((r) => r.stdout.trim()),
    ]);
    if (name && email) {
      return { name, email };
    }
  } catch {
    // fall through to anonymous default
  }
  if (!anonymousWarned) {
    anonymousWarned = true;
    process.stderr.write(
      'gitsheets: no commit author configured (set git config user.name + user.email, or pass opts.author); falling back to Anonymous <anonymous@gitsheets.local>\n',
    );
  }
  return { name: 'Anonymous', email: 'anonymous@gitsheets.local' };
}

// --- RefError helpers ---

export function refNotFound(ref: string): RefError {
  return new RefError('ref_not_found', `ref not found: ${ref}`);
}
