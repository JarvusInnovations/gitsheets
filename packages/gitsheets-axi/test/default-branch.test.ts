// gitsheets-axi default-branch binding (specs/behaviors/default-branch.md
// "CLI", #341): the global `--branch` flag, GITSHEETS_BRANCH, and the
// gitsheets.branch git config select the branch every command reads and
// writes; HEAD and the working tree are never touched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { testRepo, type TestRepoHandle } from './test-repo.js';
import { runCli } from './run-cli.js';

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

async function git(h: TestRepoHandle, ...args: string[]): Promise<string> {
  return (await h.git(...args)).stdout.trim();
}

/** main checked out (one empty commit); `data` bootstrapped through axi with the users sheet and jane. */
async function dataRepo(): Promise<TestRepoHandle> {
  const h = await testRepo({ withInitialCommit: true });
  handles.push(h);
  expect((await runCli(['init', 'users', '--path', '${{ slug }}', '--branch', 'data'], h.path)).exitCode).toBe(0);
  const up = await runCli(['upsert', 'users', '--data', '{"slug":"jane","email":"jane@x.org"}', '--branch', 'data'], h.path);
  expect(up.exitCode).toBe(0);
  return h;
}

describe('gitsheets-axi --branch', () => {
  it('init + upsert bootstrap and fill the data branch; main and the working tree stay put', async () => {
    const h = await dataRepo();
    expect(await git(h, 'rev-list', '--count', 'data')).toBe('2');
    expect(await git(h, 'rev-list', '--max-parents=0', 'data')).toBe(await git(h, 'rev-list', '--reverse', 'data').then((s) => s.split('\n')[0]!));
    expect(await git(h, 'show', 'data:users/jane.toml')).toContain('jane@x.org');
    expect(await git(h, 'rev-list', '--count', 'main')).toBe('1');
    expect(await git(h, 'status', '--porcelain')).toBe('');
  });

  it('accepts the flag before or after the command', async () => {
    const h = await dataRepo();
    expect((await runCli(['query', 'users', '--branch', 'data'], h.path)).stdout).toContain('jane');
    expect((await runCli(['--branch=data', 'query', 'users'], h.path)).stdout).toContain('jane');
  });

  it('GITSHEETS_BRANCH and gitsheets.branch bind with no flag', async () => {
    const h = await dataRepo();
    expect((await runCli(['query', 'users'], h.path)).exitCode).not.toBe(0);

    process.env['GITSHEETS_BRANCH'] = 'data';
    expect((await runCli(['query', 'users'], h.path)).stdout).toContain('jane');
    delete process.env['GITSHEETS_BRANCH'];

    await h.git('config', 'gitsheets.branch', 'data');
    expect((await runCli(['read', 'users', 'jane'], h.path)).stdout).toContain('jane@x.org');
  });

  it('config commands read the existing config from the default branch', async () => {
    const h = await dataRepo();
    const inferred = await runCli(['infer', 'users', '--branch', 'data'], h.path);
    expect(inferred.exitCode).toBe(0);
    expect(await git(h, 'show', 'data:.gitsheets/users.toml')).toContain('[gitsheet.schema]');
    // init on the bound branch sees the committed config.
    const again = await runCli(['init', 'users', '--branch', 'data'], h.path);
    expect(again.stdout).toContain('CONFIG_EXISTS');
  });

  it('push defaults to the default branch', async () => {
    const h = await dataRepo();
    const remote = await testRepo();
    handles.push(remote);
    await h.git('remote', 'add', 'origin', remote.path);
    await h.git('config', 'gitsheets.branch', 'data');
    const r = await runCli(['push'], h.path);
    expect(r.exitCode).toBe(0);
    expect(await git(remote, 'rev-parse', 'refs/heads/data')).toBe(await git(h, 'rev-parse', 'data'));
  });

  it('a tag is CONFIG_INVALID', async () => {
    const h = await testRepo({ withInitialCommit: true });
    handles.push(h);
    await h.git('tag', 'v1');
    const r = await runCli(['query', 'users', '--branch', 'v1'], h.path);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain('CONFIG_INVALID');
  });
});
