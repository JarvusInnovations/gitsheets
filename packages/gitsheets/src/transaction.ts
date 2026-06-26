// Transaction — scopes a set of sheet mutations to a single commit.
// See specs/api/transaction.md + specs/behaviors/transactions.md.

import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Repo as HologitRepo, TreeObject, Workspace } from 'hologit';

import { RefError, TransactionError } from './errors.js';
import type { RecordLike } from './path-template/index.js';
import type { Sheet } from './sheet.js';
import type { StandardSchemaV1 } from './validation.js';

const exec = promisify(execFile);

// --- holo-tree binding (experimental, #127) ---
//
// Minimal structural types for the `holo-tree-napi` binding, declared locally
// so type-checking doesn't depend on the addon's generated `.d.ts` being built.
// The module is dynamically imported via a non-literal specifier (so tsc treats
// it as `any`) only when the holo-tree path is enabled.
interface HoloTreeHandle {
  writeChild(path: string, content: string): string;
  writeChildBytes(path: string, content: Buffer): string;
  deleteChildDeep(path: string): boolean;
  write(): string;
}
interface HoloSignature {
  name: string;
  email: string;
  timeSeconds?: number;
  offsetMinutes?: number;
}
interface HoloRepoHandle {
  createTreeFromRef(gitRef: string): HoloTreeHandle;
  createTree(): HoloTreeHandle;
  commitTree(
    treeHash: string,
    parents: string[],
    message: string,
    author?: HoloSignature,
    committer?: HoloSignature,
  ): string;
  updateRef(refname: string, hash: string): void;
}
interface HoloBinding {
  Repo: { open(gitDir: string): HoloRepoHandle };
  emptyTreeHash(): string;
}

type HoloOp =
  | { readonly kind: 'write'; readonly path: string; readonly content: string }
  | { readonly kind: 'writeBytes'; readonly path: string; readonly content: Buffer }
  | { readonly kind: 'delete'; readonly path: string };

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
  /** Experimental holo-tree substrate spike (#127). */
  readonly #holoTree: boolean;
  readonly #holoOps: HoloOp[] = [];
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
    holoTree?: boolean;
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
    this.#holoTree = opts.holoTree ?? false;
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

  /** True when this transaction mirrors mutations onto the holo-tree binding. */
  get holoTreeEnabled(): boolean {
    return this.#holoTree;
  }

  /**
   * @internal — holo-tree spike (#127). Sheet mirrors each tree mutation here
   * (repo-root-relative path) so `finalize` can replay them through the Rust
   * binding and assert tree parity. Cheap no-op when the flag is off.
   */
  recordHoloWrite(path: string, content: string): void {
    if (this.#holoTree) this.#holoOps.push({ kind: 'write', path, content });
  }

  recordHoloWriteBytes(path: string, content: Buffer): void {
    if (this.#holoTree) this.#holoOps.push({ kind: 'writeBytes', path, content });
  }

  recordHoloDelete(path: string): void {
    if (this.#holoTree) this.#holoOps.push({ kind: 'delete', path });
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

    // holo-tree spike (#127): rebuild the same tree through the Rust binding
    // and assert byte-identical parity before committing through it. Trees are
    // content-addressed, so an identical tree hash proves the binding's blob
    // hashing + tree serialization match git exactly.
    let holoRepo: HoloRepoHandle | null = null;
    if (this.#holoTree) {
      holoRepo = await this.#buildHoloParityTree(gitDir, treeHash);
    }

    // No-op detection: if the resulting tree-hash matches the parent
    // commit's tree-hash, nothing actually changed. Skip the commit-tree
    // spawn + ref update — same return shape as the `!#anyMutation` path
    // above. The `#anyMutation` flag tracks "a mutating method was
    // called," which over-approximates: clear() on an already-empty
    // sheet, upsert() of byte-identical content, and bulk reimport-with-
    // unchanged-data patterns all set the flag without changing the
    // tree. Tree-hash equality is the canonical git-native truth.
    // See specs/api/transaction.md#no-op-detection.
    if (this.#parentCommitHash !== null) {
      const { stdout: parentTreeStdout } = await exec(
        'git',
        ['rev-parse', `${this.#parentCommitHash}^{tree}`],
        { cwd: gitDir },
      );
      const parentTreeHash = parentTreeStdout.trim();
      if (parentTreeHash === treeHash) {
        return {
          value,
          commitHash: null,
          treeHash: null,
          ref: null,
          parentCommitHash: this.#parentCommitHash,
        };
      }
    }

    const message = formatCommitMessage(this.#message, this.#trailers);

    const commitHash = holoRepo
      ? this.#holoCommit(holoRepo, treeHash, message)
      : await this.#gitCommit(gitDir, treeHash, message);

    return {
      value,
      commitHash,
      treeHash,
      ref: this.#branchRef,
      parentCommitHash: this.#parentCommitHash,
    };
  }

  /**
   * holo-tree spike (#127): replay this transaction's recorded mutations onto a
   * fresh holo-tree built from the parent commit, and assert its tree hash
   * matches what hologit produced. Returns the open holo Repo handle so
   * `finalize` can reuse it to create the commit + update the ref.
   */
  async #buildHoloParityTree(gitDir: string, expectedTreeHash: string): Promise<HoloRepoHandle> {
    // Non-literal specifier: tsc treats the module as `any`, so type-checking
    // doesn't require the binding's generated `.d.ts`. Loaded only when enabled.
    const specifier = 'holo-tree-napi';
    const binding = (await import(specifier)) as unknown as HoloBinding;

    const repo = binding.Repo.open(gitDir);
    const tree = this.#parentCommitHash
      ? repo.createTreeFromRef(this.#parentCommitHash)
      : repo.createTree();

    for (const op of this.#holoOps) {
      if (op.kind === 'write') tree.writeChild(op.path, op.content);
      else if (op.kind === 'writeBytes') tree.writeChildBytes(op.path, op.content);
      else tree.deleteChildDeep(op.path);
    }

    const holoTreeHash = tree.write();
    if (holoTreeHash !== expectedTreeHash) {
      throw new TransactionError(
        'commit_failed',
        `holo-tree parity mismatch: holo-tree built ${holoTreeHash}, hologit built ${expectedTreeHash}`,
      );
    }
    return repo;
  }

  /**
   * holo-tree spike (#127): create the commit + advance the ref through the
   * binding, retiring the `git commit-tree` / `update-ref` subprocesses.
   *
   * Passes this transaction's resolved author/committer identity to the
   * binding (holo-tree's `commit_tree` now accepts explicit signatures), so the
   * holo path attributes commits the same way the JS path does. Time is left
   * unset → the binding stamps the current time, matching `git commit-tree`'s
   * default; pinning a time on both paths yields bit-identical commit hashes.
   */
  #holoCommit(holoRepo: HoloRepoHandle, treeHash: string, message: string): string {
    let commitHash: string;
    try {
      const parents = this.#parentCommitHash ? [this.#parentCommitHash] : [];
      commitHash = holoRepo.commitTree(
        treeHash,
        parents,
        message,
        { name: this.#author.name, email: this.#author.email },
        { name: this.#committer.name, email: this.#committer.email },
      );
    } catch (err) {
      throw new TransactionError(
        'commit_failed',
        `holo-tree commitTree failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (this.#branchRef !== null) {
      try {
        holoRepo.updateRef(this.#branchRef, commitHash);
      } catch (err) {
        throw new TransactionError(
          'commit_failed',
          `holo-tree updateRef ${this.#branchRef} failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
    return commitHash;
  }

  /** The hologit-JS commit path: `git commit-tree` + `git update-ref`. */
  async #gitCommit(gitDir: string, treeHash: string, message: string): Promise<string> {
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
    return commitHash;
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
