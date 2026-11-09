// Submodule mode (specs/behaviors/default-branch.md "Submodule mode", #341):
// openRepo({ submodule }) opens the data submodule's git dir; its HEAD is the
// superproject's managed pointer — a commit advances HEAD's branch, or a
// detached HEAD itself (strict CAS); stagePointer stages the moved gitlink;
// `at` pins every sheet read-only to the commit a superproject commit-ish
// gitlinks.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, RefError, TransactionError } from './errors.js';
import { openRepo, type Repository } from './repository.js';
import {
  addSubmoduleWithGit,
  configureIdentity,
  submoduleFixture,
  type SubmoduleFixture,
} from './test-helpers/submodule-fixture.js';

const fixtures: SubmoduleFixture[] = [];
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

/** A superproject with `data` added by plain `git submodule add` (checked out, HEAD on main), ignore = dirty. */
async function withSubmodule(): Promise<SubmoduleFixture> {
  const fx = await submoduleFixture();
  fixtures.push(fx);
  await addSubmoduleWithGit(fx);
  await fx.git(fx.superproject.path, 'config', 'submodule.data.ignore', 'dirty');
  await configureIdentity(fx, join(fx.superproject.gitDir, 'modules', 'data'));
  return fx;
}

async function open(fx: SubmoduleFixture, extra: Parameters<typeof openRepo>[0] = {}): Promise<Repository> {
  return openRepo({ gitDir: fx.superproject.gitDir, submodule: 'data', ...extra });
}

async function upsert(repo: Repository, slug: string): Promise<string> {
  const r = await repo.transact({ message: `add ${slug}` }, async (tx) => {
    await tx.sheet('users').upsert({ slug, email: `${slug}@x.org` });
  });
  return r.commitHash!;
}

const status = (fx: SubmoduleFixture): Promise<string> => fx.git(fx.superproject.path, 'status');
const sub = (fx: SubmoduleFixture, ...args: string[]): Promise<string> =>
  fx.git(join(fx.superproject.gitDir, 'modules', 'data'), ...args);

describe('openRepo({ submodule })', () => {
  it('opens the submodule git dir through its relative gitdir pointer file', async () => {
    const fx = await withSubmodule();
    expect(await readFile(join(fx.superproject.path, 'data', '.git'), 'utf8')).toMatch(/^gitdir: \.\.\//);
    const repo = await open(fx);
    expect(repo.submodule).toBe('data');
    expect(repo.branch).toBe('main');
    expect(repo.gitDir).toBe(join(fx.superproject.gitDir, 'modules', 'data'));
    const users = await repo.openSheet('users');
    expect((await users.queryFirst({ slug: 'jane' }))?.['email']).toBe('jane@x.org');
  });

  it('a commit advances HEAD\'s branch, so the superproject reports only the moved pointer', async () => {
    const fx = await withSubmodule();
    const before = await fx.git(fx.superproject.path, 'ls-files', '--stage', 'data');
    const repo = await open(fx);
    const commit = await upsert(repo, 'bob');
    expect(await sub(fx, 'rev-parse', 'refs/heads/main')).toBe(commit);
    expect(await sub(fx, 'rev-parse', 'HEAD')).toBe(commit);
    const s = await status(fx);
    expect(s).toContain('modified:   data (new commits)');
    expect(s).not.toContain('modified content');
    expect(await fx.git(fx.superproject.path, 'status', '--porcelain')).toBe('M data');
    // Nothing staged without stagePointer.
    expect(await fx.git(fx.superproject.path, 'ls-files', '--stage', 'data')).toBe(before);
    expect(await fx.git(fx.superproject.path, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('a detached HEAD is the default branch: a commit advances HEAD itself', async () => {
    const fx = await withSubmodule();
    await sub(fx, 'checkout', '--quiet', '--detach');
    const main = await sub(fx, 'rev-parse', 'refs/heads/main');
    const repo = await open(fx);
    expect(repo.branch).toBeNull();
    const result = await repo.transact({ message: 'add bob' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'bob', email: 'bob@x.org' });
    });
    expect(result.ref).toBe('HEAD');
    expect(result.parentCommitHash).toBe(main);
    expect(await sub(fx, 'rev-parse', 'HEAD')).toBe(result.commitHash);
    expect(await sub(fx, 'rev-parse', 'refs/heads/main')).toBe(main);
    expect(await sub(fx, 'symbolic-ref', '--quiet', 'HEAD').catch(() => 'detached')).toBe('detached');
    // Live sheets follow (read-your-writes).
    const users = await repo.openSheet('users');
    expect(await users.queryFirst({ slug: 'bob' })).toBeDefined();
    expect(await status(fx)).toContain('modified:   data (new commits)');
  });

  it('the detached-HEAD advance is a strict compare-and-swap', async () => {
    const fx = await withSubmodule();
    await sub(fx, 'checkout', '--quiet', '--detach');
    const repo = await open(fx);
    const first = await upsert(repo, 'bob');
    const moved = await sub(fx, 'rev-parse', 'HEAD~1');
    const err = await repo
      .transact({ message: 'add carol' }, async (tx) => {
        await tx.sheet('users').upsert({ slug: 'carol', email: 'carol@x.org' });
        // A concurrent `git submodule update` moves HEAD mid-transaction.
        await sub(fx, 'update-ref', '--no-deref', 'HEAD', moved);
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionError);
    expect((err as TransactionError).code).toBe('parent_moved');
    expect(await sub(fx, 'rev-parse', 'HEAD')).toBe(moved);
    expect(first).not.toBe(moved);
  });

  it('sync / fetch / the push daemon need a branch on a detached pointer', async () => {
    const fx = await withSubmodule();
    await sub(fx, 'checkout', '--quiet', '--detach');
    const repo = await open(fx);
    await expect(repo.sync()).rejects.toMatchObject({ code: 'ref_not_found' });
    await expect(repo.fetch()).rejects.toMatchObject({ code: 'ref_not_found' });
    await expect(repo.startPushDaemon({ remote: 'origin' })).rejects.toBeInstanceOf(RefError);
  });

  it('an explicit branch HEAD is not on writes there and moves no pointer', async () => {
    const fx = await withSubmodule();
    await sub(fx, 'branch', 'side');
    const head = await sub(fx, 'rev-parse', 'HEAD');
    const repo = await open(fx, { branch: 'side', stagePointer: true });
    expect(repo.branch).toBe('side');
    const commit = await upsert(repo, 'bob');
    expect(await sub(fx, 'rev-parse', 'refs/heads/side')).toBe(commit);
    expect(await sub(fx, 'rev-parse', 'HEAD')).toBe(head);
    expect(await fx.git(fx.superproject.path, 'status', '--porcelain')).toBe('');
  });

  it('stagePointer updates the superproject index gitlink, and never commits', async () => {
    const fx = await withSubmodule();
    const superHead = await fx.git(fx.superproject.path, 'rev-parse', 'HEAD');
    const repo = await open(fx, { stagePointer: true });
    const commit = await upsert(repo, 'bob');
    expect(await fx.git(fx.superproject.path, 'ls-files', '--stage', 'data')).toBe(`160000 ${commit} 0\tdata`);
    expect(await fx.git(fx.superproject.path, 'diff', '--cached', '--name-only')).toBe('data');
    expect(await fx.git(fx.superproject.path, 'rev-parse', 'HEAD')).toBe(superHead);
  });

  it('stagePointer on a detached pointer stages the advanced HEAD', async () => {
    const fx = await withSubmodule();
    await sub(fx, 'checkout', '--quiet', '--detach');
    const repo = await open(fx, { stagePointer: true });
    const commit = await upsert(repo, 'bob');
    expect(await fx.git(fx.superproject.path, 'ls-files', '--stage', 'data')).toBe(`160000 ${commit} 0\tdata`);
  });

  it('falls back to modules/<name> when the submodule is deinitialized', async () => {
    const fx = await withSubmodule();
    await fx.git(fx.superproject.path, 'submodule', 'deinit', '--quiet', '-f', 'data');
    const repo = await open(fx);
    expect(repo.gitDir).toBe(join(fx.superproject.gitDir, 'modules', 'data'));
    expect(await (await repo.openSheet('users')).queryFirst({ slug: 'jane' })).toBeDefined();
  });

  it('a submodule with no git dir is config_missing naming the remedy', async () => {
    const fx = await submoduleFixture();
    fixtures.push(fx);
    const err = await openRepo({ gitDir: fx.superproject.gitDir, submodule: 'data' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe('config_missing');
    expect((err as ConfigError).message).toContain('git sheet submodule init data');
  });

  it('rejects a path outside the superproject', async () => {
    const fx = await withSubmodule();
    await expect(open(fx, { submodule: '../data' })).rejects.toMatchObject({ code: 'config_invalid' });
  });

  it('resolves option → GITSHEETS_SUBMODULE → gitsheets.submodule (superproject config)', async () => {
    const fx = await withSubmodule();
    expect((await openRepo({ gitDir: fx.superproject.gitDir })).submodule).toBeNull();

    await fx.git(fx.superproject.path, 'config', 'gitsheets.submodule', 'data');
    expect((await openRepo({ gitDir: fx.superproject.gitDir })).submodule).toBe('data');

    process.env['GITSHEETS_SUBMODULE'] = 'nope';
    await expect(openRepo({ gitDir: fx.superproject.gitDir })).rejects.toMatchObject({ code: 'config_missing' });
    expect((await openRepo({ gitDir: fx.superproject.gitDir, submodule: './data/' })).submodule).toBe('data');
  });

  it('gitsheets.branch resolves inside the submodule', async () => {
    const fx = await withSubmodule();
    await sub(fx, 'branch', 'side');
    await sub(fx, 'config', 'gitsheets.branch', 'side');
    expect((await open(fx)).branch).toBe('side');
    // The superproject's own gitsheets.branch does not apply to the submodule.
    await sub(fx, 'config', '--unset', 'gitsheets.branch');
    await fx.git(fx.superproject.path, 'config', 'gitsheets.branch', 'side');
    expect((await open(fx)).branch).toBe('main');
  });
});

describe('openRepo({ submodule, at })', () => {
  it('pins every sheet read-only at the commit the superproject gitlinks', async () => {
    const fx = await withSubmodule();
    const live = await open(fx);
    const pinned = await upsert(live, 'bob');
    await fx.git(fx.superproject.path, 'add', 'data');
    await fx.git(fx.superproject.path, 'commit', '--quiet', '-m', 'pin bob');
    await fx.git(fx.superproject.path, 'tag', 'v1');
    await upsert(live, 'carol');

    const repo = await open(fx, { at: 'v1' });
    const users = await repo.openSheet('users');
    expect(users.pinnedRef).toBe(pinned);
    expect(await users.queryFirst({ slug: 'bob' })).toBeDefined();
    expect(await users.queryFirst({ slug: 'carol' })).toBeUndefined();
    expect(Object.keys(await repo.openSheets())).toEqual(['users']);

    // The first gitlink (jane only) is still reachable by superproject history.
    const older = await open(fx, { at: 'v1~1' });
    expect(await (await older.openSheet('users')).queryFirst({ slug: 'bob' })).toBeUndefined();

    await expect(repo.transact({ message: 'x' }, async () => undefined)).rejects.toMatchObject({ code: 'transaction_required' });
    await expect(users.upsert({ slug: 'dave', email: 'd@x.org' })).rejects.toMatchObject({ code: 'transaction_required' });
    await expect(repo.sync()).rejects.toMatchObject({ code: 'transaction_required' });
    await expect(repo.tag('t')).rejects.toMatchObject({ code: 'transaction_required' });
    await expect(repo.merge({ theirs: 'main' })).rejects.toMatchObject({ code: 'transaction_required' });
  });

  it('is ref_not_found when the commit-ish has no gitlink at the path', async () => {
    const fx = await withSubmodule();
    await expect(open(fx, { at: 'HEAD~1' })).rejects.toBeInstanceOf(RefError);
    await expect(open(fx, { at: 'no-such-ref' })).rejects.toMatchObject({ code: 'ref_not_found' });
  });

  it('is ref_not_found when the gitlinked commit is not in the submodule', async () => {
    const fx = await withSubmodule();
    await fx.git(fx.superproject.path, 'update-index', '--cacheinfo', `160000,${'f'.repeat(40)},data`);
    await fx.git(fx.superproject.path, 'commit', '--quiet', '-m', 'bogus pointer');
    await expect(open(fx, { at: 'HEAD' })).rejects.toMatchObject({ code: 'ref_not_found' });
  });

  it('at without a submodule binding is config_invalid', async () => {
    const fx = await withSubmodule();
    await expect(openRepo({ gitDir: fx.superproject.gitDir, at: 'HEAD' })).rejects.toMatchObject({ code: 'config_invalid' });
  });
});
