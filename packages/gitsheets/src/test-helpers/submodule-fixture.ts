// Test fixture for submodule mode (specs/behaviors/default-branch.md
// "Submodule mode"): a bare data repository holding a `users` sheet + jane,
// and a superproject with one empty commit. Tests attach the data repository
// as a submodule either with plain `git submodule add` (a checkout) or with
// `git sheet submodule init` (no checkout).

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { openRepo } from '../repository.js';
import { testRepo, type TestRepoHandle } from './test-repo.js';

const exec = promisify(execFile);

export const USERS_CONFIG = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

export interface SubmoduleFixture {
  /** The superproject (main checked out, one empty commit). */
  readonly superproject: TestRepoHandle;
  /** A bare data repository: `main` holds `.gitsheets/users.toml` + users/jane.toml. */
  readonly remote: string;
  /** Run git in `cwd`. */
  readonly git: (cwd: string, ...args: string[]) => Promise<string>;
  readonly cleanup: () => Promise<void>;
}

export async function submoduleFixture(opts: { emptyRemote?: boolean } = {}): Promise<SubmoduleFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'gitsheets-submodule-'));
  const remote = join(dir, 'app-data.git');
  const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec('git', args, { cwd })).stdout.trim();
  const source = await testRepo();
  try {
    if (opts.emptyRemote === true) {
      await git(dir, 'init', '--bare', remote);
    } else {
      const repo = await openRepo({ gitDir: source.gitDir });
      await repo.transact({ message: 'seed' }, async (tx) => {
        tx.writeFile('.gitsheets/users.toml', USERS_CONFIG);
        await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
      });
      await git(dir, 'clone', '--quiet', '--bare', source.path, remote);
    }
  } finally {
    await source.cleanup();
  }
  const superproject = await testRepo({ withInitialCommit: true });
  return {
    superproject,
    remote,
    git,
    cleanup: async () => {
      await superproject.cleanup();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** `git submodule add <remote> data` + commit — the plain-git layout, with a checkout. */
export async function addSubmoduleWithGit(fx: SubmoduleFixture, path = 'data'): Promise<void> {
  const cwd = fx.superproject.path;
  await fx.git(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', fx.remote, path);
  await fx.git(cwd, 'commit', '--quiet', '-m', `add ${path}`);
}

/** Point a submodule's git dir at a clean test identity (commits need one). */
export async function configureIdentity(fx: SubmoduleFixture, gitDir: string): Promise<void> {
  await fx.git(gitDir, 'config', 'user.email', 'test@gitsheets.local');
  await fx.git(gitDir, 'config', 'user.name', 'gitsheets test');
  await fx.git(gitDir, 'config', 'commit.gpgsign', 'false');
}
