// Sheet attachment surface (get/set/delete) — covers #153 deleteAttachment(s).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NotFoundError } from './errors.js';
import { RECORD_PATH_KEY } from './sheet.js';
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

// specs/behaviors/attachments.md "Move on record rename" (#302).
describe('rename moves attachments', () => {
  it('a rename-on-upsert moves the attachment directory with the record', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      const users = tx.sheet('users');
      await users.upsert({ slug: 'jane', email: 'jane@x.org' });
      await users.setAttachments({ slug: 'jane' }, { 'avatar.jpg': Buffer.from('AVATAR'), 'cv.pdf': Buffer.from('CV') });
    });

    const users = await repo.openSheet('users');
    const jane = await users.get('jane');
    expect(jane).toBeDefined();
    // Spread keeps the symbol-keyed path annotation → rename semantics.
    await repo.transact({ message: 'rename' }, async (tx) => {
      await tx.sheet('users').upsert({ ...jane!, slug: 'jane-doe' });
    });

    expect(await users.get('jane')).toBeUndefined();
    expect(await users.getAttachments('jane')).toBeNull();
    const moved = await users.getAttachments('jane-doe');
    expect(Object.keys(moved!).sort()).toEqual(['avatar.jpg', 'cv.pdf']);
    expect((await moved!['avatar.jpg']!.read()).toString()).toBe('AVATAR');
    const { stdout } = await fixture.git('ls-tree', '-r', '--name-only', 'HEAD');
    expect(stdout).not.toContain('users/jane/');
    expect(stdout).toContain('users/jane-doe/avatar.jpg');
  });

  it('works in permissive mode and across a validator that drops symbols when the annotation is re-applied', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');
    await users.upsert({ slug: 'bob', email: 'bob@x.org' });
    await users.setAttachment({ slug: 'bob' }, 'avatar.jpg', Buffer.from('B'));

    const bob = await users.get('bob');
    // Simulate Zod's `.parse`: a fresh object with only string keys.
    const parsed: Record<string | symbol, unknown> = { slug: 'robert', email: 'bob@x.org' };
    parsed[RECORD_PATH_KEY] = (bob as Record<symbol, unknown>)[RECORD_PATH_KEY];
    await users.upsert(parsed);

    expect(await users.getAttachments('bob')).toBeNull();
    expect(Object.keys((await users.getAttachments('robert'))!)).toEqual(['avatar.jpg']);
  });

  it('delete-then-upsert is not a rename: the cascade removes the attachments first', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');
    await users.upsert({ slug: 'amy', email: 'amy@x.org' });
    await users.setAttachment({ slug: 'amy' }, 'avatar.jpg', Buffer.from('A'));

    await repo.transact({ message: 'lossy rename' }, async (tx) => {
      await tx.sheet('users').delete('amy');
      await tx.sheet('users').upsert({ slug: 'amy-b', email: 'amy@x.org' });
    });
    expect(await users.getAttachments('amy-b')).toBeNull();
  });
});
