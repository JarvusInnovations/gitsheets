// Repository — entry point. A thin orchestration shell over the Rust core
// (`gitsheets-core`, via the `@gitsheets/core-napi` addon): transactions run on
// `CoreTransaction`, reads resolve against a captured tree ref, and the only
// remaining git shell-outs are genuine porcelain (ref resolution, sheet
// discovery, author config). See specs/api/repository.md.

import { execFile, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { addon, callCore, CoreTransaction } from './core.js';
import { ConfigError, NotFoundError, RefError, TransactionError } from './errors.js';
import type { RecordLike } from './path-template/index.js';
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
  toTrailerArray,
  transactionContext,
  type TransactionHandler,
  type TransactionOptions,
  type TransactionResult,
} from './transaction.js';
import type { StandardSchemaV1 } from './validation.js';
import { EMPTY_TREE_HASH, makeBlobHandle, type BlobHandle } from './working-tree.js';

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
  readonly #gitDir: string;
  readonly #mutex = new Mutex();
  readonly #postCommitHooks: Array<(commitHash: string) => void> = [];
  /**
   * Every live non-transaction Sheet this Repository has issued, held weakly
   * so registration imposes no lifecycle obligation on consumers. Rebound to
   * the current HEAD tree by {@link refresh} (and the transact auto-refresh).
   * See specs/behaviors/freshness.md.
   */
  readonly #sheetRegistry = new Set<WeakRef<Sheet>>();
  #strictMode = false;
  #pushDaemon: PushDaemon | null = null;

  constructor(opts: { gitDir: string }) {
    this.#gitDir = opts.gitDir;
  }

  /** Discover a `.git` upward from `cwd` and open it. */
  static async fromCwd(): Promise<Repository> {
    return Repository.open({});
  }

  /** Open a specific git directory (or discover one from the cwd). */
  static async open(opts: OpenRepoOptions): Promise<Repository> {
    const gitDir = await resolveGitDir(opts.gitDir);
    return new Repository({ gitDir });
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

  /**
   * @internal — called from the Sheet constructor so every non-transaction
   * Sheet this Repository issues (openSheet / openSheets / openStore /
   * Sheet.clone) participates in the freshness model. Weakly held.
   */
  registerSheet(sheet: Sheet): void {
    this.#sheetRegistry.add(new WeakRef(sheet));
  }

  /**
   * @internal — the tree hash non-transaction reads currently resolve
   * against: HEAD's tree, or the empty tree on a fresh repo. Used by
   * Sheet.refresh to rebind a single sheet.
   */
  async currentReadTree(): Promise<string> {
    return this.#resolveReadTree();
  }

  /**
   * Rebind every live Sheet this Repository has issued to the current HEAD
   * tree. The consumer's tool after out-of-band ref movement; not needed
   * after this repository's own transact (a successful commit auto-refreshes).
   * See specs/behaviors/freshness.md.
   */
  async refresh(): Promise<void> {
    const tree = await this.#resolveReadTree();
    this.#rebindLiveSheets(tree);
  }

  #rebindLiveSheets(tree: string): void {
    for (const ref of this.#sheetRegistry) {
      const sheet = ref.deref();
      if (sheet === undefined) {
        this.#sheetRegistry.delete(ref);
        continue;
      }
      sheet.rebindReadTree(tree);
    }
  }

  /**
   * Stream a blob's bytes by `<ref>:<path>`, resolved at call time —
   * independent of any Sheet's read snapshot. Returns a Node Readable piped
   * from `git cat-file blob`; the blob is never fully buffered by gitsheets.
   *
   * Throws RefError(ref_not_found) when `ref` doesn't resolve to a tree-ish,
   * NotFoundError(record_not_found) when `path` is absent under the ref's
   * tree or names a non-blob. See specs/api/repository.md and
   * specs/behaviors/attachments.md#streaming-reads-by-keypath.
   */
  async readBlobStream(ref: string, path: string): Promise<Readable> {
    const spec = `${ref}:${path}`;
    let type: string | null = null;
    try {
      const { stdout } = await exec('git', ['cat-file', '-t', spec], { cwd: this.#gitDir });
      type = stdout.trim() || null;
    } catch {
      type = null;
    }
    if (type === null) {
      // Distinguish a bad ref from a missing path for typed errors.
      const refResolves = await revParseVerify(this.#gitDir, `${ref}^{tree}`);
      if (!refResolves) {
        throw new RefError('ref_not_found', `readBlobStream: ref does not resolve: ${ref}`);
      }
      throw new NotFoundError('record_not_found', `readBlobStream: no object at ${spec}`);
    }
    if (type !== 'blob') {
      throw new NotFoundError(
        'record_not_found',
        `readBlobStream: object at ${spec} is a ${type}, not a blob`,
      );
    }
    const child = spawn('git', ['cat-file', 'blob', spec], { cwd: this.#gitDir });
    child.stdin.end();
    return child.stdout;
  }

  /** Resolve a ref or commit hash. Returns the full commit hash or null. */
  async resolveRef(ref: string): Promise<string | null> {
    return resolveCommit(this.#gitDir, ref);
  }

  /**
   * @internal — Write raw bytes as a loose blob in the ODB and return a
   * gitsheets blob handle. Used by the CLI to hash binary attachments before
   * placing them in a record's attachment tree.
   */
  async writeBlob(content: Buffer): Promise<BlobHandle> {
    const hash = callCore(() => addon.writeBlob(this.#gitDir, content));
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
    const readRef = await this.#resolveReadTree();
    const configPath = joinTreePath(root, '.gitsheets', `${name}.toml`);
    const sheetOpts: import('./sheet.js').SheetConstructorOptions<T> = {
      repo: this,
      name,
      configPath,
      readRef,
      dataBase: dataRootBase(root),
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
    const readRef = await this.#resolveReadTree();
    let names: string[];
    try {
      names = callCore(() => addon.coreDiscoverSheets(this.#gitDir, readRef, root));
    } catch {
      return {};
    }

    const out: Record<string, Sheet> = {};
    for (const sheetName of names) {
      const sheetOpts: import('./sheet.js').SheetConstructorOptions = {
        repo: this,
        name: sheetName,
        configPath: joinTreePath(root, '.gitsheets', `${sheetName}.toml`),
        readRef,
        dataBase: dataRootBase(root),
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
    const author = await resolveAuthor(this.#gitDir, normalized.author);
    const committer = normalized.committer ?? author;

    const release = await this.#mutex.acquire();
    try {
      const coreOpts: import('@gitsheets/core-napi').JsTransactionOptions = {
        message: normalized.message,
        trailers: toTrailerArray(normalized.trailers),
        author,
        committer,
        timeSeconds: Math.floor(Date.now() / 1000),
        // getTimezoneOffset returns minutes local is *behind* UTC; negate for
        // git's "+HHMM"-style offset (minutes ahead of UTC).
        offsetMinutes: -new Date().getTimezoneOffset(),
      };
      if (normalized.parent !== undefined) coreOpts.parent = normalized.parent;
      if (normalized.branch !== undefined) coreOpts.branch = normalized.branch;

      const coreTx = callCore(() => CoreTransaction.begin(this.#gitDir, coreOpts));
      const tx: Transaction = new Transaction({
        coreTx,
        gitDir: this.#gitDir,
        sheetFactory: <R extends RecordLike = RecordLike>(
          name: string,
          txn: Transaction,
          validator?: StandardSchemaV1<unknown, R>,
          prefix?: string,
        ): Sheet<R> => this.#makeTxSheet<R>(txn, name, validator, prefix),
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
        // Auto-refresh: rebind every live sheet to the post-commit HEAD tree
        // (read-your-writes — specs/behaviors/freshness.md). Resolved from
        // HEAD rather than the result tree so a commit onto a non-HEAD branch
        // doesn't shift HEAD-bound sheets.
        this.#rebindLiveSheets(await this.#resolveReadTree());
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
    validator?: StandardSchemaV1<unknown, T>,
    prefix?: string,
  ): Sheet<T> {
    const configPath = `.gitsheets/${name}.toml`;
    const opts: import('./sheet.js').SheetConstructorOptions<T> = {
      repo: this,
      name,
      configPath,
      transaction: tx,
    };
    if (validator !== undefined) Object.assign(opts, { validator });
    if (prefix !== undefined) Object.assign(opts, { prefix });
    return new Sheet<T>(opts);
  }

  /** The tree hash reads resolve against — HEAD's tree, or the empty tree on a fresh repo. */
  async #resolveReadTree(): Promise<string> {
    try {
      const { stdout } = await exec('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], {
        cwd: this.#gitDir,
      });
      const hash = stdout.trim();
      if (hash) return hash;
    } catch {
      // fresh repo — no HEAD
    }
    return EMPTY_TREE_HASH;
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

/** True when `git rev-parse --verify --quiet <rev>` resolves. */
async function revParseVerify(gitDir: string, rev: string): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--verify', '--quiet', rev], {
      cwd: gitDir,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Resolve a ref/commit-ish to its full commit hash via git rev-parse; null on failure. */
async function resolveCommit(gitDir: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: gitDir,
    });
    const hash = stdout.trim();
    return hash || null;
  } catch {
    return null;
  }
}

/** Join tree-path segments, dropping empties / `.` and stray slashes. */
function joinTreePath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((p) => p.length > 0 && p !== '.')
    .join('/');
}

/** Normalize the `root` open-option to a tree base path (`''` for the repo root). */
function dataRootBase(root: string): string {
  if (root === '.' || root === '') return '';
  return root.replace(/^\/+|\/+$/g, '');
}
