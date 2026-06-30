// Transaction — scopes a set of sheet mutations to a single commit.
// See specs/api/transaction.md + specs/behaviors/transactions.md.

import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Repo as HologitRepo, TreeObject, Workspace } from 'hologit';

import { RefError, TransactionError } from './errors.js';
import type { RecordLike } from './path-template/index.js';
import { commitTreeWithRepo, loadHoloTree, openBindingRepo } from './substrate.js';
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
  readonly #sheetFactory: <T extends RecordLike = RecordLike>(
    name: string,
    workspace: Workspace,
    tree: TreeObject,
    validator?: StandardSchemaV1<unknown, T>,
    prefix?: string,
  ) => Sheet<T>;
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
    sheetFactory: <T extends RecordLike = RecordLike>(
      name: string,
      workspace: Workspace,
      tree: TreeObject,
      validator?: StandardSchemaV1<unknown, T>,
      prefix?: string,
    ) => Sheet<T>;
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
    return this.#sheetFactory<T>(
      name,
      this.#workspace,
      this.#workspace.root,
      opts?.validator,
      opts?.prefix,
    );
  }

  /**
   * Finalize the transaction. Returns the commit hash + tree hash, or nulls if
   * no mutations occurred. Throws TransactionError(parent_moved) on optimistic
   * concurrency conflict. After finalize the transaction is closed.
   */
  async finalize<T>(value: T): Promise<TransactionResult<T>> {
    this.#closed = true;

    const noChange: TransactionResult<T> = {
      value,
      commitHash: null,
      treeHash: null,
      ref: null,
      parentCommitHash: this.#parentCommitHash,
    };

    if (!this.#anyMutation) {
      return noChange;
    }

    const gitDir = this.#hologitRepo.gitDir;

    // The holo-tree binding (#127) backs commit-object creation, the no-op
    // tree-hash probe, the parent-moved check, and compare-and-swap ref
    // movement. The working tree itself (`workspace.root`) stays on hologit
    // for now — only the commit/ref tail of finalize is migrated. When the
    // binding can't load on this platform (or GITSHEETS_COMMIT_SUBSTRATE=git),
    // `binding` is null and the legacy `git` shell-out path runs end-to-end.
    // See plans/holo-tree-migration.md.
    const holo = await loadHoloTree();
    const binding = holo ? openBindingRepo(holo, gitDir) : null;

    // Optimistic concurrency: re-check the parent ref hasn't moved. The CAS
    // `updateRef` below is the actual race guard; this pre-check just surfaces
    // the friendlier `parent_moved` error (and an early exit) before we bother
    // writing a commit object.
    if (this.#parentRef !== null) {
      const current = binding
        ? binding.resolveRef(this.#parentRef)
        : await this.#hologitRepo.resolveRef(this.#parentRef);
      if (current !== this.#parentCommitHash) {
        throw new TransactionError(
          'parent_moved',
          `parent ref ${this.#parentRef} moved during transaction (expected ${this.#parentCommitHash ?? 'null'}, found ${current ?? 'null'})`,
        );
      }
    }

    const treeHash = await this.#workspace.root.write();

    // No-op detection: if the resulting tree-hash matches the parent
    // commit's tree-hash, nothing actually changed. Skip the commit + ref
    // update — same return shape as the `!#anyMutation` path above. The
    // `#anyMutation` flag tracks "a mutating method was called," which
    // over-approximates: clear() on an already-empty sheet, upsert() of
    // byte-identical content, and bulk reimport-with-unchanged-data patterns
    // all set the flag without changing the tree. Tree-hash equality is the
    // canonical git-native truth. See specs/api/transaction.md#no-op-detection.
    if (this.#parentCommitHash !== null) {
      const parentTreeHash = binding
        ? binding.createTreeFromRef(this.#parentCommitHash).write()
        : (
            await exec('git', ['rev-parse', `${this.#parentCommitHash}^{tree}`], { cwd: gitDir })
          ).stdout.trim();
      if (parentTreeHash === treeHash) {
        return noChange;
      }
    }

    const message = formatCommitMessage(this.#message, this.#trailers);

    let commitHash: string;
    if (binding) {
      try {
        commitHash = commitTreeWithRepo(binding, {
          treeHash,
          parents: this.#parentCommitHash ? [this.#parentCommitHash] : [],
          message,
          author: this.#author,
          committer: this.#committer,
        });
      } catch (err) {
        throw new TransactionError(
          'commit_failed',
          `holo-tree commitTree failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    } else {
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
    }

    if (this.#branchRef !== null) {
      if (binding) {
        try {
          // CAS: only advance the ref if it still points at the parent commit
          // (undefined expected-old → unconditional, for a fresh branch) —
          // matching `git update-ref <ref> <new> [<old>]`.
          binding.updateRef(
            this.#branchRef,
            commitHash,
            this.#parentCommitHash ?? undefined,
          );
        } catch (err) {
          throw new TransactionError(
            'commit_failed',
            `holo-tree updateRef ${this.#branchRef} failed: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      } else {
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
