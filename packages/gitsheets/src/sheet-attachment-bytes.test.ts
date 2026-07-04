// One-call attachment writes from raw bytes (#234).
// See specs/behaviors/attachments.md#sheetsetattachmentrecord-name-content.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openRepo, type Repository } from './repository.js';
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

async function seededRepo(): Promise<Repository> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
  return openRepo({ gitDir: fixture.gitDir });
}

/** Binary bytes (not valid UTF-8) to prove byte fidelity. */
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

describe('setAttachment with raw bytes (#234)', () => {
  it('accepts a Buffer directly — no repo.writeBlob pre-step', async () => {
    const repo = await seededRepo();
    await repo.transact({ message: 'avatar from buffer' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.upsert({ slug: 'jane' });
      await sheet.setAttachment('jane', 'avatar.png', BINARY);
    });

    const users = await repo.openSheet('users');
    const blob = await users.getAttachment('jane', 'avatar.png');
    expect(blob).not.toBeNull();
    expect(Buffer.compare(await blob!.read(), BINARY)).toBe(0);
  });

  it('accepts a plain Uint8Array', async () => {
    const repo = await seededRepo();
    const bytes = new Uint8Array([1, 2, 3, 254, 255]);
    await repo.transact({ message: 'uint8array' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.upsert({ slug: 'jane' });
      await sheet.setAttachment('jane', 'data.bin', bytes);
    });

    const users = await repo.openSheet('users');
    const blob = await users.getAttachment('jane', 'data.bin');
    expect(Buffer.compare(await blob!.read(), Buffer.from(bytes))).toBe(0);
  });

  it('a subarray view writes only the viewed bytes', async () => {
    const repo = await seededRepo();
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(2, 5); // [1, 2, 3]
    await repo.transact({ message: 'view' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.upsert({ slug: 'jane' });
      await sheet.setAttachment('jane', 'view.bin', view);
    });

    const users = await repo.openSheet('users');
    const blob = await users.getAttachment('jane', 'view.bin');
    expect(Buffer.compare(await blob!.read(), Buffer.from([1, 2, 3]))).toBe(0);
  });

  it('bytes produce the same blob hash as the writeBlob two-step', async () => {
    const repo = await seededRepo();
    const viaWriteBlob = await repo.writeBlob(BINARY);

    await repo.transact({ message: 'one-call' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.upsert({ slug: 'jane' });
      await sheet.setAttachment('jane', 'avatar.png', BINARY);
    });

    const users = await repo.openSheet('users');
    const blob = await users.getAttachment('jane', 'avatar.png');
    expect(blob!.hash).toBe(viaWriteBlob.hash);
  });

  it('setAttachments accepts mixed value types in one call', async () => {
    const repo = await seededRepo();
    const handle = await repo.writeBlob(Buffer.from('via-handle'));
    await repo.transact({ message: 'mixed' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.upsert({ slug: 'jane' });
      await sheet.setAttachments('jane', {
        'a.bin': BINARY,                       // Buffer
        'b.bin': new Uint8Array([7, 8, 9]),    // Uint8Array
        'c.txt': 'plain text',                 // string (UTF-8)
        'd.bin': handle,                       // BlobHandle
      });
    });

    const users = await repo.openSheet('users');
    expect(Buffer.compare(await (await users.getAttachment('jane', 'a.bin'))!.read(), BINARY)).toBe(0);
    expect(Buffer.compare(await (await users.getAttachment('jane', 'b.bin'))!.read(), Buffer.from([7, 8, 9]))).toBe(0);
    expect((await (await users.getAttachment('jane', 'c.txt'))!.read()).toString()).toBe('plain text');
    expect((await (await users.getAttachment('jane', 'd.bin'))!.read()).toString()).toBe('via-handle');
  });

  it('works through the permissive-mode standalone path too', async () => {
    const repo = await seededRepo();
    const users = await repo.openSheet('users');
    await users.upsert({ slug: 'jane' });
    await users.setAttachment('jane', 'avatar.png', BINARY);

    // Re-open to read the committed state (this branch predates the
    // freshness auto-refresh shipping in PR #239).
    const fresh = await repo.openSheet('users');
    const blob = await fresh.getAttachment('jane', 'avatar.png');
    expect(Buffer.compare(await blob!.read(), BINARY)).toBe(0);
  });
});
