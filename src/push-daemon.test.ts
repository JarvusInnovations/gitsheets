import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

const exec = promisify(execFile);

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

async function makeRepo(): Promise<TestRepoHandle> {
  const h = await testRepo({ withInitialCommit: true });
  handles.push(h);
  return h;
}

async function makeBareRemote(): Promise<TestRepoHandle> {
  const h = await testRepo({ withInitialCommit: false });
  // Convert to a bare repo
  await h.git('config', 'core.bare', 'true');
  handles.push(h);
  return h;
}

const USERS_CONFIG = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

async function seedConfig(fixture: TestRepoHandle, content: string): Promise<void> {
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), content);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
}

function nextPushEvent(daemon: { on: (e: string, fn: (data: unknown) => void) => void }): Promise<void> {
  return new Promise((resolve) => daemon.on('push', () => resolve()));
}

describe('PushDaemon (integration with a local bare-repo remote)', () => {
  it('pushes commits to a configured remote', async () => {
    const remote = await makeBareRemote();
    const local = await makeRepo();
    await seedConfig(local, USERS_CONFIG);

    await local.git('remote', 'add', 'origin', remote.path);
    await local.git('push', 'origin', 'main'); // initial sync

    const repo = await openRepo({ gitDir: local.gitDir });
    const daemon = await repo.startPushDaemon({ remote: 'origin', maxRetries: 3 });
    const pushed = nextPushEvent(daemon);

    await repo.transact({ message: 'add jane' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane' });
    });

    await pushed;

    // The remote should now contain the new commit
    const { stdout } = await remote.git('log', '--format=%s');
    expect(stdout).toContain('add jane');

    await daemon.stop({ timeoutMs: 1000 });
  });

  it('reports status accurately during push and idle', async () => {
    const remote = await makeBareRemote();
    const local = await makeRepo();
    await seedConfig(local, USERS_CONFIG);
    await local.git('remote', 'add', 'origin', remote.path);
    await local.git('push', 'origin', 'main');

    const repo = await openRepo({ gitDir: local.gitDir });
    const daemon = await repo.startPushDaemon({ remote: 'origin', maxRetries: 1 });

    let s = daemon.status();
    expect(s.running).toBe(true);
    expect(s.pendingCommits).toBe(0);

    const pushed = nextPushEvent(daemon);
    await repo.transact({ message: 'tick' }, async (tx) => tx.sheet('users').upsert({ slug: 'a' }));
    await pushed;

    s = daemon.status();
    expect(s.lastPushAt).not.toBeNull();
    expect(s.pendingCommits).toBe(0);

    await daemon.stop({ timeoutMs: 500 });
    s = daemon.status();
    expect(s.running).toBe(false);
  });

  it('classifies non-fast-forward rejection as terminal and stops retrying', async () => {
    const remote = await makeBareRemote();
    const local = await makeRepo();
    await seedConfig(local, USERS_CONFIG);
    await local.git('remote', 'add', 'origin', remote.path);
    await local.git('push', 'origin', 'main');

    // Push a divergent commit to the remote via a second clone so the remote
    // is genuinely ahead of `local` for the same branch.
    const sideClone = await mkdtemp(join(tmpdir(), 'gitsheets-nff-'));
    try {
      await exec('git', ['clone', remote.path, sideClone]);
      await exec('git', ['config', 'user.email', 'side@gitsheets.local'], { cwd: sideClone });
      await exec('git', ['config', 'user.name', 'side'], { cwd: sideClone });
      await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: sideClone });
      await writeFile(join(sideClone, 'extra.txt'), 'remote-only\n');
      await exec('git', ['add', 'extra.txt'], { cwd: sideClone });
      await exec('git', ['commit', '-m', 'remote-only commit'], { cwd: sideClone });
      await exec('git', ['push', 'origin', 'main'], { cwd: sideClone });
    } finally {
      // We've pushed; the working clone is no longer needed.
    }

    const repo = await openRepo({ gitDir: local.gitDir });
    const daemon = await repo.startPushDaemon({
      remote: 'origin',
      backoff: { base: 5, multiplier: 1, cap: 5 },
      maxRetries: 5,
    });

    const errors: Array<{ reason: string; attempt: number }> = [];
    daemon.on('error', (data) => errors.push(data as { reason: string; attempt: number }));
    const retries: unknown[] = [];
    daemon.on('retry', (data) => retries.push(data));

    // Wait for the push-attempt error (attempt >= 1). The startup-backlog
    // fetch may race in another error event with attempt: 0; filter for the
    // real push attempt.
    const pushError = new Promise<void>((resolve) => {
      daemon.on('error', (data) => {
        if ((data as { attempt: number }).attempt >= 1) resolve();
      });
    });

    await repo.transact({ message: 'doomed local commit' }, async (tx) =>
      tx.sheet('users').upsert({ slug: 'jane' }),
    );

    await pushError;
    // Give any spurious retry a chance to fire (it shouldn't, that's the
    // whole point of this test — but if it did, we want to catch it).
    await new Promise((r) => setTimeout(r, 100));

    const pushErrors = errors.filter((e) => e.attempt >= 1);
    expect(pushErrors.length).toBe(1);
    expect(pushErrors[0]!.reason).toBe('non-fast-forward');
    expect(retries.length).toBe(0);

    const status = daemon.status();
    expect(status.lastError?.reason).toBe('non-fast-forward');

    await daemon.stop({ timeoutMs: 100 });
    await rm(sideClone, { recursive: true, force: true });
  });

  it('pushes pre-existing local commits when the daemon starts (startup backlog)', async () => {
    const remote = await makeBareRemote();
    const local = await makeRepo();
    await seedConfig(local, USERS_CONFIG);
    await local.git('remote', 'add', 'origin', remote.path);
    await local.git('push', 'origin', 'main');

    const repo = await openRepo({ gitDir: local.gitDir });

    // Commit BEFORE starting any daemon — these commits accumulate locally
    // without notifyCommit firing on a (non-existent) daemon.
    await repo.transact({ message: 'pre-daemon commit' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'orphan' });
    });

    // Sanity: remote doesn't have this commit yet.
    const { stdout: before } = await remote.git('log', '--format=%s');
    expect(before).not.toContain('pre-daemon commit');

    const daemon = await repo.startPushDaemon({ remote: 'origin', maxRetries: 3 });
    const pushed = nextPushEvent(daemon);
    await pushed;

    const { stdout: after } = await remote.git('log', '--format=%s');
    expect(after).toContain('pre-daemon commit');

    await daemon.stop({ timeoutMs: 500 });
  });

  it('startup backlog with no ahead commits is a no-op', async () => {
    const remote = await makeBareRemote();
    const local = await makeRepo();
    await seedConfig(local, USERS_CONFIG);
    await local.git('remote', 'add', 'origin', remote.path);
    await local.git('push', 'origin', 'main');

    const repo = await openRepo({ gitDir: local.gitDir });
    const daemon = await repo.startPushDaemon({ remote: 'origin', maxRetries: 1 });

    const pushes: unknown[] = [];
    daemon.on('push', (d) => pushes.push(d));

    // Give the deferred startup-backlog check a chance to run.
    await new Promise((r) => setTimeout(r, 100));

    expect(pushes.length).toBe(0);
    expect(daemon.status().pendingCommits).toBe(0);

    await daemon.stop({ timeoutMs: 100 });
  });

  it('startup with an unreachable remote emits an error but keeps the daemon usable', async () => {
    const local = await makeRepo();
    await seedConfig(local, USERS_CONFIG);
    await local.git('remote', 'add', 'origin', `/tmp/gitsheets-nope-${Date.now()}`);

    const repo = await openRepo({ gitDir: local.gitDir });
    const daemon = await repo.startPushDaemon({
      remote: 'origin',
      backoff: { base: 5, multiplier: 1, cap: 5 },
      maxRetries: 0,
    });

    const errors: unknown[] = [];
    const firstError = new Promise<void>((resolve) => {
      daemon.on('error', (d) => {
        errors.push(d);
        resolve();
      });
    });

    // Wait for the deferred startup-backlog check to run + report.
    await firstError;

    expect(daemon.status().running).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(1);

    await daemon.stop({ timeoutMs: 100 });
  });

  it('emits error and retry on a failing push, eventually gives up at maxRetries', async () => {
    const local = await makeRepo();
    await seedConfig(local, USERS_CONFIG);
    // origin points at a non-existent path → push will fail
    await local.git('remote', 'add', 'origin', '/tmp/this-does-not-exist-' + Date.now());

    const repo = await openRepo({ gitDir: local.gitDir });
    const daemon = await repo.startPushDaemon({
      remote: 'origin',
      backoff: { base: 10, multiplier: 1, cap: 10 },
      maxRetries: 2,
    });

    const errors: unknown[] = [];
    daemon.on('error', (data) => errors.push(data));
    const retries: unknown[] = [];
    daemon.on('retry', (data) => retries.push(data));

    await repo.transact({ message: 'doomed push' }, async (tx) => tx.sheet('users').upsert({ slug: 'x' }));

    // Wait for daemon to give up
    await new Promise((r) => setTimeout(r, 200));

    expect(errors.length).toBeGreaterThanOrEqual(1);
    await daemon.stop({ timeoutMs: 100 });
  });
});
