// Read freshness — refresh + transact auto-refresh.
// See specs/behaviors/freshness.md.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openRepo } from './repository.js';
import { openStore } from './store.js';
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

const USERS = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

async function seedUsers(fixture: TestRepoHandle): Promise<void> {
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
}

describe('transact auto-refresh (read-your-writes)', () => {
  it('standing Sheet reads reflect a repo.transact commit without re-opening', async () => {
    const fixture = await makeRepo();
    await seedUsers(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');

    expect(await users.queryAll()).toEqual([]);

    await repo.transact({ message: 'add jane' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
    });

    const rows = await users.queryAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: 'jane', email: 'jane@x.org' });
  });

  it('store sheets read post-commit state after store.transact', async () => {
    const fixture = await makeRepo();
    await seedUsers(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const store = await openStore(repo);

    await store.transact({ message: 'add jane' }, async (tx) => {
      await (tx as Record<string, import('./sheet.js').Sheet>)['users']!.upsert({
        slug: 'jane',
        email: 'jane@x.org',
      });
    });

    const users = (store as unknown as Record<string, import('./sheet.js').Sheet>)['users']!;
    expect(await users.queryAll()).toHaveLength(1);
  });

  it('permissive-mode auto-transactions refresh sibling sheets too', async () => {
    const fixture = await makeRepo();
    await seedUsers(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const writer = await repo.openSheet('users');
    const reader = await repo.openSheet('users');

    await writer.upsert({ slug: 'jane' });

    expect(await reader.queryAll()).toHaveLength(1);
  });

  it('attachment reads through a standing sheet see post-commit state', async () => {
    const fixture = await makeRepo();
    await seedUsers(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');

    await repo.transact({ message: 'add jane + avatar' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.upsert({ slug: 'jane' });
      const blob = await repo.writeBlob(Buffer.from('png-bytes'));
      await sheet.setAttachment('jane', 'avatar.png', blob);
    });

    const att = await users.getAttachment('jane', 'avatar.png');
    expect(att).not.toBeNull();
    expect((await att!.read()).toString()).toBe('png-bytes');
  });

  it('a commit onto a non-HEAD branch does not shift standing sheets', async () => {
    const fixture = await makeRepo();
    await seedUsers(fixture);
    await fixture.git('branch', 'side');
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');

    const result = await repo.transact(
      { message: 'add jane on side', parent: 'side' },
      async (tx) => {
        await tx.sheet('users').upsert({ slug: 'jane' });
      },
    );
    expect(result.commitHash).not.toBeNull();
    expect(result.ref).toBe('refs/heads/side');

    // HEAD (main) is unchanged, so the standing sheet stays empty.
    expect(await users.queryAll()).toEqual([]);
  });

  it('a no-op transaction leaves the snapshot untouched', async () => {
    const fixture = await makeRepo();
    await seedUsers(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');

    const result = await repo.transact({ message: 'noop' }, async () => 'nothing');
    expect(result.commitHash).toBeNull();
    expect(await users.queryAll()).toEqual([]);
  });
});

describe('explicit refresh after out-of-band movement', () => {
  it('an external commit is invisible until sheet.refresh()', async () => {
    const fixture = await makeRepo();
    await seedUsers(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');
    expect(await users.queryAll()).toEqual([]);

    // Out-of-band writer: a second Repository instance over the same git dir.
    const external = await openRepo({ gitDir: fixture.gitDir });
    await external.transact({ message: 'external add' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'ext' });
    });

    // The first repo instance did not commit; its sheets are still pinned.
    expect(await users.queryAll()).toEqual([]);

    await users.refresh();
    expect(await users.queryAll()).toHaveLength(1);
  });

  it('repo.refresh() rebinds every open sheet at once', async () => {
    const fixture = await makeRepo();
    await seedUsers(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const a = await repo.openSheet('users');
    const b = await repo.openSheet('users');

    const external = await openRepo({ gitDir: fixture.gitDir });
    await external.transact({ message: 'external add' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'ext' });
    });

    await repo.refresh();
    expect(await a.queryAll()).toHaveLength(1);
    expect(await b.queryAll()).toHaveLength(1);
  });

  it('store.refresh() delegates to repo.refresh()', async () => {
    const fixture = await makeRepo();
    await seedUsers(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const store = await openStore(repo);
    const users = (store as unknown as Record<string, import('./sheet.js').Sheet>)['users']!;

    const external = await openRepo({ gitDir: fixture.gitDir });
    await external.transact({ message: 'external add' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'ext' });
    });

    expect(await users.queryAll()).toEqual([]);
    await store.refresh();
    expect(await users.queryAll()).toHaveLength(1);
  });

  it('refresh() throws TypeError on a transaction-bound sheet', async () => {
    const fixture = await makeRepo();
    await seedUsers(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'probe' }, async (tx) => {
      const sheet = tx.sheet('users');
      await expect(sheet.refresh()).rejects.toBeInstanceOf(TypeError);
      await sheet.upsert({ slug: 'jane' });
    });
  });
});

describe('rebind re-derivations', () => {
  it('findByIndex reflects the post-commit tree via lazy rebuild', async () => {
    const fixture = await makeRepo();
    await seedUsers(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');
    users.defineIndex('byEmail', { unique: true }, (r) => (r['email'] as string) ?? undefined);

    expect(await users.findByIndex('byEmail', 'jane@x.org')).toBeUndefined();

    await repo.transact({ message: 'add jane' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
    });

    const hit = await users.findByIndex('byEmail', 'jane@x.org');
    expect(hit).toMatchObject({ slug: 'jane' });
  });

  it('a committed sheet-config change becomes visible after rebind', async () => {
    const fixture = await makeRepo();
    await seedUsers(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');
    expect((await users.readConfig()).schema).toBeNull();

    const withSchema = `${USERS}
[gitsheet.schema]
type = 'object'

[gitsheet.schema.properties.slug]
type = 'string'
`;
    await repo.transact({ message: 'tighten config' }, async (tx) => {
      tx.writeFile('.gitsheets/users.toml', withSchema);
    });

    expect((await users.readConfig()).schema).not.toBeNull();
  });
});
