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
const ENV = ['GITSHEETS_BRANCH', 'GITSHEETS_SUBMODULE', 'GITSHEETS_STAGE_POINTER', 'GITSHEETS_AT'] as const;
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

  it('submodule errors map to CONFIG_* with the submodule hint and the source the user set', async () => {
    const h = await superproject();
    const flag = await runCli(['query', 'users', '--submodule', 'nope'], h.path);
    expect(flag.exitCode).not.toBe(0);
    expect(flag.stdout).toContain('CONFIG_INVALID');
    expect(flag.stdout).toContain('--submodule: ');
    expect(flag.stdout).not.toContain('openRepo(');
    expect(flag.stdout).toContain('git sheet submodule init');
    expect(flag.stdout).not.toContain('gitsheets.branch');

    await git(h.path, 'config', 'gitsheets.submodule', '../outside');
    const config = await runCli(['query', 'users'], h.path);
    expect(config.stdout).toContain('CONFIG_INVALID');
    expect(config.stdout).toContain('git config gitsheets.submodule: ');
    expect(config.stdout).toContain('git sheet submodule init');
  });

  it('push on a detached pointer needs a branch', async () => {
    const h = await superproject();
    await git(join(h.gitDir, 'modules', 'data'), 'checkout', '--quiet', '--detach');
    const r = await runCli(['push', '--submodule', 'data'], h.path);
    expect(r.exitCode).not.toBe(0);
  });
});

describe('gitsheets-axi --no-submodule / --no-branch (explicit opt-out)', () => {
  /** superproject() plus the superproject's own users sheet holding `root`, written through --no-submodule. */
  async function bothSheets(): Promise<TestRepoHandle> {
    const h = await superproject();
    process.env['GITSHEETS_SUBMODULE'] = 'data';
    expect((await runCli(['init', 'users', '--path', '${{ slug }}', '--no-submodule'], h.path)).exitCode).toBe(0);
    expect((await runCli(['--no-submodule', 'upsert', 'users', '--data', '{"slug":"root","email":"root@x.org"}'], h.path)).exitCode).toBe(0);
    delete process.env['GITSHEETS_SUBMODULE'];
    // The data submodule was not touched.
    expect(await git(join(h.gitDir, 'modules', 'data'), 'ls-tree', '--name-only', 'HEAD', 'users/')).toBe('users/jane.toml');
    return h;
  }

  it('GITSHEETS_SUBMODULE=data with --no-submodule reads the superproject, in any position', async () => {
    const h = await bothSheets();
    process.env['GITSHEETS_SUBMODULE'] = 'data';
    expect((await runCli(['query', 'users'], h.path)).stdout).toContain('jane');
    for (const argv of [
      ['--no-submodule', 'query', 'users'],
      ['query', '--no-submodule', 'users'],
      ['query', 'users', '--no-submodule'],
      ['query', 'users', '--submodule', 'data', '--no-submodule'],
    ]) {
      const r = await runCli(argv, h.path);
      expect(r.exitCode, argv.join(' ')).toBe(0);
      expect(r.stdout, argv.join(' ')).toContain('root');
      expect(r.stdout, argv.join(' ')).not.toContain('jane');
    }
    // The last of a flag and its --no- form wins.
    expect((await runCli(['query', 'users', '--no-submodule', '--submodule=data'], h.path)).stdout).toContain('jane');
  });

  it('--no-submodule beats gitsheets.submodule; an empty GITSHEETS_SUBMODULE does not', async () => {
    const h = await bothSheets();
    await git(h.path, 'config', 'gitsheets.submodule', 'data');
    process.env['GITSHEETS_SUBMODULE'] = '';
    expect((await runCli(['query', 'users'], h.path)).stdout).toContain('jane');
    const r = await runCli(['query', 'users', '--no-submodule'], h.path);
    expect(r.stdout).toContain('root');
    expect(r.stdout).not.toContain('jane');
  });

  it('--no-branch binds HEAD’s branch, ignoring GITSHEETS_BRANCH and gitsheets.branch', async () => {
    const h = await bothSheets();
    process.env['GITSHEETS_BRANCH'] = 'unborn-data';
    expect((await runCli(['query', 'users'], h.path)).exitCode).not.toBe(0);
    expect((await runCli(['--no-branch', 'query', 'users'], h.path)).stdout).toContain('root');
    delete process.env['GITSHEETS_BRANCH'];
    await git(h.path, 'config', 'gitsheets.branch', 'unborn-data');
    expect((await runCli(['query', 'users', '--no-branch'], h.path)).stdout).toContain('root');
  });

  it('a --no-* flag takes no value (VALIDATION_ERROR, exit 2)', async () => {
    const h = await superproject();
    for (const argv of [['query', 'users', '--no-submodule=data'], ['--no-branch=main', 'query', 'users']]) {
      const r = await runCli(argv, h.path);
      expect(r.exitCode, argv.join(' ')).toBe(2);
      expect(r.stdout, argv.join(' ')).toContain('VALIDATION_ERROR');
      expect(r.stdout, argv.join(' ')).toContain('takes no value');
    }
  });
});

describe('gitsheets-axi --stage-pointer / --at', () => {
  const staged = (h: TestRepoHandle): Promise<string> => git(h.path, 'ls-files', '--stage', 'data');
  const tip = (h: TestRepoHandle): Promise<string> => git(join(h.gitDir, 'modules', 'data'), 'rev-parse', 'HEAD');

  it('--stage-pointer (either position) stages the moved gitlink; --no-stage-pointer beats gitsheets.stagePointer', async () => {
    const h = await superproject();
    const base = await staged(h);
    expect((await runCli(['--submodule', 'data', 'upsert', 'users', '--data', '{"slug":"bob","email":"b@x.org"}'], h.path)).exitCode).toBe(0);
    expect(await staged(h)).toBe(base);
    expect((await runCli(['upsert', 'users', '--data', '{"slug":"carol","email":"c@x.org"}', '--submodule', 'data', '--stage-pointer'], h.path)).exitCode).toBe(0);
    expect(await staged(h)).toBe(`160000 ${await tip(h)} 0\tdata`);

    await git(h.path, 'reset', '--quiet', '--', 'data');
    const reset = await staged(h);
    await git(h.path, 'config', 'gitsheets.stagePointer', 'true');
    expect((await runCli(['--no-stage-pointer', 'upsert', 'users', '--data', '{"slug":"dave","email":"d@x.org"}', '--submodule', 'data'], h.path)).exitCode).toBe(0);
    expect(await staged(h)).toBe(reset);
    process.env['GITSHEETS_STAGE_POINTER'] = 'maybe';
    const bad = await runCli(['query', 'users', '--submodule', 'data'], h.path);
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout).toContain('CONFIG_INVALID');
    expect(bad.stdout).toContain('GITSHEETS_STAGE_POINTER');
  });

  it('--at / GITSHEETS_AT read the snapshot the superproject pins and refuse writes', async () => {
    const h = await superproject(); // HEAD pins jane only
    expect((await runCli(['upsert', 'users', '--data', '{"slug":"bob","email":"b@x.org"}', '--submodule', 'data'], h.path)).exitCode).toBe(0);
    expect((await runCli(['query', 'users', '--submodule', 'data'], h.path)).stdout).toContain('bob');
    const pinned = await runCli(['query', 'users', '--submodule', 'data', '--at', 'HEAD'], h.path);
    expect(pinned.exitCode).toBe(0);
    expect(pinned.stdout).toContain('jane');
    expect(pinned.stdout).not.toContain('bob');
    expect((await runCli(['--at=HEAD', '--submodule=data', 'query', 'users'], h.path)).stdout).not.toContain('bob');

    process.env['GITSHEETS_AT'] = 'HEAD';
    expect((await runCli(['query', 'users', '--submodule', 'data'], h.path)).stdout).not.toContain('bob');
    const write = await runCli(['upsert', 'users', '--data', '{"slug":"carol","email":"c@x.org"}', '--submodule', 'data'], h.path);
    expect(write.exitCode).not.toBe(0);
    delete process.env['GITSHEETS_AT'];

    const noSubmodule = await runCli(['query', 'users', '--at', 'HEAD'], h.path);
    expect(noSubmodule.exitCode).toBe(1);
    expect(noSubmodule.stdout).toContain('--at / GITSHEETS_AT');
  });

  it('malformed global flags are usage errors (VALIDATION_ERROR, exit 2)', async () => {
    const h = await superproject();
    for (const argv of [['query', 'users', '--at'], ['query', 'users', '--branch'], ['--submodule=', 'query', 'users'], ['query', 'users', '--stage-pointer=yes']]) {
      const r = await runCli(argv, h.path);
      expect(r.exitCode, argv.join(' ')).toBe(2);
      expect(r.stdout, argv.join(' ')).toContain('VALIDATION_ERROR');
    }
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
