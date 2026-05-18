import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NotFoundError } from './errors.js';
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

async function seedConfig(fixture: TestRepoHandle, name: string, toml: string): Promise<void> {
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', `${name}.toml`), toml);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', `add ${name} sheet`);
}

const USERS_CONFIG = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

describe('Sheet.patch (RFC 7396)', () => {
  it('merges a partial into an existing record', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx
        .sheet('users')
        .upsert({ slug: 'jane', email: 'jane@x.org', fullName: 'Jane', bio: 'old bio' });
    });

    await repo.transact({ message: 'patch' }, async (tx) => {
      await tx.sheet('users').patch({ slug: 'jane' }, { fullName: 'Jane O. Doe', bio: null });
    });

    const users = await repo.openSheet('users');
    const jane = await users.queryFirst({ slug: 'jane' });
    expect(jane?.['fullName']).toBe('Jane O. Doe');
    expect(jane?.['email']).toBe('jane@x.org');
    expect('bio' in (jane ?? {})).toBe(false);
  });

  it('throws NotFoundError when the query matches no record', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await expect(
      repo.transact({ message: 'patch missing' }, async (tx) =>
        tx.sheet('users').patch({ slug: 'nobody' }, { fullName: 'x' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('replaces arrays (RFC 7396 — no concat)', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', tags: ['admin', 'staff'] });
    });

    await repo.transact({ message: 'patch tags' }, async (tx) => {
      await tx.sheet('users').patch({ slug: 'jane' }, { tags: ['member'] });
    });

    const users = await repo.openSheet('users');
    const jane = await users.queryFirst({ slug: 'jane' });
    expect(jane?.['tags']).toEqual(['member']);
  });
});
