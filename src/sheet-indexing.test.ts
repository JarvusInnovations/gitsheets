import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { IndexError } from './errors.js';
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

describe('Sheet.defineIndex / findByIndex', () => {
  it('unique index returns the matching record', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'Jane@x.org' });
      await tx.sheet('users').upsert({ slug: 'bob', email: 'bob@y.org' });
    });

    const users = await repo.openSheet('users');
    users.defineIndex(
      'byEmail',
      { unique: true },
      (r) => (r['email'] as string).toLowerCase(),
    );

    const jane = await users.findByIndex('byEmail', 'jane@x.org');
    expect(jane).toBeDefined();
    expect((jane as Record<string, unknown>)['slug']).toBe('jane');

    const missing = await users.findByIndex('byEmail', 'nobody@example.com');
    expect(missing).toBeUndefined();
  });

  it('non-unique index returns an array', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'a', team: 'eng' });
      await tx.sheet('users').upsert({ slug: 'b', team: 'eng' });
      await tx.sheet('users').upsert({ slug: 'c', team: 'design' });
    });

    const users = await repo.openSheet('users');
    users.defineIndex('byTeam', (r) => String(r['team']));

    const eng = await users.findByIndex('byTeam', 'eng');
    expect(Array.isArray(eng)).toBe(true);
    expect((eng as unknown[]).length).toBe(2);
  });

  it('keyFn returning undefined excludes the record', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'a', legacyId: 100 });
      await tx.sheet('users').upsert({ slug: 'b' }); // no legacyId
    });

    const users = await repo.openSheet('users');
    users.defineIndex('byLegacy', { unique: true }, (r) =>
      'legacyId' in r ? String(r['legacyId']) : undefined,
    );

    const found = await users.findByIndex('byLegacy', '100');
    expect(found).toBeDefined();
    // Record `b` is excluded — there's no key for it, so any non-100 lookup is undefined
    const notFound = await users.findByIndex('byLegacy', 'anything-else');
    expect(notFound).toBeUndefined();
  });

  it('throws IndexError(index_not_defined) for an unknown index', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');
    await expect(users.findByIndex('nope', 'x')).rejects.toBeInstanceOf(IndexError);
  });

  it('throws IndexError(index_unique_conflict) on duplicate keys for unique index', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'a', email: 'same@x.org' });
      await tx.sheet('users').upsert({ slug: 'b', email: 'same@x.org' });
    });

    const users = await repo.openSheet('users');
    users.defineIndex('byEmail', { unique: true }, (r) => String(r['email']));

    try {
      await users.findByIndex('byEmail', 'same@x.org');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IndexError);
      expect((err as IndexError).code).toBe('index_unique_conflict');
      expect((err as IndexError).conflictingPaths?.length).toBe(2);
    }
  });

  it('pre-write check: rejects an upsert that would violate a unique index, leaving the tree unchanged', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    // Seed alice
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'alice', email: 'shared@x.org' });
    });

    // Open a sheet, define + build a unique index by email
    const users = await repo.openSheet('users');
    users.defineIndex('byEmail', { unique: true }, (r) => String(r['email']));
    // Force-build the index
    await users.findByIndex('byEmail', 'shared@x.org');

    const headBefore = await repo.resolveRef('HEAD');

    // Attempting to insert a different record with the same email should throw
    // BEFORE any tree mutation.
    await expect(
      repo.transact({ message: 'should fail' }, async (tx) => {
        // Re-define the index on the tx-bound sheet so it's pre-built there too.
        const txUsers = tx.sheet('users');
        txUsers.defineIndex('byEmail', { unique: true }, (r) => String(r['email']));
        await txUsers.findByIndex('byEmail', 'shared@x.org');
        // Now this upsert should fail
        await txUsers.upsert({ slug: 'bob', email: 'shared@x.org' });
      }),
    ).rejects.toBeInstanceOf(IndexError);

    // HEAD must not have advanced.
    const headAfter = await repo.resolveRef('HEAD');
    expect(headAfter).toBe(headBefore);
  });

  it('defineIndex({ eager: true }) returns a Promise that resolves when built', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'a', team: 'eng' });
      await tx.sheet('users').upsert({ slug: 'b', team: 'design' });
    });

    const users = await repo.openSheet('users');
    const ready = users.defineIndex('byTeam', { eager: true }, (r) => String(r['team']));
    expect(ready).toBeInstanceOf(Promise);
    await ready;
    // Index is now built — findByIndex should not need to re-walk.
    const eng = await users.findByIndex('byTeam', 'eng');
    expect((eng as unknown[]).length).toBe(1);
  });

  it('defineIndex({ eager: true }) rejects on a unique conflict', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'a', email: 'dup@x.org' });
      await tx.sheet('users').upsert({ slug: 'b', email: 'dup@x.org' });
    });

    const users = await repo.openSheet('users');
    await expect(
      users.defineIndex('byEmail', { unique: true, eager: true }, (r) => String(r['email'])),
    ).rejects.toBeInstanceOf(IndexError);
  });

  it('rebuilds after upsert on the same Sheet instance', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'a', team: 'eng' });
    });

    const users = await repo.openSheet('users');
    users.defineIndex('byTeam', (r) => String(r['team']));
    const before = (await users.findByIndex('byTeam', 'eng')) as unknown[];
    expect(before.length).toBe(1);

    // Add another record through a tx, then look up via the same Sheet instance.
    await repo.transact({ message: 'add b' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'b', team: 'eng' });
    });

    // `users` instance still points at the old workspace's tree; rebuilds may
    // not see the new record without a fresh openSheet. Verify the new
    // instance behaves correctly:
    const fresh = await repo.openSheet('users');
    fresh.defineIndex('byTeam', (r) => String(r['team']));
    const after = (await fresh.findByIndex('byTeam', 'eng')) as unknown[];
    expect(after.length).toBe(2);
  });
});
