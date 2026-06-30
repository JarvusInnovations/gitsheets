// Repository — entry point. Wraps the holo-tree binding `Repo` with
// gitsheets-specific orchestration (transactions, sheet discovery).
// See specs/api/repository.md.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ConfigError, RefError, TransactionError } from './errors.js';
import type { RecordLike } from './path-template/index.js';
import {
  PushDaemon,
  resolveBackoff,
  type PushDaemonOptions,
} from './push-daemon.js';
import { Sheet } from './sheet.js';
import {
  loadBinding,
  openBindingRepo,
  type BindingRepo,
  type BindingTree,
} from './substrate.js';
import {
  Mutex,
  Transaction,
  resolveAuthor,
  transactionContext,
  type TransactionHandler,
  type TransactionOptions,
  type TransactionResult,
} from './transaction.js';
import type { StandardSchemaV1 } from './validation.js';
import { TreeView, joinTreePath, makeBlobHandle, type BlobHandle } from './working-tree.js';

const exec = promisify(execFile);

export interface OpenRepoOptions {
  /** Path to a `.git` directory. If omitted, discovered from the cwd upward. */
  readonly gitDir?: string;
  /** Working tree path; default `null` (bare-style operation). */
  readonly workTree?: string | null;
}

export interface OpenSheetOptions<T extends RecordLike = RecordLike> {
  /** Sub-directory under the data tree to scope this sheet to; default '.'. */
  readonly root?: string;
  /**
   * Optional sub-prefix under the resolved sheet root (and under `root` if
   * set). Records read/written by this Sheet live at
   * `<configRoot>/<prefix>/<rendered-path>.toml`. Use for multi-tenant
   * sub-tree partitioning of a sheet's records. See specs/api/cli.md and #148.
   */
  readonly prefix?: string;
  /** Standard Schema validator; runs after the persisted JSON Schema. */
  readonly validator?: StandardSchemaV1<unknown, T>;
}

/** Options for {@link Repository.openSheets}. No `validator` — use {@link openStore} for that. */
export interface OpenSheetsOptions {
  /** Sub-directory under the data tree to scope every sheet to; default '.'. */
  readonly root?: string;
  /** Optional sub-prefix applied to every sheet opened. See {@link OpenSheetOptions}. */
  readonly prefix?: string;
}

/** Resolve the absolute `.git` directory for `gitDir` (or discovered from `cwd`). */
async function resolveGitDir(gitDir: string | undefined): Promise<string> {
  const cwd = gitDir ?? process.cwd();
  try {
    const { stdout } = await exec('git', ['rev-parse', '--absolute-git-dir'], { cwd });
    return stdout.trim();
  } catch (err) {
    throw new ConfigError(
      'config_missing',
      `could not find a git repository at ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export class Repository {
  readonly #holo: typeof import('@hologit/holo-tree');
  readonly #binding: BindingRepo;
  readonly #gitDir: string;
  readonly #mutex = new Mutex();
  readonly #postCommitHooks: Array<(commitHash: string) => void> = [];
  #strictMode = false;
  #pushDaemon: PushDaemon | null = null;

  constructor(opts: {
    holo: typeof import('@hologit/holo-tree');
    binding: BindingRepo;
    gitDir: string;
  }) {
    this.#holo = opts.holo;
    this.#binding = opts.binding;
    this.#gitDir = opts.gitDir;
  }

  /** Discover a `.git` upward from `cwd` and open it. */
  static async fromCwd(): Promise<Repository> {
    return Repository.open({});
  }

  /** Open a specific git directory (or discover one from the cwd). */
  static async open(opts: OpenRepoOptions): Promise<Repository> {
    const holo = await loadBinding();
    const gitDir = await resolveGitDir(opts.gitDir);
    const binding = openBindingRepo(holo, gitDir);
    return new Repository({ holo, binding, gitDir });
  }

  get gitDir(): string {
    return this.#gitDir;
  }

  /** @internal — used by Sheet to enforce strict mode. Library cross-class signal, not a consumer API. */
  isStrictMode(): boolean {
    return this.#strictMode;
  }

  /** Switch to strict mode — mutations outside repo.transact throw. One-way. */
  requireExplicitTransactions(): void {
    this.#strictMode = true;
  }

  /** Resolve a ref or commit hash. Returns the full commit hash or null. */
  async resolveRef(ref: string): Promise<string | null> {
    return this.#binding.resolveRef(ref);
  }

  /**
   * @internal — Write raw bytes as a loose blob in the ODB and return a
   * gitsheets blob handle. Used by the CLI to hash binary attachments before
   * placing them in a record's attachment tree.
   */
  async writeBlob(content: Buffer): Promise<BlobHandle> {
    const hash = this.#binding.writeBlob(content);
    return makeBlobHandle(this.#gitDir, hash, '100644', content);
  }

  /**
   * Open a Sheet handle bound to the workspace at the resolved ref (default
   * HEAD). Throws ConfigError(config_missing) when `.gitsheets/<name>.toml`
   * is absent.
   */
  async openSheet<T extends RecordLike = RecordLike>(
    name: string,
    opts: OpenSheetOptions<T> = {},
  ): Promise<Sheet<T>> {
    const root = opts.root ?? '.';
    const rootTree = await this.#readRootTree();
    const rootView = new TreeView(this.#binding, rootTree, '', this.#gitDir);
    const dataTree = new TreeView(this.#binding, rootTree, dataRootBase(root), this.#gitDir);
    const configPath = joinTreePath(root, '.gitsheets', `${name}.toml`);
    const sheetOpts: import('./sheet.js').SheetConstructorOptions<T> = {
      repo: this,
      rootView,
      dataTree,
      name,
      configPath,
    };
    if (opts.validator !== undefined) {
      Object.assign(sheetOpts, { validator: opts.validator });
    }
    if (opts.prefix !== undefined) {
      Object.assign(sheetOpts, { prefix: opts.prefix });
    }
    const sheet = new Sheet<T>(sheetOpts);
    // Eagerly validate config exists by reading once.
    await sheet.readConfig();
    return sheet;
  }

  /** Discover every sheet declared in `<root>/.gitsheets/*.toml`. */
  async openSheets(opts: OpenSheetsOptions = {}): Promise<Record<string, Sheet>> {
    const root = opts.root ?? '.';
    const rootTree = await this.#readRootTree();
    const rootView = new TreeView(this.#binding, rootTree, '', this.#gitDir);
    const sheetsDir = await rootView.getSubtree(joinTreePath(root, '.gitsheets'));
    if (!sheetsDir) return {};

    const children = await sheetsDir.getChildren();
    const out: Record<string, Sheet> = {};

    for (const childName of Object.keys(children)) {
      const child = children[childName];
      const match = /^(.+)\.toml$/.exec(childName);
      if (!match) continue;
      if (!child || (child as { isBlob?: boolean }).isBlob !== true) continue;
      const sheetName = match[1]!;
      const dataTree = new TreeView(this.#binding, rootTree, dataRootBase(root), this.#gitDir);
      const sheetOpts: import('./sheet.js').SheetConstructorOptions = {
        repo: this,
        rootView,
        dataTree,
        name: sheetName,
        configPath: joinTreePath(root, '.gitsheets', childName),
      };
      if (opts.prefix !== undefined) {
        Object.assign(sheetOpts, { prefix: opts.prefix });
      }
      out[sheetName] = new Sheet(sheetOpts);
    }
    return out;
  }

  /**
   * Run a handler inside a transaction. On handler success, commit; on throw,
   * discard the tree. See specs/api/transaction.md.
   */
  async transact<T>(
    opts: TransactionOptions,
    handler: TransactionHandler<T>,
  ): Promise<TransactionResult<T>> {
    if (transactionContext.getStore() !== undefined) {
      throw new TransactionError(
        'transaction_in_progress',
        'nested repo.transact is not allowed — use tx.sheet(name) inside the handler',
      );
    }

    const normalized = Transaction.normalizeOptions(opts);
    const author = await resolveAuthor(this.gitDir, normalized.author);
    const committer = normalized.committer ?? author;

    const release = await this.#mutex.acquire();
    try {
      const { parent, branch } = await this.#resolveParent(normalized.parent, normalized.branch);
      const parentCommitHash = parent.commitHash;
      const rootTree = parentCommitHash
        ? this.#binding.createTreeFromRef(parentCommitHash)
        : this.#binding.createTree();
      const rootView = new TreeView(this.#binding, rootTree, '', this.#gitDir);

      const tx: Transaction = new Transaction({
        binding: this.#binding,
        rootView,
        parentCommitHash,
        parentRef: parent.refName,
        branchRef: branch,
        author,
        committer,
        message: normalized.message,
        trailers: normalized.trailers,
        sheetFactory: <R extends RecordLike = RecordLike>(
          name: string,
          tree: TreeView,
          validator?: StandardSchemaV1<unknown, R>,
          prefix?: string,
        ): Sheet<R> => this.#makeTxSheet<R>(tx, name, tree, validator, prefix),
      });

      let value: T;
      try {
        value = await transactionContext.run(tx, () => handler(tx));
      } catch (err) {
        tx.discard();
        throw err;
      }
      const result = await tx.finalize(value);
      if (result.commitHash !== null) {
        for (const hook of this.#postCommitHooks) {
          try {
            hook(result.commitHash);
          } catch {
            // Hooks must not break transactions.
          }
        }
      }
      return result;
    } finally {
      release();
    }
  }

  /**
   * Start an async push daemon for this repo. Only one daemon may be active
   * at a time; throws TransactionError(push_daemon_running) on contention.
   * See specs/behaviors/push-sync.md.
   */
  async startPushDaemon(opts: PushDaemonOptions): Promise<PushDaemon> {
    if (this.#pushDaemon) {
      throw new TransactionError(
        'push_daemon_running',
        'a push daemon is already running for this Repository — stop it first',
      );
    }
    let branch = opts.branch;
    if (!branch) {
      const headRef = await this.#headBranchRef();
      if (!headRef) {
        throw new RefError(
          'ref_not_found',
          'cannot start push daemon — HEAD is detached or the repo is fresh',
        );
      }
      branch = headRef.replace(/^refs\/heads\//, '');
    }
    const daemon = new PushDaemon({
      gitDir: this.gitDir,
      remote: opts.remote,
      branch,
      backoff: resolveBackoff(opts.backoff),
      maxRetries: opts.maxRetries ?? Number.POSITIVE_INFINITY,
    });
    this.#pushDaemon = daemon;
    const hook = (commitHash: string): void => daemon.notifyCommit(commitHash);
    this.#postCommitHooks.push(hook);
    daemon.once('stopped', () => {
      const idx = this.#postCommitHooks.indexOf(hook);
      if (idx >= 0) this.#postCommitHooks.splice(idx, 1);
      this.#pushDaemon = null;
    });
    // Defer the startup-backlog check so the consumer has a tick to attach
    // `error` / `push` listeners on the returned handle. See #157 + the
    // "Startup backlog" section of specs/behaviors/push-sync.md.
    setImmediate(() => {
      void daemon.checkStartupBacklog();
    });
    return daemon;
  }

  // --- Private helpers ---

  #makeTxSheet<T extends RecordLike = RecordLike>(
    tx: Transaction,
    name: string,
    tree: TreeView,
    validator?: StandardSchemaV1<unknown, T>,
    prefix?: string,
  ): Sheet<T> {
    const configPath = `.gitsheets/${name}.toml`;
    const opts: import('./sheet.js').SheetConstructorOptions<T> = {
      repo: this,
      rootView: tree,
      dataTree: tree,
      name,
      configPath,
      transaction: tx,
    };
    if (validator !== undefined) Object.assign(opts, { validator });
    if (prefix !== undefined) Object.assign(opts, { prefix });
    return new Sheet<T>(opts);
  }

  /**
   * Build a fresh in-memory root tree from HEAD (or an empty tree on a fresh
   * repo). Resolved fresh on each call so post-commit reads never see stale
   * state. Fresh-repo fallback handles #19.
   */
  async #readRootTree(): Promise<BindingTree> {
    let head: string | null = null;
    try {
      head = this.#binding.resolveRef('HEAD');
    } catch {
      head = null;
    }
    if (head) {
      return this.#binding.createTreeFromRef(head);
    }
    return this.#binding.createTree();
  }

  /**
   * Resolve the parent ref + branch ref pair per specs/behaviors/transactions.md.
   * - parent unset → HEAD's branch (or detached HEAD's commit)
   * - parent = branch → branch advances
   * - parent = hash → no ref updated unless `branch` explicit
   */
  async #resolveParent(
    parent: string | undefined,
    branch: string | undefined,
  ): Promise<{ parent: { refName: string | null; commitHash: string | null }; branch: string | null }> {
    if (!parent) {
      // Use HEAD's branch when on a branch; otherwise current HEAD commit.
      const headRef = await this.#headBranchRef();
      if (headRef) {
        const commit = this.#binding.resolveRef(headRef);
        return {
          parent: { refName: headRef, commitHash: commit },
          branch: branch ?? headRef,
        };
      }
      // Detached or fresh repo
      let headHash: string | null = null;
      try {
        headHash = this.#binding.resolveRef('HEAD');
      } catch {
        headHash = null;
      }
      return {
        parent: { refName: null, commitHash: headHash },
        branch: branch ?? null,
      };
    }

    // parent is set — figure out if it's a ref name (branch) or a hash
    const isLikelyBranch = /^[a-zA-Z0-9_./-]+$/.test(parent) && !/^[0-9a-f]{4,40}$/.test(parent);
    if (isLikelyBranch) {
      const refName = parent.startsWith('refs/') ? parent : `refs/heads/${parent}`;
      const commit = this.#binding.resolveRef(refName);
      if (commit === null) {
        // Maybe they passed a raw "main" that doesn't exist yet
        throw new RefError('ref_not_found', `ref not found: ${parent}`);
      }
      return {
        parent: { refName, commitHash: commit },
        branch: branch ?? refName,
      };
    }

    // Hash
    const resolved = this.#binding.resolveRef(parent);
    if (!resolved) {
      throw new RefError('ref_not_found', `cannot resolve commit: ${parent}`);
    }
    return {
      parent: { refName: null, commitHash: resolved },
      branch: branch ? (branch.startsWith('refs/') ? branch : `refs/heads/${branch}`) : null,
    };
  }

  async #headBranchRef(): Promise<string | null> {
    try {
      const { stdout } = await exec('git', ['symbolic-ref', '--quiet', 'HEAD'], {
        cwd: this.gitDir,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}

/** Convenience factory: `openRepo({ gitDir? })`. */
export async function openRepo(opts: OpenRepoOptions = {}): Promise<Repository> {
  return Repository.open(opts);
}

/** Normalize the `root` open-option to a tree base path (`''` for the repo root). */
function dataRootBase(root: string): string {
  if (root === '.' || root === '') return '';
  return root.replace(/^\/+|\/+$/g, '');
}
