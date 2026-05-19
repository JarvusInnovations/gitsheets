// Transaction#finalize no-op detection (#179).
//
// Before the fix, `#anyMutation = true` was sufficient to produce a
// commit, even when the resulting tree-hash matched the parent's. The
// fix compares tree hashes after `workspace.root.write()`; equality
// short-circuits to the same return shape as the `!#anyMutation` path.

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
    });
  }
  return fixture;
}

async function commitCount(fixture: TestRepoHandle): Promise<number> {
  const { stdout } = await fixture.git('rev-list', '--count', 'HEAD');
  return parseInt(stdout.trim(), 10);
}

describe('Transaction#finalize no-op detection', () => {
  it('upsert of byte-identical record produces no commit', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const before = await commitCount(fixture);

    const result = await repo.transact({ message: 'reupsert same' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
    });

    expect(result.commitHash).toBeNull();
    expect(await commitCount(fixture)).toBe(before);
  });

  it('clear + reupsert with identical data produces no commit', async () => {
    // The snapshot-importer pattern from #179.
    const fixture = await seedRepo({ withRecords: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const before = await commitCount(fixture);

    const result = await repo.transact({ message: 'snapshot reimport' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.clear();
      await sheet.upsert({ slug: 'jane', email: 'jane@x.org' });
      await sheet.upsert({ slug: 'bob', email: 'bob@x.org' });
    });

    expect(result.commitHash).toBeNull();
    expect(await commitCount(fixture)).toBe(before);
  });

  it('clear + reupsert with ONE record changed produces exactly one commit', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const before = await commitCount(fixture);

    const result = await repo.transact({ message: 'snapshot diff' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.clear();
      await sheet.upsert({ slug: 'jane', email: 'jane@x.org' });
      // bob's email changed
      await sheet.upsert({ slug: 'bob', email: 'bob@new.org' });
    });

    expect(result.commitHash).not.toBeNull();
    expect(await commitCount(fixture)).toBe(before + 1);
  });

  it('markMutated alone (no tree change) produces no commit — behavior change vs v1.3.0', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const before = await commitCount(fixture);

    const result = await repo.transact({ message: 'force?' }, async (tx) => {
      // markMutated alone used to produce an empty commit; after #179, the
      // tree-hash comparison short-circuits.
      tx.markMutated();
    });

    expect(result.commitHash).toBeNull();
    expect(await commitCount(fixture)).toBe(before);
  });

  it('initial commit on a fresh repo IS produced when transaction runs (no parent to compare against)', async () => {
    const fixture = await testRepo({ withInitialCommit: false });
    handles.push(fixture);

    // .gitsheets/users.toml created INSIDE the transaction so the tx has
    // real tree changes; the assertion is that `commitHash` is non-null
    // because there's no parent to compare against.
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const result = await repo.transact(
      {
        message: 'initial',
        branch: 'refs/heads/main',
        // No `parent` — fresh repo, no parent commit to compare against.
      },
      async (tx) => {
        await tx.tree.writeChild('.gitsheets/users.toml', USERS_CONFIG);
        tx.markMutated();
      },
    );

    expect(result.commitHash).not.toBeNull();
  });

  it('delete then re-add identical record produces no commit', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const before = await commitCount(fixture);

    const result = await repo.transact({ message: 'rebuild jane' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.delete('jane');
      await sheet.upsert({ slug: 'jane', email: 'jane@x.org' });
    });

    expect(result.commitHash).toBeNull();
    expect(await commitCount(fixture)).toBe(before);
  });

  it('returns the same shape as the !anyMutation path on no-op (treeHash: null)', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const result = await repo.transact({ message: 'noop' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
    });

    expect(result.commitHash).toBeNull();
    expect(result.treeHash).toBeNull();
    expect(result.ref).toBeNull();
    expect(result.parentCommitHash).not.toBeNull();
  });
});
