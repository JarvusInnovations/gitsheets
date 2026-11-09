// CLI submodule mode (specs/behaviors/default-branch.md "Submodule mode" +
// "Bootstrapping" — "A data submodule", specs/api/cli.md): `--submodule` /
// GITSHEETS_SUBMODULE / gitsheets.submodule select the data submodule, and
// `git sheet submodule init` sets one up with no record checkout.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main } from './index.js';
import { openRepo } from '../repository.js';
import { configureIdentity, submoduleFixture, type SubmoduleFixture } from '../test-helpers/submodule-fixture.js';
import { testRepo } from '../test-helpers/test-repo.js';

const fixtures: Array<{ cleanup: () => Promise<void> }> = [];
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
  while (fixtures.length > 0) await fixtures.pop()?.cleanup();
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

async function fixture(opts: { emptyRemote?: boolean } = {}): Promise<SubmoduleFixture> {
  const fx = await submoduleFixture(opts);
  fixtures.push(fx);
  return fx;
}

/** `git sheet submodule init data --url <remote>` against the fixture's superproject. */
async function initNew(fx: SubmoduleFixture, ...extra: string[]): Promise<{ code: number; out: string; err: string }> {
  const r = await run(['--git-dir', fx.superproject.gitDir, 'submodule', 'init', 'data', '--url', fx.remote, ...extra]);
  if (r.code === 0) await configureIdentity(fx, join(fx.superproject.gitDir, 'modules', 'data'));
  return r;
}

describe('git sheet submodule init --url', () => {
  it('adds the entry, clones with no checkout, puts HEAD on the branch, sets ignore = dirty, stages, never commits', async () => {
    const fx = await fixture();
    const cwd = fx.superproject.path;
    const superHead = await fx.git(cwd, 'rev-parse', 'HEAD');
    const r = await initNew(fx);
    expect(r.code).toBe(0);

    const modules = join(fx.superproject.gitDir, 'modules', 'data');
    const tip = await fx.git(fx.remote, 'rev-parse', 'refs/heads/main');
    expect(await fx.git(cwd, 'config', '-f', '.gitmodules', 'submodule.data.path')).toBe('data');
    expect(await fx.git(cwd, 'config', '-f', '.gitmodules', 'submodule.data.url')).toBe(fx.remote);
    expect(await fx.git(cwd, 'config', '-f', '.gitmodules', 'submodule.data.branch')).toBe('main');
    expect(await fx.git(cwd, 'config', 'submodule.data.ignore')).toBe('dirty');
    expect(await fx.git(modules, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(await fx.git(modules, 'rev-parse', 'HEAD')).toBe(tip);
    // No record checkout: data/ holds only the gitdir pointer file.
    expect(await readdir(join(cwd, 'data'))).toEqual(['.git']);
    expect(await readFile(join(cwd, 'data', '.git'), 'utf8')).toBe('gitdir: ../.git/modules/data\n');
    // Staged, not committed.
    expect((await fx.git(cwd, 'diff', '--cached', '--name-only')).split('\n').sort()).toEqual(['.gitmodules', 'data']);
    expect(await fx.git(cwd, 'ls-files', '--stage', 'data')).toBe(`160000 ${tip} 0\tdata`);
    expect(await fx.git(cwd, 'rev-parse', 'HEAD')).toBe(superHead);
    // Plain git sees a clean submodule (only the staged additions).
    expect(await fx.git(cwd, 'status', '--porcelain')).toBe('A  .gitmodules\nA  data');
  });

  it('end to end: write through --submodule, commit the pointer, read it back with at', async () => {
    const fx = await fixture();
    const cwd = fx.superproject.path;
    expect((await initNew(fx)).code).toBe(0);
    await fx.git(cwd, 'commit', '--quiet', '-m', 'add data submodule');

    process.env['GITSHEETS_SUBMODULE'] = 'data';
    const up = await run(['--git-dir', fx.superproject.gitDir, 'upsert', 'users', '{"slug":"bob","email":"bob@x.org"}']);
    expect(up.code).toBe(0);
    delete process.env['GITSHEETS_SUBMODULE'];

    const s = await fx.git(cwd, 'status');
    expect(s).toContain('modified:   data (new commits)');
    expect(s).not.toContain('modified content');
    expect(await fx.git(cwd, 'status', '--porcelain')).toBe('M data');
    expect(await readdir(join(cwd, 'data'))).toEqual(['.git']);

    await fx.git(cwd, 'add', 'data');
    await fx.git(cwd, 'commit', '--quiet', '-m', 'pin bob');
    const pinned = await openRepo({ gitDir: fx.superproject.gitDir, submodule: 'data', at: 'HEAD' });
    const users = await pinned.openSheet('users');
    expect(await users.queryFirst({ slug: 'bob' })).toBeDefined();

    // The flag spelling reads the same data.
    const q = await run(['--git-dir', fx.superproject.gitDir, '--submodule', 'data', 'query', 'users']);
    expect(q.out).toContain('"slug":"bob"');
    expect(q.out).toContain('"slug":"jane"');
  });

  it('a fresh clone of the superproject + submodule init reads the same records with no files under data/', async () => {
    const fx = await fixture();
    expect((await initNew(fx)).code).toBe(0);
    const up = await run(['--git-dir', fx.superproject.gitDir, '--submodule', 'data', 'upsert', 'users', '{"slug":"bob","email":"bob@x.org"}']);
    expect(up.code).toBe(0);
    await fx.git(join(fx.superproject.gitDir, 'modules', 'data'), 'push', '--quiet', 'origin', 'main');
    await fx.git(fx.superproject.path, 'add', 'data');
    await fx.git(fx.superproject.path, 'commit', '--quiet', '-m', 'add data with bob');
    // Another data commit the clone's pin must not include.
    await run(['--git-dir', fx.superproject.gitDir, '--submodule', 'data', 'upsert', 'users', '{"slug":"carol","email":"carol@x.org"}']);
    await fx.git(join(fx.superproject.gitDir, 'modules', 'data'), 'push', '--quiet', 'origin', 'main');

    const clone = await testRepo();
    fixtures.push(clone);
    await fx.git(clone.path, 'clone', '--quiet', fx.superproject.path, 'app');
    const app = join(clone.path, 'app');
    const appGit = join(app, '.git');

    // Before init: the binding names the remedy.
    const missing = await run(['--git-dir', appGit, '--submodule', 'data', 'query', 'users']);
    expect(missing.code).toBe(64);
    expect(missing.err).toContain('--submodule / GITSHEETS_SUBMODULE');
    expect(missing.err).toContain('git sheet submodule init data');

    const init = await run(['--git-dir', appGit, 'submodule', 'init', 'data']);
    expect(init.code).toBe(0);
    const modules = join(appGit, 'modules', 'data');
    const pinnedCommit = (await fx.git(app, 'ls-tree', 'HEAD', 'data')).split(/\s+/)[2]!;
    expect(await fx.git(modules, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(await fx.git(modules, 'rev-parse', 'HEAD')).toBe(pinnedCommit);
    expect(await fx.git(app, 'config', 'submodule.data.ignore')).toBe('dirty');
    expect(await readdir(join(app, 'data'))).toEqual(['.git']);
    expect(await fx.git(app, 'status', '--porcelain')).toBe('');

    const q = await run(['--git-dir', appGit, '--submodule', 'data', 'query', 'users']);
    expect(q.code).toBe(0);
    expect(q.out).toContain('"slug":"bob"');
    expect(q.out).not.toContain('"slug":"carol"');

    // Idempotent: a re-run leaves an existing branch (and any unpinned data commits) alone.
    await configureIdentity(fx, modules);
    await run(['--git-dir', appGit, '--submodule', 'data', 'upsert', 'users', '{"slug":"dave","email":"dave@x.org"}']);
    const tip = await fx.git(modules, 'rev-parse', 'HEAD');
    const again = await run(['--git-dir', appGit, 'submodule', 'init', 'data']);
    expect(again.code).toBe(0);
    expect(await fx.git(modules, 'rev-parse', 'HEAD')).toBe(tip);
    expect(await fx.git(modules, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  });

  it('--branch names the data branch; an empty remote needs it and starts the branch unborn', async () => {
    const fx = await fixture({ emptyRemote: true });
    const cwd = fx.superproject.path;
    const noBranch = await run(['--git-dir', fx.superproject.gitDir, 'submodule', 'init', 'data', '--url', fx.remote]);
    expect(noBranch.code).toBe(64);
    expect(noBranch.err).toContain('--branch');

    const r = await initNew(fx, '--branch', 'records');
    expect(r.code).toBe(0);
    const modules = join(fx.superproject.gitDir, 'modules', 'data');
    expect(await fx.git(modules, 'symbolic-ref', 'HEAD')).toBe('refs/heads/records');
    expect(await fx.git(cwd, 'config', '-f', '.gitmodules', 'submodule.data.branch')).toBe('records');
    expect(await fx.git(cwd, 'diff', '--cached', '--name-only')).toBe('.gitmodules');

    // Bootstrap the data branch through the submodule binding.
    const init = await run(['--git-dir', fx.superproject.gitDir, '--submodule', 'data', 'init', 'users', '--path', '${{ slug }}']);
    expect(init.code).toBe(0);
    expect(await fx.git(modules, 'rev-parse', '--verify', 'refs/heads/records')).toMatch(/^[0-9a-f]{40}$/);
    expect(await fx.git(cwd, 'status', '--porcelain')).toContain('data');
  });

  it('--url conflicting with an existing entry is config_invalid', async () => {
    const fx = await fixture();
    expect((await initNew(fx)).code).toBe(0);
    const r = await run(['--git-dir', fx.superproject.gitDir, 'submodule', 'init', 'data', '--url', '/elsewhere.git']);
    expect(r.code).toBe(64);
    expect(r.err).toContain('already in .gitmodules');
    // The same URL is the idempotent existing-entry form.
    expect((await initNew(fx)).code).toBe(0);
  });

  it('an unknown path with no --url names the remedy', async () => {
    const fx = await fixture();
    const r = await run(['--git-dir', fx.superproject.gitDir, 'submodule', 'init', 'data']);
    expect(r.code).toBe(64);
    expect(r.err).toContain('--url');
  });
});

describe('gitsheets.submodule git config', () => {
  it('binds `git sheet` to the data submodule with no flags', async () => {
    const fx = await fixture();
    expect((await initNew(fx)).code).toBe(0);
    await fx.git(fx.superproject.path, 'config', 'gitsheets.submodule', 'data');
    const q = await run(['--git-dir', fx.superproject.gitDir, 'query', 'users']);
    expect(q.code).toBe(0);
    expect(q.out).toContain('"slug":"jane"');
  });
});
