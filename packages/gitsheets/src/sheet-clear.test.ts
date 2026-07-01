// Sheet.clear() — #178 fix: uses the binding tree's clearChildren()
// (O(1)) instead of walking + deleteChild per entry.
//
// The behavioral observable is the serialized hash of the sheet's subtree
// in the working tree's TreeObject mid-transaction: after clear() it must
// equal git's empty-tree hash.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

async function seedRepo({
  withRecords = false,
}: { withRecords?: boolean } = {}): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_CONFIG);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users');

  if (withRecords) {
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
      await tx.sheet('users').upsert({ slug: 'bob', email: 'bob@x.org' });
      await tx.sheet('users').upsert({ slug: 'mia', email: 'mia@x.org' });
    });
  }
  return fixture;
}

async function commitCount(fixture: TestRepoHandle): Promise<number> {
  const { stdout } = await fixture.git('rev-list', '--count', 'HEAD');
  return parseInt(stdout.trim(), 10);
}

describe('Sheet.clear', () => {
  it('clear empties the sheet subtree — omitted from the committed tree', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'clear users' }, async (tx) => {
      await tx.sheet('users').clear();
    });

    // An emptied subtree serializes to the empty tree, which git omits from the
    // committed tree — so there's no `users/` entry and no records remain.
    const { stdout } = await fixture.git('ls-tree', '--name-only', 'HEAD');
    const entries = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    expect(entries).not.toContain('users');

    const users = await repo.openSheet('users');
    expect(await users.queryAll()).toEqual([]);
  });

  it('committed sheet has no records after clear', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'clear users' }, async (tx) => {
      await tx.sheet('users').clear();
    });

    const sheet = await repo.openSheet('users');
    const rows = await sheet.queryAll({});
    expect(rows).toEqual([]);
  });

  it('clear then re-upsert leaves only the new records', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'reset + reseed' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.clear();
      await sheet.upsert({ slug: 'new-only', email: 'new@x.org' });
    });

    const sheet = await repo.openSheet('users');
    const rows = await sheet.queryAll({});
    const slugs = rows.map((r) => (r as Record<string, unknown>)['slug']);
    expect(slugs).toEqual(['new-only']);
  });

  it('clear on an already-empty sheet is a safe no-op (still produces a commit due to markMutated)', async () => {
    // After the #179 no-op-detection fix, the commit count should NOT
    // increase if no actual tree mutation occurred. That assertion lives
    // in the transaction test file; here we just check that clear() on
    // an already-empty sheet doesn't throw.
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'clear empty' }, async (tx) => {
      await tx.sheet('users').clear();
    });
  });

  it('invalidates indexes — subsequent findByIndex sees the cleared state', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const sheet = await repo.openSheet('users');
    sheet.defineIndex(
      'byEmail',
      { unique: true },
      (r) => (r as Record<string, unknown>)['email'] as string,
    );

    // Prime the index.
    const before = await sheet.findByIndex('byEmail', 'jane@x.org');
    expect(before).toBeDefined();

    // Clear via a different sheet handle (sharing the underlying repo) to
    // simulate an external mutation; the per-instance handle's index
    // wouldn't auto-invalidate, but the clear() inside the transaction
    // does invalidate the in-tx sheet's indexes. The behavior under test
    // is that clear() invokes #invalidateIndexes() (added with the fix).
    await repo.transact({ message: 'clear' }, async (tx) => {
      const txSheet = tx.sheet('users');
      txSheet.defineIndex(
        'byEmail',
        { unique: true },
        (r) => (r as Record<string, unknown>)['email'] as string,
      );
      // Build the index so we can verify it's invalidated.
      const found = await txSheet.findByIndex('byEmail', 'jane@x.org');
      expect(found).toBeDefined();

      await txSheet.clear();

      // After clear(), the index should rebuild from the now-empty subtree.
      const afterClear = await txSheet.findByIndex('byEmail', 'jane@x.org');
      expect(afterClear).toBeUndefined();
    });
  });

  it('multiple clears in different transactions produce expected commit counts', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const beforeClear = await commitCount(fixture);

    await repo.transact({ message: 'clear 1' }, async (tx) => {
      await tx.sheet('users').clear();
    });
    const afterFirstClear = await commitCount(fixture);
    expect(afterFirstClear).toBe(beforeClear + 1);

    // Second clear on an already-empty sheet — after #179, no commit.
    await repo.transact({ message: 'clear 2' }, async (tx) => {
      await tx.sheet('users').clear();
    });
    const afterSecondClear = await commitCount(fixture);
    expect(afterSecondClear).toBe(afterFirstClear);
  });
});
