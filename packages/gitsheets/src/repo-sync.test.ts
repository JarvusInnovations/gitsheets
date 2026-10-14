// repo.sync() against a bare remote with a second clone as the other writer
// (specs/behaviors/push-sync.md "Sync (opt-in, explicit)", #301).

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { RefError, TransactionError } from './errors.js';
import { openRepo, type Repository } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

const exec = promisify(execFile);

const handles: TestRepoHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

const USERS = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/** A bare remote, a local clone (with the users sheet pushed), and a second clone as "the other writer". */
async function world(): Promise<{ remote: string; local: TestRepoHandle; repo: Repository; other: string }> {
  const remote = await mkdtemp(join(tmpdir(), 'gitsheets-sync-remote-'));
  dirs.push(remote);
  await exec('git', ['init', '-q', '--bare', '-b', 'main', remote]);

  const local = await testRepo({ withInitialCommit: true });
  handles.push(local);
  await mkdir(join(local.path, '.gitsheets'), { recursive: true });
  await writeFile(join(local.path, '.gitsheets', 'users.toml'), USERS);
  await local.git('add', '.gitsheets/');
  await local.git('commit', '-m', 'add users sheet');
  await local.git('remote', 'add', 'origin', remote);
  await local.git('push', '-q', 'origin', 'main');

  const other = await mkdtemp(join(tmpdir(), 'gitsheets-sync-other-'));
  dirs.push(other);
  await exec('git', ['clone', '-q', remote, other]);
  await git(other, 'config', 'user.name', 'Other');
  await git(other, 'config', 'user.email', 'other@x.org');

  const repo = await openRepo({ gitDir: local.gitDir });
  return { remote, local, repo, other };
}

/** Commit + push a record from the other clone. */
async function otherWrites(other: string, slug: string, email: string): Promise<string> {
  await mkdir(join(other, 'users'), { recursive: true });
  await writeFile(join(other, 'users', `${slug}.toml`), `email = "${email}"\nslug = "${slug}"\n`);
  await git(other, 'add', 'users');
  await git(other, 'commit', '-q', '-m', `other: ${slug}`);
  await git(other, 'push', '-q', 'origin', 'main');
  return git(other, 'rev-parse', 'HEAD');
}

describe('repo.sync()', () => {
  it('in-sync when nothing changed on either side', async () => {
    const { repo, local } = await world();
    const tip = await local.git('rev-parse', 'HEAD');
    const r = await repo.sync();
    expect(r.outcome).toBe('in-sync');
    expect(r.newCommit).toBe(tip.stdout.trim());
  });

  it('behind → fast-forwarded, and standing sheets see the remote record', async () => {
    const { repo, other } = await world();
    const users = await repo.openSheet('users');
    expect(await users.get('remote-jane')).toBeUndefined();
    const remoteTip = await otherWrites(other, 'remote-jane', 'rj@x.org');

    const r = await repo.sync();
    expect(r.outcome).toBe('fast-forwarded');
    expect(r.newCommit).toBe(remoteTip);
    expect([r.ahead, r.behind]).toEqual([0, 1]);
    expect((await users.get('remote-jane'))?.['email']).toBe('rj@x.org'); // rebound, no refresh() needed
  });

  it('ahead → nothing moves; a running push daemon is handed the tip and pushes it', async () => {
    const { repo, remote, local } = await world();
    const daemon = await repo.startPushDaemon({ remote: 'origin', maxRetries: 2 });
    // A commit the daemon never heard about (made with plain git, not transact).
    await mkdir(join(local.path, 'users'), { recursive: true });
    await writeFile(join(local.path, 'users', 'jane.toml'), 'email = "jane@x.org"\nslug = "jane"\n');
    await local.git('add', 'users');
    await local.git('commit', '-q', '-m', 'local jane');
    const localTip = (await local.git('rev-parse', 'main')).stdout.trim();
    expect(await git(remote, 'rev-parse', 'main')).not.toBe(localTip);

    const pushed = new Promise<void>((resolve) => daemon.once('push', () => resolve()));
    const r = await repo.sync();
    expect(r.outcome).toBe('ahead');
    expect([r.ahead, r.behind]).toEqual([1, 0]);
    expect(r.newCommit).toBe(localTip);
    await pushed;
    expect(await git(remote, 'rev-parse', 'main')).toBe(localTip);
    await daemon.stop();
  });

  it('diverged without overlap → rebased: remote record visible, local commit replayed on top', async () => {
    const { repo, other, local } = await world();
    const { commitHash: localCommit } = await repo.transact({ message: 'local jane', author: { name: 'Me', email: 'me@x.org' } }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
    });
    const remoteTip = await otherWrites(other, 'bob', 'bob@x.org');

    const r = await repo.sync({ committer: { name: 'Sync Bot', email: 'sync@x.org' } });
    expect(r.outcome).toBe('rebased');
    expect([r.ahead, r.behind]).toEqual([1, 1]);
    expect(r.newCommit).not.toBe(localCommit);
    const users = await repo.openSheet('users');
    expect((await users.get('bob'))?.['email']).toBe('bob@x.org');
    expect((await users.get('jane'))?.['email']).toBe('jane@x.org');
    const { stdout: log } = await local.git('log', '--format=%P|%s|%an|%cn', '-1', 'main');
    expect(log.trim()).toBe(`${remoteTip}|local jane|Me|Sync Bot`);
  });

  it("conflict with onConflict: 'fail' → nothing moves", async () => {
    const { repo, other, local } = await world();
    await repo.transact({ message: 'jane here' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'local@x.org' });
    });
    const before = (await local.git('rev-parse', 'main')).stdout.trim();
    await otherWrites(other, 'jane', 'remote@x.org');

    const r = await repo.sync();
    expect(r.outcome).toBe('conflict');
    expect(r.conflictCommit).toBe(before);
    expect((await local.git('rev-parse', 'main')).stdout.trim()).toBe(before);
  });

  it("conflict with onConflict: 'preserve-branch' → local history kept on a pushed side branch, branch reset to remote", async () => {
    const { repo, other, local, remote } = await world();
    await repo.transact({ message: 'jane here' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'local@x.org' });
    });
    const before = (await local.git('rev-parse', 'main')).stdout.trim();
    const remoteTip = await otherWrites(other, 'jane', 'remote@x.org');

    const r = await repo.sync({ onConflict: 'preserve-branch' });
    expect(r.outcome).toBe('conflict-escaped');
    expect(r.newCommit).toBe(remoteTip);
    expect(r.conflictBranch).toMatch(/^refs\/heads\/conflicts\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
    expect(r.conflictBranchPushed).toBe(true);
    expect((await local.git('rev-parse', r.conflictBranch!)).stdout.trim()).toBe(before);
    expect(await git(remote, 'rev-parse', r.conflictBranch!)).toBe(before);
    expect((await local.git('rev-parse', 'main')).stdout.trim()).toBe(remoteTip);
    const users = await repo.openSheet('users');
    expect((await users.get('jane'))?.['email']).toBe('remote@x.org');
  });

  it('fetch failure is an outcome, not an error', async () => {
    const { repo, local } = await world();
    await local.git('remote', 'set-url', 'origin', '/nonexistent/path/to/remote.git');
    const r = await repo.sync();
    expect(r.outcome).toBe('fetch-failed');
    expect(r.fetchError).toBeTruthy();
    expect(r.newCommit).toBe(r.oldCommit);
  });

  it('refuses to run inside a transaction handler (lock_held); isAncestor follows reachability', async () => {
    const { repo, local } = await world();
    await expect(
      repo.transact({ message: 'x' }, async () => repo.sync()),
    ).rejects.toMatchObject({ code: 'lock_held' });
    const tip = (await local.git('rev-parse', 'HEAD')).stdout.trim();
    const parent = (await local.git('rev-parse', 'HEAD^')).stdout.trim();
    expect(await repo.isAncestor(parent, tip)).toBe(true);
    expect(await repo.isAncestor(tip, parent)).toBe(false);
    expect(await repo.isAncestor(tip, tip)).toBe(true);
    await expect(repo.isAncestor('nope', tip)).rejects.toBeInstanceOf(RefError);
    expect(TransactionError).toBeDefined();
  });
});
