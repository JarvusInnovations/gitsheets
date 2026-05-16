// Repository — entry point. Wraps hologit's Repo with gitsheets-specific
// orchestration (transactions, sheet discovery). See specs/api/repository.md.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Repo as HologitRepo } from 'hologit';
import type { TreeObject, Workspace } from 'hologit';

import { ConfigError, RefError, TransactionError } from './errors.js';
import {
  PushDaemon,
  resolveBackoff,
  type PushDaemonOptions,
} from './push-daemon.js';
import { Sheet } from './sheet.js';
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

const exec = promisify(execFile);

export interface OpenRepoOptions {
  /** Path to a `.git` directory. If omitted, discovered from the cwd upward. */
  readonly gitDir?: string;
  /** Working tree path; default `null` (bare-style operation). */
  readonly workTree?: string | null;
}

export interface OpenSheetOptions {
  /** Sub-directory under the data tree to scope this sheet to; default '.'. */
  readonly root?: string;
  /** Standard Schema validator; runs after the persisted JSON Schema. */
  readonly validator?: StandardSchemaV1;
}

export class Repository {
  readonly #hologitRepo: HologitRepo;
  readonly #mutex = new Mutex();
  readonly #postCommitHooks: Array<(commitHash: string) => void> = [];
  #strictMode = false;
  #pushDaemon: PushDaemon | null = null;

  constructor(hologitRepo: HologitRepo) {
    this.#hologitRepo = hologitRepo;
  }

  /** Discover a `.git` upward from `cwd` and open it. */
  static async fromCwd(): Promise<Repository> {
    const repo = await HologitRepo.getFromEnvironment();
    return new Repository(repo);
  }

  /** Open a specific git directory. */
  static async open(opts: OpenRepoOptions): Promise<Repository> {
    if (!opts.gitDir) {
      return Repository.fromCwd();
    }
    const repoOpts: { gitDir: string; workTree?: string | null } = { gitDir: opts.gitDir };
    if (opts.workTree !== undefined) {
      repoOpts.workTree = opts.workTree;
    }
    const repo = new HologitRepo(repoOpts);
    return new Repository(repo);
  }

  get hologitRepo(): HologitRepo {
    return this.#hologitRepo;
  }

  get gitDir(): string {
    return this.#hologitRepo.gitDir;
  }

  isStrictMode(): boolean {
    return this.#strictMode;
  }

  /** Switch to strict mode — mutations outside repo.transact throw. One-way. */
  requireExplicitTransactions(): void {
    this.#strictMode = true;
  }

  /** Resolve a ref or commit hash. Returns the full commit hash or null. */
  async resolveRef(ref: string): Promise<string | null> {
    return this.#hologitRepo.resolveRef(ref);
  }

  /**
   * Open a Sheet handle bound to the workspace at the resolved ref (default
   * HEAD). Throws ConfigError(config_missing) when `.gitsheets/<name>.toml`
   * is absent.
   */
  async openSheet(name: string, opts: OpenSheetOptions = {}): Promise<Sheet> {
    const root = opts.root ?? '.';
    const workspace = await this.#getWorkspace();
    const dataTree = await this.#resolveDataTree(workspace, root);
    const configPath = joinTreePath(root, '.gitsheets', `${name}.toml`);
    const sheetOpts: import('./sheet.js').SheetConstructorOptions = {
      repo: this,
      workspace,
      dataTree,
      name,
      configPath,
    };
    if (opts.validator !== undefined) {
      Object.assign(sheetOpts, { validator: opts.validator });
    }
    const sheet = new Sheet(sheetOpts);
    // Eagerly validate config exists by reading once.
    await sheet.readConfig();
    return sheet;
  }

  /** Discover every sheet declared in `<root>/.gitsheets/*.toml`. */
  async openSheets(opts: OpenSheetOptions = {}): Promise<Record<string, Sheet>> {
    const root = opts.root ?? '.';
    const workspace = await this.#getWorkspace();
    const sheetsDir = await workspace.root.getSubtree(joinTreePath(root, '.gitsheets'));
    if (!sheetsDir) return {};

    const children = await sheetsDir.getChildren();
    const out: Record<string, Sheet> = {};
    const dataTree = await this.#resolveDataTree(workspace, root);

    // for...in to include hologit's prototype-loaded entries.
    for (const childName in children) {
      const child = children[childName];
      const match = /^(.+)\.toml$/.exec(childName);
      if (!match) continue;
      if (!child || (child as { isBlob?: boolean }).isBlob !== true) continue;
      const sheetName = match[1]!;
      out[sheetName] = new Sheet({
        repo: this,
        workspace,
        dataTree,
        name: sheetName,
        configPath: joinTreePath(root, '.gitsheets', childName),
      });
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
      const workspace = parentCommitHash
        ? await this.#hologitRepo.createWorkspaceFromRef(parentCommitHash)
        : await this.#emptyWorkspace();

      const tx: Transaction = new Transaction({
        hologitRepo: this.#hologitRepo,
        workspace,
        parentCommitHash,
        parentRef: parent.refName,
        branchRef: branch,
        author,
        committer,
        message: normalized.message,
        trailers: normalized.trailers,
        sheetFactory: (
          name: string,
          ws: Workspace,
          tree: TreeObject,
          validator?: StandardSchemaV1,
        ): Sheet => this.#makeTxSheet(tx, name, ws, tree, validator),
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
    return daemon;
  }

  // --- Private helpers ---

  #makeTxSheet(
    tx: Transaction,
    name: string,
    workspace: Workspace,
    tree: TreeObject,
    validator?: StandardSchemaV1,
  ): Sheet {
    const configPath = `.gitsheets/${name}.toml`;
    const opts: import('./sheet.js').SheetConstructorOptions = {
      repo: this,
      workspace,
      dataTree: tree,
      name,
      configPath,
      transaction: tx,
    };
    if (validator !== undefined) Object.assign(opts, { validator });
    return new Sheet(opts);
  }

  async #getWorkspace(): Promise<Workspace> {
    // Bypass hologit's getWorkspace cache — it caches the first observed
    // workspace per Repo instance, so post-commit reads would return stale
    // state. Resolve HEAD fresh on each call. Fresh-repo fallback handles #19.
    let head: string | null = null;
    try {
      head = await this.#hologitRepo.resolveRef('HEAD');
    } catch {
      head = null;
    }
    if (head) {
      return this.#hologitRepo.createWorkspaceFromRef(head);
    }
    return this.#emptyWorkspace();
  }

  async #emptyWorkspace(): Promise<Workspace> {
    // hologit doesn't expose an empty-workspace factory directly. Use the
    // empty-tree hash to bootstrap a workspace from a deterministic tree.
    const { TreeObject } = await import('hologit');
    const emptyTreeHash = TreeObject.getEmptyTreeHash();
    return this.#hologitRepo.createWorkspaceFromTreeHash(emptyTreeHash);
  }

  async #resolveDataTree(workspace: Workspace, root: string): Promise<TreeObject> {
    if (root === '.' || root === '') return workspace.root;
    const sub = await workspace.root.getSubtree(root, true);
    if (!sub) {
      throw new ConfigError('config_missing', `data root ${root} not found in workspace`);
    }
    return sub;
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
        const commit = await this.#hologitRepo.resolveRef(headRef);
        return {
          parent: { refName: headRef, commitHash: commit },
          branch: branch ?? headRef,
        };
      }
      // Detached or fresh repo
      const headHash = await this.#hologitRepo.resolveRef('HEAD').catch(() => null);
      return {
        parent: { refName: null, commitHash: headHash },
        branch: branch ?? null,
      };
    }

    // parent is set — figure out if it's a ref name (branch) or a hash
    const isLikelyBranch = /^[a-zA-Z0-9_./-]+$/.test(parent) && !/^[0-9a-f]{4,40}$/.test(parent);
    if (isLikelyBranch) {
      const refName = parent.startsWith('refs/') ? parent : `refs/heads/${parent}`;
      const commit = await this.#hologitRepo.resolveRef(refName);
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
    const resolved = await this.#hologitRepo.resolveRef(parent);
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

function joinTreePath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((p) => p.length > 0 && p !== '.')
    .join('/');
}
