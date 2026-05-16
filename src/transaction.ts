// Transaction — scopes a set of sheet mutations to a single commit.
// See specs/api/transaction.md + specs/behaviors/transactions.md.

import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Repo as HologitRepo, TreeObject, Workspace } from 'hologit';

import { RefError, TransactionError } from './errors.js';
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

function formatCommitMessage(subject: string, trailers?: Readonly<Record<string, string>>): string {
  // The `subject` arg is the full message string — it may already contain a body.
  const body = subject.trimEnd();
  if (!trailers || Object.keys(trailers).length === 0) {
    return body + '\n';
  }
  const lines = Object.entries(trailers).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `${body}\n\n${lines}\n`;
}

/**
 * In-process mutex serializing transactions on a single Repository.
 * Concurrent callers from independent async contexts queue; nested
 * repo.transact attempts (same async context) throw before acquiring.
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
  readonly #hologitRepo: HologitRepo;
  readonly #workspace: Workspace;
  readonly #parentCommitHash: string | null;
  readonly #parentRef: string | null;
  readonly #branchRef: string | null;
  readonly #author: Author;
  readonly #committer: Author;
  readonly #message: string;
  readonly #trailers: Readonly<Record<string, string>>;
  /** Function the Repository injects so Transaction.sheet() can build Sheet instances. */
  readonly #sheetFactory: (
    name: string,
    workspace: Workspace,
    tree: TreeObject,
    validator?: StandardSchemaV1,
  ) => Sheet;
  #closed = false;
  #anyMutation = false;

  /**
   * @internal — Transactions are created by Repository.transact (or
   * Store.transact). Consumers do not construct Transaction directly; the
   * constructor is exported only so the type is available for typing
   * handler parameters.
   */
  constructor(opts: {
    hologitRepo: HologitRepo;
    workspace: Workspace;
    parentCommitHash: string | null;
    parentRef: string | null;
    branchRef: string | null;
    author: Author;
    committer: Author;
    message: string;
    trailers: Readonly<Record<string, string>>;
    sheetFactory: (
      name: string,
      workspace: Workspace,
      tree: TreeObject,
      validator?: StandardSchemaV1,
    ) => Sheet;
  }) {
    this.#hologitRepo = opts.hologitRepo;
    this.#workspace = opts.workspace;
    this.#parentCommitHash = opts.parentCommitHash;
    this.#parentRef = opts.parentRef;
    this.#branchRef = opts.branchRef;
    this.#author = opts.author;
    this.#committer = opts.committer;
    this.#message = opts.message;
    this.#trailers = opts.trailers;
    this.#sheetFactory = opts.sheetFactory;
  }

  get tree(): TreeObject {
    return this.#workspace.root;
  }

  get parentCommitHash(): string | null {
    return this.#parentCommitHash;
  }

  get parentRef(): string | null {
    return this.#parentRef;
  }

  get branchRef(): string | null {
    return this.#branchRef;
  }

  /** Marker used by Sheet to record that a mutation happened in this tx. */
  markMutated(): void {
    this.#anyMutation = true;
  }

  /**
   * Returns a Sheet whose writes route through this transaction's private tree.
   * `opts.validator` (optional) attaches a Standard Schema validator — used by
   * Store.transact to thread per-sheet validators through to tx scope.
   */
  sheet(name: string, opts?: { validator?: StandardSchemaV1 }): Sheet {
    if (this.#closed) {
      throw new TransactionError(
        'transaction_closed',
        'transaction is already closed — obtain a fresh Transaction via repo.transact',
      );
    }
    return this.#sheetFactory(name, this.#workspace, this.#workspace.root, opts?.validator);
  }

  /**
   * Finalize the transaction. Returns the commit hash + tree hash, or nulls if
   * no mutations occurred. Throws TransactionError(parent_moved) on optimistic
   * concurrency conflict. After finalize the transaction is closed.
   */
  async finalize<T>(value: T): Promise<TransactionResult<T>> {
    this.#closed = true;

    if (!this.#anyMutation) {
      return {
        value,
        commitHash: null,
        treeHash: null,
        ref: null,
        parentCommitHash: this.#parentCommitHash,
      };
    }

    // Optimistic concurrency: re-check the parent ref hasn't moved.
    if (this.#parentRef !== null) {
      const current = await this.#hologitRepo.resolveRef(this.#parentRef);
      if (current !== this.#parentCommitHash) {
        throw new TransactionError(
          'parent_moved',
          `parent ref ${this.#parentRef} moved during transaction (expected ${this.#parentCommitHash ?? 'null'}, found ${current ?? 'null'})`,
        );
      }
    }

    const gitDir = this.#hologitRepo.gitDir;
    const treeHash = await this.#workspace.root.write();
    const message = formatCommitMessage(this.#message, this.#trailers);

    let commitHash: string;
    try {
      const args = ['commit-tree', treeHash, '-m', message];
      if (this.#parentCommitHash) {
        args.push('-p', this.#parentCommitHash);
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: this.#author.name,
        GIT_AUTHOR_EMAIL: this.#author.email,
        GIT_COMMITTER_NAME: this.#committer.name,
        GIT_COMMITTER_EMAIL: this.#committer.email,
      };
      const { stdout } = await exec('git', args, { cwd: gitDir, env });
      commitHash = stdout.trim();
    } catch (err) {
      throw new TransactionError(
        'commit_failed',
        `git commit-tree failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (this.#branchRef !== null) {
      try {
        const args = ['update-ref', this.#branchRef, commitHash];
        if (this.#parentCommitHash) {
          args.push(this.#parentCommitHash);
        }
        await exec('git', args, { cwd: gitDir });
      } catch (err) {
        throw new TransactionError(
          'commit_failed',
          `git update-ref ${this.#branchRef} failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    return {
      value,
      commitHash,
      treeHash,
      ref: this.#branchRef,
      parentCommitHash: this.#parentCommitHash,
    };
  }

  /** Called by Repository on handler throw. Marks the transaction closed. */
  discard(): void {
    this.#closed = true;
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
