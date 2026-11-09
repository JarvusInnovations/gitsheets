// gitsheets-axi submodule mode (specs/behaviors/default-branch.md "CLI" +
// "Submodule mode", #341): `--submodule <path>` (any position),
// GITSHEETS_SUBMODULE, and gitsheets.submodule bind every command to the data
// submodule; writes advance its HEAD so the superproject sees only the moved
// pointer. Also the materialize hint (#353): shown only when records live on
// the checked-out branch.

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { testRepo, type TestRepoHandle } from './test-repo.js';
import { runCli } from './run-cli.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec('git', args, { cwd })).stdout.trim();

const cleanups: Array<() => Promise<void>> = [];
const saved: Record<string, string | undefined> = {};
const ENV = ['GITSHEETS_BRANCH', 'GITSHEETS_SUBMODULE'] as const;
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A superproject with `data` (a users sheet + jane) added as a submodule, ignore = dirty. */
async function superproject(): Promise<TestRepoHandle> {
  const source = await testRepo({ withInitialCommit: true });
  cleanups.push(source.cleanup);
  expect((await runCli(['init', 'users', '--path', '${{ slug }}'], source.path)).exitCode).toBe(0);
  expect((await runCli(['upsert', 'users', '--data', '{"slug":"jane","email":"jane@x.org"}'], source.path)).exitCode).toBe(0);
  const dir = await mkdtemp(join(tmpdir(), 'gitsheets-axi-submodule-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const remote = join(dir, 'app-data.git');
  await git(dir, 'clone', '--quiet', '--bare', source.path, remote);

  const h = await testRepo({ withInitialCommit: true });
  cleanups.push(h.cleanup);
  await git(h.path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', remote, 'data');
  await git(h.path, 'commit', '--quiet', '-m', 'add data');
  await git(h.path, 'config', 'submodule.data.ignore', 'dirty');
  const modules = join(h.gitDir, 'modules', 'data');
  await git(modules, 'config', 'user.email', 'test@gitsheets.local');
  await git(modules, 'config', 'user.name', 'gitsheets test');
  await git(modules, 'config', 'commit.gpgsign', 'false');
  return h;
}

describe('gitsheets-axi --submodule', () => {
  it('accepts the flag before or after the command', async () => {
    const h = await superproject();
    expect((await runCli(['query', 'users', '--submodule', 'data'], h.path)).stdout).toContain('jane');
    expect((await runCli(['--submodule=data', 'query', 'users'], h.path)).stdout).toContain('jane');
    expect((await runCli(['query', 'users'], h.path)).exitCode).not.toBe(0);
  });

  it('a write advances the submodule HEAD; the superproject reports only the moved pointer, with no materialize hint', async () => {
    const h = await superproject();
    const up = await runCli(['upsert', 'users', '--data', '{"slug":"bob","email":"bob@x.org"}', '--submodule', 'data'], h.path);
    expect(up.exitCode).toBe(0);
    expect(up.stdout).not.toContain('git checkout HEAD');
    const modules = join(h.gitDir, 'modules', 'data');
    expect(await git(modules, 'show', 'HEAD:users/bob.toml')).toContain('bob@x.org');
    expect(await git(h.path, 'status', '--porcelain')).toBe('M data');
    expect(await git(h.path, 'status')).toContain('modified:   data (new commits)');
  });

  it('GITSHEETS_SUBMODULE and gitsheets.submodule bind with no flag', async () => {
    const h = await superproject();
    process.env['GITSHEETS_SUBMODULE'] = 'data';
    expect((await runCli(['read', 'users', 'jane'], h.path)).stdout).toContain('jane@x.org');
    delete process.env['GITSHEETS_SUBMODULE'];

    await git(h.path, 'config', 'gitsheets.submodule', 'data');
    expect((await runCli(['query', 'users'], h.path)).stdout).toContain('jane');
  });

  it('a submodule that is not set up names the remedy', async () => {
    const h = await testRepo({ withInitialCommit: true });
    cleanups.push(h.cleanup);
    const r = await runCli(['query', 'users', '--submodule', 'data'], h.path);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain('git sheet submodule init');
  });

  it('push on a detached pointer needs a branch', async () => {
    const h = await superproject();
    await git(join(h.gitDir, 'modules', 'data'), 'checkout', '--quiet', '--detach');
    const r = await runCli(['push', '--submodule', 'data'], h.path);
    expect(r.exitCode).not.toBe(0);
  });
});

describe('materialize hint (#353)', () => {
  it('shows after a write to the checked-out branch, leading with the headless layouts', async () => {
    const h = await testRepo({ withInitialCommit: true });
    cleanups.push(h.cleanup);
    await runCli(['init', 'users', '--path', '${{ slug }}'], h.path);
    const up = await runCli(['upsert', 'users', '--data', '{"slug":"jane","email":"jane@x.org"}'], h.path);
    const hint = up.stdout.slice(up.stdout.indexOf('help'));
    expect(hint).toMatch(/--branch data/);
    expect(hint).toMatch(/git checkout HEAD -- \./);
    expect(hint.indexOf('--branch data')).toBeLessThan(hint.indexOf('git checkout HEAD'));
  });

  it('is omitted when the write went to a bound data branch', async () => {
    const h = await testRepo({ withInitialCommit: true });
    cleanups.push(h.cleanup);
    await runCli(['init', 'users', '--path', '${{ slug }}', '--branch', 'data'], h.path);
    const up = await runCli(['upsert', 'users', '--data', '{"slug":"jane","email":"jane@x.org"}', '--branch', 'data'], h.path);
    expect(up.exitCode).toBe(0);
    expect(up.stdout).not.toContain('git checkout HEAD');
  });
});
