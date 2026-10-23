// Shared CLI types + helpers used across command modules (`index.ts`,
// `contracts.ts`). Split out to avoid a circular import between them — both
// need `GlobalArgs`/`buildTxOpts`, and `index.ts` imports command-group
// registration functions (e.g. `registerContractsCommands`) from the modules
// that need these.

import { ConfigError } from '../errors.js';
import { openRepo, type OpenRepoOptions, type Repository } from '../repository.js';

export interface GlobalArgs {
  gitDir?: string;
  root?: string;
  prefix?: string;
  /** The repository's default branch (`--branch` / `GITSHEETS_BRANCH`); see specs/behaviors/default-branch.md. */
  branch?: string;
  ref?: string;
  commitTo?: string;
  message?: string;
  authorName?: string;
  authorEmail?: string;
  trailer?: Record<string, string>;
}

export interface TxOpts {
  message: string;
  author?: { name: string; email: string };
  trailers?: Record<string, string>;
  parent?: string;
  branch?: string;
}

/** Build `repo.transact` options from the global CLI flags shared by every mutating command. */
export function buildTxOpts(argv: GlobalArgs, defaultMessage: string): TxOpts {
  const opts: TxOpts = { message: argv.message ?? defaultMessage };
  if (argv.authorName && argv.authorEmail) {
    opts.author = { name: argv.authorName, email: argv.authorEmail };
  }
  if (argv.trailer && Object.keys(argv.trailer).length > 0) {
    opts.trailers = argv.trailer;
  }
  if (argv.ref) opts.parent = argv.ref;
  if (argv.commitTo) opts.branch = argv.commitTo;
  return opts;
}

/** `openRepo` options from the global flags: `--git-dir` and `--branch` (env already folded in by yargs). */
export function repoOptions(argv: GlobalArgs): OpenRepoOptions {
  const opts: { gitDir?: string; branch?: string } = {};
  if (argv.gitDir) opts.gitDir = argv.gitDir;
  if (argv.branch) opts.branch = argv.branch;
  return opts;
}

/**
 * The ref a command reads committed state from: `--ref` when given, else the
 * resolved default branch (`HEAD` when bound to a detached HEAD). See
 * specs/api/cli.md "Global flags".
 */
export function readRef(argv: GlobalArgs, repo: Repository): string {
  if (argv.ref) return argv.ref;
  return repo.branch !== null ? `refs/heads/${repo.branch}` : 'HEAD';
}

/**
 * `openRepo(repoOptions(argv))`, with a bad `--branch` binding reported
 * against the CLI's own spelling of the knob rather than the library option.
 */
export async function openCliRepo(argv: GlobalArgs): Promise<Repository> {
  try {
    return await openRepo(repoOptions(argv));
  } catch (err) {
    if (err instanceof ConfigError && err.code === 'config_invalid' && err.message.startsWith('openRepo({ branch })')) {
      throw new ConfigError('config_invalid', `--branch / GITSHEETS_BRANCH${err.message.slice('openRepo({ branch })'.length)}`, { cause: err });
    }
    throw err;
  }
}
