// CLI default-branch binding (specs/behaviors/default-branch.md "CLI" +
// "Bootstrapping", #341): `--branch` / GITSHEETS_BRANCH / gitsheets.branch
// select the branch `git sheet` reads and writes; `init` bootstraps an absent
// branch with a root commit and leaves the checked-out branch untouched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main } from './index.js';
import { openRepo } from '../repository.js';
import { testRepo, type TestRepoHandle } from '../test-helpers/test-repo.js';

const USERS = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

const handles: TestRepoHandle[] = [];
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env['GITSHEETS_BRANCH'];
  delete process.env['GITSHEETS_BRANCH'];
});
afterEach(async () => {
  if (savedEnv === undefined) delete process.env['GITSHEETS_BRANCH'];
  else process.env['GITSHEETS_BRANCH'] = savedEnv;
  while (handles.length > 0) await handles.pop()?.cleanup();
});

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  const sink = (into: string[]) =>
    ((chunk: string | Uint8Array): boolean => {
      into.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = sink(out);
  process.stderr.write = sink(err);
  try {
    const code = await main(args);
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

async function git(fixture: TestRepoHandle, ...args: string[]): Promise<string> {
  return (await fixture.git(...args)).stdout.trim();
}

/** main checked out with one empty commit; an orphan `data` branch holding the users sheet and jane. */
async function dataBranchRepo(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
  await repo.transact({ message: 'seed' }, async (tx) => {
    tx.writeFile('.gitsheets/users.toml', USERS);
    await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
  });
  return fixture;
}

describe('CLI --branch / GITSHEETS_BRANCH / gitsheets.branch', () => {
  it('without a binding, the checked-out branch has no users sheet', async () => {
    const fixture = await dataBranchRepo();
    const r = await run(['--git-dir', fixture.gitDir, 'query', 'users']);
    expect(r.code).not.toBe(0);
  });

  it('gitsheets.branch git config makes `query` read the data branch with no flags', async () => {
    const fixture = await dataBranchRepo();
    await fixture.git('config', 'gitsheets.branch', 'data');
    const r = await run(['--git-dir', fixture.gitDir, 'query', 'users']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"slug":"jane"');
  });

  it('GITSHEETS_BRANCH selects the binding', async () => {
    const fixture = await dataBranchRepo();
    process.env['GITSHEETS_BRANCH'] = 'data';
    const r = await run(['--git-dir', fixture.gitDir, 'read', 'users', 'jane']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('jane@x.org');
  });

  it('--branch writes to the data branch; HEAD, main, and the working tree stay put', async () => {
    const fixture = await dataBranchRepo();
    const main0 = await git(fixture, 'rev-parse', 'main');
    const data0 = await git(fixture, 'rev-parse', 'data');
    const r = await run([
      '--git-dir', fixture.gitDir, '--branch', 'data', '--message', 'add ada',
      'upsert', 'users', '{"slug":"ada","email":"ada@x.org"}',
    ]);
    expect(r.code).toBe(0);
    expect(await git(fixture, 'rev-parse', 'data^')).toBe(data0);
    expect(await git(fixture, 'show', 'data:users/ada.toml')).toContain('ada@x.org');
    expect(await git(fixture, 'rev-parse', 'main')).toBe(main0);
    expect(await git(fixture, 'status', '--porcelain')).toBe('');
  });

  it('--branch beats GITSHEETS_BRANCH beats git config', async () => {
    const fixture = await dataBranchRepo();
    await fixture.git('config', 'gitsheets.branch', 'nope');
    process.env['GITSHEETS_BRANCH'] = 'data';
    expect((await run(['--git-dir', fixture.gitDir, 'query', 'users'])).out).toContain('jane');
    // The flag wins over the env: `main` has no users sheet.
    expect((await run(['--git-dir', fixture.gitDir, '--branch', 'main', 'query', 'users'])).code).not.toBe(0);
  });

  it('a tag as --branch is config_invalid', async () => {
    const fixture = await dataBranchRepo();
    await fixture.git('tag', 'v1', 'main');
    const r = await run(['--git-dir', fixture.gitDir, '--branch', 'v1', 'query', 'users']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('config_invalid');
  });

  it('infer reads the existing config from the default branch', async () => {
    const fixture = await dataBranchRepo();
    const r = await run(['--git-dir', fixture.gitDir, '--branch', 'data', 'infer', 'users']);
    expect(r.code).toBe(0);
    expect(await git(fixture, 'show', 'data:.gitsheets/users.toml')).toContain('[gitsheet.schema]');
  });
});

describe('CLI init bootstraps a data branch', () => {
  it('`init users --commit --branch data` creates data with a root commit holding only the config', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    const main0 = await git(fixture, 'rev-parse', 'main');
    const r = await run(['--git-dir', fixture.gitDir, '--branch', 'data', 'init', 'users', '--commit']);
    expect(r.code).toBe(0);
    expect(await git(fixture, 'rev-list', '--count', 'data')).toBe('1');
    expect(await git(fixture, 'rev-list', '--parents', '-n', '1', 'data')).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(fixture, 'ls-tree', '-r', '--name-only', 'data')).toBe('.gitsheets/users.toml');
    expect(await git(fixture, 'rev-parse', 'main')).toBe(main0);
    expect(await git(fixture, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(await git(fixture, 'status', '--porcelain')).toBe('');

    // Re-running refuses to clobber the committed config on that branch.
    const again = await run(['--git-dir', fixture.gitDir, '--branch', 'data', 'init', 'users']);
    expect(again.code).not.toBe(0);
  });

  it('`init users --ref data` with no binding also starts the absent branch with a root commit', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    const r = await run(['--git-dir', fixture.gitDir, '--ref', 'data', 'init', 'users']);
    expect(r.code).toBe(0);
    expect(await git(fixture, 'rev-list', '--count', 'data')).toBe('1');
    expect(await git(fixture, 'ls-tree', '-r', '--name-only', 'data')).toBe('.gitsheets/users.toml');
  });

  it('a bare data clone works with no binding at all (HEAD’s branch)', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    const bare = `${fixture.path}-bare.git`;
    await fixture.git('clone', '-q', '--bare', fixture.path, bare);
    try {
      expect((await run(['--git-dir', bare, 'init', 'users'])).code).toBe(0);
      expect((await run(['--git-dir', bare, '--message', 'jane', 'upsert', 'users', '{"id":"jane"}'])).code).toBe(0);
      const q = await run(['--git-dir', bare, 'query', 'users']);
      expect(q.out).toContain('"id":"jane"');
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('only a plain branch name is bootstrapped from an unresolved --ref', async () => {
    const fixture = await testRepo(); // fresh: HEAD unresolvable
    handles.push(fixture);
    for (const bad of ['HEAD', 'refs/tags/x', 'refs/remotes/origin/x', 'a..b']) {
      const r = await run(['--git-dir', fixture.gitDir, '--ref', bad, 'init', 'users']);
      expect(r.code, bad).not.toBe(0);
    }
    expect(await git(fixture, 'for-each-ref', '--format=%(refname)')).toBe('');
    // refs/heads/<name> is a plain branch name.
    const ok = await run(['--git-dir', fixture.gitDir, '--ref', 'refs/heads/data', 'init', 'users']);
    expect(ok.code).toBe(0);
    expect(await git(fixture, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/data');
  });

  it('a --ref branch that exists only on a remote is not bootstrapped', async () => {
    const origin = await testRepo({ withInitialCommit: true });
    handles.push(origin);
    await origin.git('branch', 'data');
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await fixture.git('remote', 'add', 'origin', origin.path);
    await fixture.git('fetch', '-q', 'origin');
    const r = await run(['--git-dir', fixture.gitDir, '--ref', 'data', 'init', 'users']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('git branch data origin/data');
    const bound = await run(['--git-dir', fixture.gitDir, '--branch', 'data', 'init', 'users']);
    expect(bound.code).not.toBe(0);
    expect(bound.err).toContain('--branch / GITSHEETS_BRANCH');
    await expect(fixture.git('rev-parse', '--verify', '--quiet', 'refs/heads/data')).rejects.toBeTruthy();
  });

  it('init --no-commit is rejected', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    const head0 = await git(fixture, 'rev-parse', 'HEAD');
    const r = await run(['--git-dir', fixture.gitDir, 'init', 'users', '--no-commit']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('--no-commit');
    expect(await git(fixture, 'rev-parse', 'HEAD')).toBe(head0);
  });
});
