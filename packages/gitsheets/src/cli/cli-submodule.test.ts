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

describe('submodule init after git submodule update (detached HEAD)', () => {
  /** A pushed+pinned data submodule, then a fresh superproject clone set up with plain `git submodule update --init`. */
  async function detachedClone(fx: SubmoduleFixture): Promise<{ app: string; modules: string }> {
    expect((await initNew(fx)).code).toBe(0);
    await fx.git(fx.superproject.path, 'commit', '--quiet', '-m', 'add data');
    const clone = await testRepo();
    fixtures.push(clone);
    await fx.git(clone.path, 'clone', '--quiet', fx.superproject.path, 'app');
    const app = join(clone.path, 'app');
    await fx.git(app, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--quiet');
    const modules = join(app, '.git', 'modules', 'data');
    await configureIdentity(fx, modules);
    expect(await fx.git(modules, 'symbolic-ref', '--quiet', 'HEAD').catch(() => 'detached')).toBe('detached');
    return { app, modules };
  }

  it('fast-forwards the branch over gitsheets writes on the detached HEAD instead of orphaning them', async () => {
    const fx = await fixture();
    const { app, modules } = await detachedClone(fx);
    const up = await run(['--git-dir', join(app, '.git'), '--submodule', 'data', 'upsert', 'users', '{"slug":"bob","email":"bob@x.org"}']);
    expect(up.code).toBe(0);
    const written = await fx.git(modules, 'rev-parse', 'HEAD');

    const init = await run(['--git-dir', join(app, '.git'), 'submodule', 'init', 'data']);
    expect(init.code).toBe(0);
    expect(await fx.git(modules, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(await fx.git(modules, 'rev-parse', 'refs/heads/main')).toBe(written);
  });

  it('refuses when the detached HEAD and the branch have diverged, changing nothing', async () => {
    const fx = await fixture();
    const { app, modules } = await detachedClone(fx);
    await run(['--git-dir', join(app, '.git'), '--submodule', 'data', 'upsert', 'users', '{"slug":"bob","email":"bob@x.org"}']);
    const written = await fx.git(modules, 'rev-parse', 'HEAD');
    // Another write lands on main itself (not through the pointer).
    const side = await openRepo({ gitDir: join(app, '.git'), submodule: 'data', branch: 'main' });
    await side.transact({ message: 'carol' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'carol', email: 'carol@x.org' });
    });
    const mainTip = await fx.git(modules, 'rev-parse', 'refs/heads/main');

    const init = await run(['--git-dir', join(app, '.git'), 'submodule', 'init', 'data']);
    expect(init.code).toBe(64);
    expect(init.err).toContain('diverged');
    expect(init.err).toContain(written);
    expect(await fx.git(modules, 'rev-parse', 'HEAD')).toBe(written);
    expect(await fx.git(modules, 'symbolic-ref', '--quiet', 'HEAD').catch(() => 'detached')).toBe('detached');
    expect(await fx.git(modules, 'rev-parse', 'refs/heads/main')).toBe(mainTip);
  });
});

describe('submodule init --url ordering and URL refresh', () => {
  it('a failed clone writes nothing, so a retry starts clean', async () => {
    const fx = await fixture();
    const cwd = fx.superproject.path;
    const bad = await run(['--git-dir', fx.superproject.gitDir, 'submodule', 'init', 'data', '--url', `${fx.remote}-missing`, '--branch', 'main']);
    expect(bad.code).toBe(64);
    expect(await fx.git(cwd, 'status', '--porcelain')).toBe('');
    expect(await fx.git(cwd, 'config', '--get', 'submodule.data.url').catch(() => 'unset')).toBe('unset');

    const good = await initNew(fx);
    expect(good.code).toBe(0);
    expect((await fx.git(cwd, 'diff', '--cached', '--name-only')).split('\n').sort()).toEqual(['.gitmodules', 'data']);
  });

  it('a matching --url refreshes a stale submodule.<name>.url', async () => {
    const fx = await fixture();
    expect((await initNew(fx)).code).toBe(0);
    await fx.git(fx.superproject.path, 'config', 'submodule.data.url', '/stale.git');
    expect((await initNew(fx)).code).toBe(0);
    expect(await fx.git(fx.superproject.path, 'config', '--get', 'submodule.data.url')).toBe(fx.remote);
  });
});

describe('linked worktree superproject', () => {
  it('submodule init writes the worktree\'s own modules/ dir, which openRepo then uses', async () => {
    const fx = await fixture();
    expect((await initNew(fx)).code).toBe(0);
    await fx.git(fx.superproject.path, 'commit', '--quiet', '-m', 'add data');
    const holder = await testRepo();
    fixtures.push(holder);
    const wt = join(holder.path, 'wt');
    await fx.git(fx.superproject.path, 'worktree', 'add', '--quiet', '--detach', wt);
    const wtGitDir = await fx.git(wt, 'rev-parse', '--absolute-git-dir');
    expect(wtGitDir).toContain('/worktrees/');

    await expect(openRepo({ gitDir: wt, submodule: 'data' })).rejects.toMatchObject({ code: 'config_missing' });
    const init = await run(['--git-dir', wt, 'submodule', 'init', 'data']);
    expect(init.code).toBe(0);
    const repo = await openRepo({ gitDir: wt, submodule: 'data' });
    expect(repo.gitDir).toBe(join(wtGitDir, 'modules', 'data'));
    expect(await (await repo.openSheet('users')).queryFirst({ slug: 'jane' })).toBeDefined();
  });
});

describe('GIT_DIR in the environment', () => {
  it('GIT_DIR=<super>/.git git sheet --submodule data query users reads the submodule', async () => {
    const fx = await fixture();
    expect((await initNew(fx)).code).toBe(0);
    const saved = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = fx.superproject.gitDir;
    try {
      const q = await run(['--submodule', 'data', 'query', 'users']);
      expect(q.code).toBe(0);
      expect(q.out).toContain('"slug":"jane"');
    } finally {
      if (saved === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = saved;
    }
  });
});

describe('gitsheets.submodule git config', () => {
  it('errors name the source the user actually set', async () => {
    const fx = await fixture();
    await fx.git(fx.superproject.path, 'config', 'gitsheets.submodule', 'nope');
    const fromConfig = await run(['--git-dir', fx.superproject.gitDir, 'query', 'users']);
    expect(fromConfig.code).toBe(64);
    expect(fromConfig.err).toContain('git config gitsheets.submodule: ');
    const fromFlag = await run(['--git-dir', fx.superproject.gitDir, '--submodule', 'nope', 'query', 'users']);
    expect(fromFlag.err).toContain('--submodule / GITSHEETS_SUBMODULE: ');
    expect(fromFlag.err.split('\n')[0]).not.toContain('openRepo(');
  });

  it('binds `git sheet` to the data submodule with no flags', async () => {
    const fx = await fixture();
    expect((await initNew(fx)).code).toBe(0);
    await fx.git(fx.superproject.path, 'config', 'gitsheets.submodule', 'data');
    const q = await run(['--git-dir', fx.superproject.gitDir, 'query', 'users']);
    expect(q.code).toBe(0);
    expect(q.out).toContain('"slug":"jane"');
  });
});

describe('--no-submodule / --no-branch (explicit opt-out)', () => {
  /** A data submodule (jane) under a superproject whose own users sheet holds `root`. */
  async function bothSheets(): Promise<SubmoduleFixture> {
    const fx = await fixture();
    expect((await initNew(fx)).code).toBe(0);
    const superRepo = await openRepo({ gitDir: fx.superproject.gitDir, submodule: null });
    await superRepo.transact({ message: 'superproject users' }, async (tx) => {
      tx.writeFile('.gitsheets/users.toml', "[gitsheet]\nroot = 'users'\npath = '${{ slug }}'\n");
      await tx.sheet('users').upsert({ slug: 'root', email: 'root@x.org' });
    });
    return fx;
  }

  it('GITSHEETS_SUBMODULE=data git sheet --no-submodule query users reads the superproject, in any position', async () => {
    const fx = await bothSheets();
    const g = ['--git-dir', fx.superproject.gitDir];
    process.env['GITSHEETS_SUBMODULE'] = 'data';
    const bound = await run([...g, 'query', 'users']);
    expect(bound.code).toBe(0);
    expect(bound.out).toContain('"slug":"jane"');
    for (const args of [
      [...g, '--no-submodule', 'query', 'users'],
      [...g, 'query', 'users', '--no-submodule'],
      [...g, '--submodule', 'data', 'query', 'users', '--no-submodule'],
    ]) {
      const q = await run(args);
      expect(q.code, args.join(' ')).toBe(0);
      expect(q.out, args.join(' ')).toContain('"slug":"root"');
      expect(q.out, args.join(' ')).not.toContain('"slug":"jane"');
    }
    // The last of a flag and its --no- form wins.
    const last = await run([...g, '--no-submodule', '--submodule', 'data', 'query', 'users']);
    expect(last.out).toContain('"slug":"jane"');
  });

  it('--no-submodule beats gitsheets.submodule git config', async () => {
    const fx = await bothSheets();
    await fx.git(fx.superproject.path, 'config', 'gitsheets.submodule', 'data');
    const q = await run(['--git-dir', fx.superproject.gitDir, '--no-submodule', 'query', 'users']);
    expect(q.code).toBe(0);
    expect(q.out).toContain('"slug":"root"');
  });

  it('an empty GITSHEETS_SUBMODULE is unset: git config still binds', async () => {
    const fx = await bothSheets();
    await fx.git(fx.superproject.path, 'config', 'gitsheets.submodule', 'data');
    process.env['GITSHEETS_SUBMODULE'] = '';
    const q = await run(['--git-dir', fx.superproject.gitDir, 'query', 'users']);
    expect(q.out).toContain('"slug":"jane"');
  });

  it('--no-branch binds HEAD’s branch, ignoring GITSHEETS_BRANCH and gitsheets.branch', async () => {
    const fx = await bothSheets();
    const g = ['--git-dir', fx.superproject.gitDir];
    process.env['GITSHEETS_BRANCH'] = 'unborn-data';
    const unborn = await run([...g, 'query', 'users']);
    expect(unborn.code).not.toBe(0);
    const q = await run([...g, '--no-branch', 'query', 'users']);
    expect(q.code).toBe(0);
    expect(q.out).toContain('"slug":"root"');
    delete process.env['GITSHEETS_BRANCH'];
    await fx.git(fx.superproject.path, 'config', 'gitsheets.branch', 'unborn-data');
    const fromConfig = await run([...g, 'query', 'users', '--no-branch']);
    expect(fromConfig.code).toBe(0);
    expect(fromConfig.out).toContain('"slug":"root"');
  });

  it('submodule init treats --no-branch as no --branch', async () => {
    const fx = await fixture();
    expect((await initNew(fx, '--no-branch')).code).toBe(0);
    expect(await fx.git(fx.superproject.path, 'config', '-f', '.gitmodules', 'submodule.data.branch')).toBe('main');
  });
});

describe('--stage-pointer / GITSHEETS_STAGE_POINTER / gitsheets.stagePointer', () => {
  /** initNew + commit, so the superproject's index starts clean. */
  async function ready(): Promise<{ fx: SubmoduleFixture; staged: () => Promise<string>; base: string }> {
    const fx = await fixture();
    expect((await initNew(fx)).code).toBe(0);
    await fx.git(fx.superproject.path, 'commit', '--quiet', '-m', 'add data submodule');
    const staged = (): Promise<string> => fx.git(fx.superproject.path, 'ls-files', '--stage', 'data');
    return { fx, staged, base: await staged() };
  }
  const upsert = (fx: SubmoduleFixture, slug: string, ...flags: string[]) =>
    run(['--git-dir', fx.superproject.gitDir, '--submodule', 'data', ...flags, 'upsert', 'users', JSON.stringify({ slug, email: `${slug}@x.org` })]);
  const tip = (fx: SubmoduleFixture): Promise<string> => fx.git(join(fx.superproject.gitDir, 'modules', 'data'), 'rev-parse', 'HEAD');

  it('the flag stages the moved gitlink after a write; without it nothing is staged', async () => {
    const { fx, staged, base } = await ready();
    expect((await upsert(fx, 'bob')).code).toBe(0);
    expect(await staged()).toBe(base);
    expect((await upsert(fx, 'carol', '--stage-pointer')).code).toBe(0);
    expect(await staged()).toBe(`160000 ${await tip(fx)} 0\tdata`);
  });

  it('GITSHEETS_STAGE_POINTER takes git booleans, and an invalid value is config_invalid (exit 64)', async () => {
    const { fx, staged } = await ready();
    process.env['GITSHEETS_STAGE_POINTER'] = '1';
    expect((await upsert(fx, 'bob')).code).toBe(0);
    expect(await staged()).toBe(`160000 ${await tip(fx)} 0\tdata`);
    process.env['GITSHEETS_STAGE_POINTER'] = 'maybe';
    const bad = await upsert(fx, 'carol');
    expect(bad.code).toBe(64);
    expect(bad.err).toContain('GITSHEETS_STAGE_POINTER: ');
  });

  it('gitsheets.stagePointer config applies with no flag, and --no-stage-pointer beats it', async () => {
    const { fx, staged, base } = await ready();
    await fx.git(fx.superproject.path, 'config', 'gitsheets.stagePointer', 'true');
    expect((await upsert(fx, 'bob', '--no-stage-pointer')).code).toBe(0);
    expect(await staged()).toBe(base);
    expect((await upsert(fx, 'carol')).code).toBe(0);
    expect(await staged()).toBe(`160000 ${await tip(fx)} 0\tdata`);
  });
});

describe('--at / GITSHEETS_AT', () => {
  it('reads the snapshot a superproject ref pins; writes exit 69; outside submodule mode exits 64 naming --at', async () => {
    const fx = await fixture();
    const cwd = fx.superproject.path;
    expect((await initNew(fx)).code).toBe(0);
    await fx.git(cwd, 'commit', '--quiet', '-m', 'add data submodule'); // pins jane only
    const g = ['--git-dir', fx.superproject.gitDir, '--submodule', 'data'];
    expect((await run([...g, 'upsert', 'users', '{"slug":"bob","email":"bob@x.org"}'])).code).toBe(0);

    const live = await run([...g, 'query', 'users']);
    expect(live.out).toContain('"slug":"bob"');
    const pinned = await run([...g, '--at', 'HEAD', 'query', 'users']);
    expect(pinned.code).toBe(0);
    expect(pinned.out).toContain('"slug":"jane"');
    expect(pinned.out).not.toContain('"slug":"bob"');
    expect((await run([...g, '--at', 'HEAD', 'read', 'users', 'bob'])).code).toBe(66);

    process.env['GITSHEETS_AT'] = 'HEAD';
    try {
      expect((await run([...g, 'query', 'users'])).out).not.toContain('"slug":"bob"');
      const write = await run([...g, 'upsert', 'users', '{"slug":"carol","email":"carol@x.org"}']);
      expect(write.code).toBe(69);
      expect(write.err).toContain('transaction_required');
    } finally {
      delete process.env['GITSHEETS_AT'];
    }

    const noSubmodule = await run(['--git-dir', fx.superproject.gitDir, '--at', 'HEAD', 'query', 'users']);
    expect(noSubmodule.code).toBe(64);
    expect(noSubmodule.err).toContain('--at / GITSHEETS_AT');
    const noGitlink = await run([...g, '--at', 'HEAD~1', 'query', 'users']);
    expect(noGitlink.code).toBe(65);
    expect(noGitlink.err).toContain('--at / GITSHEETS_AT');
  });
});
