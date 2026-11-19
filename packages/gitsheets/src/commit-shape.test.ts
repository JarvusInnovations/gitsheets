// Commit-shape options end to end through the JS library: additional parents,
// replace-tip, empty commits, readCommit, and repo.push({ to })
// (specs/behaviors/transactions.md, specs/behaviors/push-sync.md
// "Pushing part of a branch" / "The push daemon and an open tip").

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
  while (handles.length > 0) await handles.pop()?.cleanup();
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

const USERS = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

/** A repo with the users sheet committed on main and a bare `origin`. */
async function world(): Promise<{ local: TestRepoHandle; repo: Repository; remote: string }> {
  const remote = await mkdtemp(join(tmpdir(), 'gitsheets-shape-remote-'));
  dirs.push(remote);
  await exec('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const local = await testRepo({ withInitialCommit: true });
  handles.push(local);
  await mkdir(join(local.path, '.gitsheets'), { recursive: true });
  await writeFile(join(local.path, '.gitsheets', 'users.toml'), USERS);
  await local.git('add', '.gitsheets/');
  await local.git('commit', '-m', 'add users sheet');
  await local.git('remote', 'add', 'origin', remote);
  const repo = await openRepo({ gitDir: local.gitDir });
  return { local, repo, remote };
}

async function remoteTip(remote: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', 'refs/heads/main'], { cwd: remote });
  return stdout.trim();
}

const empty = async () => undefined;


async function rev(h: TestRepoHandle, ...args: string[]): Promise<string> {
  return (await h.git(...args)).stdout.trim();
}

describe('commit shape', () => {
  it('writes additional parents, reads them back in order', async () => {
    const { local, repo } = await world();
    const base = await rev(local, 'rev-parse', 'HEAD');
    const snapshot = await rev(local, 'commit-tree', '-m', 'world', `${base}^{tree}`);
    const r = await repo.transact(
      { message: 'cycle 1', trailers: { 'Cycle-Id': '1' }, alsoParents: [snapshot], allowEmpty: true },
      empty,
    );
    expect(r.commitHash).not.toBeNull();
    expect(r.replacedCommitHash).toBeNull();
    const head = await repo.readCommit();
    expect(head).toMatchObject({ hash: r.commitHash, branch: 'refs/heads/main', subject: 'cycle 1', body: '' });
    expect(head!.parents).toEqual([base, snapshot]);
    expect(head!.trailers).toEqual([{ key: 'Cycle-Id', value: '1' }]);
  });

  it('rejects malformed and reserved trailers as trailer_invalid', async () => {
    const { repo } = await world();
    for (const trailers of [{ 'bad key': 'v' }, { Action: 'a\nb' }]) {
      await expect(repo.transact({ message: 'x', trailers, allowEmpty: true }, empty)).rejects.toMatchObject({
        code: 'trailer_invalid',
      });
    }
  });

  it('an unresolvable additional parent is parent_not_found', async () => {
    const { repo } = await world();
    const err = await repo
      .transact({ message: 'x', alsoParents: ['1234567890123456789012345678901234567890'], allowEmpty: true }, empty)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefError);
    expect((err as RefError).code).toBe('parent_not_found');
  });

  it('replace refuses a mismatched tip with expected / actual, and rebinds live sheets on success', async () => {
    const { local, repo } = await world();
    const users = await repo.openSheet('users');
    const before = await rev(local, 'rev-parse', 'HEAD');
    await users.upsert({ slug: 'jane', email: 'jane@x.org' });
    const tip = await rev(local, 'rev-parse', 'HEAD');
    const err = await repo
      .transact({ message: 'x', replace: before }, empty)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionError);
    expect(err).toMatchObject({ code: 'tip_mismatch', expected: before, actual: tip });

    const r = await repo.transact({ message: 'jane, corrected', replace: tip }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@y.org' });
    });
    expect(r.replacedCommitHash).toBe(tip);
    expect(r.parentCommitHash).toBe(before);
    expect(await rev(local, 'rev-parse', 'HEAD')).toBe(r.commitHash);
    expect(await users.queryFirst({ slug: 'jane' })).toMatchObject({ email: 'jane@y.org' });
  });

  it('replace while this repository runs a push daemon is replace_daemon_running', async () => {
    const { local, repo } = await world();
    const daemon = await repo.startPushDaemon({ remote: 'origin' });
    try {
      const tip = await rev(local, 'rev-parse', 'HEAD');
      await expect(repo.transact({ message: 'x', replace: tip, allowEmpty: true }, empty)).rejects.toMatchObject({
        code: 'replace_daemon_running',
      });
      expect(await rev(local, 'rev-parse', 'HEAD')).toBe(tip);
    } finally {
      await daemon.stop();
    }
  });

  it('readCommit on an unborn default branch is null; an unknown rev is ref_not_found', async () => {
    const { local, repo } = await world();
    await rev(local, 'config', 'gitsheets.branch', 'log');
    const bound = await openRepo({ gitDir: local.gitDir });
    expect(await bound.readCommit()).toBeNull();
    await expect(repo.readCommit('nope')).rejects.toMatchObject({ code: 'ref_not_found' });
  });
});

describe('repo.push({ to })', () => {
  it('publishes up to a first-parent ancestor and updates the tracking ref', async () => {
    const { local, repo, remote } = await world();
    await repo.transact({ message: 'a', allowEmpty: true }, empty);
    const a = await rev(local, 'rev-parse', 'HEAD');
    await repo.transact({ message: 'b (open)', allowEmpty: true }, empty);
    const r = await repo.push({ to: a });
    expect(r).toMatchObject({ outcome: 'pushed', remote: 'origin', branch: 'main', commit: a });
    expect(await remoteTip(remote)).toBe(a);
    expect(await rev(local, 'rev-parse', 'refs/remotes/origin/main')).toBe(a);
    // Again: up to date.
    expect((await repo.push({ to: a })).outcome).toBe('up-to-date');
  });

  it('refuses a commit that is not a first-parent ancestor, or does not resolve', async () => {
    const { local, repo } = await world();
    const base = await rev(local, 'rev-parse', 'HEAD');
    const side = await rev(local, 'commit-tree', '-m', 'side', '-p', base, `${base}^{tree}`);
    await repo.transact({ message: 'with an extra parent', alsoParents: [side], allowEmpty: true }, empty);
    await expect(repo.push({ to: side })).rejects.toMatchObject({ code: 'not_an_ancestor' });
    await expect(repo.push({ to: 'nope' })).rejects.toMatchObject({ code: 'ref_not_found' });
  });

  it('a remote ahead is non-fast-forward, never forced', async () => {
    const { local, repo, remote } = await world();
    await repo.push();
    const other = await mkdtemp(join(tmpdir(), 'gitsheets-shape-other-'));
    dirs.push(other);
    await exec('git', ['clone', '-q', remote, other]);
    await exec('git', ['-c', 'user.name=O', '-c', 'user.email=o@x.org', 'commit', '-q', '--allow-empty', '-m', 'other'], { cwd: other });
    await exec('git', ['push', '-q', 'origin', 'main'], { cwd: other });
    const theirs = await remoteTip(remote);
    await repo.transact({ message: 'mine', allowEmpty: true }, empty);
    const r = await repo.push();
    expect(r.outcome).toBe('non-fast-forward');
    expect(await remoteTip(remote)).toBe(theirs);
    void local;
  });

  /** The consumer's main loop at the library level. */
  it('main loop: an empty commit with an extra parent replaced many times, then publish all but the open tip', async () => {
    const { local, repo } = await world();
    const base = await rev(local, 'rev-parse', 'HEAD');
    const snapshot = await rev(local, 'commit-tree', '-m', 'world', `${base}^{tree}`);
    let r = await repo.transact(
      { message: 'cycle 1', trailers: { State: '0' }, alsoParents: [snapshot], allowEmpty: true },
      empty,
    );
    for (let i = 1; i <= 5; i++) {
      r = await repo.transact(
        { message: 'cycle 1', trailers: { State: String(i) }, replace: r.commitHash!, allowEmpty: true },
        empty,
      );
      const c = await repo.readCommit();
      expect(c!.parents).toEqual([base, snapshot]);
    }
    expect((await repo.readCommit())!.trailers).toEqual([{ key: 'State', value: '5' }]);
    const closed = r.commitHash!;
    // The next open tip on top; publish the closed one.
    const open = await repo.transact({ message: 'cycle 2', allowEmpty: true }, empty);
    expect((await repo.push({ to: closed })).outcome).toBe('pushed');
    // The open tip can still be replaced...
    const replaced = await repo.transact(
      { message: 'cycle 2', trailers: { State: '1' }, replace: open.commitHash!, allowEmpty: true },
      empty,
    );
    expect(replaced.replacedCommitHash).toBe(open.commitHash);
    // ...the published one cannot.
    await rev(local, 'update-ref', 'refs/heads/main', closed);
    await expect(
      repo.transact({ message: 'x', replace: closed, allowEmpty: true }, empty),
    ).rejects.toMatchObject({ code: 'tip_published' });
  });
});
