// Git subprocesses with an explicit repository. Every `git` gitsheets runs
// for a repository names its git dir in the environment and drops the
// variables that would otherwise redirect it — an inherited `GIT_DIR`,
// `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, or `GIT_NAMESPACE`
// (from a git hook, or `GIT_DIR=… git sheet …`) must not point a submodule
// command at the superproject, or any command at another repository.
// See specs/behaviors/default-branch.md "Submodule mode".

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REDIRECTING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'] as const;

/** `process.env` with `GIT_DIR=<gitDir>` (and `GIT_WORK_TREE` when given) and the redirecting variables removed. */
export function gitEnv(gitDir: string, workTree?: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of REDIRECTING) delete env[key];
  env['GIT_DIR'] = gitDir;
  if (workTree !== undefined && workTree !== null) env['GIT_WORK_TREE'] = workTree;
  return env;
}

/** `process.env` with the redirecting variables removed — for discovery from a path. */
export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of REDIRECTING) delete env[key];
  return env;
}

export interface GitExecOptions {
  /** The repository's working tree, exported as `GIT_WORK_TREE`; default none. */
  readonly workTree?: string | null;
  /** Process cwd; default the working tree, else the git dir. */
  readonly cwd?: string;
  readonly maxBuffer?: number;
}

/** Run `git <args>` against the repository at `gitDir`. Rejects on a non-zero exit, like `execFile`. */
export async function gitExec(
  gitDir: string,
  args: readonly string[],
  opts: GitExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const workTree = opts.workTree ?? null;
  return execFileAsync('git', [...args], {
    cwd: opts.cwd ?? workTree ?? gitDir,
    env: gitEnv(gitDir, workTree),
    ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
  });
}
