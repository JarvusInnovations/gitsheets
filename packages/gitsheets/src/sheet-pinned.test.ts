// Ref-pinned, read-only sheets (#303):
// specs/api/repository.md `opts.ref`, specs/behaviors/freshness.md "Ref-pinned sheets".

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RefError, TransactionError } from './errors.js';
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

const USERS = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

/** main: users sheet + jane. `side` branched off main with bob added. HEAD stays on main. */
async function seed(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
  const repo = await openRepo({ gitDir: fixture.gitDir });
  await repo.transact({ message: 'jane' }, async (tx) => {
    await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
  });
  await fixture.git('branch', 'side');
  await repo.transact({ message: 'bob on side', parent: 'side' }, async (tx) => {
    await tx.sheet('users').upsert({ slug: 'bob', email: 'bob@x.org' });
  });
  return fixture;
}

describe('ref-pinned sheets', () => {
  it('reads at the pinned branch and ignores HEAD commits until its own refresh()', async () => {
    const fixture = await seed();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const live = await repo.openSheet('users');
    const side = await repo.openSheet('users', { ref: 'side' });
    expect(side.pinnedRef).toBe('side');
    expect(live.pinnedRef).toBeUndefined();

    expect((await side.queryAll()).map((r) => r['slug']).sort()).toEqual(['bob', 'jane']);
    expect((await live.queryAll()).map((r) => r['slug'])).toEqual(['jane']);

    // A commit on HEAD (main) auto-refreshes the live sheet, not the pinned one.
    await repo.transact({ message: 'amy' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'amy', email: 'amy@x.org' });
    });
    expect((await live.queryAll()).map((r) => r['slug']).sort()).toEqual(['amy', 'jane']);
    expect((await side.queryAll()).map((r) => r['slug']).sort()).toEqual(['bob', 'jane']);
    await repo.refresh();
    expect((await side.queryAll()).map((r) => r['slug']).sort()).toEqual(['bob', 'jane']);

    // The branch moves; only the pinned sheet's own refresh() follows it.
    await repo.transact({ message: 'cat on side', parent: 'side' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'cat', email: 'cat@x.org' });
    });
    expect((await side.queryAll()).map((r) => r['slug']).sort()).toEqual(['bob', 'jane']);
    await side.refresh();
    expect((await side.queryAll()).map((r) => r['slug']).sort()).toEqual(['bob', 'cat', 'jane']);
    // The live sheet never moved onto the side branch.
    expect((await live.queryAll()).map((r) => r['slug']).sort()).toEqual(['amy', 'jane']);
  });

  it('a commit-pinned sheet is immutable across refresh(); clone keeps the pin', async () => {
    const fixture = await seed();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const { stdout } = await fixture.git('rev-parse', 'side');
    const at = await repo.openSheet('users', { ref: stdout.trim() });
    await repo.transact({ message: 'cat on side', parent: 'side' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'cat', email: 'cat@x.org' });
    });
    await at.refresh();
    expect((await at.queryAll()).map((r) => r['slug']).sort()).toEqual(['bob', 'jane']);
    const copy = await at.clone();
    expect(copy.pinnedRef).toBe(stdout.trim());
    expect((await copy.queryAll()).length).toBe(2);
  });

  it('is read-only in permissive mode; transactions on the ref still work', async () => {
    const fixture = await seed();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const side = await repo.openSheet('users', { ref: 'side' });
    const err = await side.upsert({ slug: 'x', email: 'x@x.org' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionError);
    expect((err as TransactionError).code).toBe('transaction_required');
    expect((err as TransactionError).message).toContain('side');
    await expect(side.delete('jane')).rejects.toBeInstanceOf(TransactionError);
    await expect(side.setAttachment('jane', 'a.txt', Buffer.from('a'))).rejects.toBeInstanceOf(TransactionError);

    await repo.transact({ message: 'write onto side', parent: 'side' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'x', email: 'x@x.org' });
    });
    await side.refresh();
    expect((await side.get('x'))?.['email']).toBe('x@x.org');
  });

  it('openStore({ ref }) pins every sheet; store.refresh() re-resolves the ref', async () => {
    const fixture = await seed();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const store = await openStore(repo, { ref: 'side' });
    expect((await store['users']!.queryAll()).map((r) => r['slug']).sort()).toEqual(['bob', 'jane']);
    await repo.transact({ message: 'cat on side', parent: 'side' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'cat', email: 'cat@x.org' });
    });
    expect((await store['users']!.queryAll()).length).toBe(2);
    await store.refresh();
    expect((await store['users']!.queryAll()).length).toBe(3);
    await expect(store['users']!.upsert({ slug: 'y', email: 'y@x.org' })).rejects.toBeInstanceOf(TransactionError);
  });

  it('a ref that does not resolve is RefError(ref_not_found)', async () => {
    const fixture = await seed();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await expect(repo.openSheet('users', { ref: 'nope' })).rejects.toBeInstanceOf(RefError);
    await expect(repo.openSheets({ ref: 'nope' })).rejects.toBeInstanceOf(RefError);
  });
});
