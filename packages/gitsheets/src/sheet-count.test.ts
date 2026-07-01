// Sheet.count() — counts records without materializing them. The empty-filter
// path counts candidate tree paths (no parse); a filter falls back to a
// body-less scan that honors the filter. count() must agree with
// queryAll().length in every case.

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

async function seedRepo(slugs: string[] = []): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_CONFIG);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users');

  if (slugs.length > 0) {
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      for (const slug of slugs) {
        await tx.sheet('users').upsert({ slug, team: slug === 'mia' ? 'ops' : 'eng' });
      }
    });
  }
  return fixture;
}

describe('Sheet.count', () => {
  it('returns 0 for an empty sheet', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');
    expect(await users.count()).toBe(0);
  });

  it('counts all records without a filter, agreeing with queryAll', async () => {
    const fixture = await seedRepo(['jane', 'bob', 'mia']);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');
    expect(await users.count()).toBe(3);
    expect(await users.count()).toBe((await users.queryAll({}, { withBody: false })).length);
  });

  it('honors a value filter (fallback scan)', async () => {
    const fixture = await seedRepo(['jane', 'bob', 'mia']);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');
    // jane + bob are 'eng', mia is 'ops'.
    expect(await users.count({ team: 'eng' } as never)).toBe(2);
    expect(await users.count({ team: 'ops' } as never)).toBe(1);
    expect(await users.count({ team: 'nope' } as never)).toBe(0);
  });

  it('honors a function predicate (fallback scan)', async () => {
    const fixture = await seedRepo(['jane', 'bob', 'mia']);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');
    const n = await users.count({
      slug: (v: unknown) => typeof v === 'string' && v.startsWith('b'),
    } as never);
    expect(n).toBe(1); // bob
  });

  it('throws TypeError when passed a function', async () => {
    const fixture = await seedRepo(['jane']);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');
    await expect(users.count((() => true) as never)).rejects.toThrow(TypeError);
  });
});
