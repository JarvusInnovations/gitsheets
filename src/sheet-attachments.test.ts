// Sheet attachment surface (get/set/delete) — covers #153 deleteAttachment(s).

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

describe('Sheet.deleteAttachment', () => {
  it('removes a single attachment, leaves siblings intact', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed jane + attachments' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.upsert({ slug: 'jane' });
      await sheet.setAttachments({ slug: 'jane' }, {
        'avatar.jpg': 'AVATAR-BYTES',
        'cover.png': 'COVER-BYTES',
      });
    });

    await repo.transact({ message: 'drop avatar' }, async (tx) => {
      await tx.sheet('users').deleteAttachment({ slug: 'jane' }, 'avatar.jpg');
    });

    const users = await repo.openSheet('users');
    const remaining = await users.getAttachments({ slug: 'jane' });
    expect(remaining).not.toBeNull();
    const names = Object.keys(remaining!);
    expect(names).toEqual(['cover.png']);
  });

  it('throws NotFoundError if the attachment does not exist', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed jane' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.upsert({ slug: 'jane' });
      await sheet.setAttachment({ slug: 'jane' }, 'avatar.jpg', 'AVATAR-BYTES');
    });

    await expect(
      repo.transact({ message: 'drop missing' }, async (tx) => {
        await tx.sheet('users').deleteAttachment({ slug: 'jane' }, 'nope.png');
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('routes through an auto-transaction in permissive mode', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed jane + avatar' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.upsert({ slug: 'jane' });
      await sheet.setAttachment({ slug: 'jane' }, 'avatar.jpg', 'AVATAR-BYTES');
    });

    const users = await repo.openSheet('users');
    await users.deleteAttachment({ slug: 'jane' }, 'avatar.jpg');

    const after = await repo.openSheet('users');
    const remaining = await after.getAttachments({ slug: 'jane' });
    expect(remaining).toBeNull(); // attachment dir disappears when last file removed
  });
});

describe('Sheet.deleteAttachments', () => {
  it('removes the entire attachment directory', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed jane + attachments' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.upsert({ slug: 'jane' });
      await sheet.setAttachments({ slug: 'jane' }, {
        'avatar.jpg': 'AVATAR',
        'cover.png': 'COVER',
        'doc.pdf': 'DOC',
      });
    });

    await repo.transact({ message: 'wipe jane attachments' }, async (tx) => {
      await tx.sheet('users').deleteAttachments({ slug: 'jane' });
    });

    const users = await repo.openSheet('users');
    const remaining = await users.getAttachments({ slug: 'jane' });
    expect(remaining).toBeNull();

    // Record itself is intact
    const jane = await users.queryFirst({ slug: 'jane' });
    expect(jane).toBeDefined();
  });

  it('is a no-op for a record with no attachment directory', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed jane' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane' });
    });

    const beforeHead = await repo.resolveRef('HEAD');

    // No-op: no attachment dir on jane. Shouldn't throw, shouldn't commit.
    const result = await repo.transact({ message: 'wipe nothing' }, async (tx) => {
      await tx.sheet('users').deleteAttachments({ slug: 'jane' });
    });
    expect(result.commitHash).toBeNull();

    const afterHead = await repo.resolveRef('HEAD');
    expect(afterHead).toBe(beforeHead);
  });

  it('accepts a record path string', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.upsert({ slug: 'pat' });
      await sheet.setAttachment({ slug: 'pat' }, 'cover.png', 'COVER');
    });

    await repo.transact({ message: 'wipe via path' }, async (tx) => {
      await tx.sheet('users').deleteAttachments('pat');
    });

    const users = await repo.openSheet('users');
    expect(await users.getAttachments({ slug: 'pat' })).toBeNull();
  });
});
