import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

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
