// Test fixture: isolated git repo in a tmpdir.
// Used by vitest specs that exercise repo/sheet behavior against real git.
//
// Per #19, gitsheets v1.0 supports fresh repositories — the helper does NOT
// create an initial commit by default. Specs that need a non-empty repo opt
// in via `withInitialCommit: true`.

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface TestRepoHandle {
  /** Absolute path to the repo's working directory. */
  readonly path: string;
  /** Absolute path to the .git directory. */
  readonly gitDir: string;
  /** Run a git command in this repo and capture stdout/stderr. */
  readonly git: (...args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Remove the temporary directory. Idempotent. */
  readonly cleanup: () => Promise<void>;
}

export interface TestRepoOptions {
  /** Initial branch name; defaults to `main`. */
  readonly initialBranch?: string;
  /** If true, create an empty initial commit. Defaults to false (fresh repo, #19). */
  readonly withInitialCommit?: boolean;
}

export async function testRepo(opts: TestRepoOptions = {}): Promise<TestRepoHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'gitsheets-test-'));
  const gitDir = join(dir, '.git');
  const initialBranch = opts.initialBranch ?? 'main';

  const git = (...args: string[]): Promise<{ stdout: string; stderr: string }> =>
    exec('git', args, { cwd: dir });

  await git('init', '-b', initialBranch);
  await git('config', 'user.email', 'test@gitsheets.local');
  await git('config', 'user.name', 'gitsheets test');
  // Disable signing for hermetic runs.
  await git('config', 'commit.gpgsign', 'false');
  // Avoid noisy hooks if a contributor has globals.
  await git('config', 'core.hooksPath', '/dev/null');

  if (opts.withInitialCommit === true) {
    await git('commit', '--allow-empty', '-m', 'initial');
  }

  let cleaned = false;
  return {
    path: dir,
    gitDir,
    git,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
