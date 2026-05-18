// Sheet.query / queryFirst / queryAll AbortSignal cancellation (#154).

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

const USERS_CONFIG = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

async function seedRepo(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_CONFIG);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
  return fixture;
}

async function seedRecords(fixture: TestRepoHandle, n: number): Promise<void> {
  const repo = await openRepo({ gitDir: fixture.gitDir });
  await repo.transact({ message: `seed ${n} users` }, async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.sheet('users').upsert({ slug: `user-${String(i).padStart(3, '0')}` });
    }
  });
}

describe('Sheet.query AbortSignal', () => {
  it('aborted-before-call throws immediately with signal.reason', async () => {
    const fixture = await seedRepo();
    await seedRecords(fixture, 5);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');

    const controller = new AbortController();
    const reason = new Error('pre-aborted');
    controller.abort(reason);

    let caught: unknown;
    let yielded = 0;
    try {
      for await (const _r of users.query({}, { signal: controller.signal })) {
        void _r;
        yielded++;
      }
    } catch (err) {
      caught = err;
    }

    expect(yielded).toBe(0);
    expect(caught).toBe(reason);
  });

  it('aborts mid-iteration on the next yield', async () => {
    const fixture = await seedRepo();
    await seedRecords(fixture, 10);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');

    const controller = new AbortController();
    const reason = new Error('stop');
    let caught: unknown;
    let yielded = 0;

    try {
      for await (const _r of users.query({}, { signal: controller.signal })) {
        void _r;
        yielded++;
        if (yielded === 3) controller.abort(reason);
      }
    } catch (err) {
      caught = err;
    }

    // We got 3 records before the abort. Iteration stopped before the 4th.
    expect(yielded).toBe(3);
    expect(caught).toBe(reason);
  });

  it('default DOMException reason is surfaced when controller.abort() is called with no arg', async () => {
    const fixture = await seedRepo();
    await seedRecords(fixture, 5);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');

    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      for await (const _r of users.query({}, { signal: controller.signal })) {
        void _r;
      }
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    // Modern Node: DOMException with name 'AbortError'
    expect((caught as { name?: string }).name).toBe('AbortError');
  });

  it('no signal runs to completion (regression)', async () => {
    const fixture = await seedRepo();
    await seedRecords(fixture, 4);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');

    const all = await users.queryAll();
    expect(all.length).toBe(4);
  });

  it('queryFirst honors a pre-aborted signal', async () => {
    const fixture = await seedRepo();
    await seedRecords(fixture, 3);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');

    const controller = new AbortController();
    const reason = new Error('first-aborted');
    controller.abort(reason);

    await expect(users.queryFirst({}, { signal: controller.signal })).rejects.toBe(reason);
  });

  it('queryAll honors a pre-aborted signal', async () => {
    const fixture = await seedRepo();
    await seedRecords(fixture, 3);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');

    const controller = new AbortController();
    const reason = new Error('all-aborted');
    controller.abort(reason);

    await expect(users.queryAll({}, { signal: controller.signal })).rejects.toBe(reason);
  });
});
